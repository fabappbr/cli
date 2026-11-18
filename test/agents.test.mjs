/**
 * `fabapp agents` and the agent MCP tools, against a server that answers like the control-plane.
 *
 * The tests that matter most are about what must NOT happen: a run paused for approval must end the wait with the
 * Studio link and never touch an approval route; a read-only token must not reach a write; `delete` without `--yes`
 * must not send the DELETE; a name that matches two agents must not pick one.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as A from "../src/agents.mjs";
import { write } from "../src/config.mjs";
import { agents, parseArgs } from "../src/commands/agents.mjs";
import { createServer as mcpServer } from "../src/mcp/server.mjs";
import { AGENT_TOOLS } from "../src/mcp/agent-tools.mjs";
import { toolsFor } from "../src/mcp/tools.mjs";

const quiet = () => {};
const ACC = "acc-1";
const BASE = `/accounts/${ACC}/operators`;

/** Same pattern as cli.test.mjs: closed through `t.after`, so a failing assertion cannot hang the run. */
async function server(t, handler) {
  const calls = [];
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
    const answer = handler({ method: req.method, path: url.pathname, query: url.searchParams, body }) || {};
    res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    res.end(answer.status === 204 ? undefined : JSON.stringify(answer.body ?? {}));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  return { host: `http://localhost:${srv.address().port}`, calls };
}

const AGENT = { id: "op-1", name: "Triagem", enabled: true, instructions: "Leia.", step_budget: 12 };
/** A list answer: `q` filters the names, the way the API's search does. */
const list = (items) => ({ query }) => {
  const q = (query.get("q") || "").toLowerCase();
  const hits = items.filter((a) => a.name.toLowerCase().includes(q));
  return { body: { items: hits, total: hits.length, limit: 50, offset: Number(query.get("offset") || 0) } };
};

async function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fab-agents-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try { return await fn(dir); } finally { process.chdir(cwd); }
}

// ---- parsing ----------------------------------------------------------------------------------------------------

test("value flags take the next word, switches do not", () => {
  const { positional, flags } = parseArgs(["Triagem", "--access", "write", "--yes", "--app", "p1"]);
  assert.deepEqual(positional, ["Triagem"]);
  assert.deepEqual(flags, { access: "write", yes: true, app: "p1" });
  assert.throws(() => parseArgs(["--app"]), /needs a value/);
});

test("an unknown flag is refused, so its value never becomes part of a name or a message", () => {
  assert.throws(() => parseArgs(["Bot", "--instruction", "Do X"]), /unknown option --instruction/);
  assert.deepEqual(parseArgs(["Bot", "--", "--not", "a flag"]).positional, ["Bot", "--not", "a flag"]);
});

test("update refuses a limit that is not a number, before the request", async (t) => {
  const s = await server(t, list([AGENT]));
  for (const bad of [["--steps", "abc"], ["--steps", "0"], ["--credit-cap", "lots"]]) {
    await assert.rejects(() => agents({ host: s.host, token: "t", accountId: ACC, args: ["update", "Triagem", ...bad],
                                        log: quiet }), /number/);
  }
  assert.ok(!s.calls.some((c) => c.method === "PUT"), "a NaN reached the server, where it resets the field");
});

// ---- resolving an agent ---------------------------------------------------------------------------------------

test("a name resolves to the agent's id, and two matches are refused instead of guessed", async (t) => {
  const s = await server(t, list([AGENT, { id: "op-2", name: "Triagem de leads" }, { id: "op-3", name: "Triagem de leads" }]));
  assert.equal(await A.resolveAgent({ host: s.host, token: "t", accountId: ACC, wanted: "triagem" }), "op-1");
  await assert.rejects(() => A.resolveAgent({ host: s.host, token: "t", accountId: ACC, wanted: "Triagem de leads" }),
                       /more than one agent matches/);
});

test("an unknown agent says so in one line", async (t) => {
  const s = await server(t, ({ path }) => path === BASE ? list([])({ query: new URLSearchParams() })
                                                        : { status: 404, body: { detail: "Agente não encontrado" } });
  await assert.rejects(() => A.resolveAgent({ host: s.host, token: "t", accountId: ACC, wanted: "nada" }),
                       /no agent matches 'nada'/);
});

// ---- scope and destructive steps --------------------------------------------------------------------------------

test("a read-only token is stopped BEFORE any write reaches the server", async (t) => {
  const s = await server(t, list([AGENT]));
  for (const args of [["create", "X"], ["delete", "Triagem", "--yes"], ["ask", "Triagem", "oi"], ["grant", "Triagem"]]) {
    await assert.rejects(() => agents({ host: s.host, token: "t", accountId: ACC, scope: "read", args, log: quiet }),
                         /read-only/);
  }
  assert.equal(s.calls.length, 0);
});

test("delete without --yes sends no DELETE", async (t) => {
  const s = await server(t, ({ path }) => path === BASE ? list([AGENT])({ query: new URLSearchParams() } )
                                                        : { body: AGENT });
  const lines = [];
  const code = await agents({ host: s.host, token: "t", accountId: ACC, args: ["delete", "Triagem"],
                              log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.ok(!s.calls.some((c) => c.method === "DELETE"), "deleted without --yes");
  assert.match(lines.join("\n"), /cannot be undone/);
});

test("delete takes the id or the full name, never part of a name", async (t) => {
  const s = await server(t, list([{ id: "op-7", name: "Weekly report" }]));
  await assert.rejects(() => agents({ host: s.host, token: "t", accountId: ACC, args: ["delete", "report", "--yes"],
                                      log: quiet }), /named exactly 'report'.*Weekly report \(op-7\)/);
  assert.ok(!s.calls.some((c) => c.method === "DELETE"), "deleted an agent picked by part of its name");
  assert.equal(await A.resolveAgent({ host: s.host, token: "t", accountId: ACC, wanted: "report" }), "op-7");
});

test("something shaped like an id goes straight to the agent, without a name search", async (t) => {
  const id = "0b9f3a52-6c1d-4e8a-9f27-3d5c1a7e4b60";
  const s = await server(t, ({ path }) => path === `${BASE}/${id}` ? { body: { id, name: "X" } } : list([])({ query: new URLSearchParams() }));
  assert.equal(await A.resolveAgent({ host: s.host, token: "t", accountId: ACC, wanted: id }), id);
  assert.equal(s.calls.length, 1);
});

// ---- grants -----------------------------------------------------------------------------------------------------

test("grant defaults to the app linked to this folder, at read", async (t) => {
  const s = await server(t, ({ path, method }) => {
    if (path === BASE) return list([AGENT])({ query: new URLSearchParams() });
    if (path === `${BASE}/app-options`) return { body: { items: [{ id: "proj-9", name: "Loja" }], total: 1 } };
    if (method === "PUT") return { body: { id: "g1" } };
    return { body: {} };
  });
  await inDir(async (dir) => {
    write(dir, { host: s.host, project_id: "proj-9" });
    await agents({ host: s.host, token: "t", accountId: ACC, args: ["grant", "Triagem"], log: quiet });
  });
  const put = s.calls.find((c) => c.method === "PUT");
  assert.equal(put.path, `${BASE}/op-1/grants`);
  assert.deepEqual(put.body, { resource_kind: "project", resource_id: "proj-9", access: "read" });
});

test("grant refuses an access level that does not exist, before the request", async () => {
  assert.throws(() => A.grantApp({ host: "http://localhost:1", token: "t", accountId: ACC, agentId: "op-1",
                                   projectId: "p", access: "admin" }), /read or write/);
});

test("revoke walks the grant pages to find the app", async (t) => {
  const s = await server(t, ({ method, query }) => {
    if (method === "DELETE") return { status: 204 };
    const offset = Number(query.get("offset"));
    const items = offset === 0
      ? Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, resource_kind: "project", resource_id: `p${i}` }))
      : [{ id: "g-target", resource_kind: "project", resource_id: "proj-x" }];
    return { body: { items, total: 51, limit: 50, offset } };
  });
  const gone = await A.revokeApp({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", projectId: "proj-x" });
  assert.equal(gone.id, "g-target");
  assert.equal(s.calls.at(-1).path, `${BASE}/op-1/grants/g-target`);
});

// ---- triggers ---------------------------------------------------------------------------------------------------

test("a schedule is checked here, so a typo fails before the request", () => {
  assert.deepEqual(A.scheduleConfig({ every: "days", at: "09:30", days: "1,4,4" }),
                   { every: "days", at: "09:30", days: [1, 4] });
  assert.deepEqual(A.scheduleConfig({ every: "hourly" }), { every: "hourly" });
  assert.throws(() => A.scheduleConfig({ every: "daily" }), /--at HH:MM/);
  assert.throws(() => A.scheduleConfig({ every: "days", at: "09:00", days: "0,8" }), /ISO weekdays/);
  assert.throws(() => A.scheduleConfig({ every: "yearly", at: "09:00" }), /--every/);
  assert.throws(() => A.scheduleConfig({ every: "daily", at: "09:00", days: "1,4" }), /--every days/);
  assert.deepEqual(A.scheduleConfig({ every: "daily", at: "09:00", days: [] }), { every: "daily", at: "09:00" });
});

test("monthly, interval and once carry the field of their own shape, and only that one", () => {
  assert.deepEqual(A.scheduleConfig({ every: "monthly", at: "09:00", day: "31", tz: "Europe/Berlin" }),
                   { every: "monthly", at: "09:00", day: 31, tz: "Europe/Berlin" });
  assert.deepEqual(A.scheduleConfig({ every: "interval", minutes: "30" }), { every: "interval", minutes: 30 });
  assert.deepEqual(A.scheduleConfig({ every: "once", date: "2026-12-05", at: "15:00" }),
                   { every: "once", at: "15:00", date: "2026-12-05" });
  assert.throws(() => A.scheduleConfig({ every: "monthly", at: "09:00" }), /--day/);
  assert.throws(() => A.scheduleConfig({ every: "monthly", at: "09:00", day: 32 }), /--day/);
  for (const minutes of [10, 17, 1445, "abc"]) {
    assert.throws(() => A.scheduleConfig({ every: "interval", minutes }), /--minutes/);
  }
  assert.throws(() => A.scheduleConfig({ every: "interval", minutes: 30, at: "09:00" }), /--at does not go/);
  assert.throws(() => A.scheduleConfig({ every: "once", date: "2026-02-30", at: "09:00" }), /--date/);
  assert.throws(() => A.scheduleConfig({ every: "once", date: "05/12/2026", at: "09:00" }), /--date/);
  assert.throws(() => A.scheduleConfig({ every: "once", date: "2026-12-05" }), /--at HH:MM/);
  assert.throws(() => A.scheduleConfig({ every: "daily", at: "09:00", day: 5 }), /--day goes with --every monthly/);
  assert.throws(() => A.scheduleConfig({ every: "daily", at: "09:00", minutes: 30 }), /--minutes goes with --every interval/);
  assert.throws(() => A.scheduleConfig({ every: "monthly", at: "09:00", day: 5, date: "2026-12-05" }), /--date goes with --every once/);
});

test("a proposal carries the terminal's zone, so a one-off is dated where the person is", async (t) => {
  const s = await server(t, () => ({ body: { name: "x", schedule: null, resources: [] } }));
  await A.proposeAgent({ host: s.host, token: "t", accountId: ACC, description: "amanhã às 15h", tz: "Europe/Berlin" });
  assert.deepEqual(s.calls.at(-1).body, { description: "amanhã às 15h", tz: "Europe/Berlin" });
});

test("webhook triggers are left to the Studio: their secret does not belong in a terminal", () => {
  assert.throws(() => A.addTrigger({ host: "http://localhost:1", token: "t", accountId: ACC, agentId: "op-1",
                                     kind: "webhook", config: {} }), /Studio/);
});

// ---- talking to it ----------------------------------------------------------------------------------------------

test("ask stops at an approval with the Studio link, and never calls an approval route", async (t) => {
  const s = await server(t, ({ path, method }) => {
    if (path === BASE) return list([AGENT])({ query: new URLSearchParams() });
    if (method === "POST" && path.endsWith("/messages")) {
      return { status: 201, body: { queued: false, run: { id: "run-1", status: "queued" } } };
    }
    if (path === `${BASE}/op-1/runs/run-1`) {
      return { body: { id: "run-1", status: "awaiting_approval", steps: [{ seq: 1, title: "Read the orders" }],
                       steps_more: false,
                       approvals: [{ id: "ap-1", action: "email.send", label: "Send an e-mail to ana@x.com" }] } };
    }
    return { status: 404, body: { detail: "unexpected" } };
  });
  const lines = [];
  const prev = process.env.FABAPP_STUDIO_URL;
  process.env.FABAPP_STUDIO_URL = "https://studio.test";
  t.after(() => { if (prev === undefined) delete process.env.FABAPP_STUDIO_URL; else process.env.FABAPP_STUDIO_URL = prev; });

  const code = await agents({ host: s.host, token: "t", accountId: ACC, args: ["ask", "Triagem", "manda", "o", "resumo"],
                              log: (l) => lines.push(l) });
  const text = lines.join("\n");
  assert.equal(code, 0);
  assert.equal(s.calls.find((c) => c.method === "POST").body.text, "manda o resumo");
  assert.match(text, /Read the orders/);
  assert.match(text, /Send an e-mail to ana@x.com/);
  assert.match(text, /https:\/\/studio\.test\/agents\/op-1/);
  assert.ok(!s.calls.some((c) => c.path.includes("/approvals")), "the CLI touched an approval route");
});

test("a message to a busy agent is queued, and the CLI says so instead of waiting", async (t) => {
  const s = await server(t, ({ path }) => path === BASE ? list([AGENT])({ query: new URLSearchParams() })
    : { status: 201, body: { queued: true, active_run: { id: "run-0", status: "running" } } });
  const lines = [];
  await agents({ host: s.host, token: "t", accountId: ACC, args: ["ask", "Triagem", "oi"], log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /Queued.*run-0/);
  assert.equal(s.calls.length, 2, "it must not poll a run it did not start");
});

test("waiting follows a run to its end, each step reported once", async (t) => {
  let polls = 0;
  const s = await server(t, ({ query }) => {
    polls += 1;
    const after = Number(query.get("after"));
    if (polls === 1) return { body: { id: "r", status: "running", steps: [{ seq: 1, title: "a" }], steps_more: false } };
    return { body: { id: "r", status: "done", result: "pronto", steps: after < 2 ? [{ seq: 2, title: "b" }] : [],
                     steps_more: false } };
  });
  const seen = [];
  const out = await A.waitForRun({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", run: { id: "r" },
                                   intervalMs: 1, onStep: (st) => seen.push(st.seq) });
  assert.equal(out.outcome, "done");
  assert.equal(out.run.result, "pronto");
  assert.deepEqual(seen, [1, 2]);
  assert.equal(s.calls[1].query.get("after"), "1", "the second poll must ask only for the new steps");
});

test("a wait that runs out says timeout and cancels nothing", async (t) => {
  const s = await server(t, () => ({ body: { id: "r", status: "running", steps: [], steps_more: false } }));
  const out = await A.waitForRun({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", run: { id: "r" },
                                   timeoutMs: 0 });
  assert.equal(out.outcome, "timeout");
  assert.ok(!s.calls.some((c) => c.path.endsWith("/cancel")));
  assert.match(A.summarize({ host: s.host, agentId: "op-1", ...out }).note, /Nothing was cancelled/);
});

// ---- listing ----------------------------------------------------------------------------------------------------

test("list asks for the page it was given and says where the next one is", async (t) => {
  const s = await server(t, ({ query }) => ({ body: {
    items: [{ id: "op-51", name: "Fifty-one", enabled: true }], total: 120, limit: 50,
    offset: Number(query.get("offset")) } }));
  const lines = [];
  await agents({ host: s.host, token: "t", accountId: ACC, args: ["list", "--page", "2"], log: (l) => lines.push(l) });
  assert.equal(s.calls[0].query.get("offset"), "50");
  assert.equal(s.calls[0].query.get("limit"), "50");
  assert.match(lines.join("\n"), /51-51 of 120\. Next: --page 3/);
});

test("the Studio link follows the API host", () => {
  const prev = process.env.FABAPP_STUDIO_URL;
  delete process.env.FABAPP_STUDIO_URL;
  try {
    assert.equal(A.studioUrl("https://api.fabapp.ai", "op-1"), "https://app.fabapp.ai/agents/op-1");
    assert.equal(A.studioUrl("https://api.staging.fabapp.ai", "x"), "https://app.staging.fabapp.ai/agents/x");
  } finally { if (prev !== undefined) process.env.FABAPP_STUDIO_URL = prev; }
});

// ---- MCP --------------------------------------------------------------------------------------------------------

test("a read-only token sees the agent reads and none of the agent writes", () => {
  const names = toolsFor("read").map((x) => x.name);
  assert.ok(names.includes("fabapp_list_agents") && names.includes("fabapp_get_agent_run"));
  for (const w of ["fabapp_create_agent", "fabapp_delete_agent", "fabapp_ask_agent", "fabapp_run_agent",
                   "fabapp_grant_agent_app", "fabapp_add_agent_trigger"]) {
    assert.ok(!names.includes(w), `${w} leaked into the read set`);
  }
});

test("no MCP tool approves anything", () => {
  // The approval is the human step. A tool for it would let the model in this conversation approve what an agent
  // asked a person to approve, and the API refuses a CLI token there anyway.
  for (const x of toolsFor("read write")) assert.doesNotMatch(x.name, /approv/i, x.name);
});

test("the delete tool says it is destructive and refuses without confirm", async (t) => {
  const d = AGENT_TOOLS.find((x) => x.name === "fabapp_delete_agent");
  assert.match(d.description, /DESTRUCTIVE AND PERMANENT/);
  assert.deepEqual(d.inputSchema.required, ["agent_id", "confirm"]);

  const s = await server(t, () => ({ body: {} }));
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read write", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_delete_agent", arguments: { agent_id: "op-1", confirm: false } } }));
  assert.equal(out[0].result.isError, true);
  assert.equal(s.calls.length, 0, "it reached the server without confirm");
});

test("fabapp_ask_agent answers the run's outcome, with the Studio link when it paused", async (t) => {
  const s = await server(t, ({ path, method }) => {
    if (path === BASE) return list([AGENT])({ query: new URLSearchParams() });
    if (method === "POST") return { status: 201, body: { queued: false, run: { id: "run-1", status: "queued" } } };
    return { body: { id: "run-1", status: "awaiting_approval", steps: [], steps_more: false,
                     approvals: [{ id: "ap-1", action: "records.delete", label: "Delete 3 records" }] } };
  });
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read write", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_ask_agent", arguments: { agent_id: "op-1", message: "limpa", wait_seconds: 5 } } }));
  const r = JSON.parse(out[0].result.content[0].text);
  assert.equal(r.outcome, "awaiting_approval");
  assert.equal(r.waiting_for_approval[0].label, "Delete 3 records");
  assert.match(r.approve_in_studio, /\/agents\/op-1$/);
});

test("the schedule flags of the new shapes are value flags, not refused as unknown", async () => {
  const { parseArgs } = await import("../src/commands/agents.mjs");
  const { flags } = parseArgs(["schedule", "x", "--every", "monthly", "--day", "5", "--minutes", "30", "--date", "2026-12-05"]);
  assert.equal(flags.day, "5");
  assert.equal(flags.minutes, "30");
  assert.equal(flags.date, "2026-12-05");
});

// ---- the server as it is today ----------------------------------------------------------------------------------

test("the beta gate's bare 404 says the account does not have Agents yet, never 'server too old'", async (t) => {
  const s = await server(t, () => ({ status: 404, body: { detail: "Not Found" } }));
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read write", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_list_agents", arguments: {} } }));
  assert.equal(out[0].result.isError, true);
  const text = out[0].result.content[0].text;
  assert.match(text, /not enabled for this account yet: it is in beta/);
  assert.doesNotMatch(text, /update the platform|older|too old/i);
  // An agent the API cannot find names what is missing: that one is NOT the gate.
  assert.equal(A.notEnabled({ status: 404, body: { detail: "Agente não encontrado" } }), false);
  assert.equal(A.notEnabled({ status: 404, body: { detail: "Not Found" } }), true);
});

test("a 401 on an agent route is the token, and says to log in again without probing another route", async (t) => {
  const s = await server(t, () => ({ status: 401, body: { detail: "token do CLI inválido ou revogado" } }));
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read write", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_list_agents", arguments: {} } }));
  assert.match(out[0].result.content[0].text, /fabapp login/);
  assert.equal(s.calls.length, 1);
});

test("a data trigger is described from its names, not the API's schedule-only label", () => {
  const t = { kind: "data", label: "invalid schedule", config: { project: "p1", model: "orders", event: "created" },
              names: { app: "Loja", table: "Pedidos", table_missing: false } };
  assert.equal(A.describeTrigger(t), "when a Pedidos record is created in Loja");
  assert.match(A.describeTrigger({ ...t, names: undefined, project_removed: true }), /an app that was deleted/);
  assert.equal(A.describeTrigger({ kind: "webhook", label: "invalid schedule", config: {} }), "when its webhook is called");
  assert.equal(A.describeTrigger({ kind: "schedule", label: "Every 30 minutes", config: {} }), "Every 30 minutes");
});

test("a customer conversation's pause is the app user's, not an approval for the Studio", async (t) => {
  const s = await server(t, () => ({ body: { id: "r", status: "awaiting_approval", origin: "customer", steps: [],
    steps_more: false, approvals: [{ id: "a1", action: "records.update", label: "Change the booking", approver: "app_user" }] } }));
  const out = await A.waitForRun({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", run: { id: "r" } });
  assert.equal(out.outcome, "awaiting_customer");
  const sum = A.summarize({ host: s.host, agentId: "op-1", ...out });
  assert.equal(sum.approve_in_studio, undefined);
  assert.match(sum.note, /app's user/);
});

test("a run parked on another agent is waited through, and a timeout names who it waits for", async (t) => {
  let polls = 0;
  const s = await server(t, () => {
    polls += 1;
    return { body: polls === 1
      ? { id: "r", status: "awaiting_agent", steps: [], steps_more: false, waiting_on: { run_id: "r2", agent_id: "op-2", agent_name: "Finance" } }
      : { id: "r", status: "done", result: "ok", steps: [], steps_more: false } };
  });
  const out = await A.waitForRun({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", run: { id: "r" }, intervalMs: 1 });
  assert.equal(out.outcome, "done");
  const parked = A.summarize({ host: s.host, agentId: "op-1", outcome: "timeout",
    run: { id: "r", status: "awaiting_agent", waiting_on: { agent_name: "Finance" } } });
  assert.match(parked.note, /another agent \(Finance\)/);
});

// ---- found in review --------------------------------------------------------------------------------------------

test("a bad --timeout is refused before the run starts, not after it is already working", async (t) => {
  const s = await server(t, ({ path }) => path === BASE ? list([AGENT])({ query: new URLSearchParams() })
    : { status: 201, body: { id: "run-1", status: "queued" } });
  for (const args of [["run", "Triagem", "--timeout", "5m"], ["ask", "Triagem", "oi", "--timeout", "0"]]) {
    await assert.rejects(agents({ host: s.host, token: "t", accountId: ACC, args, log: quiet }), /--timeout/);
  }
  assert.ok(!s.calls.some((c) => c.method === "POST"), "the run or the message went out before the flag was read");
});

test("fabapp_get_agent_run sends nobody to the Studio for the app user's own confirmation", async (t) => {
  const card = { id: "a1", action: "records.update", label: "Change the booking" };
  let origin = "customer";
  const s = await server(t, ({ path }) => path === BASE ? list([AGENT])({ query: new URLSearchParams() })
    : { body: { id: "r", status: "awaiting_approval", origin, steps: [], steps_more: false,
                approvals: [{ ...card, approver: origin === "customer" ? "app_user" : "owner" }] } });
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  const read = () => handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fabapp_get_agent_run", arguments: { agent_id: "op-1", run_id: "r" } } }));
  await read();
  const customer = JSON.parse(out[0].result.content[0].text);
  assert.equal(customer.approve_in_studio, undefined);
  assert.match(customer.note, /app's user/);
  origin = "chat";
  await read();
  assert.match(JSON.parse(out[1].result.content[0].text).approve_in_studio, /\/agents\/op-1$/);
});

test("a null in an update is a field that was not given: it never pauses the agent or empties a field", async (t) => {
  const s = await server(t, () => ({ body: AGENT }));
  await A.updateAgent({ host: s.host, token: "t", accountId: ACC, agentId: "op-1",
                        patch: { name: "Novo", enabled: null, instructions: null, credit_cap: null, summary: "" } });
  assert.deepEqual(s.calls[0].body, { name: "Novo", summary: "" });
  assert.throws(() => A.updateAgent({ host: s.host, token: "t", accountId: ACC, agentId: "op-1", patch: { enabled: null } }),
                /nothing to change/);
});

test("a draft's data trigger reads like every other one, `any` included", async (t) => {
  const s = await server(t, () => ({ body: { name: "x", instructions: "y", resources: [], schedule: null,
    data_trigger: { app: "Loja", table: "Pedidos", config: { project: "p1", model: "orders", event: "any" } } } }));
  const lines = [];
  await agents({ host: s.host, token: "t", accountId: ACC, args: ["propose", "avise quando um pedido mudar"],
                 log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /when a Pedidos record is changed in Loja/);
});

test("a run that ran out of steps is not reported as a finished job", async () => {
  // The API's field is `incomplete_reason`; the run itself reads `done`.
  const sum = A.summarize({ host: "https://api.fabapp.ai", agentId: "op-1", outcome: "done",
    run: { id: "r", status: "done", result: "metade", incomplete_reason: "step_budget", steps_refused: 2 } });
  assert.equal(sum.incomplete, true);
  assert.equal(sum.incomplete_reason, "step_budget");
  const whole = A.summarize({ host: "https://api.fabapp.ai", agentId: "op-1", outcome: "done",
    run: { id: "r", status: "done", incomplete_reason: null } });
  assert.equal(whole.incomplete, undefined);
});

test("a read that fails in passing does not end the wait: the run goes on, and so does the follow", async (t) => {
  let polls = 0;
  const s = await server(t, () => {
    polls += 1;
    return polls === 1 ? { status: 502, body: { detail: "bad gateway" } }
                       : { body: { id: "r", status: "done", result: "ok", steps: [], steps_more: false } };
  });
  const ctx = { host: s.host, token: "t", accountId: ACC, agentId: "op-1", run: { id: "r" }, intervalMs: 1 };
  assert.equal((await A.waitForRun(ctx)).outcome, "done");
  // No time left (a plain read of one run): the failure is the answer. And a refusal is never asked again.
  polls = 0;
  await assert.rejects(A.waitForRun({ ...ctx, timeoutMs: 0 }), (e) => e.status === 502);
  const gone = await server(t, () => ({ status: 404, body: { detail: "execução não encontrada" } }));
  await assert.rejects(A.waitForRun({ ...ctx, host: gone.host }), (e) => e.status === 404);
  assert.equal(gone.calls.length, 1);
});

test("over MCP a failed wait names the run that was started, and a data trigger is not an 'invalid schedule'", async (t) => {
  const trigger = { id: "t1", kind: "data", label: "invalid schedule", enabled: true,
                    config: { project: "p1", model: "orders", event: "created" }, names: { app: "Loja", table: "Pedidos" } };
  const s = await server(t, ({ method, path }) => {
    if (path === BASE) return list([AGENT])({ query: new URLSearchParams() });
    if (path === `${BASE}/op-1`) return { body: AGENT };
    if (path.endsWith("/triggers")) return { body: { items: [trigger], total: 1, limit: 50, offset: 0 } };
    if (path.endsWith("/runs") && method === "POST") return { status: 201, body: { id: "run-9", status: "queued" } };
    if (path.endsWith("/runs/run-9")) return { status: 404, body: { detail: "execução não encontrada" } };
    return { body: { items: [], total: 0, limit: 50, offset: 0 } };
  });
  const out = [];
  const handle = mcpServer({ host: s.host, creds: { token: "t", scope: "read write", account_id: ACC },
                             write: (line) => out.push(JSON.parse(line)) });
  const call = (name, args) => handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args } }));
  await call("fabapp_get_agent", { agent_id: "op-1" });
  assert.equal(JSON.parse(out[0].result.content[0].text).triggers.items[0].label, "when a Pedidos record is created in Loja");
  await call("fabapp_run_agent", { agent_id: "op-1", wait_seconds: null });
  assert.equal(out[1].result.isError, true);
  assert.match(out[1].result.content[0].text, /Run run-9 was started.*do not start it again/);
});
