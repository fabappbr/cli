/**
 * Fabapp's MCP server, over stdio.
 *
 * Line-delimited JSON-RPC 2.0, hand-written because the CLI has no dependencies and the protocol fits in one file.
 * The client is what starts the process (Claude Code, the desktop app); the credential is the SAME one `fabapp
 * login` put in the keychain — this server never asks for a secret and never shows one.
 *
 * ⚠️ NOTHING BUT JSON-RPC GOES TO STDOUT. One debugging `console.log` in the middle corrupts the stream and the
 * client disconnects with a parse error that points nowhere near the cause. Logging is stderr, always.
 */
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import { findTool, toolsFor } from "./tools.mjs";

// Protocol versions this server understands. We echo the client's when we know it — an old client talking to a
// new server is the common case, and negotiating down is what keeps the two working.
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// READ, not repeated. A hand-written copy here reported 0.1.0 for the whole life of 0.1.1 — and the version an
// MCP client shows is the one a bug report names, so it would have pointed at the release that never had the bug.
const VERSION = createRequire(import.meta.url)("../../package.json").version;

function reply(write, id, result) {
  write(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function fail(write, id, code, message, data) {
  write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }));
}

/** A tool's result, in the shape MCP expects. `isError` lets the model see the failure and react to it. */
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
        serverInfo: { name: "fabapp", version: VERSION },
        // Said at the opening because it decides what the model can plan: with a read-only token half the tools
        // do not exist, and it is better it knows that before assembling a plan that cannot run.
        //
        // And it points at `fabapp_docs` in the same breath. An agent arriving here knows nothing about this
        // platform — not the field types, which are a closed list, not the access grammar, which is the only thing
        // between an app's data and the public. Everything it needs is published, but nothing was telling it so,
        // and an agent that guesses writes a schema the server refuses and reads that as the platform being broken.
        instructions: `Account ${creds?.account_id || "?"} · scope: ${scopes}.`
          + " Call `fabapp_docs` FIRST: the field types are a closed list and the access rules decide who can read"
          + " an app's data. Then `fabapp_read_definition` for the project you are working on."
          + (scopes.includes("write") ? "" : " Read-only: no write tool is available."),
      };
    },

    "tools/list": () => ({
      tools: toolsFor(scopes).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }),

    async "tools/call"(params) {
      const tool = findTool(params?.name, scopes);
      if (!tool) {
        // The distinction matters to the model: on "does not exist" it stops trying; on "your token lacks it"
        // it asks the person for the right authorisation instead of rewording arguments until it gives up.
        const known = toolsFor("read write").some((t) => t.name === params?.name);
        return content(known
          ? `The tool '${params.name}' needs the write scope, and this token only has '${scopes}'. `
            + "Authorise again with `fabapp login --scopes \"read write\"`."
          : `Unknown tool: ${params?.name}`, true);
      }
      try {
        return content(await tool.run({ host, token, creds }, params?.arguments || {}));
      } catch (e) {
        // A tool failure becomes a RESULT with isError, not a protocol error: that way the model reads the
        // message ("invalid access rule at message.access") and corrects it, instead of watching the link die.
        return content(`${e.status ? `HTTP ${e.status}: ` : ""}${e.message}`, true);
      }
    },
  };

  return async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(write, null, -32700, "invalid JSON"); }
    // A notification (no `id`) gets no reply — answering one breaks strict clients.
    const isNotification = msg.id === undefined || msg.id === null;
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "exit") return exit(0);

    const fn = handlers[msg.method];
    if (!fn) {
      if (isNotification) return;
      return fail(write, msg.id, -32601, `unsupported method: ${msg.method}`);
    }
    try {
      const result = await fn(msg.params);
      if (!isNotification) reply(write, msg.id, result);
    } catch (e) {
      log(`[fabapp-mcp] ${msg.method} failed: ${e.message}`);
      if (!isNotification) fail(write, msg.id, -32603, e.message);
    }
  };
}

/**
 * Starts the server reading stdin and writing stdout. One line per message.
 *
 * In-flight replies are AWAITED on close. Without that, the end of stdin ended the process while a tool call was
 * still mid HTTP request — and the reply simply never came out. A real client keeps stdin open, so the defect only
 * shows up when somebody feeds the server through a pipe, which is exactly how it gets tested and debugged.
 */
export function serve({ host, creds }) {
  const write = (s) => process.stdout.write(s + "\n");
  const handle = createServer({ host, creds, write, exit: (c) => process.exit(c) });
  log(`[fabapp-mcp] ready · account ${creds?.account_id} · scope ${creds?.scope}`);

  const inFlight = new Set();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const p = Promise.resolve(handle(line)).finally(() => inFlight.delete(p));
    inFlight.add(p);
  });
  return new Promise((resolve) => {
    rl.on("close", async () => {
      // `allSettled` and not `all`: a tool that failed has already answered with `isError`, and letting it take
      // the shutdown down with it would lose the other replies.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      resolve(0);
    });
  });
}
