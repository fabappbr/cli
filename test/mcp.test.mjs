/**
 * O servidor MCP.
 *
 * O que mais importa aqui não é o protocolo — é o ESCOPO. Um token concedido só-leitura não pode ver as
 * ferramentas de escrita: anunciar uma que vai responder 403 é pior do que não anunciá-la, porque o modelo tenta,
 * falha, e tenta de novo com outros argumentos — a recusa parece problema do pedido e não da permissão.
 */
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import test from "node:test";

import { createServer } from "../src/mcp/server.mjs";
import { TOOLS, toolsFor } from "../src/mcp/tools.mjs";

/** Um servidor MCP em memória: manda linhas, recebe respostas. */
function mcp({ scopes = "read write", host = "http://localhost:1", account = "acc-1" } = {}) {
  const out = [];
  const handle = createServer({
    host, creds: { token: "fabc_x", scope: scopes, account_id: account },
    write: (s) => out.push(JSON.parse(s)),
  });
  return {
    out,
    async send(msg) { await handle(JSON.stringify(msg)); return out[out.length - 1]; },
    async raw(line) { await handle(line); return out[out.length - 1]; },
  };
}

test("initialize negocia a versão do protocolo e diz o escopo", async () => {
  const s = mcp({ scopes: "read" });
  const r = await s.send({ jsonrpc: "2.0", id: 1, method: "initialize",
                           params: { protocolVersion: "2024-11-05" } });
  // Ecoar a versão do cliente quando conhecida é o que mantém um cliente antigo funcionando com um servidor novo.
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.equal(r.result.serverInfo.name, "fabapp");
  assert.match(r.result.instructions, /Somente leitura/);

  const novo = await mcp().send({ jsonrpc: "2.0", id: 1, method: "initialize",
                                  params: { protocolVersion: "1999-01-01" } });
  assert.equal(novo.result.protocolVersion, "2025-06-18", "versão desconhecida deve cair na mais nova que sabemos");
});

test("um token só-leitura NÃO vê as ferramentas de escrita", async () => {
  const r = await mcp({ scopes: "read" }).send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const nomes = r.result.tools.map((t) => t.name);
  assert.ok(nomes.includes("fabapp_read_definition"));
  assert.ok(!nomes.includes("fabapp_write_definition"), "anunciou uma ferramenta que responderia 403");
  assert.ok(!nomes.includes("fabapp_deploy"));
});

test("com escrita, todas aparecem", async () => {
  const r = await mcp().send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.result.tools.length, TOOLS.length);
});

test("toda ferramenta declara escopo, descrição e schema de entrada", () => {
  // Uma ferramenta sem escopo cairia fora de `toolsFor` e simplesmente não existiria — falha silenciosa.
  for (const t of TOOLS) {
    assert.ok(["read", "write"].includes(t.scope), `${t.name} sem escopo válido`);
    assert.ok(t.description.length > 40, `${t.name} com descrição curta demais para o modelo escolher`);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} aceita argumento não declarado`);
    assert.equal(typeof t.run, "function", t.name);
  }
});

test("chamar uma ferramenta de escrita sem o escopo explica que é PERMISSÃO, não argumento", async () => {
  const r = await mcp({ scopes: "read" }).send({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "fabapp_deploy", arguments: { project_id: "p", app_id: "a" } } });
  assert.equal(r.result.isError, true);
  const txt = r.result.content[0].text;
  assert.match(txt, /escopo de escrita/);
  assert.match(txt, /fabapp login/, "tem de dizer COMO resolver, senão o modelo reformula argumentos até desistir");
});

test("ferramenta desconhecida é dita como desconhecida", async () => {
  const r = await mcp().send({ jsonrpc: "2.0", id: 4, method: "tools/call",
                               params: { name: "fabapp_inventada", arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /desconhecida/);
});

test("falha de ferramenta vira RESULTADO com isError, não erro de protocolo", async (t) => {
  // Assim o modelo lê a mensagem ("regra de acesso inválida em message.access") e corrige. Um erro de protocolo
  // derruba a conexão e ele não vê nada.
  const srv = httpServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: { message: "message.access: regra desconhecida 'owner_via'" } }));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());

  const s = mcp({ host: `http://localhost:${srv.address().port}` });
  const r = await s.send({ jsonrpc: "2.0", id: 5, method: "tools/call",
                           params: { name: "fabapp_read_definition", arguments: { project_id: "p" } } });
  assert.ok(!r.error, "não pode ser erro de protocolo");
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /owner_via/);
});

test("uma notificação não recebe resposta", async () => {
  const s = mcp();
  await s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(s.out.length, 0, "responder a uma notificação quebra cliente estrito");
});

test("JSON inválido vira erro de parse, e não derruba o servidor", async () => {
  const s = mcp();
  const r = await s.raw("{isto não é json");
  assert.equal(r.error.code, -32700);
  // E o servidor segue atendendo.
  const ok = await s.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.ok(ok.result.tools.length);
});

test("método não suportado responde, mas só quando tem id", async () => {
  const s = mcp();
  const r = await s.send({ jsonrpc: "2.0", id: 10, method: "resources/list" });
  assert.equal(r.error.code, -32601);
  s.out.length = 0;
  await s.send({ jsonrpc: "2.0", method: "resources/list" });
  assert.equal(s.out.length, 0);
});

test("as ferramentas de leitura nunca são as de escrita", () => {
  const leitura = new Set(toolsFor("read").map((t) => t.name));
  const escrita = toolsFor("read write").filter((t) => t.scope === "write").map((t) => t.name);
  for (const w of escrita) assert.ok(!leitura.has(w), `${w} vazou para o conjunto de leitura`);
});
