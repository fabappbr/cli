/**
 * Where the CLI keeps its token.
 *
 * The OS keychain first, and a `0600` file only as a fallback — with the fallback SAID OUT LOUD. A tool that
 * quietly drops to a worse place to keep a secret teaches the person that it is always safe, and the day it
 * matters they have no idea which one they are on.
 *
 * The keychain is reached by shelling out to the tool the OS already ships (`security` on macOS, `secret-tool` on
 * Linux). That is deliberate: the alternative is a native npm dependency, and a credential store is the last place
 * to want compiled code from a registry in the dependency graph.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "fabapp-cli";
const FILE = join(homedir(), ".config", "fabapp", "credentials.json");

function keychain(args, input) {
  return execFileSync(args[0], args.slice(1), {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

/** The keychain backend for this platform, or null when there is none to shell out to. */
function backend() {
  try {
    if (process.platform === "darwin") { keychain(["which", "security"]); return "macos"; }
    if (process.platform === "linux") { keychain(["which", "secret-tool"]); return "linux"; }
  } catch { /* no tool → the file fallback */ }
  return null;
}

function fileRead() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}

function fileWrite(data) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FILE, 0o600);      // explicit: an existing file keeps its old mode otherwise
}

/** Saves the token. Returns where it went, so the caller can tell the person. */
export function save(host, token, meta = {}) {
  const account = `${host}`;
  const kind = backend();
  const payload = JSON.stringify({ token, ...meta });
  try {
    if (kind === "macos") {
      keychain(["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", payload]);
      return "keychain";
    }
    if (kind === "linux") {
      keychain(["secret-tool", "store", "--label=" + SERVICE, "service", SERVICE, "account", account], payload);
      return "keychain";
    }
  } catch { /* fall through to the file, and SAY so */ }
  const all = fileRead();
  all[account] = { token, ...meta };
  fileWrite(all);
  return "file";
}

export function load(host) {
  const account = `${host}`;
  const kind = backend();
  try {
    if (kind === "macos") {
      return JSON.parse(keychain(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"]));
    }
    if (kind === "linux") {
      const raw = keychain(["secret-tool", "lookup", "service", SERVICE, "account", account]);
      if (raw) return JSON.parse(raw);
    }
  } catch { /* not there → try the file */ }
  return fileRead()[account] || null;
}

export function clear(host) {
  const account = `${host}`;
  const kind = backend();
  try {
    if (kind === "macos") keychain(["security", "delete-generic-password", "-s", SERVICE, "-a", account]);
    if (kind === "linux") keychain(["secret-tool", "clear", "service", SERVICE, "account", account]);
  } catch { /* it was not there */ }
  const all = fileRead();
  if (all[account]) { delete all[account]; fileWrite(all); }
  if (!Object.keys(all).length) { try { rmSync(FILE); } catch { /* already gone */ } }
}

export const CREDENTIALS_PATH = FILE;
export const keychainAvailable = () => backend() !== null;
