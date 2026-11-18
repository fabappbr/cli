# @fabappai/cli

A Fabapp project's definition, on your disk.

```bash
npx @fabappai/cli login
npx @fabappai/cli link <project-id>
npx @fabappai/cli pull
# edit the .json files
npx @fabappai/cli push
```

## Commands

| | |
|---|---|
| `projects` | lists what you can open: your own projects and, for agencies, the apps of the clients you manage, each with its account. `--account <client>` shows one client |
| `create "<name>"` | creates a project and its first surface, and links this directory. `--app <name>` names the surface separately. `--account <client>` creates it in a client's account (by id or name): the app and the AI credits it spends are the client's |
| `login` | authorises this machine through the device flow. `--scopes "read"` for read-only, `--no-open` on headless/CI |
| `logout` | forgets the token **on this machine**. It stays valid on the server until it is revoked in Studio |
| `status` | which account you are authorised on, and which project this folder is linked to |
| `link <id>` | links the current directory to a project. Verifies access **before** writing anything |
| `pull` | brings down `fab.schema.json`, `fab.automations.json`, `fab.settings.json`, `fab.connectors.json` and `apps/<slug>/fab.config.json` |
| `push` | sends back what is on disk |
| `deploy` | uploads what you edited in the workspace and publishes. `--no-publish` only saves |
| `dev` | runs the app on your machine, on the same template the platform uses. `--app <slug>` picks the surface, `--reset` rebuilds the workspace, `--port` changes the port |

`FABAPP_API_URL` changes the API base (default `https://api.fabapp.ai`).

## Agents

`fabapp agents` manages the account's **Fabapp Agents**: AI agents that work on your apps on their own. An agent
belongs to the account, reaches an app only after you grant it (`read`, or `write` to create and change records),
and works when you message it, run it, or a trigger wakes it (a schedule, or a change in one of an app's tables).

```bash
fabapp agents create "Weekly report" --instructions "Every Monday, summarise last week's orders."
fabapp agents grant "Weekly report"                    # the app linked to this folder, read only
fabapp agents schedule "Weekly report" --every days --days 1 --at 09:00 --input "Last week's orders"
fabapp agents schedule "Weekly report" --every monthly --day 5 --at 09:00 --input "Last month's orders"
fabapp agents ask "Weekly report" "How many orders came in yesterday?"
```

| | |
|---|---|
| `agents [list]` | one page of 50, with each agent's state and last and next run. `--q <name>`, `--state waiting\|failed\|running\|active\|paused`, `--here` (only agents that reach this folder's app), `--page <n>` |
| `agents show <agent>` | instructions, model, limits, what it can reach (the effective level), triggers, last runs and its Studio link |
| `agents create "<name>"` | `--instructions <text>` or `--instructions-file <path>`, `--summary`, `--model <id>` (`agents models`), `--paused`. `--from "<one sentence>"` drafts it with AI and creates it with the draft's app grants and trigger, listing each |
| `agents propose "<one sentence>"` | only shows the draft; nothing is saved |
| `agents update <agent>` | `--name`, `--summary`, `--instructions`/`--instructions-file`, `--model`, `--steps <n>`, `--credit-cap <n>`, `--email on\|off` |
| `agents pause <agent>` · `resume <agent>` | a paused agent fires no trigger and refuses messages |
| `agents delete <agent> --yes` | deletes it with its runs, chat, memory, triggers and grants. Without `--yes` it only says what would go. Takes the id or the full name, never part of a name |
| `agents apps` · `agents models` | the account's apps an agent can be given; the models it can run on |
| `agents grant <agent>` · `revoke <agent>` | `--app <id\|name>` (default: the app linked to this folder), `--access read\|write` |
| `agents triggers <agent>` | when it works |
| `agents schedule <agent>` | `--every hourly\|daily\|weekdays\|days\|monthly\|interval\|once`, `--at HH:MM`, `--days 1,4` (1 = Monday), `--day 5` (monthly; 29 to 31 fire on the last day of shorter months), `--minutes 30` (interval: a multiple of 5 from 15 to 1440), `--date YYYY-MM-DD` (once: fires one time, then shows as `done`), `--tz <zone>`, `--input "<what to do>"` |
| `agents watch <agent> --table <model-id>` | wakes it when that table changes: `--event created\|updated\|deleted\|any`, `--app` |
| `agents trigger <agent> <trigger-id> on\|off\|remove` | |
| `agents ask <agent> "<message>"` · `agents run <agent> ["<instruction>"]` | starts it and follows the run step by step until it ends. `--no-wait`, `--timeout <seconds>` (default 600; a timeout cancels nothing) |
| `agents runs <agent> [<run-id>]` · `agents cancel <agent> <run-id>` | the runs, newest first; one run with its answer and every step |

`<agent>` is the id or the name (part of a name is enough when only one agent matches). `--account <client>` works in another account you belong to. An agent reaches only
the apps of its own account.

**Approvals are given in the Studio, never here.** When an agent reaches something that cannot be undone (an
e-mail sent, records deleted) the run pauses, and `ask`/`run` stop with what it is waiting for and the link to the
agent in the Studio, where a person approves or declines. The API refuses a CLI token on the approval routes, so an
agent driven from a terminal can never approve its own request. Connected accounts (Gmail, calendars), MCP servers,
webhook triggers (their secret is shown once), memory and playbooks are managed in the Studio too.
`FABAPP_STUDIO_URL` sets the Studio base for the links (default: the API host with `api.` turned into `app.`).

## What it will not do, on purpose

**It will not write over what you edited.** `dev` assembles `.fabapp/workspace` once; on later runs it **compares**
the template signature and warns when it drifted, instead of overwriting. Rebuilding is your call (`--reset`), and
it tells you that this deletes your edits.

**It will not delete.** Neither in `pull` nor in `deploy`: a file that disappeared from your workspace is
**reported**, never removed from the app. Your workspace may be stale relative to the server — the AI may have
edited the app in Studio meanwhile — and deleting there because of an absence here destroys work nobody asked us
to manage.

**It will not push what is not yours.** `deploy` sends only what you changed since the workspace was assembled. The
platform's 57 components, the SDK and the shell stay where they are. And if you edit a file the app cannot
overwrite, it **says which one** — instead of saving with a 200 and changing nothing.

**It will not write a credential to disk.** The token goes into the system keychain; with no keychain, into a
`0600` file — and in that case it **says so**. A tool that quietly falls back to a worse place teaches you it is
always safe.

**It has no dependency.** Zero packages: it holds a credential and talks to your backend, and every package in the
graph could reach both.

**`fab.connectors.json` and `fab.integrations.json` are read-only.** They say what the project has connected — so
an agent knows it exists and which operations to call — and never the credential. Connecting and rotating happens
on the platform.

## MCP server

```bash
fabapp mcp     # JSON-RPC over stdio, for Claude Code and the desktop app
```

It uses the credential `fabapp login` already stored — it never asks for a secret and never shows one. In
`~/.claude.json` or in your client's config:

```json
{ "mcpServers": { "fabapp": { "command": "npx", "args": ["-y", "@fabappai/cli", "mcp"] } } }
```

| tool | scope |
|---|---|
| `fabapp_docs` — **read this first** | read |
| `fabapp_list_projects` · `fabapp_list_apps` · `fabapp_read_definition` · `fabapp_app_status` | read |
| `fabapp_create_project` · `fabapp_write_definition` · `fabapp_deploy` | write |
| `fabapp_list_agents` · `fabapp_get_agent` · `fabapp_list_agent_apps` · `fabapp_list_agent_models` · `fabapp_list_agent_runs` · `fabapp_get_agent_run` | read |
| `fabapp_propose_agent` · `fabapp_create_agent` · `fabapp_update_agent` · `fabapp_delete_agent` · `fabapp_grant_agent_app` · `fabapp_revoke_agent_app` · `fabapp_add_agent_trigger` · `fabapp_set_agent_trigger` · `fabapp_ask_agent` · `fabapp_run_agent` · `fabapp_cancel_agent_run` | write |

The agent tools mirror `fabapp agents`. `fabapp_delete_agent` is permanent and takes `confirm: true`.
`fabapp_ask_agent` and `fabapp_run_agent` wait up to `wait_seconds` (default 60, max 300) and answer the outcome:
`done` with the `result` (`incomplete: true` when part of the job did not fit the run's steps), `awaiting_approval`
with `approve_in_studio` (there is no approve tool, on purpose), `awaiting_customer` (a customer conversation waiting
for the app's user to confirm in the app), `timeout`, or `queued`.

**The scope decides the list.** A token granted read-only does not *see* the write tools. Advertising one that will
answer 403 is worse than not advertising it: the model tries, fails, and tries again with different arguments — the
refusal looks like a problem with the request, not the permission.

`fabapp_read_definition` is the one that matters most: without the schema, a wrong model id answers 404 and an
invented field answers 422. It is the first thing an agent should call.

## Dependencies and build plugins

`npm install` in the workspace works the way you expect: `deploy` sends the dependencies you **added** or changed
since the workspace was assembled, merged into the app's own `package.json` on the server. Not the whole file, which
is mostly the platform's floor. `devDependencies` count the same as `dependencies`.

What it does **not** send, and says so before uploading:

- **A new version of a platform package** (react, vite, tailwindcss, the Radix packages). The build always installs
  its own version of those.
- **Build config.** `vite.config.ts`, `index.html` and `tsconfig*.json` are the platform's and are rewritten on every
  build; a `postcss.config.js`, `tailwind.config.js` or `.babelrc` is never run; `@plugin`/`@config` lines in a
  stylesheet are stripped.
- **A removed dependency** is reported, never removed from the app.
- **A file that is not text.** The app's code is UTF-8 text, on the server and in the build. An image, a font or a
  media file in `public/` is named and left home; upload it in Studio (Brand, or the app's storage) and reference it
  by URL. A vector logo can stay in the code as an `.svg`.

A build plugin is switched on by declaring an **allowed** package in `package.json` (Tailwind typography, scrollbar,
safe-area and motion; svgr, Node polyfills, MDX, wasm and GLSL for Vite). The platform registers it with its own
options, and the same file does it in `fabapp dev`, so what you see locally is what gets built. The list, with how
to use each one, is in `fabapp_docs`.

## Template drift

The template — the shell, the SDK, the components, the dependency floor — is copied by the platform on every build,
so a local copy goes stale on its own. The failure mode would be the worst one possible for a command called `dev`:
it works here, comes out different in production, and nothing warns you.

So the workspace records the signature of the template it came from, and every `fabapp dev` compares it against the
one the platform used on the app's last build. On a mismatch it says so — with both values, for you to decide.

## Requires the Builder plan or above

A Free account does not authorise the CLI.
