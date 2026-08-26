/**
 * The MCP server.
 *
 * What matters most here is not the protocol — it is the SCOPE. A token granted read-only must not see the write
 * tools: advertising one that will answer 403 is worse than not advertising it, because the model tries, fails,
 * and tries again with different arguments — the refusal looks like a problem with the request, not the permission.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import test from "node:test";

import { createServer } from "../src/mcp/server.mjs";
import { TOOLS, toolsFor } from "../src/mcp/tools.mjs";

/** An in-memory MCP server: send lines, get replies. */
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

test("initialize negotiates the protocol version and states the scope", async () => {
  const s = mcp({ scopes: "read" });
  const r = await s.send({ jsonrpc: "2.0", id: 1, method: "initialize",
                           params: { protocolVersion: "2024-11-05" } });
  // Echoing the client's version when we know it is what keeps an old client working with a new server.
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.equal(r.result.serverInfo.name, "fabapp");
  assert.match(r.result.instructions, /Read-only/);

  const novo = await mcp().send({ jsonrpc: "2.0", id: 1, method: "initialize",
                                  params: { protocolVersion: "1999-01-01" } });
  assert.equal(novo.result.protocolVersion, "2025-06-18", "an unknown version must fall back to the newest one we know");
});

test("a read-only token does NOT see the write tools", async () => {
  const r = await mcp({ scopes: "read" }).send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const nomes = r.result.tools.map((t) => t.name);
  assert.ok(nomes.includes("fabapp_read_definition"));
  assert.ok(!nomes.includes("fabapp_write_definition"), "advertised a tool that would answer 403");
  assert.ok(!nomes.includes("fabapp_deploy"));
});

test("with write, all of them show up", async () => {
  const r = await mcp().send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.result.tools.length, TOOLS.length);
});

test("every tool declares a scope, a description and an input schema", () => {
  // A tool without a scope would fall outside `toolsFor` and simply not exist — a silent failure.
  for (const t of TOOLS) {
    assert.ok(["read", "write"].includes(t.scope), `${t.name} sem escopo válido`);
    assert.ok(t.description.length > 40, `${t.name} has a description too short for the model to choose by`);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} accepts an undeclared argument`);
    assert.equal(typeof t.run, "function", t.name);
  }
});

test("calling a write tool without the scope explains it is PERMISSION, not arguments", async () => {
  const r = await mcp({ scopes: "read" }).send({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "fabapp_deploy", arguments: { project_id: "p", app_id: "a" } } });
  assert.equal(r.result.isError, true);
  const txt = r.result.content[0].text;
  assert.match(txt, /needs the write scope/);
  assert.match(txt, /fabapp login/, "it has to say HOW to fix it, or the model rewords arguments until it gives up");
});

test("an unknown tool is named as unknown", async () => {
  const r = await mcp().send({ jsonrpc: "2.0", id: 4, method: "tools/call",
                               params: { name: "fabapp_inventada", arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown tool/);
});

test("a tool failure becomes a RESULT with isError, not a protocol error", async (t) => {
  // That way the model reads the message ("invalid access rule at message.access") and corrects it. A protocol
  // error takes the connection down and it sees nothing.
  const srv = httpServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: { message: "message.access: regra desconhecida 'owner_via'" } }));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());

  const s = mcp({ host: `http://localhost:${srv.address().port}` });
  const r = await s.send({ jsonrpc: "2.0", id: 5, method: "tools/call",
                           params: { name: "fabapp_read_definition", arguments: { project_id: "p" } } });
  assert.ok(!r.error, "it must not be a protocol error");
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /owner_via/);
});

test("a notification gets no reply", async () => {
  const s = mcp();
  await s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(s.out.length, 0, "answering a notification breaks a strict client");
});

test("invalid JSON becomes a parse error, and does not take the server down", async () => {
  const s = mcp();
  const r = await s.raw("{this is not json");
  assert.equal(r.error.code, -32700);
  // E o servidor segue atendendo.
  const ok = await s.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.ok(ok.result.tools.length);
});

test("an unsupported method answers, but only when it has an id", async () => {
  const s = mcp();
  const r = await s.send({ jsonrpc: "2.0", id: 10, method: "resources/list" });
  assert.equal(r.error.code, -32601);
  s.out.length = 0;
  await s.send({ jsonrpc: "2.0", method: "resources/list" });
  assert.equal(s.out.length, 0);
});

test("initialize reports THIS version, not a hand-written copy of it", async () => {
  // 0.1.0 stayed in `serverInfo` through the whole life of 0.1.1. The version an MCP client shows is the one a bug
  // report names, so a stale copy points the reader at the release that never had the bug.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const r = await mcp().send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(r.result.serverInfo.version, pkg.version);
});

test("the opening tells an agent where the contract is", async () => {
  // An agent arriving here knows nothing about this platform, and everything it needs is published — but nothing
  // was pointing at it. The `instructions` field is the one thing every MCP client feeds to the model before it
  // plans anything, so it is where the pointer has to be.
  const r = await mcp().send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.match(r.result.instructions, /fabapp_docs/);
  assert.match(r.result.instructions, /field types|access rules/);
});

test("fabapp_docs returns the platform's own contract, live", async (t) => {
  // Fetched from the host, never a copy in this package: a stale copy makes an agent write a schema the server
  // then refuses, which reads as the platform being broken rather than as the docs being old.
  const srv = httpServer((req, res) => {
    assert.equal(req.url, "/llms-full.txt");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("### Field types (this is the COMPLETE list)\n`text` `enum` `ref`");
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());

  const s = mcp({ host: `http://localhost:${srv.address().port}` });
  const r = await s.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "fabapp_docs", arguments: {} } });
  assert.equal(r.result.isError ?? false, false);
  assert.match(r.result.content[0].text, /COMPLETE list/);
});

test("writing a definition is REFUSED until the contract has been read", async (t) => {
  // The `instructions` ask; this enforces. A model is free to skip an instruction, and the cost of skipping this one
  // is a schema with an invented field type, or access rules that lock every user out of their own records.
  const srv = httpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("### Field types (this is the COMPLETE list)");
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const s = mcp({ host: `http://localhost:${srv.address().port}` });

  const blocked = await s.send({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_write_definition", arguments: { project_id: "p", files: [] } } });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /fabapp_docs/);
  // The refusal SAYS what to do and why — an agent that only reads the error still learns the shape of the problem.
  assert.match(blocked.result.content[0].text, /closed contract|field types/i);

  await s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fabapp_docs", arguments: {} } });
  const after = await s.send({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "fabapp_write_definition", arguments: { project_id: "p", files: [] } } });
  // It reaches the API now (which this fake answers as docs text) — the point is only that the gate is open.
  assert.doesNotMatch(String(after.result.content[0].text), /Call `fabapp_docs` first/);
});

test("reading, deploying and creating are NOT gated", async (t) => {
  // The gate is bought with friction, so it is spent only where the INPUT encodes the contract. Publishing code that
  // already exists, or making an empty project, encodes none of it.
  const srv = httpServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const s = mcp({ host: `http://localhost:${srv.address().port}` });

  for (const name of ["fabapp_list_projects", "fabapp_read_definition"]) {
    const r = await s.send({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: { project_id: "p" } } });
    assert.doesNotMatch(String(r.result.content[0].text), /Call `fabapp_docs` first/, name);
  }
});

test("the closed field list travels in the tool description itself", () => {
  // A tool description is the one text every MCP client puts in front of the model, read even by an agent that
  // skipped the docs and the instructions. The part most often guessed wrong belongs there too.
  const d = TOOLS.find((t) => t.name === "fabapp_write_definition").description;
  assert.match(d, /CLOSED list/);
  assert.match(d, /no 'select' \(use enum\)/);
  assert.match(d, /autonumber/);
});

test("the read tools are never the write tools", () => {
  const leitura = new Set(toolsFor("read").map((t) => t.name));
  const escrita = toolsFor("read write").filter((t) => t.scope === "write").map((t) => t.name);
  for (const w of escrita) assert.ok(!leitura.has(w), `${w} leaked into the read set`);
});
