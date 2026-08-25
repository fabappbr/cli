/**
 * THE ARTIFACT, not the file.
 *
 * This test exists because version 0.1.0 shipped broken in a way my whole suite could not see: npm publishes the
 * `bin` as a SYMLINK, and the "am I the main module" guard compared `import.meta.url` against `process.argv[1]` —
 * which through the link is the LINK's path. `main()` never ran. The command exited 0 printing nothing, which
 * looks like success.
 *
 * I was testing `node src/index.mjs`, the direct path, where the comparison holds. Testing the file is not testing
 * the artifact. Here the package is PACKED, INSTALLED and called through the binary, which is what a user does.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Packs and installs the package into a clean directory. Returns the binary's path, through the symlink. */
function install() {
  const dir = mkdtempSync(join(tmpdir(), "fab-cli-inst-"));
  const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: ROOT, encoding: "utf8" }).trim();
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(dir, tgz)], { cwd: dir, stdio: "ignore" });
  return { dir, bin: join(dir, "node_modules", ".bin", "fabapp") };
}

test("the INSTALLED package answers when called through the binary", (t) => {
  const { dir, bin } = install();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.ok(existsSync(bin), "npm did not create the `fabapp` binary");
  const out = execFileSync(bin, ["help"], { encoding: "utf8" });
  assert.match(out, /fabapp login/, "the binary exited printing nothing — the main-module guard did not match");
  assert.match(out, /fabapp mcp/);
});

test("an unknown command exits 1 through the installed binary", (t) => {
  const { dir, bin } = install();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let code = 0;
  try { execFileSync(bin, ["command-that-does-not-exist"], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1, "an unknown command has to fail — exiting 0 makes a script think it worked");
});

test("a command that needs a session says so, instead of exiting quietly", (t) => {
  const { dir, bin } = install();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let out = "";
  try { execFileSync(bin, ["pull"], { encoding: "utf8", stdio: "pipe", env: { ...process.env, FABAPP_API_URL: "http://127.0.0.1:1" } }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  assert.match(out, /not linked to a project|not authorised/,
               "it exited without saying what to do — that is the 0.1.0 failure wearing different clothes");
});
