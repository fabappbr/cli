#!/usr/bin/env node
/**
 * The Fabapp CLI.
 *
 * Zero dependencies, on purpose. This is a tool that holds a credential and talks to somebody's backend; every
 * package in its graph would be a package that could reach both.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { findRoot, read } from "./config.mjs";
import { clear, load } from "./credentials.mjs";
import { deploy } from "./commands/deploy.mjs";
import { dev } from "./commands/dev.mjs";
import { link } from "./commands/link.mjs";
import { login } from "./commands/login.mjs";
import { serve as serveMcp } from "./mcp/server.mjs";
import { pull, push } from "./commands/sync.mjs";

const DEFAULT_HOST = process.env.FABAPP_API_URL || "https://api.fabapp.ai";
const log = (...a) => console.log(...a);

const USAGE = `
  fabapp — the Fabapp command line

    fabapp login [--scopes "read write"]   authorise this machine (opens the browser)
                 [--no-open]               do not open the browser (headless / CI)
    fabapp logout                          forget the token on THIS machine
    fabapp status                          which account you are on, and which project this folder belongs to
    fabapp link <project-id>               point this directory at a project
    fabapp dev [--app <slug>] [--reset]    run the app locally, on the platform's own template
    fabapp pull                            bring the project's definition to disk
    fabapp push                            send back what is on disk
    fabapp deploy [--no-publish]           upload what you edited in the workspace, then publish
    fabapp mcp                             MCP server over stdio — for Claude Code and friends

  The API base comes from FABAPP_API_URL (default: ${DEFAULT_HOST}).
`;

function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** The directory's link plus the credential for its host — everything a project command needs. */
function context() {
  const root = findRoot();
  if (!root) throw new Error("this directory is not linked to a project — run `fabapp link <project-id>`");
  const config = read(root);
  const creds = load(config.host);
  if (!creds?.token) throw new Error(`not authorised for ${config.host} — run \`fabapp login\``);
  return { root, host: config.host, projectId: config.project_id, token: creds.token };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const host = flag(argv, "host", DEFAULT_HOST);

  switch (command) {
    case "login":
      await login({ host, scopes: flag(argv, "scopes", "read write"),
                    open: !argv.includes("--no-open"), log });
      return 0;

    case "logout": {
      clear(host);
      log(`  ✓ The token for ${host} was forgotten on this machine.`);
      log("    It stays VALID on the server until it is revoked in Studio → Settings → CLI.");
      return 0;
    }

    case "status": {
      const root = findRoot();
      const config = root ? read(root) : null;
      const creds = load(config?.host || host);
      log(`  host       ${config?.host || host}`);
      log(`  session    ${creds ? `account ${creds.account_id} · scope ${creds.scope}` : "not authorised"}`);
      log(`  directory  ${root ? `${root} → project ${config.project_id}` : "not linked"}`);
      return 0;
    }

    case "link": {
      const projectId = rest.find((a) => !a.startsWith("--"));
      if (!projectId) throw new Error("give the project id: `fabapp link <project-id>`");
      const creds = load(host);
      if (!creds?.token) throw new Error(`not authorised for ${host} — run \`fabapp login\``);
      await link({ host, token: creds.token, projectId, root: process.cwd(), log });
      return 0;
    }

    case "mcp": {
      // The MCP server needs no linked directory: the tools take a `project_id` argument, and whatever starts the
      // process (Claude Code, the desktop app) does not run from inside a project.
      const creds = load(host);
      if (!creds?.token) throw new Error(`not authorised for ${host} — run \`fabapp login\``);
      return await serveMcp({ host, creds });
    }

    case "dev":
      return await dev({ ...context(), app: flag(argv, "app", ""), reset: argv.includes("--reset"),
                         port: flag(argv, "port", ""), log });

    case "deploy":
      return await deploy({ ...context(), publish: !argv.includes("--no-publish"), log });

    case "pull": await pull({ ...context(), log }); return 0;
    case "push": await push({ ...context(), log }); return 0;

    case undefined:
    case "help":
    case "--help":
    case "-h": log(USAGE); return 0;

    default:
      log(`  unknown command: ${command}`);
      log(USAGE);
      return 1;
  }
}

/**
 * "Was I executed, or was I imported?"
 *
 * ⚠️ The naive comparison — `import.meta.url === "file://" + process.argv[1]` — is WRONG for an installed package,
 * and wrong in the quietest way there is. npm publishes the `bin` as a SYMLINK
 * (`node_modules/.bin/fabapp -> ../@fabappai/cli/src/index.mjs`), so `process.argv[1]` is the LINK's path while
 * `import.meta.url` is the real file's. They never match, `main()` never runs, and the command exits 0 printing
 * nothing — which looks exactly like success.
 *
 * That shipped in 0.1.0 and passed every test, because the tests ran `node src/index.mjs` — the DIRECT path, where
 * the comparison holds. Testing the file is not testing the artifact. `realpathSync` resolves the link before
 * comparing, and `test/installed.test.mjs` packs, installs and calls the binary the way a user does.
 */
function wasRunDirectly() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(invoked)).href; }
  catch { return false; }
}

if (wasRunDirectly()) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(`\n  ✗ ${e.message}\n`);
    process.exit(1);
  });
}
