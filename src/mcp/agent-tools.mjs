/**
 * MCP tools for Fabapp Agents: the account's AI agents (the API calls them `operators`).
 *
 * The same calls as `fabapp agents`, through `../agents.mjs`. The descriptions carry the model of the feature,
 * because the model choosing a tool reads nothing else: an agent belongs to the ACCOUNT, reaches an app only through
 * a grant, works when a message, a run or a trigger wakes it, and PAUSES for a person's approval before anything
 * irreversible. There is no approve tool, and that is the point: the API refuses a CLI token on the approval routes,
 * so the model in this conversation can never approve what an agent asked a human to approve.
 */
import { request } from "../api.mjs";
import * as A from "../agents.mjs";

const ACCOUNT = { type: "string", description: "the account the agent belongs to; omitted = the authorised account "
  + "(a client account id from fabapp_list_projects' `accounts`, for an agency)" };
const AGENT = { type: "string", description: "the agent's id (from fabapp_list_agents), or its name" };
const PAGE = { type: "integer", minimum: 1, description: "page number, 1 first (50 per page)" };
const WAIT = { type: "integer", minimum: 0, maximum: 300,
  description: "seconds to wait for the run to end or pause (default 60, max 300). 0 = return at once" };

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const accountOf = (creds, args) => args.account_id || creds.account_id;

async function agentCtx({ host, token, creds }, args, { exact = false } = {}) {
  const accountId = accountOf(creds, args);
  const agentId = await A.resolveAgent({ host, token, accountId, wanted: args.agent_id, exact });
  return { host, token, accountId, agentId };
}

async function waitAndSummarize(ctx, run, waitSeconds) {
  const seconds = waitSeconds === undefined ? 60 : Math.min(300, Math.max(0, Number(waitSeconds) || 0));
  const out = await A.waitForRun({ ...ctx, run, timeoutMs: seconds * 1000 });
  return A.summarize({ host: ctx.host, agentId: ctx.agentId, ...out });
}

/** A 401 on an agent route is one of two things. A route the CLI token has always reached is asked: refused there
 *  too, the token is dead; accepted, it is a server older than the release that opened the agent routes. */
function explained(tool) {
  return { ...tool, run: async (c, args) => {
    try { return await tool.run(c, args); } catch (e) {
      if (e.status === 401) {
        const id = encodeURIComponent(c.creds?.account_id || "");
        const tokenDead = await request(c.host, `/projects/reachable/accounts?account_id=${id}&per_page=1`, { token: c.token })
          .then(() => false, (probe) => probe.status === 401);
        e.message = tokenDead
          ? "the CLI token is no longer valid: run `fabapp login` again"
          : "this server does not let a CLI token manage agents yet (401): use the Studio, or update the platform.";
      }
      throw e;
    }
  } };
}

export const AGENT_TOOLS = [
  {
    name: "fabapp_list_agents",
    scope: "read",
    description: "Lists the account's Fabapp Agents: AI agents that work on the account's apps on their own (answer "
      + "messages, run on a schedule, react when a table changes). One page of 50, with each agent's state, last run "
      + "and next scheduled run; `total` says how many there are. Filter with `q` (name), `project_id` (agents that "
      + "can reach that app) or `state`.",
    inputSchema: object({ account_id: ACCOUNT, q: { type: "string" }, project_id: { type: "string" },
      state: { type: "string", enum: ["waiting", "failed", "running", "active", "paused"],
      description: "waiting = its last run waits for an approval; failed = it ended in error" }, page: PAGE }),
    run: async ({ host, token, creds }, args) => {
      const page = args.page || 1;
      return A.listAgents({ host, token, accountId: accountOf(creds, args), q: args.q || "",
                            project: args.project_id || "", state: args.state || "", offset: (page - 1) * A.PAGE });
    },
  },
  {
    name: "fabapp_get_agent",
    scope: "read",
    description: "One agent in full: its instructions, model, limits, the apps and accounts it can reach (with the "
      + "EFFECTIVE access level), its triggers and its 5 latest runs, plus the Studio link where a person approves "
      + "its paused actions.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT }, ["agent_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const [agent, grants, triggers, runs] = await Promise.all([
        A.getAgent(ctx), A.listGrants(ctx), A.listTriggers(ctx), A.listRuns({ ...ctx, limit: 5 })]);
      return { agent, grants, triggers, recent_runs: runs, studio_url: A.studioUrl(c.host, ctx.agentId) };
    },
  },
  {
    name: "fabapp_list_agent_apps",
    scope: "read",
    description: "The apps (projects) of the account that an agent can be given access to, 20 per page. An agent "
      + "reaches only apps of its OWN account.",
    inputSchema: object({ account_id: ACCOUNT, q: { type: "string" }, page: PAGE }),
    run: ({ host, token, creds }, args) => A.appOptions({ host, token, accountId: accountOf(creds, args),
      q: args.q || "", limit: 20, offset: ((args.page || 1) - 1) * 20 }),
  },
  {
    name: "fabapp_list_agent_models",
    scope: "read",
    description: "The AI models an agent of this account can run on, with their relative cost and which is the "
      + "default. Use a `model` value from here in fabapp_create_agent / fabapp_update_agent.",
    inputSchema: object({ account_id: ACCOUNT }),
    run: ({ host, token, creds }, args) => A.modelOptions({ host, token, accountId: accountOf(creds, args) }),
  },
  {
    name: "fabapp_propose_agent",
    scope: "write",
    description: "Drafts an agent from one sentence (\"every Monday, summarise last week's orders\"): name, "
      + "instructions, the apps it should reach and a schedule or data trigger. It SAVES NOTHING and grants nothing; "
      + "it spends a small amount of AI credits. Show the draft to the person, then create it with "
      + "fabapp_create_agent + fabapp_grant_agent_app + fabapp_add_agent_trigger.",
    inputSchema: object({ account_id: ACCOUNT, description: { type: "string" } }, ["description"]),
    run: ({ host, token, creds }, args) => A.proposeAgent({ host, token, accountId: accountOf(creds, args),
                                                           description: args.description }),
  },
  {
    name: "fabapp_create_agent",
    scope: "write",
    description: "Creates an agent in the account. It reaches NOTHING until you grant it an app "
      + "(fabapp_grant_agent_app), and it works only when messaged, run, or woken by a trigger "
      + "(fabapp_add_agent_trigger). Write `instructions` as the agent's standing job description.",
    inputSchema: object({ account_id: ACCOUNT, name: { type: "string" }, instructions: { type: "string" },
      summary: { type: "string", description: "one line shown on the agent's card" },
      model: { type: "string", description: "from fabapp_list_agent_models; omitted = the default" },
      enabled: { type: "boolean", description: "false creates it paused (default true)" } }, ["name"]),
    run: ({ host, token, creds }, args) => A.createAgent({ host, token, accountId: accountOf(creds, args),
      name: args.name, summary: args.summary, instructions: args.instructions, model: args.model,
      enabled: args.enabled ?? true }),
  },
  {
    name: "fabapp_update_agent",
    scope: "write",
    description: "Changes an agent: name, summary, instructions, model, step budget per run, monthly credit cap, "
      + "whether unattended results are e-mailed, or `enabled` (false PAUSES it: no trigger fires and messages are "
      + "refused; true resumes it). Only the fields given change.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, name: { type: "string" },
      summary: { type: "string" }, instructions: { type: "string" }, model: { type: "string" },
      enabled: { type: "boolean" }, step_budget: { type: "integer", minimum: 1 },
      credit_cap: { type: "number", minimum: 0, description: "credits per month; 0 = no cap" },
      deliver_email: { type: "boolean" } }, ["agent_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const { account_id, agent_id, ...patch } = args;
      return A.updateAgent({ ...ctx, patch });
    },
  },
  {
    name: "fabapp_delete_agent",
    scope: "write",
    description: "DESTRUCTIVE AND PERMANENT: deletes the agent with all its runs, chat history, memory, triggers and "
      + "grants. Nothing can be recovered. Only call it when the person explicitly asked to delete this agent; to "
      + "stop it, prefer fabapp_update_agent with enabled=false. `confirm` must be true.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT,
      confirm: { type: "boolean", description: "must be true: the person asked for the deletion" } },
    ["agent_id", "confirm"]),
    run: async (c, args) => {
      if (args.confirm !== true) throw new Error("not deleted: `confirm` must be true, and only when the person asked");
      const ctx = await agentCtx(c, args, { exact: true });     // the id or the full name, never part of one
      const agent = await A.getAgent(ctx);
      await A.deleteAgent(ctx);
      return { deleted: true, id: agent.id, name: agent.name };
    },
  },
  {
    name: "fabapp_grant_agent_app",
    scope: "write",
    description: "Gives an agent access to one app's data (a project of the same account): `read` (default) or "
      + "`write` (create and change records). Granting again changes the level. Even with write, actions that "
      + "cannot be undone pause for a person's approval in the Studio. Connected accounts (Gmail, calendars) and MCP "
      + "servers are granted in the Studio, not here.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, project_id: { type: "string" },
      access: { type: "string", enum: A.ACCESS } }, ["agent_id", "project_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      return A.grantApp({ ...ctx, projectId: args.project_id, access: args.access || "read" });
    },
  },
  {
    name: "fabapp_revoke_agent_app",
    scope: "write",
    description: "Removes an agent's access to one app. Its data triggers on that app stop being able to fire.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, project_id: { type: "string" } },
                        ["agent_id", "project_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const gone = await A.revokeApp({ ...ctx, projectId: args.project_id });
      return { revoked: Boolean(gone), project_id: args.project_id };
    },
  },
  {
    name: "fabapp_add_agent_trigger",
    scope: "write",
    description: "Sets WHEN an agent works on its own. kind=schedule: `every` hourly|daily|weekdays|days, `at` HH:MM "
      + "(not for hourly), `days` ISO weekdays 1=Monday..7=Sunday (for every=days), `tz` an IANA zone (default "
      + "America/Sao_Paulo). kind=data: wakes it when a record of `table` (a model id from the app's "
      + "fab.schema.json) is created|updated|deleted|any in `project_id`, which the agent must be able to READ. "
      + "`input` is what to do on each firing. Webhook triggers are created in the Studio.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, kind: { type: "string", enum: ["schedule", "data"] },
      every: { type: "string", enum: A.EVERY }, at: { type: "string" },
      days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } }, tz: { type: "string" },
      project_id: { type: "string" }, table: { type: "string" }, event: { type: "string", enum: A.DATA_EVENTS },
      input: { type: "string" } }, ["agent_id", "kind"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const config = args.kind === "data"
        ? { project: args.project_id, model: args.table, event: args.event || "created" }
        : A.scheduleConfig({ every: args.every, at: args.at, days: args.days, tz: args.tz });
      return A.addTrigger({ ...ctx, kind: args.kind, config, input: args.input || "" });
    },
  },
  {
    name: "fabapp_set_agent_trigger",
    scope: "write",
    description: "Turns one of an agent's triggers on or off (`enabled`), or deletes it (`remove`: true). Trigger "
      + "ids come from fabapp_get_agent.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, trigger_id: { type: "string" },
      enabled: { type: "boolean" }, remove: { type: "boolean" } }, ["agent_id", "trigger_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      if (args.remove === true) {
        await A.removeTrigger({ ...ctx, triggerId: args.trigger_id });
        return { removed: true, trigger_id: args.trigger_id };
      }
      if (typeof args.enabled !== "boolean") throw new Error("give `enabled` (true/false) or `remove: true`");
      return A.setTriggerEnabled({ ...ctx, triggerId: args.trigger_id, enabled: args.enabled });
    },
  },
  {
    name: "fabapp_ask_agent",
    scope: "write",
    description: "Sends a chat message to an agent and waits for its answer (`result`). The agent acts with the "
      + "access it was granted and spends the account's AI credits. Outcomes: `done`; `awaiting_approval` (it "
      + "paused before an irreversible action: tell the person to approve or decline at `approve_in_studio`, there "
      + "is no tool for it); `timeout` (still working, nothing cancelled: read it later with fabapp_get_agent_run); "
      + "`queued` (it was busy; the message is read when the current run ends). A paused agent refuses messages.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, message: { type: "string" }, wait_seconds: WAIT },
                        ["agent_id", "message"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const out = await A.sendMessage({ ...ctx, text: args.message });
      if (out.queued) {
        return { outcome: "queued", active_run_id: out.active_run?.id || null,
                 note: "The agent is busy; it reads this message as soon as the current run ends." };
      }
      return waitAndSummarize(ctx, out.run, args.wait_seconds);
    },
  },
  {
    name: "fabapp_run_agent",
    scope: "write",
    description: "Runs an agent now on its standing instructions, with an optional `input` for this run, and waits "
      + "like fabapp_ask_agent (same outcomes, including `awaiting_approval`, which only a person resolves in the "
      + "Studio). Spends the account's AI credits.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, input: { type: "string" }, wait_seconds: WAIT },
                        ["agent_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const run = await A.startRun({ ...ctx, input: args.input || "" });
      return waitAndSummarize(ctx, run, args.wait_seconds);
    },
  },
  {
    name: "fabapp_list_agent_runs",
    scope: "read",
    description: "An agent's runs, newest first, 50 per page: status, what woke it (chat, manual, schedule, data), "
      + "steps and credits.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, page: PAGE }, ["agent_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      return A.listRuns({ ...ctx, offset: ((args.page || 1) - 1) * A.PAGE });
    },
  },
  {
    name: "fabapp_get_agent_run",
    scope: "read",
    description: "One run: its answer (`result`), status, error and its steps (each tool the agent called, on which "
      + "app, with what access). `after` = the last step seq already read, to page through long runs "
      + "(`steps_more` says there are more). Pending approvals are listed with the Studio link.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, run_id: { type: "string" },
      after: { type: "integer", minimum: 0 } }, ["agent_id", "run_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      const run = await A.getRun({ ...ctx, runId: args.run_id, after: args.after || 0 });
      const approvals = run.approvals || [];
      return approvals.length ? { ...run, approve_in_studio: A.studioUrl(c.host, ctx.agentId) } : run;
    },
  },
  {
    name: "fabapp_cancel_agent_run",
    scope: "write",
    description: "Stops a queued, running or approval-paused run of an agent. What it already did stays done.",
    inputSchema: object({ account_id: ACCOUNT, agent_id: AGENT, run_id: { type: "string" } }, ["agent_id", "run_id"]),
    run: async (c, args) => {
      const ctx = await agentCtx(c, args);
      return A.cancelRun({ ...ctx, runId: args.run_id });
    },
  },
].map(explained);
