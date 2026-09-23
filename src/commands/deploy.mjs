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
import { ROOT_FILES, changes, fingerprint, hash, readStamp, writeStamp } from "../workspace.mjs";

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

  if (removed.length) {
    // Reported BEFORE any early exit, and never applied. A removal IS a change — leaving quietly on "nothing
    // changed" would leave the person thinking `deploy` saw nothing, when what it saw was precisely the thing it
    // refuses to do. And not deleting is the same rule as `pull`: the workspace may be stale relative to the
    // server, and deleting there because of an absence here destroys work nobody asked us to manage.
    log(`\n  These files disappeared from the workspace and I did NOT delete them from the app:`);
    for (const p of removed) log(`    ? ${p}`);
    log("    Delete them in Studio if that was on purpose.\n");
  }

  if (!changed.length && !added.length) {
    log("  Nothing changed in the workspace since it was assembled.");
    if (!publish) return 0;
  }

  // The DESIRED set, not a delta: `PUT /code` replaces the whole list. It starts from what the server has right
  // now — which may have moved, if the AI edited the app in Studio meanwhile — and lays your edits on top. That way
  // the work over there does not vanish because of a stale workspace.
  current = current || await request(host, `${base}/code`, { token });
  const files = new Map((current.files || []).map((f) => [f.path, f.content]));
  for (const p of [...changed, ...added]) files.set(p, readFileSync(join(workspace, p), "utf8"));

  const payload = [...files].map(([path, content]) => ({ path, content }));
  const saved = await request(host, `${base}/code`, {
    method: "PUT", token, body: { files: payload, code_rev: current.code_rev },
  });
  log(`  ✓ ${changed.length} edited, ${added.length} new · code_rev ${saved.code_rev}`);
  for (const p of [...changed, ...added]) log(`    ~ ${p}`);
  if (saved.provided_ignored?.length) {
    // Without this, editing a platform file would be a save that answers 200 and changes nothing.
    log(`\n  These belong to the platform and the app cannot overwrite them — they were ignored:`);
    for (const p of saved.provided_ignored) log(`    ! ${p}`);
  }

  if (!publish) return 0;
  log("\n  Publishing…");
  const out = await request(host, `${base}/publish`, { method: "POST", token });
  // The fingerprint is rewritten: what just went up becomes the new baseline for "what changed".
  writeStamp(root, { ...stamp, files: fingerprint(workspace) });
  log(`  ✓ Live: ${out.bundle_url || "(no URL)"}`);
  if (out.template_sig && stamp.template && out.template_sig !== stamp.template) {
    log(`\n  ⚠ The platform built with template ${out.template_sig}; your workspace came from ${stamp.template}.`);
    log("    What you saw in `dev` may differ from what is live. `fabapp dev --reset` aligns the two.");
  }
  return 0;
}
