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
| `create "<name>"` | creates a project and its first surface, and links this directory. `--app <name>` names the surface separately |
| `login` | authorises this machine through the device flow. `--scopes "read"` for read-only, `--no-open` on headless/CI |
| `logout` | forgets the token **on this machine**. It stays valid on the server until it is revoked in Studio |
| `status` | which account you are authorised on, and which project this folder is linked to |
| `link <id>` | links the current directory to a project. Verifies access **before** writing anything |
| `pull` | brings down `fab.schema.json`, `fab.automations.json`, `fab.settings.json`, `fab.connectors.json` and `apps/<slug>/fab.config.json` |
| `push` | sends back what is on disk |
| `deploy` | uploads what you edited in the workspace and publishes. `--no-publish` only saves |
| `dev` | runs the app on your machine, on the same template the platform uses. `--app <slug>` picks the surface, `--reset` rebuilds the workspace, `--port` changes the port |

`FABAPP_API_URL` changes the API base (default `https://api.fabapp.ai`).

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
