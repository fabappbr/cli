/**
 * `fabapp deploy` — o que você editou aqui vai para o ar.
 *
 * Dois passos, e a ordem importa: primeiro o código sobe (`PUT /code`, com compare-and-swap), depois o app é
 * publicado. Publicar sem subir publicaria o que está no SERVIDOR — o comando pareceria funcionar e o trabalho
 * local ficaria para trás, que é a pior forma de um deploy falhar.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { request } from "../api.mjs";
import { changes, fingerprint, readStamp, writeStamp } from "../workspace.mjs";

export async function deploy({ host, token, projectId, root, log, publish = true }) {
  const workspace = join(root, ".fabapp", "workspace");
  const stamp = readStamp(root);
  if (!existsSync(join(workspace, "package.json")) || !stamp?.app_id) {
    throw new Error("não há workspace local — rode `fabapp dev` primeiro");
  }
  const appId = stamp.app_id;
  const base = `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`;

  const pristine = stamp.files || {};
  if (!Object.keys(pristine).length) {
    throw new Error("este workspace foi montado por uma versão anterior do CLI e não registra o que veio da " +
                    "plataforma — rode `fabapp dev --reset` (ele apaga suas edições, então salve antes)");
  }
  const { changed, added, removed } = changes(workspace, pristine);

  if (removed.length) {
    // Relatado ANTES de qualquer atalho, e nunca aplicado. Uma remoção É mudança — sair calado por "nada mudou"
    // deixaria a pessoa achando que o `deploy` não viu nada, quando o que ele viu foi justamente o que ele se
    // recusa a fazer. E não apagar é a mesma regra do `pull`: o workspace pode estar velho em relação ao servidor,
    // e apagar lá por causa de uma ausência aqui destrói trabalho que ninguém pediu para gerenciar.
    log(`\n  Estes arquivos sumiram do workspace e eu NÃO os apaguei do app:`);
    for (const p of removed) log(`    ? ${p}`);
    log("    Apague pelo Studio se for de propósito.\n");
  }

  if (!changed.length && !added.length) {
    log("  Nada mudou no workspace desde que ele foi montado.");
    if (!publish) return 0;
  }

  // O conjunto DESEJADO, e não um delta: o `PUT /code` substitui a lista inteira. Parte-se do que o servidor tem
  // agora — que pode ter mudado, se a IA editou o app no Studio nesse meio-tempo — e aplicam-se as suas edições
  // por cima. Assim o trabalho de lá não some por causa de um workspace velho.
  const current = await request(host, `${base}/code`, { token });
  const files = new Map((current.files || []).map((f) => [f.path, f.content]));
  for (const p of [...changed, ...added]) files.set(p, readFileSync(join(workspace, p), "utf8"));

  const payload = [...files].map(([path, content]) => ({ path, content }));
  const saved = await request(host, `${base}/code`, {
    method: "PUT", token, body: { files: payload, code_rev: current.code_rev },
  });
  log(`  ✓ ${changed.length} editado(s), ${added.length} novo(s) · code_rev ${saved.code_rev}`);
  for (const p of [...changed, ...added]) log(`    ~ ${p}`);
  if (saved.provided_ignored?.length) {
    // Sem isto, editar um arquivo da plataforma seria um save que responde 200 e não muda nada.
    log(`\n  Estes são da plataforma e o app não pode reescrevê-los — foram ignorados:`);
    for (const p of saved.provided_ignored) log(`    ! ${p}`);
  }

  if (!publish) return 0;
  log("\n  Publicando…");
  const out = await request(host, `${base}/publish`, { method: "POST", token });
  // A impressão é regravada: o que acabou de subir passa a ser a nova base do "o que mudou".
  writeStamp(root, { ...stamp, files: fingerprint(workspace) });
  log(`  ✓ No ar: ${out.bundle_url || "(sem URL)"}`);
  if (out.template_sig && stamp.template && out.template_sig !== stamp.template) {
    log(`\n  ⚠ A plataforma buildou com o template ${out.template_sig}; seu workspace veio do ${stamp.template}.`);
    log("    O que você viu no `dev` pode diferir do que está no ar. `fabapp dev --reset` alinha os dois.");
  }
  return 0;
}
