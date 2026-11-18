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
export const EVERY = ["hourly", "daily", "weekdays", "days", "monthly", "interval", "once"];
export const DATA_EVENTS = ["created", "updated", "deleted", "any"];
/** Statuses after which a run never changes again (`service.TERMINAL_STATUSES`). */
export const TERMINAL = new Set(["done", "error", "canceled", "expired"]);
export const PAUSED_FOR_APPROVAL = "awaiting_approval";
/**
 * A run of a customer conversation paused on the CUSTOMER's own confirmation card: the app's end user decides it in
 * the app (the card's `approver` is `app_user`), and the owner's Studio routes refuse it. Not a server status: the
 * same reading the API's agent list and the Studio make of `awaiting_approval` on a run whose `origin` is `customer`.
 */
export const AWAITING_CUSTOMER = "awaiting_customer";
/** Parked on another agent's run (`ask_agent`): still busy, and it resumes by itself when that run ends. */
export const AWAITING_AGENT = "awaiting_agent";

/**
 * The gate's answer. While Fabapp Agents is in beta, every agent route answers a plain 404 `{"detail": "Not Found"}`
 * (FastAPI's own, the answer an address that does not exist gets) to an account outside it. The API's own "not
 * found" answers on these routes all name what is missing ("Agente não encontrado", "gatilho não encontrado"), so the
 * bare one is the gate.
 */
export function notEnabled(e) {
  return e?.status === 404 && e?.body?.detail === "Not Found";
}
export const NOT_ENABLED = "Fabapp Agents is not enabled for this account yet: it is in beta.";

/**
 * The two refusals a person can act on, in one line each, or null for any other failure: the beta gate's bare 404,
 * and a 401, which on these routes is the token itself (unknown, revoked, or its owner suspended). One reading for
 * the command and the MCP tools, instead of "Not Found" or "token inválido".
 */
export function refusal(e, host) {
  if (notEnabled(e)) return NOT_ENABLED;
  if (e?.status === 401) return `the CLI token for ${host} is no longer valid: run \`fabapp login\` again`;
  return null;
}

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

/**
 * Only the fields that were given travel: the API applies a PATCH-like PUT, and an absent key is left alone. `null`
 * counts as not given: the server reads a present key, so a null (an MCP client filling in what it left out) would
 * pause the agent (`enabled`), empty its instructions or drop its credit cap.
 */
const EDITABLE = ["name", "summary", "instructions", "model", "enabled", "step_budget", "credit_cap", "deliver_email"];
export function updateAgent({ host, token, accountId, agentId, patch }) {
  const body = Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => EDITABLE.includes(k) && v != null));
  if (!Object.keys(body).length) throw new Error(`nothing to change: give at least one of ${EDITABLE.join(", ")}`);
  return request(host, `${base(accountId)}/${enc(agentId)}`, { method: "PUT", token, body });
}

export function deleteAgent({ host, token, accountId, agentId }) {
  return request(host, `${base(accountId)}/${enc(agentId)}`, { method: "DELETE", token });
}

/** The terminal's own IANA zone, sent with a proposal so "tomorrow at 3pm" is dated where the person is. */
export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** A draft from one sentence. It SAVES nothing and grants nothing; it costs one small AI call. */
export function proposeAgent({ host, token, accountId, description, tz = localZone() }) {
  if (!String(description || "").trim()) throw new Error("describe what the agent should do, in one sentence");
  return request(host, `${base(accountId)}/propose`, { method: "POST", token, body: { description, tz } });
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

/** `every: "interval"` bounds, the server's (`schedule.INTERVAL_*`): 15 to 1440 minutes, a multiple of 5. */
export const INTERVAL_MIN = 15;
export const INTERVAL_MAX = 1440;

/**
 * A schedule's config, checked here so a typo fails before the request:
 *   - `every` hourly|daily|weekdays|days|monthly|interval|once;
 *   - `at` HH:MM for all but hourly and interval;
 *   - `days` ISO weekdays (1 = Monday … 7 = Sunday) for `days`;
 *   - `day` 1-31 for `monthly` (a month without that day fires on its last day: the 31st is "the end of the month");
 *   - `minutes` for `interval`, a multiple of 5 from 15 to 1440;
 *   - `date` YYYY-MM-DD for `once`, which fires one time and then switches itself off (the server refuses a moment
 *     that already passed);
 *   - an optional IANA `tz` (the server defaults to America/Sao_Paulo).
 * A flag that belongs to another shape is refused rather than dropped: silently saving "every day" for somebody
 * who also typed `--day 5` would be a schedule they did not ask for.
 */
export function scheduleConfig({ every, at, days, tz, minutes, day, date }) {
  if (!EVERY.includes(every)) throw new Error(`--every is one of ${EVERY.join(", ")}`);
  const config = { every };
  const given = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== "");
  const owner = { days: "days", day: "monthly", minutes: "interval", date: "once" };
  for (const [flag, value] of Object.entries({ days, day, minutes, date })) {
    if (given(value) && every !== owner[flag]) {
      throw new Error(`--${flag} goes with --every ${owner[flag]}, not with '${every}'`);
    }
  }
  if (every !== "hourly" && every !== "interval") {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(at || ""))) throw new Error("--at HH:MM is required (e.g. 09:00)");
    config.at = at;
  } else if (given(at)) {
    throw new Error(`--at does not go with --every ${every}`);
  }
  if (every === "days") {
    const list = (Array.isArray(days) ? days : String(days || "").split(",")).map((d) => Number(String(d).trim()));
    if (!list.length || list.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error("--days is a list of ISO weekdays, 1 = Monday … 7 = Sunday (e.g. 1,4)");
    }
    config.days = [...new Set(list)];
  }
  if (every === "monthly") {
    const n = Number(String(day ?? "").trim());
    if (!given(day) || !Number.isInteger(n) || n < 1 || n > 31) {
      throw new Error("--day is the day of the month, 1 to 31 (29-31 fire on the last day of shorter months)");
    }
    config.day = n;
  }
  if (every === "interval") {
    const n = Number(String(minutes ?? "").trim());
    if (!given(minutes) || !Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX || n % 5 !== 0) {
      throw new Error(`--minutes is a multiple of 5 from ${INTERVAL_MIN} to ${INTERVAL_MAX} (e.g. 30; 120 = every 2 hours)`);
    }
    config.minutes = n;
  }
  if (every === "once") {
    const d = String(date ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const probe = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || probe.getUTCMonth() !== +m[2] - 1 || probe.getUTCDate() !== +m[3]) {
      throw new Error("--date is YYYY-MM-DD (e.g. 2026-12-05)");
    }
    config.date = d;
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

/** A failure of the request and not of the run: the server unreachable, a gateway's 5xx, a rate limit. */
const transient = (e) => e?.status === 0 || e?.status === 429 || e?.status >= 500;

/**
 * Follows a run until it ENDS, PAUSES for an approval, or `timeoutMs` passes, whichever comes first. `onStep` gets
 * each new step once, in order. Answers `{run, steps, approvals, outcome}` with `outcome` one of `done`, `error`,
 * `canceled`, `expired`, `awaiting_approval`, `awaiting_customer` or `timeout` (the run goes on without us; nothing
 * was cancelled). `queued`, `running` and `awaiting_agent` (parked on another agent's run) are waited through.
 *
 * A read that fails in passing (a 502 while the platform deploys, a dropped connection) is asked again until the
 * deadline: the run goes on in the server either way, and giving up on the first blip left the caller with an error
 * for a run that was working, and no answer to read.
 */
export async function waitForRun({ host, token, accountId, agentId, run, timeoutMs = 600_000, intervalMs = 2000,
                                   onStep = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  const steps = [];
  let current = run;
  for (;;) {
    let detail;
    try {
      detail = await getRun({ host, token, accountId, agentId, runId: current.id, after });
    } catch (e) {
      if (!transient(e) || Date.now() >= deadline) throw e;
      await sleep(intervalMs);
      continue;
    }
    const before = after;
    for (const s of detail.steps || []) { steps.push(s); onStep(s); after = Math.max(after, s.seq || 0); }
    current = detail;
    const approvals = detail.approvals || (detail.approval ? [detail.approval] : []);
    // Drain the steps before deciding anything. Only while the cursor moves: a page that says "more" without
    // advancing it would otherwise be asked for again forever, with no pause and no deadline.
    if (detail.steps_more && after > before) continue;
    if (TERMINAL.has(detail.status)) return { run: detail, steps, approvals, outcome: detail.status };
    if (detail.status === PAUSED_FOR_APPROVAL) {
      const outcome = awaitsCustomer(detail, approvals) ? AWAITING_CUSTOMER : PAUSED_FOR_APPROVAL;
      return { run: detail, steps, approvals, outcome };
    }
    if (Date.now() >= deadline) return { run: detail, steps, approvals, outcome: "timeout" };
    await sleep(intervalMs);
  }
}

/**
 * Whether a paused run waits for the app's end user (in the app) and not for the owner (in the Studio). The one
 * reading for every place that tells the two apart: the wait's outcome, the list's state and the run read over MCP.
 * A list row carries no cards, so there it is the run's `origin` alone.
 */
export function awaitsCustomer(run, approvals = []) {
  return run?.status === PAUSED_FOR_APPROVAL
    && (run.origin === "customer" || (approvals.length > 0 && approvals.every((a) => a.approver === "app_user")));
}
export const CUSTOMER_NOTE = "The run waits for the app's user to confirm in the app. Neither the Studio nor the "
  + "CLI decides it.";

/**
 * A trigger in one line, in English. The API's `label` describes SCHEDULES only (a data or webhook trigger gets
 * "invalid schedule" there), so a data trigger is told from its `names` (the app's and the table's names).
 */
export function describeTrigger(t) {
  if (t.kind === "data") {
    const c = t.config || {};
    const n = t.names || {};
    const where = t.project_removed ? "an app that was deleted" : (n.app || c.project);
    return `when a ${n.table || c.model} record is ${c.event === "any" ? "changed" : c.event} in ${where}`
      + (n.table_missing ? " (the table is no longer in the app)" : "");
  }
  if (t.kind === "webhook") return "when its webhook is called";
  return t.label || JSON.stringify(t.config || {});
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
  if (run.waiting_on) out.waiting_on = run.waiting_on;
  if (outcome === AWAITING_CUSTOMER) {
    out.note = CUSTOMER_NOTE;
  } else if (outcome === PAUSED_FOR_APPROVAL || approvals.length) {
    out.approve_in_studio = studioUrl(host, agentId);
    out.note = "The run is paused until a person approves or declines in the Studio. It cannot be approved from "
      + "the CLI or MCP.";
  }
  if (outcome === "timeout") {
    out.note = run.status === AWAITING_AGENT
      ? `Waiting for another agent${run.waiting_on?.agent_name ? ` (${run.waiting_on.agent_name})` : ""} to answer; it `
        + "goes on by itself. Nothing was cancelled: read it later with the run id."
      : "Still working. Nothing was cancelled: read it later with the run id.";
  }
  // The API's field is `incomplete_reason` (`step_budget`: part of the job did not fit the run's steps). A run that
  // ended like that reads `done`, so without this it is reported as a job finished.
  if (run.incomplete_reason) {
    out.incomplete = true;
    out.incomplete_reason = run.incomplete_reason;
  }
  return out;
}
