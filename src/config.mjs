/**
 * The link between a directory and a project.
 *
 * It lives in `.fabapp/config.json` at the root of the working copy, and it holds NO credential — only which host
 * and which project this folder belongs to. That separation is the point: the link is safe to commit, and the
 * token never is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DIR = ".fabapp";
const FILE = "config.json";

/** Walks up from `start` looking for a linked directory, the way git finds its root. */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, DIR, FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function read(root) {
  return JSON.parse(readFileSync(join(root, DIR, FILE), "utf8"));
}

export function write(root, config) {
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, DIR, FILE), JSON.stringify(config, null, 2) + "\n");
  // A `pull` writes files next to whatever else is in the folder. The ignore file is written once, and it names
  // what must never be committed — the alternative is trusting that every user thinks of it themselves.
  const ignore = join(root, DIR, ".gitignore");
  // `workspace/` is a checkout of the app plus 335 MB of node_modules — it is a build directory, not source.
  if (!existsSync(ignore)) writeFileSync(ignore, "workspace/\n*.log\n");
}

export const CONFIG_DIR = DIR;
