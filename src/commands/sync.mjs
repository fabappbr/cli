/** `fabapp pull` and `fabapp push` — the round trip the previous phases made possible. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { request } from "../api.mjs";
import { safeJoin } from "../workspace.mjs";

/** Every file the CLI owns, as repo-relative paths with forward slashes on every platform. */
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".fabapp" || entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else if (entry.endsWith(".json")) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

export async function pull({ host, token, projectId, root, log }) {
  const { files } = await request(host, `/projects/${encodeURIComponent(projectId)}/files`, { token });
  const written = [];
  for (const file of files) {
    const target = safeJoin(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const before = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (before !== file.content) written.push(file.path);
    writeFileSync(target, file.content);
  }
  const known = new Set(files.map((f) => f.path));
  // A file the project no longer has is REPORTED, never deleted. Deleting somebody's file because the server did
  // not mention it is how a sync tool loses work it was never asked to manage.
  const orphans = walk(root).filter((p) => !known.has(p) && (p.startsWith("fab.") || p.startsWith("apps/")));

  log(`  ✓ ${files.length} file(s) · ${written.length} changed`);
  for (const p of written) log(`    ~ ${p}`);
  if (orphans.length) {
    log("\n  These files no longer exist in the project (I deleted none of them):");
    for (const p of orphans) log(`    ? ${p}`);
  }
  return { files, written, orphans };
}

export async function push({ host, token, projectId, root, log }) {
  const paths = walk(root).filter((p) => p.startsWith("fab.") || (p.startsWith("apps/") && p.endsWith("fab.config.json")));
  if (!paths.length) throw new Error("nothing to send — run `fabapp pull` first");

  const files = paths.map((p) => ({ path: p, content: readFileSync(join(root, ...p.split("/")), "utf8") }));
  const out = await request(host, `/projects/${encodeURIComponent(projectId)}/files`, {
    method: "POST", token, body: { files },
  });

  log(`  ✓ Sent: ${paths.join(", ")}`);
  if (out?.added_by_platform?.length) {
    // Applying NORMALISES, and a person who pushed exactly what they pulled and got a model back deserves to be
    // told here rather than to find it on the next pull and not know where it came from.
    log(`\n  The platform added: ${out.added_by_platform.join(", ")}`);
    log("    Run `fabapp pull` to bring that down to disk.");
  }
  for (const w of out?.warnings || []) log(`  ⚠ ${w}`);
  return out;
}
