/**
 * The CLI, against a server that answers like the real one — and sometimes like a broken one.
 *
 * The two tests that matter most are the ones about NOT doing something: `link` must not leave a config file
 * behind when it could not verify access, and `pull` must not delete a file the server did not mention. A sync
 * tool that destroys work it was never asked to manage is worse than no sync tool.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApiError, request } from "../src/api.mjs";
import { findRoot, read, write } from "../src/config.mjs";
import { create } from "../src/commands/create.mjs";
import { link } from "../src/commands/link.mjs";
import { pull, push } from "../src/commands/sync.mjs";

const quiet = () => {};

/**
 * A server whose answer each test decides.
 *
 * It closes through `t.after`, and that is not tidiness: an HTTP server holds the event loop open, so a
 * `s.close()` written after the assertions never runs when one FAILS — and `node --test` then hangs instead of
 * reporting. The tests would be silent at exactly the moment they had something to say. Found by mutating the
 * code they cover and watching the run stop producing output.
 */
async function server(t, handler) {
  const calls = [];
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    const answer = handler({ method: req.method, url: req.url, body }) || {};
    res.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/json" });
    res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  return { host: `http://localhost:${srv.address().port}`, calls };
}

const dir = () => mkdtempSync(join(tmpdir(), "fab-cli-"));

const PROJECT_FILES = [
  { path: "fab.schema.json", content: '{\n  "models": []\n}\n' },
  { path: "apps/loja/fab.config.json", content: '{\n  "kind": "app"\n}\n' },
];

// ---- create -----------------------------------------------------------------------------------------------------

test("create makes the project AND a surface, then links the directory", async (t) => {
  // A project with no surface has nothing to publish, so both are created here rather than leaving the second for
  // a later command to remember.
  const s = await server(t, ({ url }) => url.includes("/apps")
    ? { body: { id: "a1", slug: "meu-app" } }
    : { body: { id: "p1", name: "Meu app" } });
  const root = dir();

  const out = await create({ host: s.host, token: "t", accountId: "acc-1", name: "Meu app", root, log: quiet });

  assert.equal(out.project.id, "p1");
  assert.equal(out.app.id, "a1");
  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url}`), ["POST /projects", "POST /projects/p1/apps"]);
  assert.equal(s.calls[0].body.account_id, "acc-1");
  assert.equal(read(root).project_id, "p1");
});

test("a surface that fails leaves the project ALIVE and says so", async (t) => {
  // Deleting somebody's just-created project because a second call failed is a worse outcome than an empty project
  // they can finish by hand. The id has to reach them, or the project is lost without being deleted.
  const s = await server(t, ({ url }) => url.includes("/apps")
    ? { status: 500, body: { detail: "deu ruim" } }
    : { body: { id: "p9", name: "Meu app" } });
  const lines = [];

  const out = await create({ host: s.host, token: "t", accountId: "acc-1", name: "Meu app",
                             root: dir(), log: (l) => lines.push(l) });

  assert.equal(out.app, null);
  assert.equal(out.project.id, "p9");
  assert.match(lines.join("\n"), /p9/, "the id of the surviving project must reach the person");
  assert.match(lines.join("\n"), /stays/);
});

test("create refuses an empty name instead of making an unnamed project", async (t) => {
  const s = await server(t, () => ({ body: {} }));
  await assert.rejects(() => create({ host: s.host, token: "t", accountId: "a", name: "  ", root: dir(), log: quiet }),
                       /give the project a name/);
  assert.equal(s.calls.length, 0, "it must not reach the server at all");
});

test("create does not link when asked not to", async (t) => {
  const s = await server(t, ({ url }) => url.includes("/apps") ? { body: { id: "a1", slug: "s" } } : { body: { id: "p1" } });
  const root = dir();
  await create({ host: s.host, token: "t", accountId: "a", name: "X", root, log: quiet, link: false });
  assert.equal(findRoot(root), null);
});

// ---- link -------------------------------------------------------------------------------------------------------

test("link verifies access BEFORE writing anything to disk", async (t) => {
  // A link written first and validated later leaves a directory claiming to be a project nobody can reach, and
  // every later command fails with a confusing error instead of the honest one, while it can still be fixed.
  const s = await server(t, () => ({ status: 403, body: { detail: "sem acesso a esta conta" } }));
  const root = dir();
  await assert.rejects(() => link({ host: s.host, token: "t", projectId: "p1", root, log: quiet }),
                       /not found, or this account has no access/);
  assert.equal(existsSync(join(root, ".fabapp", "config.json")), false, "left a link behind after failing");
});

test("link says the same thing for 'not yours' and 'does not exist'", async (t) => {
  for (const status of [403, 404]) {
    const s = await server(t, () => ({ status, body: { detail: "x" } }));
    const root = dir();
    const err = await link({ host: s.host, token: "t", projectId: "p1", root, log: quiet }).catch((e) => e);
    assert.match(err.message, /not found, or this account has no access/);
  }
});

test("link writes the project, and never the token", async (t) => {
  const s = await server(t, () => ({ body: { files: [] } }));
  const root = dir();
  await link({ host: s.host, token: "segredo-do-token", projectId: "p1", root, log: quiet });
  const raw = readFileSync(join(root, ".fabapp", "config.json"), "utf8");
  assert.equal(read(root).project_id, "p1");
  assert.ok(!raw.includes("segredo-do-token"), "the link file must be safe to commit");
});

// ---- pull -------------------------------------------------------------------------------------------------------

test("pull writes the files and reports only what changed", async (t) => {
  const s = await server(t, () => ({ body: { files: PROJECT_FILES } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });

  const first = await pull({ host: s.host, token: "t", projectId: "p1", root, log: quiet });
  assert.equal(first.written.length, 2);
  assert.equal(readFileSync(join(root, "apps", "loja", "fab.config.json"), "utf8"), '{\n  "kind": "app"\n}\n');

  const second = await pull({ host: s.host, token: "t", projectId: "p1", root, log: quiet });
  assert.deepEqual(second.written, [], "nothing changed, so nothing should be reported as changed");
});

test("pull REPORTS a file the project no longer has, and does not delete it", async (t) => {
  const s = await server(t, () => ({ body: { files: [PROJECT_FILES[0]] } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  writeFileSync(join(root, "fab.settings.json"), "{}\n");

  const out = await pull({ host: s.host, token: "t", projectId: "p1", root, log: quiet });
  assert.deepEqual(out.orphans, ["fab.settings.json"]);
  assert.equal(existsSync(join(root, "fab.settings.json")), true, "deleted a file it was never asked to manage");
});

test("pull ignores what is not the CLI's to manage", async (t) => {
  const s = await server(t, () => ({ body: { files: [PROJECT_FILES[0]] } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x.json"), "{}");
  writeFileSync(join(root, "package.json"), "{}");

  const out = await pull({ host: s.host, token: "t", projectId: "p1", root, log: quiet });
  assert.deepEqual(out.orphans, []);
});

// ---- push -------------------------------------------------------------------------------------------------------

test("push sends the project's files and nothing else in the folder", async (t) => {
  const s = await server(t, () => ({ body: { applied: ["schema"] } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  writeFileSync(join(root, "fab.schema.json"), "{}\n");
  writeFileSync(join(root, "package.json"), '{"name":"nao-e-do-cli"}');
  mkdirSync(join(root, "apps", "loja"), { recursive: true });
  writeFileSync(join(root, "apps", "loja", "fab.config.json"), "{}\n");

  await push({ host: s.host, token: "t", projectId: "p1", root, log: quiet });
  const sent = s.calls.at(-1).body.files.map((f) => f.path).sort();
  assert.deepEqual(sent, ["apps/loja/fab.config.json", "fab.schema.json"]);
});

test("push carries the token, and refuses when there is nothing to send", async (t) => {
  const s = await server(t, () => ({ body: {} }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  await assert.rejects(() => push({ host: s.host, token: "t", projectId: "p1", root, log: quiet }),
                       /run `fabapp pull` first/);

  writeFileSync(join(root, "fab.schema.json"), "{}\n");
  await push({ host: s.host, token: "tok-123", projectId: "p1", root, log: quiet });
  assert.equal(s.calls.at(-1).auth, "Bearer tok-123");
});

test("push reports what the platform added on its own", async (t) => {
  const lines = [];
  const s = await server(t, () => ({ body: { applied: ["schema"], added_by_platform: ["notification"] } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  writeFileSync(join(root, "fab.schema.json"), "{}\n");

  await push({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l) });
  assert.ok(lines.join("\n").includes("notification"), "a model that appeared must be said, not discovered later");
});

// ---- the link file ------------------------------------------------------------------------------------------------

test("findRoot walks up, the way git finds its root", () => {
  const root = dir();
  write(root, { host: "h", project_id: "p1" });
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  assert.equal(findRoot(deep), root);
  assert.equal(findRoot(tmpdir()), null);
});

// ---- errors -------------------------------------------------------------------------------------------------------

test("a gateway's HTML error becomes one readable line", async (t) => {
  const s = await server(t, () => ({ status: 502, type: "text/html", raw: "<html><body><h1>502 Bad Gateway</h1></body></html>" }));
  const err = await request(s.host, "/x").catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 502);
  assert.match(err.message, /502 Bad Gateway/);
  assert.doesNotMatch(err.message, /</, "printing a raw HTML page into a terminal helps nobody");
});

test("a file error names the file and the reason", async (t) => {
  const s = await server(t, () => ({ status: 400, body: { detail: { file: "fab.schema.json", errors: ["invalid JSON"], message: "fab.schema.json: invalid JSON" } } }));
  const err = await request(s.host, "/x", { method: "POST", body: {} }).catch((e) => e);
  assert.equal(err.message, "fab.schema.json: invalid JSON");
});

test("a host that is not there says so, instead of throwing a TypeError", async (t) => {
  const err = await request("http://127.0.0.1:1", "/x").catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 0);
  assert.match(err.message, /could not reach/);
});

// ---- dev ---------------------------------------------------------------------------------------------------------

import { dev } from "../src/commands/dev.mjs";

/** A workspace that already exists, with the person's edits in it and a stamp saying where it came from. */
function existingWorkspace(root, templateSig) {
  const ws = join(root, ".fabapp", "workspace");
  mkdirSync(join(ws, "node_modules"), { recursive: true });
  mkdirSync(join(ws, "src", "pages"), { recursive: true });
  writeFileSync(join(ws, "package.json"), '{"name":"app"}');
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// O QUE A PESSOA EDITOU");
  writeFileSync(join(root, ".fabapp", "workspace.json"),
                JSON.stringify({ app_id: "a1", template: templateSig }));
  return ws;
}

const APPS = [{ id: "a1", slug: "loja", template_sig: "tpl-aaaa" }];

test("dev refuses to guess which surface to run when there is more than one", async (t) => {
  const s = await server(t, () => ({ body: [{ id: "a1", slug: "loja" }, { id: "a2", slug: "admin" }] }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  await assert.rejects(() => dev({ host: s.host, token: "t", projectId: "p1", root, log: quiet,
                                   install: () => {}, run: () => 0 }),
                       /pick one with --app/);
});

test("dev names the surfaces it knows when the one asked for is not there", async (t) => {
  const s = await server(t, () => ({ body: APPS }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  await assert.rejects(() => dev({ host: s.host, token: "t", projectId: "p1", root, app: "inexistente",
                                   log: quiet, install: () => {}, run: () => 0 }),
                       /no surface named 'inexistente'.*loja/);
});

test("dev does NOT touch an existing workspace, even when the template moved on", async (t) => {
  // The person edits INSIDE the workspace while `dev` runs. Re-downloading over it would delete their work — the
  // same rule `pull` follows. Saying it and letting them decide is the whole job here.
  const s = await server(t, () => ({ body: APPS }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  const ws = existingWorkspace(root, "tpl-VELHO");

  const lines = [];
  await dev({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l),
              install: () => {}, run: () => 0 });

  assert.equal(readFileSync(join(ws, "src", "pages", "Home.tsx"), "utf8"), "// O QUE A PESSOA EDITOU");
  const said = lines.join("\n");
  assert.match(said, /template changed/);
  assert.match(said, /tpl-VELHO/);
  assert.match(said, /tpl-aaaa/);
  assert.match(said, /--reset/);
  // And it never silently downloaded: the only call was the surface listing.
  assert.equal(s.calls.filter((c) => c.url.includes("export")).length, 0);
});

test("dev stays quiet when the template matches", async (t) => {
  const s = await server(t, () => ({ body: APPS }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  existingWorkspace(root, "tpl-aaaa");

  const lines = [];
  await dev({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l),
              install: () => {}, run: () => 0 });
  assert.doesNotMatch(lines.join("\n"), /template changed/);
});

test("dev warns when the workspace cannot say where it came from", async (t) => {
  // An unstamped workspace is one nothing can vouch for. Silence there would be the same silent divergence with an
  // extra step.
  const s = await server(t, () => ({ body: APPS }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  existingWorkspace(root, "");

  const lines = [];
  await dev({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l),
              install: () => {}, run: () => 0 });
  assert.match(lines.join("\n"), /does not record which template it came from/);
});

test("dev installs only when node_modules is missing, and always runs", async (t) => {
  const s = await server(t, () => ({ body: APPS }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  const ws = existingWorkspace(root, "tpl-aaaa");

  let installs = 0;
  let ran = null;
  const opts = { host: s.host, token: "t", projectId: "p1", root, log: quiet,
                 install: () => { installs++; }, run: (w, port) => { ran = { w, port }; return 0; } };

  await dev(opts);
  assert.equal(installs, 0, "node_modules is there — installing again would cost minutes for nothing");
  assert.equal(ran.w, ws);

  rmSync(join(ws, "node_modules"), { recursive: true });
  await dev(opts);
  assert.equal(installs, 1);
});

// ---- deploy ------------------------------------------------------------------------------------------------------

import { deploy } from "../src/commands/deploy.mjs";
import { changes, fingerprint, writeStamp } from "../src/workspace.mjs";

/** A workspace as `dev` leaves it: the platform's files and the app's, with a fingerprint of both. */
function stampedWorkspace(root, host, extra = {}) {
  const ws = join(root, ".fabapp", "workspace");
  mkdirSync(join(ws, "src", "pages"), { recursive: true });
  mkdirSync(join(ws, "src", "components", "ui"), { recursive: true });
  writeFileSync(join(ws, "package.json"), '{"name":"app"}');
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// gerado pela IA");
  writeFileSync(join(ws, "src", "components", "ui", "button.tsx"), "// da plataforma");
  write(root, { host, project_id: "p1" });
  writeStamp(root, { app_id: "a1", template: "tpl-aaaa", files: fingerprint(ws), ...extra });
  return ws;
}

test("deploy sends ONLY what you changed, never the platform's untouched files", async (t) => {
  // The workspace mixes both halves. Sending everything would push the platform's 57 UI components into the app's
  // stored code — files the app does not own and the build overwrites anyway.
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 8, provided_ignored: [] } }
    : { body: { files: [{ path: "src/pages/Home.tsx", content: "// gerado pela IA" }], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");
  writeFileSync(join(ws, "src", "pages", "Sobre.tsx"), "// NOVA");

  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet, publish: false });

  const put = s.calls.find((c) => c.method === "PUT");
  const sent = Object.fromEntries(put.body.files.map((f) => [f.path, f.content]));
  assert.equal(sent["src/pages/Home.tsx"], "// EU EDITEI");
  assert.equal(sent["src/pages/Sobre.tsx"], "// NOVA");
  assert.ok(!("src/components/ui/button.tsx" in sent), "sent an untouched platform file");
});

test("deploy starts from what the SERVER has, so work done in the Studio is not lost", async (t) => {
  // The workspace can be old: the AI may have edited the app in the Studio meanwhile. Sending only local files
  // would delete that work by omission, because the save replaces the whole set.
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 9 } }
    : { body: { files: [{ path: "src/pages/Home.tsx", content: "// gerado pela IA" },
                        { path: "src/pages/FeitoNoStudio.tsx", content: "// veio de lá" }], code_rev: 8 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet, publish: false });
  const sent = s.calls.find((c) => c.method === "PUT").body.files.map((f) => f.path);
  assert.ok(sent.includes("src/pages/FeitoNoStudio.tsx"), "dropped a file that only existed on the server");
});

test("deploy carries the code_rev, so a concurrent build is a conflict and not a silent overwrite", async (t) => {
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 8 } }
    : { body: { files: [], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet, publish: false });
  assert.equal(s.calls.find((c) => c.method === "PUT").body.code_rev, 7);
});

test("a file you deleted is reported, and saves nothing when it is the only difference", async (t) => {
  // A removal IS a difference, so staying silent would leave the person thinking `deploy` saw nothing — when what
  // it saw is exactly what it refuses to do. And with nothing else changed there is nothing to save: the desired
  // set equals what the server already has, so a PUT would only bump a version for no reason.
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 8 } }
    : { body: { files: [{ path: "src/pages/Home.tsx", content: "// gerado pela IA" }], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  rmSync(join(ws, "src", "pages", "Home.tsx"));

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  assert.match(lines.join("\n"), /did NOT delete them/);
  assert.equal(s.calls.filter((c) => c.method === "PUT").length, 0);
});

test("a deletion never travels, even when something else did change", async (t) => {
  // The workspace can be old — the AI may have edited in the Studio meanwhile. Letting an absence here delete
  // there destroys work nobody asked this tool to manage.
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 8 } }
    : { body: { files: [{ path: "src/pages/Home.tsx", content: "// gerado pela IA" },
                        { path: "src/components/ui/button.tsx", content: "// da plataforma" }], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  rmSync(join(ws, "src", "pages", "Home.tsx"));
  writeFileSync(join(ws, "src", "pages", "Outra.tsx"), "// nova");

  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet, publish: false });
  const sent = s.calls.find((c) => c.method === "PUT").body.files.map((f) => f.path);
  assert.ok(sent.includes("src/pages/Home.tsx"), "an absence in a stale workspace deleted work on the server");
  assert.ok(sent.includes("src/pages/Outra.tsx"));
});

test("deploy says which edits the platform refused to keep", async (t) => {
  // Otherwise editing a platform file is a save that answers 200 and changes nothing.
  const s = await server(t, ({ method }) => (method === "PUT"
    ? { body: { ok: true, code_rev: 8, provided_ignored: ["src/lib/fab-client.tsx"] } }
    : { body: { files: [], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  mkdirSync(join(ws, "src", "lib"), { recursive: true });
  writeFileSync(join(ws, "src", "lib", "fab-client.tsx"), "// tentei editar o SDK");

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  assert.match(lines.join("\n"), /cannot overwrite them/);
  assert.match(lines.join("\n"), /fab-client\.tsx/);
});

test("deploy publishes after saving, in that order", async (t) => {
  const s = await server(t, ({ method, url }) => (url.endsWith("/publish")
    ? { body: { bundle_url: "https://loja.fabapp.app", template_sig: "tpl-aaaa" } }
    : method === "PUT" ? { body: { ok: true, code_rev: 8 } } : { body: { files: [], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l) });
  const order = s.calls.map((c) => `${c.method} ${c.url.split("/apps/a1")[1]}`);
  assert.deepEqual(order, ["GET /code", "PUT /code", "POST /publish"],
                   "publishing before saving would ship the SERVER's code and look like it worked");
  assert.match(lines.join("\n"), /loja\.fabapp\.app/);
});

test("deploy warns when what went live was built on a different template", async (t) => {
  const s = await server(t, ({ method, url }) => (url.endsWith("/publish")
    ? { body: { bundle_url: "https://loja.fabapp.app", template_sig: "tpl-OUTRO" } }
    : method === "PUT" ? { body: { ok: true, code_rev: 8 } } : { body: { files: [], code_rev: 7 } }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /tpl-OUTRO/);
  assert.match(lines.join("\n"), /may differ from what is live/);
});

test("deploy refuses a workspace an older CLI left without a fingerprint", async (t) => {
  const s = await server(t, () => ({ body: {} }));
  const root = dir();
  const ws = stampedWorkspace(root, s.host);
  writeStamp(root, { app_id: "a1", template: "tpl-aaaa" });      // no `files`
  await assert.rejects(() => deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet }),
                       /does not record what came from/);
});

test("changes() tells apart edited, new and removed", () => {
  const root = dir();
  const ws = stampedWorkspace(root, "http://x");
  const pristine = fingerprint(ws);
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// mudou");
  writeFileSync(join(ws, "src", "pages", "Nova.tsx"), "// nova");
  rmSync(join(ws, "src", "components", "ui", "button.tsx"));

  const out = changes(ws, pristine);
  assert.deepEqual(out.changed, ["src/pages/Home.tsx"]);
  assert.deepEqual(out.added, ["src/pages/Nova.tsx"]);
  assert.deepEqual(out.removed, ["src/components/ui/button.tsx"]);
});

test("the root manifests travel with the code", () => {
  // `fab.functions.json` decides who may call each function. Left behind, every function ran under the default
  // ("user") whatever the manifest said — a `public` form refused visitors, a `role:` function let anyone in.
  const root = dir();
  const ws = stampedWorkspace(root, "http://x");
  const pristine = fingerprint(ws);
  writeFileSync(join(ws, "fab.functions.json"), '{ "functions": { "contact": { "auth": "public" } } }');
  writeFileSync(join(ws, "fab.agents.json"), '{ "agents": [] }');
  writeFileSync(join(ws, "vite.config.ts"), "// platform-owned, stays home");

  assert.deepEqual(changes(ws, pristine).added, ["fab.agents.json", "fab.functions.json"]);
});

test("deploy does not put an untracked root manifest over the server's", async (t) => {
  // A workspace assembled by an older CLI: `fab.functions.json` is on disk (the export brought it) but not in the
  // stamp. The Studio has since tightened the manifest. The stale copy must stay home.
  const puts = [];
  const s = await server(t, ({ method, body }) => {
    if (method === "PUT") { puts.push(body); return { body: { ok: true, code_rev: 2, provided_ignored: [] } }; }
    return { body: { files: [{ path: "fab.functions.json", content: '{"functions":{"contact":{"auth":"role:admin"}}}' }],
                     code_rev: 1 } };
  });
  const root = dir();
  const ws = stampedWorkspace(root, s.host);                       // the stamp has no root manifest
  writeFileSync(join(ws, "fab.functions.json"), '{"functions":{"contact":{"auth":"public"}}}');
  writeFileSync(join(ws, "fab.agents.json"), '{"agents":[]}');    // absent on the server: genuinely new
  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });

  const sent = new Map(puts[0].files.map((f) => [f.path, f.content]));
  assert.equal(sent.get("fab.functions.json"), '{"functions":{"contact":{"auth":"role:admin"}}}');   // the server's stays
  assert.equal(sent.get("fab.agents.json"), '{"agents":[]}');
  assert.ok(lines.some((l) => l.includes("fab.functions.json") && l.includes("NOT uploaded")));
});

test("a path from the server that escapes the project is refused", async (t) => {
  // `join(root, ...'../../.ssh/authorized_keys'.split('/'))` lands in somebody else's home directory. Getting here
  // needs a compromised API or FABAPP_API_URL pointed at a hostile host — which is exactly why the check exists: a
  // sync tool that writes outside its own folder cannot be trusted on the day either of those happens.
  const { safeJoin } = await import("../src/workspace.mjs");
  const root = dir();
  assert.equal(safeJoin(root, "fab.schema.json"), join(root, "fab.schema.json"));
  assert.equal(safeJoin(root, "apps/loja/fab.config.json"), join(root, "apps", "loja", "fab.config.json"));
  assert.equal(safeJoin(root, "/etc/passwd"), join(root, "etc", "passwd"));   // an absolute path stays inside
  for (const bad of ["../../.ssh/authorized_keys", "a/../../b", "../fora.json"]) {
    assert.throws(() => safeJoin(root, bad), /escapes the project/, bad);
  }
});

test("pull refuses to write a file the server placed outside the project", async (t) => {
  const s = await server(t, () => ({ body: { files: [{ path: "../ESCAPOU.json", content: "{}" }] } }));
  const root = dir();
  write(root, { host: s.host, project_id: "p1" });
  await assert.rejects(() => pull({ host: s.host, token: "t", projectId: "p1", root, log: quiet }),
                       /escapes the project/);
  assert.equal(existsSync(join(root, "..", "ESCAPOU.json")), false);
});

// ---- deploy: dependencies and what the platform ignores ------------------------------------------------------------

import { platformFingerprint, readDeps } from "../src/workspace.mjs";

/** A workspace whose package.json is the MERGED one the export ships: the platform's floor plus the app's own deps. */
function workspaceWithDeps(root, host) {
  const ws = stampedWorkspace(root, host);
  writeFileSync(join(ws, "package.json"), JSON.stringify({
    dependencies: { react: "19.0.0", "@dnd-kit/core": "^6.3.1" }, devDependencies: { vite: "^6.0.11" } }));
  writeFileSync(join(ws, "vite.config.ts"), "// the platform's");
  writeStamp(root, { app_id: "a1", template: "tpl-aaaa", files: fingerprint(ws), deps: readDeps(ws),
                     platform: platformFingerprint(ws) });
  return ws;
}
const SERVER_PKG = JSON.stringify({ dependencies: { "@dnd-kit/core": "^6.3.1" } });
const codeServer = (t, files) => server(t, ({ method }) => (method === "PUT"
  ? { body: { ok: true, code_rev: 8, provided_ignored: [] } }
  : { body: { files, code_rev: 7 } }));

test("deploy sends the dependencies you ADDED, merged into the app's own package.json", async (t) => {
  // package.json lives outside src/, so before this an `npm install` here went nowhere and the build failed to
  // resolve the import.
  const s = await codeServer(t, [{ path: "package.json", content: SERVER_PKG }]);
  const root = dir();
  const ws = workspaceWithDeps(root, s.host);
  const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
  pkg.dependencies["framer-motion"] = "^11.0.0";
  pkg.devDependencies["vite-plugin-svgr"] = "5.2.0";      // `npm i -D`, as the plugin's README says
  writeFileSync(join(ws, "package.json"), JSON.stringify(pkg));

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  const put = s.calls.find((c) => c.method === "PUT");
  const sent = JSON.parse(put.body.files.find((f) => f.path === "package.json").content);
  assert.deepEqual(sent.dependencies, { "@dnd-kit/core": "^6.3.1", "framer-motion": "^11.0.0", "vite-plugin-svgr": "5.2.0" },
                   "the app's own deps plus the new ones, and none of the platform's floor");
  assert.match(lines.join("\n"), /\+ framer-motion@\^11\.0\.0/);
});

test("a dependency change alone is a change worth saving", async (t) => {
  const s = await codeServer(t, [{ path: "package.json", content: SERVER_PKG }]);
  const root = dir();
  const ws = workspaceWithDeps(root, s.host);
  const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
  pkg.dependencies["@tailwindcss/typography"] = "0.5.20";
  writeFileSync(join(ws, "package.json"), JSON.stringify(pkg));

  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: quiet, publish: false });
  assert.equal(s.calls.filter((c) => c.method === "PUT").length, 1);
});

test("re-pinning a platform package is named, not sent: the build keeps its own version", async (t) => {
  const s = await codeServer(t, [{ path: "package.json", content: SERVER_PKG }]);
  const root = dir();
  const ws = workspaceWithDeps(root, s.host);
  const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
  pkg.dependencies.react = "19.2.0";
  writeFileSync(join(ws, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  const put = s.calls.find((c) => c.method === "PUT");
  assert.ok(!put.body.files.some((f) => f.path === "package.json" && f.content.includes("19.2.0")));
  assert.match(lines.join("\n"), /platform's and the build keeps its own.*react/);
});

test("deploy warns about what the platform ignores: its root files, build configs and @plugin in a stylesheet", async (t) => {
  const s = await codeServer(t, []);
  const root = dir();
  const ws = workspaceWithDeps(root, s.host);
  writeFileSync(join(ws, "vite.config.ts"), "// I added a plugin here");
  writeFileSync(join(ws, "postcss.config.js"), "export default {}");
  writeFileSync(join(ws, "src", "extra.css"), '@plugin "daisyui";\n');

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  const out = lines.join("\n");
  assert.match(out, /never reach the app/);
  assert.match(out, /! vite\.config\.ts/);
  assert.match(out, /! postcss\.config\.js/);
  assert.match(out, /@plugin\/@config in src\/extra\.css/);
});

test("a dependency removed here is reported and never removed from the app", async (t) => {
  const s = await codeServer(t, [{ path: "package.json", content: SERVER_PKG }]);
  const root = dir();
  const ws = workspaceWithDeps(root, s.host);
  const pkg = JSON.parse(readFileSync(join(ws, "package.json"), "utf8"));
  delete pkg.dependencies["@dnd-kit/core"];
  writeFileSync(join(ws, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(ws, "src", "pages", "Home.tsx"), "// EU EDITEI");

  const lines = [];
  await deploy({ host: s.host, token: "t", projectId: "p1", root, log: (l) => lines.push(l), publish: false });
  assert.match(lines.join("\n"), /did NOT remove them from the app: @dnd-kit\/core/);
  const put = s.calls.find((c) => c.method === "PUT");
  assert.ok(put.body.files.some((f) => f.path === "package.json" && f.content.includes("@dnd-kit/core")));
});
