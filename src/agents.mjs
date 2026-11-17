/**
 * Fabapp Agents: the account's AI agents (the API calls them `operators`), over the control-plane.
 *
 * One module for both doors, the `fabapp agents` command and the MCP tools, so the two cannot drift: what an agent
 * is, how a name becomes an id, how "wait for the answer" ends. Printing lives in `commands/agents.mjs`.
 *
 * An agent belongs to an ACCOUNT, not to a project. It reaches an app only through a grant (`read` or `write`), and
 * it acts only when something wakes it: a message, a manual run, a schedule or a change in an app's data. When it
 * reaches an action that cannot be undone (an e-mail sent, a record deleted) the run PAUSES for an approval, and the
 * approval is given in the Studio, by a person. Neither this module nor the MCP tools can approve: the API refuses a
 * CLI token on those routes, on purpose, so an agent in a terminal can never approve its own requests.
 */
import { request } from "./api.mjs";

export const PAGE = 50;                                   // the API's default page (`listing.PAGE`)
export const ACCESS = ["read", "write"];
export const EVERY = ["hourly", "daily", "weekdays", "days"];
export const DATA_EVENTS = ["created", "updated", "deleted", "any"];
/** Statuses after which a run never changes again (`service.TERMINAL_STATUSES`). */
export const TERMINAL = new Set(["done", "error", "canceled", "expired"]);
export const PAUSED_FOR_APPROVAL = "awaiting_approval";

const enc = encodeURIComponent;
const base = (accountId) => `/accounts/${enc(accountId)}/operators`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The shape of an agent's id (a UUID). */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a person opens this agent in the Studio: approvals, connections and everything the CLI leaves to a human.
 * `FABAPP_STUDIO_URL` wins; otherwise the API host's `api.` becomes `app.` (api.fabapp.ai → app.fabapp.ai), and a
 * host with no `api.` in it (a local one) falls back to production's Studio, which is only a guess and says so by
 * being overridable.
 */
export function studioUrl(host, agentId) {
  const fromEnv = process.env.FABAPP_STUDIO_URL;
  let root = fromEnv || "https://app.fabapp.ai";
  if (!fromEnv) {
    try {
      const u = new URL(host);
      if (u.hostname.startsWith("api.")) root = `${u.protocol}//app.${u.hostname.slice(4)}`;
    } catch { /* keep the default */ }
  }
  return `${root.replace(/\/$/, "")}/agents${agentId ? `/${enc(agentId)}` : ""}`;
}

// ── agents ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One page of the account's agents: `{items, total, limit, offset}` (+ `states` on the first page). */
export function listAgents({ host, token, accountId, q = "", project = "", state = "", sort = "",
                             limit = PAGE, offset = 0 }) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) qs.set("q", q);
  if (project) qs.set("project", project);
  if (state) qs.set("state", state);
  if (sort) qs.set("sort", sort);
  return request(host, `${base(accountId)}?${qs}`, { token });
}

export function getAgent({ host, token, accountId, agentId }) {
  return request(host, `${base(accountId)}/${enc(agentId)}`, { token });
}

/**
 * What a person types (an id, or a name) → the agent's id, refusing anything ambiguous instead of guessing. The name
 * is searched with the list's own `q`, one page: an account with more than a page of agents that share a word in
 * their names is asked for the id.
 */
export async function resolveAgent({ host, token, accountId, wanted, exact: exactOnly = false }) {
  const raw = String(wanted || "").trim();
  if (!raw) throw new Error("name the agent: its id or its name (`fabapp agents list` shows both)");
  // The search reads names, not ids: an id goes straight to the agent.
  const asId = async () => {
    try {
      return (await getAgent({ host, token, accountId, agentId: raw })).id;
    } catch (e) {
      if (e.status === 404 || e.status === 422) return null;
      throw e;
    }
  };
  // Something shaped like an id is tried as one FIRST: one request instead of a name search that cannot find it,
  // and an id can never lose to another agent whose name happens to contain it.
  const idShaped = ID_SHAPE.test(raw);
  if (idShaped) {
    const id = await asId();
    if (id) return id;
  }
  const page = await listAgents({ host, token, accountId, q: raw, limit: PAGE });
  const items = page.items || [];
  const byId = items.find((a) => a.id === raw);
  if (byId) return byId.id;
  const needle = raw.toLowerCase();
  const exact = items.filter((a) => (a.name || "").toLowerCase() === needle);
  if (exact.length === 1) return exact[0].id;
  const partial = items.filter((a) => (a.name || "").toLowerCase().includes(needle));
  const named = (list) => list.map((a) => `${a.name} (${a.id})`).join(", ");
  if (exact.length > 1) throw new Error(`more than one agent matches '${raw}', use the id: ${named(exact)}`);
  if (exactOnly && partial.length) {
    // `exact` is what a permanent action asks for: part of a name is not enough to pick what gets deleted.
    throw new Error(`no agent is named exactly '${raw}'; use the id or the full name: ${named(partial)}`);
  }
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) throw new Error(`more than one agent matches '${raw}', use the id: ${named(partial)}`);
  const id = idShaped ? null : await asId();
  if (id) return id;
  throw new Error(`no agent matches '${raw}' in this account`);
}

export function createAgent({ host, token, accountId, name, summary, instructions, model, enabled = true }) {
  if (!String(name || "").trim()) throw new Error("give the agent a name");
  const body = { name: String(name).trim(), enabled: Boolean(enabled) };
  if (summary) body.summary = summary;
  if (instructions) body.instructions = instructions;
  if (model) body.model = model;
  return request(host, base(accountId), { method: "POST", token, body });
}

/** Only the fields that were given travel: the API applies a PATCH-like PUT, and an absent key is left alone. */
const EDITABLE = ["name", "summary", "instructions", "model", "enabled", "step_budget", "credit_cap", "deliver_email"];
export function updateAgent({ host, token, accountId, agentId, patch }) {
  const body = Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined));
  if (!Object.keys(body).length) throw new Error(`nothing to change: give at least one of ${EDITABLE.join(", ")}`);
  return request(host, `${base(accountId)}/${enc(agentId)}`, { method: "PUT", token, body });
}

export function deleteAgent({ host, token, accountId, agentId }) {
  return request(host, `${base(accountId)}/${enc(agentId)}`, { method: "DELETE", token });
}

/** A draft from one sentence. It SAVES nothing and grants nothing; it costs one small AI call. */
export function proposeAgent({ host, token, accountId, description }) {
  if (!String(description || "").trim()) throw new Error("describe what the agent should do, in one sentence");
  return request(host, `${base(accountId)}/propose`, { method: "POST", token, body: { description } });
}

/** The models an agent of this account can run on. Bounded by the curated catalog, so the API does not page it. */
export function modelOptions({ host, token, accountId }) {
  return request(host, `${base(accountId)}/model-options`, { token });
}

/** A page of the account's apps an agent can be given (`scope`: all | granted | ungranted, with `agentId`). */
export function appOptions({ host, token, accountId, q = "", scope = "all", agentId = "", limit = 20, offset = 0 }) {
  const qs = new URLSearchParams({ q, scope, limit: String(limit), offset: String(offset) });
  if (agentId) qs.set("operator_id", agentId);
  return request(host, `${base(accountId)}/app-options?${qs}`, { token });
}

/**
 * An app (a project) by id or name → its id. An agent reaches only apps of ITS OWN account, so the search is the
 * account's app picker, and a project of another account (a client's, for an agency) is simply not found here.
 */
export async function resolveApp({ host, token, accountId, wanted }) {
  const raw = String(wanted || "").trim();
  if (!raw) throw new Error("name the app: `--app <project-id>`, or run this inside a linked folder");
  const byId = await request(host, `${base(accountId)}/app-options?${new URLSearchParams({ ids: raw, limit: "1" })}`,
                             { token });
  if ((byId.items || []).length) return byId.items[0];
  const page = await appOptions({ host, token, accountId, q: raw, limit: 50 });
  const items = page.items || [];
  const needle = raw.toLowerCase();
  const exact = items.filter((a) => (a.name || "").toLowerCase() === needle || a.slug === raw);
  if (exact.length === 1) return exact[0];
  if (!exact.length && items.length === 1) return items[0];
  if (items.length > 1) {
    throw new Error(`more than one app matches '${raw}', use the id: ${items.map((a) => `${a.name} (${a.id})`).join(", ")}`);
  }
  throw new Error(`no app '${raw}' in this account. An agent reaches only the apps of its own account`
    + " (`fabapp agents apps` lists them).");
}

// ── grants ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function listGrants({ host, token, accountId, agentId, limit = PAGE, offset = 0 }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/grants?limit=${limit}&offset=${offset}`, { token });
}

/** Gives the agent access to one app's data. Re-granting the same app changes its level; it never duplicates. */
export function grantApp({ host, token, accountId, agentId, projectId, access = "read" }) {
  if (!ACCESS.includes(access)) throw new Error(`access is ${ACCESS.join(" or ")}, not '${access}'`);
  return request(host, `${base(accountId)}/${enc(agentId)}/grants`, {
    method: "PUT", token, body: { resource_kind: "project", resource_id: projectId, access },
  });
}

/** Removes the agent's access to one app. Walks the grant pages, since one agent may hold many. */
export async function revokeApp({ host, token, accountId, agentId, projectId }) {
  for (let offset = 0; ; offset += PAGE) {
    const page = await listGrants({ host, token, accountId, agentId, offset });
    const hit = (page.items || []).find((g) => g.resource_kind === "project" && g.resource_id === projectId);
    if (hit) {
      await request(host, `${base(accountId)}/${enc(agentId)}/grants/${enc(hit.id)}`, { method: "DELETE", token });
      return hit;
    }
    if (offset + PAGE >= (page.total ?? 0)) return null;
  }
}

// ── triggers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function listTriggers({ host, token, accountId, agentId, limit = PAGE, offset = 0 }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/triggers?limit=${limit}&offset=${offset}`, { token });
}

/**
 * A schedule's config, checked here so a typo fails before the request: `every` hourly|daily|weekdays|days, `at`
 * HH:MM for all but hourly, `days` ISO weekdays (1 = Monday … 7 = Sunday) for `days`, and an optional IANA `tz`
 * (the server defaults to America/Sao_Paulo).
 */
export function scheduleConfig({ every, at, days, tz }) {
  if (!EVERY.includes(every)) throw new Error(`--every is one of ${EVERY.join(", ")}`);
  const config = { every };
  const givenDays = Array.isArray(days) ? days.length > 0 : String(days ?? "").trim() !== "";
  if (givenDays && every !== "days") {
    // Silently dropping the list would save "every day" for somebody who asked for Mondays and Thursdays.
    throw new Error(`--days goes with --every days, not with '${every}'`);
  }
  if (every !== "hourly") {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(at || ""))) throw new Error("--at HH:MM is required (e.g. 09:00)");
    config.at = at;
  }
  if (every === "days") {
    const list = (Array.isArray(days) ? days : String(days || "").split(",")).map((d) => Number(String(d).trim()));
    if (!list.length || list.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error("--days is a list of ISO weekdays, 1 = Monday … 7 = Sunday (e.g. 1,4)");
    }
    config.days = [...new Set(list)];
  }
  if (tz) config.tz = tz;
  return config;
}

/**
 * Adds a trigger: `schedule` (a clock) or `data` (a change in one table of an app the agent can READ). Webhook
 * triggers are left to the Studio: their secret is shown once, and a terminal or a model's context is the wrong
 * place for it.
 */
export function addTrigger({ host, token, accountId, agentId, kind = "schedule", config, input = "", enabled = true }) {
  if (!["schedule", "data"].includes(kind)) {
    throw new Error("a trigger here is a schedule or a data change; webhook triggers are created in the Studio");
  }
  if (kind === "data") {
    if (!config?.project || !config?.model) throw new Error("a data trigger needs the app and the table (model id)");
    if (!DATA_EVENTS.includes(config.event)) throw new Error(`the event is one of ${DATA_EVENTS.join(", ")}`);
  }
  return request(host, `${base(accountId)}/${enc(agentId)}/triggers`, {
    method: "POST", token, body: { kind, config, input, enabled },
  });
}

export function setTriggerEnabled({ host, token, accountId, agentId, triggerId, enabled }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/triggers/${enc(triggerId)}`, {
    method: "PUT", token, body: { enabled: Boolean(enabled) },
  });
}

export function removeTrigger({ host, token, accountId, agentId, triggerId }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/triggers/${enc(triggerId)}`, { method: "DELETE", token });
}

// ── runs and chat ─────────────────────────────────────────────────────────────────────────────────────────────────

export function listRuns({ host, token, accountId, agentId, limit = PAGE, offset = 0 }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/runs?limit=${limit}&offset=${offset}`, { token });
}

/** The run plus its steps after `after` (a page; `steps_more` says there is another) and its pending approvals. */
export function getRun({ host, token, accountId, agentId, runId, after = 0, limit = 100 }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/runs/${enc(runId)}?after=${after}&limit=${limit}`, { token });
}

export function cancelRun({ host, token, accountId, agentId, runId }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/runs/${enc(runId)}/cancel`, { method: "POST", token });
}

/** Runs the agent now, with an optional instruction for this run. Answers the run in the state it reached. */
export function startRun({ host, token, accountId, agentId, input = "" }) {
  return request(host, `${base(accountId)}/${enc(agentId)}/runs`, {
    method: "POST", token, body: { input, origin: "manual" },
  });
}

/**
 * Sends a chat message. Answers `{queued: false, run}` when the message started a run, or `{queued: true,
 * active_run}` when the agent was busy: the message waits and is read when the current run ends.
 */
export function sendMessage({ host, token, accountId, agentId, text }) {
  if (!String(text || "").trim()) throw new Error("the message is empty");
  return request(host, `${base(accountId)}/${enc(agentId)}/messages`, { method: "POST", token, body: { text } });
}

/** The newest page of the chat thread (`before` = the oldest seq already seen, for the page before it). */
export function thread({ host, token, accountId, agentId, limit = 30, before }) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (before) qs.set("before", String(before));
  return request(host, `${base(accountId)}/${enc(agentId)}/messages?${qs}`, { token });
}

/**
 * Follows a run until it ENDS, PAUSES for an approval, or `timeoutMs` passes, whichever comes first. `onStep` gets
 * each new step once, in order. Answers `{run, steps, approvals, outcome}` with `outcome` one of `done`, `error`,
 * `canceled`, `expired`, `awaiting_approval` or `timeout` (the run goes on without us; nothing was cancelled).
 */
export async function waitForRun({ host, token, accountId, agentId, run, timeoutMs = 600_000, intervalMs = 2000,
                                   onStep = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  const steps = [];
  let current = run;
  for (;;) {
    const detail = await getRun({ host, token, accountId, agentId, runId: current.id, after });
    const before = after;
    for (const s of detail.steps || []) { steps.push(s); onStep(s); after = Math.max(after, s.seq || 0); }
    current = detail;
    const approvals = detail.approvals || (detail.approval ? [detail.approval] : []);
    // Drain the steps before deciding anything. Only while the cursor moves: a page that says "more" without
    // advancing it would otherwise be asked for again forever, with no pause and no deadline.
    if (detail.steps_more && after > before) continue;
    if (TERMINAL.has(detail.status)) return { run: detail, steps, approvals, outcome: detail.status };
    if (detail.status === PAUSED_FOR_APPROVAL) return { run: detail, steps, approvals, outcome: PAUSED_FOR_APPROVAL };
    if (Date.now() >= deadline) return { run: detail, steps, approvals, outcome: "timeout" };
    await sleep(intervalMs);
  }
}

/** A run reduced to what a caller reads: the answer, why it stopped, and what it is waiting for. */
export function summarize({ host, agentId, run, approvals = [], outcome }) {
  const out = {
    run_id: run.id, status: run.status, outcome: outcome || run.status, result: run.result || "",
    error: run.error || null, reason_code: run.reason_code || null, steps_done: run.steps_done,
    credits: run.credits,
  };
  if (approvals.length) {
    out.waiting_for_approval = approvals.map((a) => ({ id: a.id, action: a.action, label: a.label }));
  }
  if (outcome === PAUSED_FOR_APPROVAL || approvals.length) {
    out.approve_in_studio = studioUrl(host, agentId);
    out.note = "The run is paused until a person approves or declines in the Studio. It cannot be approved from "
      + "the CLI or MCP.";
  }
  if (outcome === "timeout") {
    out.note = "Still working. Nothing was cancelled: read it later with the run id.";
  }
  if (run.incomplete) out.incomplete = true;
  return out;
}
