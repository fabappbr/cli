/**
 * `fabapp dev` — o app rodando na sua máquina, com o mesmo template que a plataforma usa no build.
 *
 * O risco que este comando tem de tratar não é montar o workspace: é a DIVERGÊNCIA. O template — a casca, o SDK, os
 * componentes, o piso de dependências — é copiado do `services/gen-template` a cada build da plataforma, então uma
 * cópia local envelhece sozinha. O modo de falha é o pior possível para um comando chamado `dev`: funciona aqui,
 * sai diferente em produção, e nada avisa.
 *
 * Por isso o workspace guarda a ASSINATURA do template que veio dentro dele, e toda execução compara. Divergiu, ele
 * DIZ — e não conserta sozinho, porque consertar sozinho significaria escrever por cima do que você editou.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { request } from "../api.mjs";
import { fingerprint, readStamp, writeStamp } from "../workspace.mjs";

/** Unzips with whatever the OS ships. `unzip` first, `tar` second (bsdtar on macOS and Windows 10+ read zip). */
function unzip(zip, into) {
  mkdirSync(into, { recursive: true });
  for (const [cmd, args] of [["unzip", ["-q", "-o", zip, "-d", into]], ["tar", ["-xf", zip, "-C", into]]]) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return cmd;
    } catch { /* try the next one */ }
  }
  throw new Error("não achei `unzip` nem `tar` para descompactar o pacote");
}

/** The zip has a single top-level folder; the workspace is what is inside it. */
function onlyChild(dir) {
  const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
  if (entries.length === 1 && statSync(join(dir, entries[0])).isDirectory()) return join(dir, entries[0]);
  return dir;
}

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`não consegui baixar o pacote (${res.status})`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

async function pickApp({ host, token, projectId, wanted }) {
  const apps = await request(host, `/projects/${encodeURIComponent(projectId)}/apps`, { token });
  if (!apps.length) throw new Error("este projeto não tem nenhuma surface ainda");
  if (wanted) {
    const found = apps.find((a) => a.slug === wanted || a.id === wanted);
    if (!found) throw new Error(`não achei a surface '${wanted}' — tem: ${apps.map((a) => a.slug).join(", ")}`);
    return found;
  }
  if (apps.length > 1) {
    throw new Error(`este projeto tem ${apps.length} surfaces — escolha com --app ` +
                    `(${apps.map((a) => a.slug).join(", ")})`);
  }
  return apps[0];
}

/**
 * `run` and `install` are injectable so the workspace logic can be tested without spawning npm or Vite. The property
 * worth testing is not that Vite starts — it is that an existing workspace with YOUR EDITS in it is never written
 * over, and that a template mismatch is said out loud.
 */
export async function dev({ host, token, projectId, root, app: wanted, reset = false, port, log,
                            install = defaultInstall, run = defaultRun }) {
  const app = await pickApp({ host, token, projectId, wanted });
  const workspace = join(root, ".fabapp", "workspace");
  const stamp = readStamp(root);

  if (reset && existsSync(workspace)) {
    log("  Refazendo o workspace do zero (--reset)…");
    rmSync(workspace, { recursive: true, force: true });
  }

  if (!existsSync(join(workspace, "package.json"))) {
    log(`  Montando o workspace de '${app.slug}'…`);
    const out = await request(host, `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(app.id)}/export`,
                              { method: "POST", token });
    const zip = join(tmpdir(), `fabapp-${app.id}.zip`);
    await download(out.download_url, zip);
    const staging = join(tmpdir(), `fabapp-ws-${app.id}`);
    rmSync(staging, { recursive: true, force: true });
    unzip(zip, staging);
    mkdirSync(join(root, ".fabapp"), { recursive: true });
    execFileSync("cp", ["-R", onlyChild(staging) + "/", workspace + "/"]);
    rmSync(zip, { force: true });
    rmSync(staging, { recursive: true, force: true });
    // A IMPRESSÃO de cada arquivo, gravada agora que o workspace é exatamente o que a plataforma entregou. É o
    // que permite ao `deploy` enviar só o que VOCÊ mudou, em vez de empurrar os arquivos da plataforma junto.
    writeStamp(root, { app_id: app.id, template: out.template || "", files: fingerprint(workspace) });
    log(`  ✓ Workspace em .fabapp/workspace · template ${out.template || "(desconhecido)"}`);
  } else {
    // O workspace EXISTE e tem edições suas. Comparar é o serviço deste comando; escrever por cima não é.
    const current = app.template_sig || "";
    const local = stamp?.template || "";
    if (current && local && current !== local) {
      log("");
      log(`  ⚠ O template mudou desde que este workspace foi montado.`);
      log(`      aqui:        ${local}`);
      log(`      na plataforma: ${current}`);
      log("    O que roda aqui pode sair diferente no build. `fabapp dev --reset` refaz o workspace —");
      log("    e ele APAGA o que você editou dentro de .fabapp/workspace, então salve antes.");
      log("");
    } else if (!local) {
      log("  ⚠ Este workspace não registra de qual template veio — não consigo confirmar que confere.");
    }
  }

  if (!existsSync(join(workspace, "node_modules"))) {
    log("  Instalando as dependências (só na primeira vez)…");
    await install(workspace);
  }

  log(`\n  Subindo o Vite em .fabapp/workspace…\n`);
  return run(workspace, port);
}

function defaultInstall(workspace) {
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: workspace, stdio: "inherit" });
}

function defaultRun(workspace, port) {
  const args = ["run", "dev", ...(port ? ["--", "--port", String(port)] : [])];
  const child = spawn("npm", args, { cwd: workspace, stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}
