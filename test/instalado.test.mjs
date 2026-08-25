/**
 * O ARTEFATO, não o arquivo.
 *
 * Este teste existe porque a versão 0.1.0 foi publicada quebrada de um jeito que toda a minha suíte não via: o npm
 * publica o `bin` como SYMLINK, e o guarda de "sou o módulo principal" comparava `import.meta.url` com
 * `process.argv[1]` — que através do link é o caminho do LINK. `main()` nunca rodava. O comando saía com código 0
 * sem imprimir nada, o que parece sucesso.
 *
 * Eu testava `node src/index.mjs`, o caminho direto, onde a comparação dá certo. Testar o arquivo não é testar o
 * artefato. Aqui o pacote é EMPACOTADO, INSTALADO e chamado pelo binário, que é o que um cliente faz.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Empacota e instala o pacote num diretório limpo. Devolve o caminho do binário, pelo symlink. */
function instalar() {
  const dir = mkdtempSync(join(tmpdir(), "fab-cli-inst-"));
  const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: RAIZ, encoding: "utf8" }).trim();
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(dir, tgz)], { cwd: dir, stdio: "ignore" });
  return { dir, bin: join(dir, "node_modules", ".bin", "fabapp") };
}

test("o pacote INSTALADO responde quando chamado pelo binário", (t) => {
  const { dir, bin } = instalar();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.ok(existsSync(bin), "o npm não criou o binário `fabapp`");
  const saida = execFileSync(bin, ["help"], { encoding: "utf8" });
  assert.match(saida, /fabapp login/, "o binário saiu sem imprimir nada — o guarda de módulo principal não casou");
  assert.match(saida, /fabapp mcp/);
});

test("um comando inexistente sai com código 1 pelo binário instalado", (t) => {
  const { dir, bin } = instalar();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let code = 0;
  try { execFileSync(bin, ["comando-que-nao-existe"], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1, "um comando desconhecido tem de falhar — sair 0 faz um script achar que deu certo");
});

test("um comando que exige sessão explica isso, em vez de sair calado", (t) => {
  const { dir, bin } = instalar();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let saida = "";
  try { execFileSync(bin, ["pull"], { encoding: "utf8", stdio: "pipe", env: { ...process.env, FABAPP_API_URL: "http://127.0.0.1:1" } }); }
  catch (e) { saida = (e.stdout || "") + (e.stderr || ""); }
  assert.match(saida, /não está ligado a um projeto|sem autorização/,
               "saiu sem dizer o que fazer — é a falha que o 0.1.0 tinha, com outra roupa");
});
