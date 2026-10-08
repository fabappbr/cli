/**
 * `fabapp projects` — what this person can open, the clients' apps an agency manages included.
 *
 * It reads the same list the Studio's "Meus projetos" shows (`/projects/reachable`), so an agency sees its own apps
 * and every client app it manages, each with the account it belongs to. The account matters on screen because the
 * credits and the plan of a client app are the CLIENT's, not the agency's.
 *
 * `resolveAccount` is shared with `fabapp create --account`: it turns what a person types (an id, or a name) into the
 * account id the API wants, refusing anything ambiguous instead of guessing.
 */
import { request } from "../api.mjs";

export async function reachableAccounts({ host, token, accountId }) {
  const out = await request(host, `/projects/reachable/accounts?account_id=${encodeURIComponent(accountId)}&per_page=100`, { token });
  return out.items || [];
}

export async function resolveAccount({ host, token, accountId, wanted }) {
  if (!wanted) return accountId;
  const accounts = await reachableAccounts({ host, token, accountId });
  const exact = accounts.find((a) => a.id === wanted);
  if (exact) return exact.id;
  const needle = String(wanted).trim().toLowerCase();
  const byName = accounts.filter((a) => (a.name || "").toLowerCase() === needle);
  if (byName.length === 1) return byName[0].id;
  const partial = accounts.filter((a) => (a.name || "").toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0].id;
  const names = accounts.map((a) => `${a.name} (${a.id})`).join(", ");
  if (byName.length > 1 || partial.length > 1) {
    throw new Error(`more than one account matches '${wanted}' — use the id. Accounts: ${names}`);
  }
  throw new Error(`no account matches '${wanted}'. Accounts you can reach: ${names || "(none)"}`);
}

export async function projects({ host, token, accountId, owner, log }) {
  const accounts = await reachableAccounts({ host, token, accountId });
  const nameOf = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const ownerId = owner ? await resolveAccount({ host, token, accountId, wanted: owner }) : "";
  const q = new URLSearchParams({ account_id: accountId, per_page: "100" });
  if (ownerId) q.set("owner", ownerId);
  const page = await request(host, `/projects/reachable?${q}`, { token });
  const items = page.items || [];
  if (!items.length) {
    log("  No projects yet. Create one with `fabapp create \"My app\"` (add `--account <client>` for a client).");
    return items;
  }
  const rows = items.map((p) => {
    const acc = nameOf[p.account_id];
    const conta = acc ? `${acc.name}${acc.kind === "client" ? " · client" : ""}` : p.account_id;
    return [conta, p.name, p.id, p.published ? "published" : "draft"];
  });
  const head = ["ACCOUNT", "PROJECT", "ID", "STATE"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cols) => "  " + cols.map((c, i) => String(c).padEnd(widths[i])).join("   ");
  log(line(head));
  for (const r of rows) log(line(r));
  log("");
  log("  Link a folder with `fabapp link <id>`. AI credits used on a client's app come out of the client's account.");
  return items;
}
