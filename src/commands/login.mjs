/** `fabapp login` — the device flow, from the side that has no credential yet. */
import { request } from "../api.mjs";
import { CREDENTIALS_PATH, keychainAvailable, save } from "../credentials.mjs";
import { hostname } from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login({ host, scopes = "read write", open = true, log }) {
  const started = await request(host, "/cli/device/start", {
    method: "POST",
    body: { client_name: `fabapp-cli (${hostname()})`, scopes },
  });

  log(`\n  Abra:   ${started.verification_uri}`);
  log(`  Código: ${started.user_code}\n`);
  log("  Aguardando a autorização…");
  if (open) tryOpen(started.verification_uri_complete);

  const deadline = Date.now() + started.expires_in * 1000;
  let interval = Math.max(1, started.interval) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("o código expirou — rode `fabapp login` de novo");
    await sleep(interval);
    try {
      const issued = await request(host, "/cli/device/token", {
        method: "POST", body: { device_code: started.device_code },
      });
      const where = save(host, issued.access_token,
                         { account_id: issued.account_id, scope: issued.scope, name: issued.name });
      // Where the token went is SAID, not assumed. A tool that quietly falls back to a worse store teaches the
      // person it is always safe, and the day it matters they do not know which one they are on.
      if (where === "keychain") log("\n  ✓ Autorizado. O token ficou no chaveiro do sistema.");
      else log(`\n  ✓ Autorizado.\n  ⚠ Sem chaveiro disponível: o token ficou em ${CREDENTIALS_PATH} (modo 0600).`);
      log(`    Conta ${issued.account_id} · escopo: ${issued.scope}`);
      log("    Para revogar: Studio → Configurações → CLI, ou `fabapp logout`.");
      return issued;
    } catch (e) {
      if (e.status === 400 && e.message === "authorization_pending") continue;
      if (e.status === 400 && e.message === "slow_down") { interval += 2000; continue; }
      if (e.status === 400 && e.message === "access_denied") throw new Error("a autorização foi recusada");
      if (e.status === 400 && e.message === "expired_token") throw new Error("o código expirou — rode `fabapp login` de novo");
      throw e;
    }
  }
}

function tryOpen(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  import("node:child_process").then(({ spawn }) => {
    try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* the person opens it */ }
  }).catch(() => {});
}

export { keychainAvailable };
