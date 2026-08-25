/**
 * O workspace local: o que veio da plataforma e o que VOCÊ mudou.
 *
 * A distinção é o que torna o `deploy` seguro. Um workspace tem as duas metades misturadas — as suas páginas ao
 * lado dos 57 componentes da plataforma —, e enviar tudo empurraria para dentro do `App.code` arquivos que o app
 * não é dono e que a plataforma reescreve a cada build. Por isso o momento em que ele é montado grava uma
 * IMPRESSÃO de cada arquivo, e daí em diante "o que mudou" é uma pergunta com resposta exata.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const STAMP = "workspace.json";
const SKIP = new Set(["node_modules", "dist", ".git", ".vite", ".fabapp"]);
/** Onde mora código do app. Fora disto é infraestrutura do build, e não tem por que viajar. */
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

/** Todo arquivo de código do workspace, como caminho relativo com barras normais em qualquer sistema. */
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

/** A impressão do workspace inteiro, gravada quando ele nasce. */
export function fingerprint(ws) {
  const out = {};
  for (const p of walkWorkspace(ws)) out[p] = hash(readFileSync(join(ws, p)));
  return out;
}

/**
 * O que mudou desde que o workspace foi montado.
 *
 * `removed` é RELATADO e não aplicado, pela mesma razão do `pull`: o workspace pode estar velho em relação ao
 * servidor (a IA pode ter editado o app no Studio nesse meio-tempo), e apagar do lado de lá por causa de uma
 * ausência aqui destrói trabalho que ninguém pediu para gerenciar.
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
 * Um caminho vindo do SERVIDOR, resolvido dentro de `root` — ou um erro.
 *
 * `join(root, ...'../../.ssh/authorized_keys'.split('/'))` sai de `root` e escreve no diretório de outra pessoa. É
 * preciso que a API esteja comprometida, ou que `FABAPP_API_URL` aponte para um host hostil, para chegar aqui — e é
 * exatamente por isso que a checagem existe: uma ferramenta de sync que escreve fora da própria pasta não tem como
 * ser confiada quando qualquer uma dessas duas coisas acontecer.
 */
export function safeJoin(root, relPath) {
  const target = resolve(root, ...String(relPath).split("/"));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`o servidor mandou um caminho que sai do projeto: ${relPath}`);
  }
  return target;
}
