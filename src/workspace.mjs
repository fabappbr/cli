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
/**
 * App code that lives at the ROOT of the workspace rather than under a folder. The platform documents both as going
 * up with `deploy`, and they are not optional: `fab.functions.json` decides who may call each function. Walking only
 * the folders left it behind, so every function deployed from here ran under the fail-closed default ("user") — a
 * `public` contact form refused visitors and a `role:<slug>` function let in any signed-in user.
 */
export const ROOT_FILES = ["fab.functions.json", "fab.agents.json"];

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
  for (const f of ROOT_FILES) if (existsSync(join(ws, f)) && statSync(join(ws, f)).isFile()) out.push(f);
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
 * The workspace's DEPENDENCIES, `dependencies` and `devDependencies` together. The platform installs both the same
 * way (an SPA bundle has no use for the split), and `npm i -D` is how most plugin READMEs say to install one.
 */
export function readDeps(ws) {
  try {
    const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8")) || {};
    return { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  } catch { return {}; }
}

/** What moved in the dependencies since the workspace was assembled. `removed` is reported and never applied, for
 *  the same reason as a removed file (see `changes`). */
export function depChanges(pristine, now) {
  const added = {};
  const changed = {};
  for (const [name, version] of Object.entries(now)) {
    if (!(name in pristine)) added[name] = version;
    else if (pristine[name] !== version) changed[name] = version;
  }
  const removed = Object.keys(pristine).filter((name) => !(name in now));
  return { added, changed, removed };
}

/**
 * The platform's files at the workspace root. They are rewritten from the template on every build, so an edit to one
 * of them never reaches the app; fingerprinting them is what lets `deploy` say so instead of letting it look sent.
 */
export const PLATFORM_ROOT = ["vite.config.ts", "index.html", "tsconfig.json", "tsconfig.node.json", "lazy-routes.ts",
                              "fab-plugins.ts", "fab-plugins.json"];
export function platformFingerprint(ws) {
  const out = {};
  for (const p of PLATFORM_ROOT) if (existsSync(join(ws, p))) out[p] = hash(readFileSync(join(ws, p)));
  return out;
}

/** A build tool's config at the workspace root, which the platform never runs (the build config is its own). The same
 *  names the server refuses; `vite.config.ts` is the platform's and is covered by `platformFingerprint`. */
const BUILD_CONFIG = /^(?:(?:vite|vitest|postcss|tailwind|babel|svgr)\.config\.(?:[cm]?[jt]s|json)|\.postcssrc(?:\..+)?|\.babelrc(?:\..+)?|\.svgrrc(?:\..+)?)$/i;
export function strayConfigs(ws) {
  return readdirSync(ws).filter((f) => BUILD_CONFIG.test(f) && f !== "vite.config.ts").sort();
}

/** A stylesheet directive that loads a module into Tailwind. The platform strips it from the app's CSS: plugins are
 *  enabled by declaring an allowed package instead (see `fabapp_docs`). */
export const CSS_LOADER_RULE = /(^|[;{}])[ \t\r\n]*@(plugin|config)\b[^;{]*(\{[^}]*\}|;)/i;

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
