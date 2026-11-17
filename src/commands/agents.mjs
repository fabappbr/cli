/**
 * `fabapp agents …` — Fabapp Agents from the terminal: create and edit them, give them apps, set when they work,
 * talk to them and read what they did.
 *
 * The API work is in `../agents.mjs`, shared with the MCP tools; this file parses the arguments and prints. Two
 * things are left to the Studio on purpose, and the output says where to go for them: APPROVING an action an agent
 * paused on (a person decides that, never a token), and connecting accounts such as Gmail (an OAuth screen).
 */
import { readFileSync } from "node:fs";

import { findRoot, read } from "../config.mjs";
import * as A from "../agents.mjs";

/** The flags that take a value. Anything else that starts with `--` is a switch. */
const VALUE_FLAGS = new Set(["account", "host", "q", "state", "page", "sort", "name", "summary", "instructions",
  "instructions-file", "model", "steps", "credit-cap", "email", "from", "app", "access", "every", "at", "days", "tz",
  "day", "minutes", "date", "input", "table", "event", "timeout"]);

/** The switches. A flag in neither list is refused: see `parseArgs`. */
const SWITCHES = new Set(["yes", "here", "paused", "no-wait", "help"]);

/**
 * An unknown flag is an error, never a switch. Taken as a switch, a typo (`--instruction "…"`) left its value among
 * the positionals, where it became part of the agent's name or of the message sent to it. A bare `--` ends the
 * flags, for a message that itself starts with `--`.
 */
export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positional.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      if (args[i + 1] === undefined) throw new Error(`--${name} needs a value`);
      flags[name] = args[++i];
    } else if (SWITCHES.has(name)) {
      flags[name] = true;
    } else {
      throw new Error(`unknown option --${name} (\`fabapp agents help\` lists them)`);
    }
  }
  return { positional, flags };
}

/** A numeric flag, refused when it is not a number: sent as it is, `NaN` travels as null and the server resets the field. */
function numberFlag(flags, name, { integer = false, min = 0 } = {}) {
  const n = Number(flags[name]);
  if (String(flags[name]).trim() === "" || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} is ${integer ? "a whole number" : "a number"} from ${min}`);
  }
  return n;
}

/** The subcommands that change something, and so need a token granted `write`. */
const WRITES = new Set(["create", "propose", "update", "pause", "resume", "delete", "grant", "revoke", "schedule",
  "watch", "trigger", "ask", "run", "cancel"]);

export const AGENTS_USAGE = `
  fabapp agents — the account's AI agents (Fabapp Agents)

    fabapp agents [list] [--q <text>] [--here] [--state <s>] [--page <n>]   list them, 50 a page
                         (--state waiting|failed|running|active|paused; --here = can reach this folder's app)
    fabapp agents show <agent>                          instructions, apps it can reach, triggers, last runs
    fabapp agents create "<name>" [--instructions <text> | --instructions-file <path>]
                         [--summary <text>] [--model <id>] [--paused]
    fabapp agents create --from "<one sentence>"        draft it with AI, then create it with the draft's apps and schedule
    fabapp agents propose "<one sentence>"              only show the draft; nothing is saved
    fabapp agents update <agent> [--name] [--summary] [--instructions | --instructions-file] [--model]
                         [--steps <n>] [--credit-cap <n>] [--email on|off]
    fabapp agents pause <agent> | resume <agent>
    fabapp agents delete <agent> --yes                  deletes it with its runs, chat, triggers and grants
    fabapp agents apps [--q <text>]                     the apps of the account an agent can be given
    fabapp agents models                                the models an agent can run on
    fabapp agents grant <agent> [--app <id|name>] [--access read|write]   default: the app linked to this folder, read
    fabapp agents revoke <agent> [--app <id|name>]
    fabapp agents triggers <agent>                      when it works
    fabapp agents schedule <agent> --every hourly|daily|weekdays|days|monthly|interval|once [--at HH:MM]
                         [--days 1,4] [--day 5] [--minutes 30] [--date YYYY-MM-DD] [--tz <zone>]
                         [--input "<what to do>"]   (--day 29-31: last day of shorter months; once: fires one time)
    fabapp agents watch <agent> --table <model-id> [--event created|updated|deleted|any] [--app <id|name>]
                         [--input "<what to do>"]      wake it when that table changes
    fabapp agents trigger <agent> <trigger-id> on|off|remove
    fabapp agents ask <agent> "<message>" [--no-wait] [--timeout <seconds>]   chat, and wait for the answer
    fabapp agents run <agent> ["<instruction>"] [--no-wait] [--timeout <seconds>]
    fabapp agents runs <agent> [--page <n>]             its runs, newest first
    fabapp agents runs <agent> <run-id>                 one run: the answer and every step
    fabapp agents cancel <agent> <run-id>

    <agent> is its id or its name. Add --account <client> to work in another account you belong to.
    Approvals are given in the Studio: a run that needs one stops and prints the link.
`;

/** on, off, or done: a one-off schedule that already fired is switched off by the server and cannot be resumed. */
const triggerState = (t) => (t.done ? "done" : t.enabled ? "on" : "off");

function table(log, head, rows) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cols) => "  " + cols.map((c, i) => String(c ?? "").padEnd(widths[i])).join("   ").trimEnd();
  log(line(head));
  for (const r of rows) log(line(r));
}

function pageOf(flags) {
  const n = flags.page === undefined ? 1 : Number(flags.page);
  if (!Number.isInteger(n) || n < 1) throw new Error("--page is a number from 1");
  return n;
}

function pager(log, { total, offset, count }, more) {
  if (!total) return;
  log("");
  log(`  ${offset + 1}-${offset + count} of ${total}.` + (offset + count < total ? ` Next: ${more}` : ""));
}

/** The project of the linked folder, if any: the natural "this app" for grant, revoke, watch and `--here`. */
function linkedProject() {
  const root = findRoot();
  return root ? read(root).project_id : "";
}

function instructionsFrom(flags) {
  if (flags["instructions-file"]) return readFileSync(flags["instructions-file"], "utf8");
  return typeof flags.instructions === "string" ? flags.instructions : undefined;
}

function when(t) {
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toISOString().slice(0, 16).replace("T", " ");
}

function stateOf(agent) {
  if (!agent.enabled) return "paused";
  const s = agent.last_run?.status;
  return s === A.PAUSED_FOR_APPROVAL ? "needs approval" : s || "never ran";
}

function printRunEnd(log, host, agentId, out) {
  const s = A.summarize({ host, agentId, ...out });
  log("");
  if (s.result) {
    log("  " + s.result.trim().split("\n").join("\n  "));
    log("");
  }
  if (s.outcome === "done") log(`  ✓ Done · run ${s.run_id} · ${s.steps_done ?? 0} steps · ${s.credits ?? 0} credits`);
  else if (s.outcome === A.PAUSED_FOR_APPROVAL) {
    log(`  ⏸ Paused for your approval · run ${s.run_id}`);
    for (const a of s.waiting_for_approval || []) log(`    · ${a.label || a.action}`);
    log(`    Approve or decline in the Studio: ${s.approve_in_studio}`);
    log("    (Approvals are never given from the CLI. After you decide, the run continues by itself.)");
  } else if (s.outcome === "timeout") {
    log(`  … Still working · run ${s.run_id}. Nothing was cancelled.`);
    log(`    Follow it with \`fabapp agents runs ${agentId} ${s.run_id}\`.`);
  } else {
    log(`  ✗ ${s.outcome} · run ${s.run_id}${s.error ? `: ${s.error}` : ""}`);
  }
  return s;
}

async function follow({ host, token, accountId, agentId, run, flags, log }) {
  if (flags["no-wait"]) {
    log(`  ✓ Started · run ${run.id} (${run.status}). Follow it with \`fabapp agents runs ${agentId} ${run.id}\`.`);
    return run;
  }
  const seconds = flags.timeout === undefined ? 600 : Number(flags.timeout);
  if (!(seconds > 0)) throw new Error("--timeout is a number of seconds");
  log(`  … run ${run.id}`);
  const out = await A.waitForRun({
    host, token, accountId, agentId, run, timeoutMs: seconds * 1000,
    onStep: (s) => { if (s.title) log(`    · ${s.title}${s.ok === false ? "  (failed)" : ""}`); },
  });
  return printRunEnd(log, host, agentId, out);
}

export async function agents({ host, token, accountId, scope = "read write", args, log }) {
  const [sub0, ...rest0] = args;
  const sub = !sub0 || sub0.startsWith("--") ? "list" : sub0;
  const { positional, flags } = parseArgs(sub0 && !sub0.startsWith("--") ? rest0 : args);
  if (sub === "help" || flags.help) { log(AGENTS_USAGE); return 0; }
  if (WRITES.has(sub) && !String(scope).split(/\s+/).includes("write")) {
    throw new Error("this machine is authorised read-only: run `fabapp login --scopes \"read write\"`");
  }
  const ctx = { host, token, accountId };
  const agentArg = async () => A.resolveAgent({ ...ctx, wanted: positional[0] });
  const appArg = async () => {
    const wanted = flags.app || linkedProject();
    if (!wanted) throw new Error("which app? `--app <project-id|name>`, or run this inside a folder linked with `fabapp link`");
    return A.resolveApp({ ...ctx, wanted });
  };

  switch (sub) {
    case "list": {
      const page = pageOf(flags);
      const project = flags.here ? linkedProject() : "";
      if (flags.here && !project) throw new Error("--here needs a folder linked with `fabapp link`");
      const out = await A.listAgents({ ...ctx, q: flags.q || "", project, state: flags.state || "",
                                       sort: flags.sort || "", offset: (page - 1) * A.PAGE });
      const items = out.items || [];
      if (!items.length) {
        log(page > 1 ? "  No agents on this page." : "  No agents yet. Create one with `fabapp agents create \"Name\" --instructions \"…\"`.");
        return 0;
      }
      table(log, ["AGENT", "ID", "STATE", "LAST RUN (UTC)", "NEXT RUN (UTC)"],
            items.map((a) => [a.name, a.id, stateOf(a), when(a.last_run?.created_at), when(a.next_run_at)]));
      pager(log, { total: out.total, offset: out.offset ?? 0, count: items.length }, `--page ${page + 1}`);
      return 0;
    }

    case "show": {
      const agentId = await agentArg();
      const [agent, grants, triggers, runs] = await Promise.all([
        A.getAgent({ ...ctx, agentId }), A.listGrants({ ...ctx, agentId }),
        A.listTriggers({ ...ctx, agentId }), A.listRuns({ ...ctx, agentId, limit: 5 }),
      ]);
      log(`  ${agent.name} · ${agent.id} · ${agent.enabled ? "active" : "paused"}`);
      if (agent.summary) log(`  ${agent.summary}`);
      log(`  model ${agent.model || "(default)"} · up to ${agent.step_budget} steps a run`
          + ` · ${agent.credits_month ?? 0} credits this month${agent.credit_cap ? ` of ${agent.credit_cap}` : ""}`);
      log("");
      log("  INSTRUCTIONS");
      log("  " + (agent.instructions || "(none)").trim().split("\n").join("\n  "));
      log("");
      log(`  CAN REACH (${grants.total ?? 0})`);
      for (const g of grants.items || []) {
        log(`    ${g.resource_kind} ${g.resource_id} · ${g.effective_access || g.access}`
            + (g.effective_access && g.effective_access !== g.access ? ` (granted ${g.access})` : ""));
      }
      log("");
      log(`  TRIGGERS (${triggers.total ?? 0})`);
      for (const t of triggers.items || []) {
        log(`    ${t.id} · ${t.kind} · ${t.label || JSON.stringify(t.config)} · ${triggerState(t)}`
            + (t.next_run_at ? ` · next ${when(t.next_run_at)} UTC` : ""));
      }
      log("");
      log(`  LAST RUNS (${runs.total ?? 0})`);
      for (const r of runs.items || []) log(`    ${r.id} · ${r.status} · ${r.origin} · ${when(r.created_at)} UTC`);
      log("");
      log(`  Studio: ${A.studioUrl(host, agent.id)}`);
      return 0;
    }

    case "propose": {
      const draft = await A.proposeAgent({ ...ctx, description: positional.join(" ") || flags.from });
      printDraft(log, draft);
      log("  Nothing was saved. Create it with `fabapp agents create --from \"…\"`, or by hand with `create`.");
      return 0;
    }

    case "create": {
      if (flags.from) return await createFromSentence({ ctx, flags, log, name: positional.join(" ").trim() || flags.name });
      const agent = await A.createAgent({ ...ctx, name: positional.join(" ").trim() || flags.name,
                                          summary: flags.summary, instructions: instructionsFrom(flags),
                                          model: flags.model, enabled: !flags.paused });
      log(`  ✓ Agent ${agent.name} · ${agent.id}${agent.enabled ? "" : " (paused)"}`);
      log("    Give it an app with `fabapp agents grant " + agent.id + "`, and a schedule with `fabapp agents schedule`.");
      return 0;
    }

    case "update": {
      const agentId = await agentArg();
      const patch = { name: flags.name, summary: flags.summary, instructions: instructionsFrom(flags),
                      model: flags.model };
      if (flags.steps !== undefined) patch.step_budget = numberFlag(flags, "steps", { integer: true, min: 1 });
      if (flags["credit-cap"] !== undefined) patch.credit_cap = numberFlag(flags, "credit-cap");
      if (flags.email !== undefined) {
        if (!["on", "off"].includes(flags.email)) throw new Error("--email is on or off");
        patch.deliver_email = flags.email === "on";
      }
      const agent = await A.updateAgent({ ...ctx, agentId, patch });
      log(`  ✓ Agent ${agent.name} updated.`);
      return 0;
    }

    case "pause":
    case "resume": {
      const agentId = await agentArg();
      const agent = await A.updateAgent({ ...ctx, agentId, patch: { enabled: sub === "resume" } });
      log(sub === "resume" ? `  ✓ ${agent.name} is active again: its triggers fire and it answers messages.`
                           : `  ✓ ${agent.name} is paused: no trigger fires and messages are refused until \`resume\`.`);
      return 0;
    }

    case "delete": {
      // Permanent, so the id or the FULL name: part of a name is not enough to choose what is deleted.
      const agentId = await A.resolveAgent({ ...ctx, wanted: positional[0], exact: true });
      const agent = await A.getAgent({ ...ctx, agentId });
      if (!flags.yes) {
        log(`  This deletes ${agent.name} (${agent.id}) with its runs, chat, memory, triggers and grants.`);
        log("  It cannot be undone. Run it again with --yes, or pause it instead (`fabapp agents pause`).");
        return 1;
      }
      await A.deleteAgent({ ...ctx, agentId });
      log(`  ✓ ${agent.name} was deleted.`);
      return 0;
    }

    case "apps": {
      const page = pageOf(flags);
      const out = await A.appOptions({ ...ctx, q: flags.q || "", limit: 20, offset: (page - 1) * 20 });
      const items = out.items || [];
      if (!items.length) { log("  No apps in this account."); return 0; }
      table(log, ["APP", "ID"], items.map((a) => [a.name, a.id]));
      pager(log, { total: out.total, offset: out.offset ?? 0, count: items.length }, `--page ${page + 1}`);
      return 0;
    }

    case "models": {
      const out = await A.modelOptions(ctx);
      table(log, ["MODEL", "NAME", "COST", ""], (out.models || []).map((m) => [
        m.model, m.display_name, m.relative_cost ? `${m.relative_cost}x` : "",
        [m.default ? "default" : "", m.allowed === false ? "not on this plan" : "", m.own_key ? "your key" : ""]
          .filter(Boolean).join(", ")]));
      return 0;
    }

    case "grant": {
      const agentId = await agentArg();
      const app = await appArg();
      const access = flags.access || "read";
      await A.grantApp({ ...ctx, agentId, projectId: app.id, access });
      log(`  ✓ The agent can ${access === "write" ? "read and change" : "read"} the data of ${app.name} (${app.id}).`);
      if (access === "write") log("    Creating, changing and deleting records still wait for your approval, given in the Studio.");
      return 0;
    }

    case "revoke": {
      const agentId = await agentArg();
      const app = await appArg();
      const gone = await A.revokeApp({ ...ctx, agentId, projectId: app.id });
      log(gone ? `  ✓ The agent no longer reaches ${app.name}.` : `  The agent had no access to ${app.name}; nothing changed.`);
      return 0;
    }

    case "triggers": {
      const agentId = await agentArg();
      const page = pageOf(flags);
      const out = await A.listTriggers({ ...ctx, agentId, offset: (page - 1) * A.PAGE });
      const items = out.items || [];
      if (!items.length) {
        log("  No triggers: it works only when you message or run it. Add one with `fabapp agents schedule`.");
        return 0;
      }
      table(log, ["ID", "KIND", "WHEN", "STATE", "NEXT RUN (UTC)", "INPUT"], items.map((t) => [
        t.id, t.kind, t.label || JSON.stringify(t.config), triggerState(t), when(t.next_run_at),
        (t.input || "").slice(0, 40)]));
      pager(log, { total: out.total, offset: out.offset ?? 0, count: items.length }, `--page ${page + 1}`);
      return 0;
    }

    case "schedule": {
      const agentId = await agentArg();
      const config = A.scheduleConfig({ every: flags.every, at: flags.at, days: flags.days, tz: flags.tz,
                                        minutes: flags.minutes, day: flags.day, date: flags.date });
      const t = await A.addTrigger({ ...ctx, agentId, kind: "schedule", config, input: flags.input || "" });
      log(`  ✓ Trigger ${t.id} · ${t.label || flags.every}${t.next_run_at ? ` · next ${when(t.next_run_at)} UTC` : ""}`);
      return 0;
    }

    case "watch": {
      const agentId = await agentArg();
      if (!flags.table) throw new Error("which table? `--table <model-id>` (the id in fab.schema.json)");
      const app = await appArg();
      const t = await A.addTrigger({ ...ctx, agentId, kind: "data", input: flags.input || "",
                                     config: { project: app.id, model: flags.table, event: flags.event || "created" } });
      log(`  ✓ Trigger ${t.id} · when a ${flags.table} record is ${flags.event || "created"} in ${app.name}`);
      return 0;
    }

    case "trigger": {
      const agentId = await agentArg();
      const [, triggerId, action] = positional;
      if (!triggerId || !["on", "off", "remove"].includes(action)) {
        throw new Error("`fabapp agents trigger <agent> <trigger-id> on|off|remove` (`fabapp agents triggers` lists the ids)");
      }
      if (action === "remove") {
        await A.removeTrigger({ ...ctx, agentId, triggerId });
        log(`  ✓ Trigger ${triggerId} removed.`);
      } else {
        await A.setTriggerEnabled({ ...ctx, agentId, triggerId, enabled: action === "on" });
        log(`  ✓ Trigger ${triggerId} is ${action}.`);
      }
      return 0;
    }

    case "ask": {
      const agentId = await agentArg();
      const text = positional.slice(1).join(" ");
      const out = await A.sendMessage({ ...ctx, agentId, text });
      if (out.queued) {
        log(`  ✓ Queued: the agent is busy with run ${out.active_run?.id}, and reads your message as soon as it ends.`);
        log(`    Read the answer later with \`fabapp agents runs ${agentId}\`.`);
        return 0;
      }
      const s = await follow({ ...ctx, agentId, run: out.run, flags, log });
      return s?.outcome && !["done", A.PAUSED_FOR_APPROVAL, "timeout"].includes(s.outcome) ? 1 : 0;
    }

    case "run": {
      const agentId = await agentArg();
      // `--input` too: it is how `schedule` and `watch` name the same thing, and it was read and then dropped here.
      const run = await A.startRun({ ...ctx, agentId, input: positional.slice(1).join(" ") || flags.input || "" });
      const s = await follow({ ...ctx, agentId, run, flags, log });
      return s?.outcome && !["done", A.PAUSED_FOR_APPROVAL, "timeout"].includes(s.outcome) ? 1 : 0;
    }

    case "runs": {
      const agentId = await agentArg();
      if (positional[1]) {
        const out = await A.waitForRun({ ...ctx, agentId, run: { id: positional[1] }, timeoutMs: 0,
          onStep: (s) => log(`    ${s.seq}. ${s.title || s.kind}${s.ok === false ? "  (failed)" : ""}`) });
        printRunEnd(log, host, agentId, out);
        return 0;
      }
      const page = pageOf(flags);
      const out = await A.listRuns({ ...ctx, agentId, offset: (page - 1) * A.PAGE });
      const items = out.items || [];
      if (!items.length) { log("  No runs yet."); return 0; }
      table(log, ["RUN", "STATUS", "WOKE BY", "STARTED (UTC)", "STEPS", "CREDITS"], items.map((r) => [
        r.id, r.status, r.origin, when(r.created_at), r.steps_done, r.credits]));
      pager(log, { total: out.total, offset: out.offset ?? 0, count: items.length }, `--page ${page + 1}`);
      return 0;
    }

    case "cancel": {
      const agentId = await agentArg();
      if (!positional[1]) throw new Error("`fabapp agents cancel <agent> <run-id>`");
      const run = await A.cancelRun({ ...ctx, agentId, runId: positional[1] });
      log(`  ✓ Run ${run.id} is ${run.status}.`);
      return 0;
    }

    default:
      log(`  unknown agents command: ${sub}`);
      log(AGENTS_USAGE);
      return 1;
  }
}

function printDraft(log, draft) {
  log(`  ${draft.name}`);
  if (draft.summary) log(`  ${draft.summary}`);
  log("");
  log("  " + (draft.instructions || "").trim().split("\n").join("\n  "));
  log("");
  for (const r of draft.resources || []) log(`  · ${r.label || r.resource_id} (${r.resource_kind}) · ${r.access}${r.why ? ` · ${r.why}` : ""}`);
  if (draft.schedule) log(`  · schedule: ${draft.schedule.label || JSON.stringify(draft.schedule.config)}`);
  if (draft.data_trigger) log(`  · when a ${draft.data_trigger.table} record is ${draft.data_trigger.config?.event} in ${draft.data_trigger.app}`);
  log("");
}

/**
 * `create --from "<sentence>"`: the draft, then the agent with what the draft suggested. The person typed the
 * command, and the output lists every grant and trigger it made, so what was decided is on screen.
 *
 * Only APP grants are applied here. A draft can also suggest a connected account (a Gmail, a calendar) or an MCP
 * server; those are listed for the person to grant in the Studio, where the connection and its ceiling are visible.
 */
async function createFromSentence({ ctx, flags, log, name }) {
  const draft = await A.proposeAgent({ ...ctx, description: flags.from });
  printDraft(log, draft);
  // What the person typed wins over the draft: a name, a summary or instructions given with `--from` are kept.
  const agent = await A.createAgent({ ...ctx, name: name || draft.name || "Agent", summary: flags.summary || draft.summary,
                                      instructions: instructionsFrom(flags) || draft.instructions, model: flags.model,
                                      enabled: !flags.paused });
  log(`  ✓ Agent ${agent.name} · ${agent.id}${agent.enabled ? "" : " (paused)"}`);
  const later = [];
  for (const r of draft.resources || []) {
    if (r.resource_kind !== "project") { later.push(r); continue; }
    try {
      await A.grantApp({ ...ctx, agentId: agent.id, projectId: r.resource_id, access: r.access });
      log(`  ✓ Can ${r.access === "write" ? "read and change" : "read"} ${r.label || r.resource_id}`);
    } catch (e) { log(`  ⚠ ${r.label || r.resource_id} was not granted: ${e.message}`); }
  }
  const triggers = [];
  if (draft.schedule) triggers.push({ kind: "schedule", config: draft.schedule.config, input: draft.schedule.input });
  if (draft.data_trigger) triggers.push({ kind: "data", config: draft.data_trigger.config, input: draft.data_trigger.input });
  for (const t of triggers) {
    try {
      const made = await A.addTrigger({ ...ctx, agentId: agent.id, ...t });
      log(`  ✓ Trigger ${made.id} · ${made.label || t.kind}`);
    } catch (e) { log(`  ⚠ The ${t.kind} trigger was not created: ${e.message}`); }
  }
  if (later.length) {
    log("");
    log("  Grant these in the Studio, where the connection is visible:");
    for (const r of later) log(`    · ${r.label || r.resource_id} (${r.resource_kind}) · ${r.access}`);
    log(`    ${A.studioUrl(ctx.host, agent.id)}`);
  }
  return 0;
}
