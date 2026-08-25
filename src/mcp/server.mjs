/**
 * O servidor MCP da Fabapp, sobre stdio.
 *
 * JSON-RPC 2.0 delimitado por linha, escrito à mão porque o CLI não tem dependências e o protocolo cabe num
 * arquivo. Quem sobe o processo é o cliente (Claude Code, o app de desktop); a credencial é a MESMA que o
 * `fabapp login` guardou no chaveiro — este servidor nunca pede nem mostra segredo.
 *
 * ⚠️ NADA VAI PARA O STDOUT ALÉM DE JSON-RPC. Um `console.log` de depuração no meio corrompe o fluxo e o cliente
 * desconecta com um erro de parse que não aponta para a causa. Log é stderr, sempre.
 */
import { createInterface } from "node:readline";

import { findTool, toolsFor } from "./tools.mjs";

// Versões do protocolo que este servidor entende. Ecoamos a do cliente quando conhecida — um cliente antigo
// falando com um servidor novo é o caso comum, e negociar para baixo é o que mantém os dois funcionando.
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

const log = (...a) => process.stderr.write(a.join(" ") + "\n");

function reply(write, id, result) {
  write(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function fail(write, id, code, message, data) {
  write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }));
}

/** O resultado de uma ferramenta, no formato que o MCP espera. `isError` deixa o modelo ver a falha e reagir. */
function content(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
           isError };
}

export function createServer({ host, creds, write, exit = () => {} }) {
  const scopes = creds?.scope || "read";
  const token = creds?.token;

  const handlers = {
    initialize(params) {
      const asked = params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fabapp", version: "0.1.0" },
        // Dito na abertura porque decide o que o modelo pode planejar: com um token só-leitura metade das
        // ferramentas não existe, e é melhor que ele saiba disso antes de montar um plano que não roda.
        instructions: `Conta ${creds?.account_id || "?"} · escopo: ${scopes}.`
          + (scopes.includes("write") ? "" : " Somente leitura: nenhuma ferramenta de escrita está disponível."),
      };
    },

    "tools/list": () => ({
      tools: toolsFor(scopes).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }),

    async "tools/call"(params) {
      const tool = findTool(params?.name, scopes);
      if (!tool) {
        // A distinção importa para o modelo: "não existe" ele para de tentar; "seu token não tem" ele pede a
        // autorização certa à pessoa em vez de reformular argumentos até desistir.
        const known = toolsFor("read write").some((t) => t.name === params?.name);
        return content(known
          ? `A ferramenta '${params.name}' precisa do escopo de escrita, e este token tem apenas '${scopes}'. `
            + "Autorize de novo com `fabapp login --scopes \"read write\"`."
          : `Ferramenta desconhecida: ${params?.name}`, true);
      }
      try {
        return content(await tool.run({ host, token, creds }, params?.arguments || {}));
      } catch (e) {
        // Falha de ferramenta vira RESULTADO com isError, e não erro de protocolo: assim o modelo lê a mensagem
        // ("regra de acesso inválida em message.access") e corrige, em vez de ver a conexão morrer.
        return content(`${e.status ? `HTTP ${e.status}: ` : ""}${e.message}`, true);
      }
    },
  };

  return async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(write, null, -32700, "JSON inválido"); }
    // Uma notificação (sem `id`) não recebe resposta — responder a uma quebra clientes estritos.
    const isNotification = msg.id === undefined || msg.id === null;
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "exit") return exit(0);

    const fn = handlers[msg.method];
    if (!fn) {
      if (isNotification) return;
      return fail(write, msg.id, -32601, `método não suportado: ${msg.method}`);
    }
    try {
      const result = await fn(msg.params);
      if (!isNotification) reply(write, msg.id, result);
    } catch (e) {
      log(`[fabapp-mcp] ${msg.method} falhou: ${e.message}`);
      if (!isNotification) fail(write, msg.id, -32603, e.message);
    }
  };
}

/**
 * Sobe o servidor lendo stdin e escrevendo stdout. Uma linha por mensagem.
 *
 * As respostas em voo são ESPERADAS no fechamento. Sem isso, o fim do stdin encerrava o processo enquanto uma
 * chamada de ferramenta ainda estava no meio da requisição HTTP — e a resposta simplesmente nunca saía. Um cliente
 * de verdade mantém o stdin aberto, então o defeito só aparece quando alguém alimenta o servidor por um pipe, que
 * é justamente como se testa e como se depura.
 */
export function serve({ host, creds }) {
  const write = (s) => process.stdout.write(s + "\n");
  const handle = createServer({ host, creds, write, exit: (c) => process.exit(c) });
  log(`[fabapp-mcp] pronto · conta ${creds?.account_id} · escopo ${creds?.scope}`);

  const inFlight = new Set();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const p = Promise.resolve(handle(line)).finally(() => inFlight.delete(p));
    inFlight.add(p);
  });
  return new Promise((resolve) => {
    rl.on("close", async () => {
      // `allSettled` e não `all`: uma ferramenta que falhou já respondeu com `isError`, e derrubar o
      // encerramento por causa dela perderia as respostas das outras.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      resolve(0);
    });
  });
}
