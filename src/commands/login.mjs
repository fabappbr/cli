/** `fabapp login` — the device flow, from the side that has no credential yet. */
import { hostname } from "node:os";

import { request } from "../api.mjs";
import { CREDENTIALS_PATH, keychainAvailable, save } from "../credentials.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login({ host, scopes = "read write", open = true, log }) {
  const started = await request(host, "/cli/device/start", {
    method: "POST",
    body: { client_name: `fabapp-cli (${hostname()})`, scopes },
  });

  log(`\n  Open:  ${started.verification_uri}`);
  log(`  Code:  ${started.user_code}\n`);
  log("  Waiting for you to authorise…");
  if (open) tryOpen(started.verification_uri_complete);

  const deadline = Date.now() + started.expires_in * 1000;
  let interval = Math.max(1, started.interval) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the code expired — run `fabapp login` again");
    await sleep(interval);
    try {
      const issued = await request(host, "/cli/device/token", {
        method: "POST", body: { device_code: started.device_code },
      });
      const where = save(host, issued.access_token,
                         { account_id: issued.account_id, scope: issued.scope, name: issued.name });
      // WHERE the token went is SAID, not assumed. A tool that quietly falls back to a worse store teaches the
      // person it is always safe, and on the day it matters they have no idea which one they are on.
      if (where === "keychain") log("\n  ✓ Authorised. The token went into the system keychain.");
      else log(`\n  ✓ Authorised.\n  ⚠ No keychain available: the token is in ${CREDENTIALS_PATH} (mode 0600).`);
      log(`    Account ${issued.account_id} · scope: ${issued.scope}`);
      log("    To revoke: Studio → Settings → CLI, or `fabapp logout`.");
      return issued;
    } catch (e) {
      if (e.status === 400 && e.message === "authorization_pending") continue;
      if (e.status === 400 && e.message === "slow_down") { interval += 2000; continue; }
      if (e.status === 400 && e.message === "access_denied") throw new Error("the request was denied");
      if (e.status === 400 && e.message === "expired_token") throw new Error("the code expired — run `fabapp login` again");
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
