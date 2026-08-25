/**
 * `fabapp dev` — the app running on your machine, on the same template the platform builds with.
 *
 * The risk this command has to handle is not assembling the workspace: it is DRIFT. The template — the shell, the
 * SDK, the components, the dependency floor — is copied fresh from `services/gen-template` on every platform build,
 * so a local copy goes stale on its own. The failure mode is the worst one possible for a command called `dev`: it
 * works here, comes out different in production, and nothing warns you.
 *
 * So the workspace records the SIGNATURE of the template it came from, and every run compares. On a mismatch it
 * SAYS SO — and does not fix itself, because fixing itself would mean writing over what you edited.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { request } from "../api.mjs";
import { fingerprint, readStamp, writeStamp } from "../workspace.mjs";

/** Unzips with whatever the OS ships. `unzip` first, `tar` second (bsdtar on macOS and Windows 10+ read zip). */
function unzip(zip, into) {
  mkdirSync(into, { recursive: true });
  for (const [cmd, args] of [["unzip", ["-q", "-o", zip, "-d", into]], ["tar", ["-xf", zip, "-C", into]]]) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return cmd;
    } catch { /* try the next one */ }
  }
  throw new Error("found neither `unzip` nor `tar` to unpack the bundle");
}

/** The zip has a single top-level folder; the workspace is what is inside it. */
function onlyChild(dir) {
  const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
  if (entries.length === 1 && statSync(join(dir, entries[0])).isDirectory()) return join(dir, entries[0]);
  return dir;
}

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the bundle (${res.status})`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

async function pickApp({ host, token, projectId, wanted }) {
  const apps = await request(host, `/projects/${encodeURIComponent(projectId)}/apps`, { token });
  if (!apps.length) throw new Error("this project has no surface yet");
  if (wanted) {
    const found = apps.find((a) => a.slug === wanted || a.id === wanted);
    if (!found) throw new Error(`no surface named '${wanted}' — this project has: ${apps.map((a) => a.slug).join(", ")}`);
    return found;
  }
  if (apps.length > 1) {
    throw new Error(`this project has ${apps.length} surfaces — pick one with --app ` +
                    `(${apps.map((a) => a.slug).join(", ")})`);
  }
  return apps[0];
}

/**
 * `run` and `install` are injectable so the workspace logic can be tested without spawning npm or Vite. The property
 * worth testing is not that Vite starts — it is that an existing workspace with YOUR EDITS in it is never written
 * over, and that a template mismatch is said out loud.
 */
export async function dev({ host, token, projectId, root, app: wanted, reset = false, port, log,
                            install = defaultInstall, run = defaultRun }) {
  const app = await pickApp({ host, token, projectId, wanted });
  const workspace = join(root, ".fabapp", "workspace");
  const stamp = readStamp(root);

  if (reset && existsSync(workspace)) {
    log("  Rebuilding the workspace from scratch (--reset)…");
    rmSync(workspace, { recursive: true, force: true });
  }

  if (!existsSync(join(workspace, "package.json"))) {
    log(`  Assembling the workspace for '${app.slug}'…`);
    const out = await request(host, `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(app.id)}/export`,
                              { method: "POST", token });
    const zip = join(tmpdir(), `fabapp-${app.id}.zip`);
    await download(out.download_url, zip);
    const staging = join(tmpdir(), `fabapp-ws-${app.id}`);
    rmSync(staging, { recursive: true, force: true });
    unzip(zip, staging);
    mkdirSync(join(root, ".fabapp"), { recursive: true });
    execFileSync("cp", ["-R", onlyChild(staging) + "/", workspace + "/"]);
    rmSync(zip, { force: true });
    rmSync(staging, { recursive: true, force: true });
    // The FINGERPRINT of every file, taken now that the workspace is exactly what the platform handed over. It is
    // what lets `deploy` send only what YOU changed, instead of pushing the platform's files along with it.
    writeStamp(root, { app_id: app.id, template: out.template || "", files: fingerprint(workspace) });
    log(`  ✓ Workspace at .fabapp/workspace · template ${out.template || "(unknown)"}`);
  } else {
    // The workspace EXISTS and holds your edits. Comparing is this command's job; overwriting is not.
    const current = app.template_sig || "";
    const local = stamp?.template || "";
    if (current && local && current !== local) {
      log("");
      log(`  ⚠ The template changed since this workspace was assembled.`);
      log(`      here:            ${local}`);
      log(`      on the platform: ${current}`);
      log("    What runs here may come out different in the build. `fabapp dev --reset` rebuilds the workspace —");
      log("    and it DELETES what you edited inside .fabapp/workspace, so save first.");
      log("");
    } else if (!local) {
      log("  ⚠ This workspace does not record which template it came from — I cannot confirm it matches.");
    }
  }

  if (!existsSync(join(workspace, "node_modules"))) {
    log("  Installing dependencies (first run only)…");
    await install(workspace);
  }

  log(`\n  Starting Vite in .fabapp/workspace…\n`);
  return run(workspace, port);
}

function defaultInstall(workspace) {
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: workspace, stdio: "inherit" });
}

function defaultRun(workspace, port) {
  const args = ["run", "dev", ...(port ? ["--", "--port", String(port)] : [])];
  const child = spawn("npm", args, { cwd: workspace, stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}
