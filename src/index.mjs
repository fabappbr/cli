#!/usr/bin/env node
/**
 * The Fabapp CLI.
 *
 * Zero dependencies, on purpose. This is a tool that holds a credential and talks to somebody's backend; every
 * package in its graph would be a package that could reach both.
 */
import { findRoot, read } from "./config.mjs";
import { clear, load } from "./credentials.mjs";
import { serve as serveMcp } from "./mcp/server.mjs";
import { deploy } from "./commands/deploy.mjs";
import { dev } from "./commands/dev.mjs";
import { link } from "./commands/link.mjs";
import { login } from "./commands/login.mjs";
import { pull, push } from "./commands/sync.mjs";

const DEFAULT_HOST = process.env.FABAPP_API_URL || "https://api.fabapp.ai";
const log = (...a) => console.log(...a);

const USAGE = `
  fabapp — a linha de comando da Fabapp

    fabapp login [--scopes "read write"]   autoriza esta máquina (abre o navegador)
                 [--no-open]               não abre o navegador (headless/CI)
    fabapp logout                          esquece o token desta máquina
    fabapp status                          quem você é e a que projeto esta pasta está ligada
    fabapp link <project-id>               liga este diretório a um projeto
    fabapp dev [--app <slug>] [--reset]    roda o app localmente, com o template da plataforma
    fabapp pull                            traz a definição do projeto para o disco
    fabapp push                            envia o que está no disco
    fabapp deploy [--no-publish]           sobe o que você editou no workspace e publica
    fabapp mcp                             servidor MCP (stdio) — para o Claude Code e afins

  A base da API vem de FABAPP_API_URL (padrão: ${DEFAULT_HOST}).
`;

function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** The directory's link plus the credential for its host — everything a project command needs. */
function context() {
  const root = findRoot();
  if (!root) throw new Error("este diretório não está ligado a um projeto — rode `fabapp link <project-id>`");
  const config = read(root);
  const creds = load(config.host);
  if (!creds?.token) throw new Error(`sem autorização para ${config.host} — rode \`fabapp login\``);
  return { root, host: config.host, projectId: config.project_id, token: creds.token };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const host = flag(argv, "host", DEFAULT_HOST);

  switch (command) {
    case "login":
      await login({ host, scopes: flag(argv, "scopes", "read write"),
                    open: !argv.includes("--no-open"), log });
      return 0;

    case "logout": {
      clear(host);
      log(`  ✓ Token de ${host} esquecido nesta máquina.`);
      log("    Ele continua VÁLIDO no servidor até ser revogado no Studio → Configurações → CLI.");
      return 0;
    }

    case "status": {
      const root = findRoot();
      const config = root ? read(root) : null;
      const creds = load(config?.host || host);
      log(`  host      ${config?.host || host}`);
      log(`  sessão    ${creds ? `conta ${creds.account_id} · escopo ${creds.scope}` : "não autorizada"}`);
      log(`  diretório ${root ? `${root} → projeto ${config.project_id}` : "não ligado"}`);
      return 0;
    }

    case "link": {
      const projectId = rest.find((a) => !a.startsWith("--"));
      if (!projectId) throw new Error("informe o id do projeto: `fabapp link <project-id>`");
      const creds = load(host);
      if (!creds?.token) throw new Error(`sem autorização para ${host} — rode \`fabapp login\``);
      await link({ host, token: creds.token, projectId, root: process.cwd(), log });
      return 0;
    }

    case "mcp": {
      // O servidor MCP não exige diretório ligado: as ferramentas recebem o `project_id` como argumento, e quem
      // sobe o processo (o Claude Code, o app de desktop) não roda de dentro de um projeto.
      const creds = load(host);
      if (!creds?.token) throw new Error(`sem autorização para ${host} — rode \`fabapp login\``);
      return await serveMcp({ host, creds });
    }

    case "dev":
      return await dev({ ...context(), app: flag(argv, "app", ""), reset: argv.includes("--reset"),
                         port: flag(argv, "port", ""), log });

    case "deploy":
      return await deploy({ ...context(), publish: !argv.includes("--no-publish"), log });

    case "pull": await pull({ ...context(), log }); return 0;
    case "push": await push({ ...context(), log }); return 0;

    case undefined:
    case "help":
    case "--help":
    case "-h": log(USAGE); return 0;

    default:
      log(`  comando desconhecido: ${command}`);
      log(USAGE);
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(`\n  ✗ ${e.message}\n`);
    process.exit(1);
  });
}
