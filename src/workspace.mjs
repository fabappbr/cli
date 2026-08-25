/**
 * The local workspace: what came from the platform, and what YOU changed.
 *
 * That distinction is what makes `deploy` safe. A workspace has both halves mixed together — your pages next to
 * the platform's 57 components — and sending all of it would push into `App.code` files the app does not own and
 * that the platform rewrites on every build. So the moment it is assembled records a FINGERPRINT of each file, and
 * from then on "what changed" is a question with an exact answer.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const STAMP = "workspace.json";
const SKIP = new Set(["node_modules", "dist", ".git", ".vite", ".fabapp"]);
/** Where app code lives. Outside of this is build infrastructure, and has no reason to travel. */
const ROOTS = ["src", "functions", "public"];

export function stampPath(root) { return join(root, ".fabapp", STAMP); }

export function readStamp(root) {
  try { return JSON.parse(readFileSync(stampPath(root), "utf8")); } catch { return null; }
}

export function writeStamp(root, stamp) {
  writeFileSync(stampPath(root), JSON.stringify(stamp, null, 2) + "\n");
}

export function hash(content) {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

/** Every code file in the workspace, as a relative path with forward slashes on any system. */
export function walkWorkspace(ws) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(ws, full).split(sep).join("/"));
    }
  };
  for (const r of ROOTS) if (existsSync(join(ws, r))) visit(join(ws, r));
  return out.sort();
}

/** The fingerprint of the whole workspace, taken when it is born. */
export function fingerprint(ws) {
  const out = {};
  for (const p of walkWorkspace(ws)) out[p] = hash(readFileSync(join(ws, p)));
  return out;
}

/**
 * What changed since the workspace was assembled.
 *
 * `removed` is REPORTED and not applied, for the same reason as `pull`: the workspace may be stale relative to the
 * server (the AI may have edited the app in Studio meanwhile), and deleting on that side because of an absence on
 * this one destroys work nobody asked us to manage.
 */
export function changes(ws, pristine) {
  const now = walkWorkspace(ws);
  const changed = [];
  const added = [];
  for (const p of now) {
    const h = hash(readFileSync(join(ws, p)));
    if (!(p in pristine)) added.push(p);
    else if (pristine[p] !== h) changed.push(p);
  }
  const present = new Set(now);
  const removed = Object.keys(pristine).filter((p) => !present.has(p));
  return { changed, added, removed };
}


/**
 * A path coming from the SERVER, resolved inside `root` — or an error.
 *
 * `join(root, ...'../../.ssh/authorized_keys'.split('/'))` escapes `root` and writes into somebody else's
 * directory. It takes a compromised API, or a `FABAPP_API_URL` pointing at a hostile host, to get here — and that
 * is exactly why the check exists: a sync tool that writes outside its own folder cannot be trusted on the day
 * either of those two things happens.
 */
export function safeJoin(root, relPath) {
  const target = resolve(root, ...String(relPath).split("/"));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`the server sent a path that escapes the project: ${relPath}`);
  }
  return target;
}
