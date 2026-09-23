/**
 * `fabapp deploy` — what you edited here goes live.
 *
 * Two steps, and the order matters: the code goes up first (`PUT /code`, with compare-and-swap), then the app is
 * published. Publishing without uploading would publish what is on the SERVER — the command would look like it
 * worked and the local work would be left behind, which is the worst way for a deploy to fail.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { request } from "../api.mjs";
import { CSS_LOADER_RULE, ROOT_FILES, changes, depChanges, fingerprint, hash, platformFingerprint, readDeps,
         readStamp, strayConfigs, writeStamp } from "../workspace.mjs";

export async function deploy({ host, token, projectId, root, log, publish = true }) {
  const workspace = join(root, ".fabapp", "workspace");
  const stamp = readStamp(root);
  if (!existsSync(join(workspace, "package.json")) || !stamp?.app_id) {
    throw new Error("there is no local workspace — run `fabapp dev` first");
  }
  const appId = stamp.app_id;
  const base = `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`;

  const pristine = stamp.files || {};
  if (!Object.keys(pristine).length) {
    throw new Error("this workspace was assembled by an earlier CLI version and does not record what came from " +
                    "the platform — run `fabapp dev --reset` (it deletes your edits, so save first)");
  }
  const { changed, removed } = changes(workspace, pristine);
  let { added } = changes(workspace, pristine);

  // A root manifest the STAMP never recorded is not something you wrote: workspaces assembled before the CLI walked
  // the root already hold the export-time copy of `fab.functions.json`, and their stamp has no entry for it. Left
  // alone, `changes()` reads it as "new" and `deploy` would put an old manifest over whatever the Studio has now —
  // the file that decides who may call each function, rewritten by nobody. So it only goes up when the server has
  // no such file; otherwise it stays home, and the stamp learns it on the next publish.
  const stale = added.filter((p) => ROOT_FILES.includes(p));
  let current = null;
  if (stale.length) {
    current = await request(host, `${base}/code`, { token });
    const onServer = new Map((current.files || []).map((f) => [f.path, f.content]));
    const kept = [];
    for (const p of stale) {
      if (!onServer.has(p)) continue;                      // genuinely new: it goes up
      kept.push(p);
      if (hash(onServer.get(p)) !== hash(readFileSync(join(workspace, p), "utf8"))) {
        log(`  ⚠ ${p} exists here and on the server and this workspace predates it being tracked — NOT uploaded.`);
        log("    Edit it in Studio, or `fabapp dev --reset` to start from the server's copy (it deletes your edits).");
      }
    }
    added = added.filter((p) => !kept.includes(p));
  }
  // THE DEPENDENCIES YOU ADDED. `package.json` lives outside `src/`, so the fingerprint above never saw it: an
  // `npm install` here went nowhere, the import reached the build with nothing declared for it, and the build failed
  // with "failed to resolve import". Only the delta against what the platform handed over is sent, never the whole
  // file, which is mostly the platform's own floor.
  const deps = stamp.deps ? depChanges(stamp.deps, readDeps(workspace)) : null;
  const wantedDeps = deps ? { ...deps.added, ...deps.changed } : {};
  warnIgnored({ workspace, stamp, paths: [...changed, ...added], log });
  if (!deps) {
    log("  ⚠ This workspace was assembled by an older CLI and does not record its dependencies, so any you added are");
    log("    not sent (the platform still installs the ones your imports name). `fabapp dev --reset` fixes it.");
  } else if (deps.removed.length) {
    log(`\n  These dependencies disappeared from package.json and I did NOT remove them from the app: ${deps.removed.join(", ")}`);
  }

  if (removed.length) {
    // Reported BEFORE any early exit, and never applied. A removal IS a change — leaving quietly on "nothing
    // changed" would leave the person thinking `deploy` saw nothing, when what it saw was precisely the thing it
    // refuses to do. And not deleting is the same rule as `pull`: the workspace may be stale relative to the
    // server, and deleting there because of an absence here destroys work nobody asked us to manage.
    log(`\n  These files disappeared from the workspace and I did NOT delete them from the app:`);
    for (const p of removed) log(`    ? ${p}`);
    log("    Delete them in Studio if that was on purpose.\n");
  }

  if (!changed.length && !added.length && !Object.keys(wantedDeps).length) {
    log("  Nothing changed in the workspace since it was assembled.");
    if (!publish) return 0;
  }

  // The DESIRED set, not a delta: `PUT /code` replaces the whole list. It starts from what the server has right
  // now — which may have moved, if the AI edited the app in Studio meanwhile — and lays your edits on top. That way
  // the work over there does not vanish because of a stale workspace.
  current = current || await request(host, `${base}/code`, { token });
  const files = new Map((current.files || []).map((f) => [f.path, f.content]));
  for (const p of [...changed, ...added]) files.set(p, readFileSync(join(workspace, p), "utf8"));
  const sentDeps = mergeDeps(files, wantedDeps, stamp.deps || {}, log);

  const payload = [...files].map(([path, content]) => ({ path, content }));
  const saved = await request(host, `${base}/code`, {
    method: "PUT", token, body: { files: payload, code_rev: current.code_rev },
  });
  log(`  ✓ ${changed.length} edited, ${added.length} new · code_rev ${saved.code_rev}`);
  for (const p of [...changed, ...added]) log(`    ~ ${p}`);
  for (const [name, version] of Object.entries(sentDeps)) log(`    + ${name}@${version}`);
  if (saved.provided_ignored?.length) {
    // Without this, editing a platform file would be a save that answers 200 and changes nothing.
    log(`\n  These belong to the platform and the app cannot overwrite them — they were ignored:`);
    for (const p of saved.provided_ignored) log(`    ! ${p}`);
  }

  if (!publish) return 0;
  log("\n  Publishing…");
  const out = await request(host, `${base}/publish`, { method: "POST", token });
  // The fingerprint is rewritten: what just went up becomes the new baseline for "what changed".
  writeStamp(root, { ...stamp, files: fingerprint(workspace), deps: readDeps(workspace) });
  log(`  ✓ Live: ${out.bundle_url || "(no URL)"}`);
  if (out.template_sig && stamp.template && out.template_sig !== stamp.template) {
    log(`\n  ⚠ The platform built with template ${out.template_sig}; your workspace came from ${stamp.template}.`);
    log("    What you saw in `dev` may differ from what is live. `fabapp dev --reset` aligns the two.");
  }
  return 0;
}

/**
 * It lays the dependencies you added over the app's `package.json` as the SERVER has it, and returns what it sent.
 *
 * A package that came in the workspace but is NOT in the app's own manifest is the platform's floor (react, vite,
 * tailwind, the Radix packages): the build always installs the platform's version of those, so a new pin here would
 * be saved and never obeyed. It is named instead of sent.
 */
function mergeDeps(files, wanted, pristine, log) {
  if (!Object.keys(wanted).length) return {};
  let pkg = {};
  try { pkg = JSON.parse(files.get("package.json") || "{}") || {}; } catch { pkg = {}; }
  const own = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  const sent = {};
  const floor = [];
  for (const [name, version] of Object.entries(wanted)) {
    if (name in pristine && !(name in own)) { floor.push(name); continue; }
    pkg.dependencies = { ...(pkg.dependencies || {}), [name]: version };
    if (pkg.devDependencies) delete pkg.devDependencies[name];
    sent[name] = version;
  }
  if (floor.length) {
    log(`\n  These versions are the platform's and the build keeps its own, so I did not send them: ${floor.join(", ")}`);
  }
  if (Object.keys(sent).length) files.set("package.json", JSON.stringify(pkg, null, 2) + "\n");
  return sent;
}

/**
 * What the platform ignores, said BEFORE the upload rather than discovered after a build that did not do it: an edit
 * to one of its root files, a build tool config, and a Tailwind `@plugin`/`@config` in a stylesheet.
 */
function warnIgnored({ workspace, stamp, paths, log }) {
  const now = platformFingerprint(workspace);
  const edited = stamp.platform ? Object.keys(now).filter((p) => stamp.platform[p] && stamp.platform[p] !== now[p]) : [];
  const stray = strayConfigs(workspace);
  const css = paths.filter((p) => /\.css$/i.test(p) && CSS_LOADER_RULE.test(readFileSync(join(workspace, p), "utf8")));
  if (!edited.length && !stray.length && !css.length) return;
  log("\n  ⚠ The build config is the platform's. These never reach the app:");
  for (const p of [...edited, ...stray]) log(`    ! ${p}`);
  for (const p of css) log(`    ! @plugin/@config in ${p}`);
  log("    A build plugin is enabled by adding an ALLOWED package to package.json (the list is in `fabapp_docs`).");
}
