/**
 * O que um agente pode fazer com um projeto Fabapp.
 *
 * As ferramentas são declaradas aqui, separadas do transporte, porque o transporte vai mudar: hoje é stdio (o
 * Claude Code sobe o processo), e o diretório de conectores exige HTTP com OAuth. A implementação de cada
 * ferramenta é a mesma nos dois — o que muda é quem entrega a mensagem.
 *
 * ⚠️ O ESCOPO DECIDE A LISTA. Um token concedido só-leitura não vê as ferramentas de escrita: `tools/list` devolve
 * apenas o que aquele token consegue usar. Anunciar uma ferramenta que vai responder 403 é pior do que não
 * anunciá-la — o modelo tenta, falha, e tenta de novo com outros argumentos, porque a recusa parece problema do
 * pedido e não da permissão.
 */
import { request } from "../api.mjs";

/** `scope` é "read" ou "write": o mínimo que a ferramenta exige. */
export const TOOLS = [
  {
    name: "fabapp_list_projects",
    scope: "read",
    description: "Lista os projetos da conta autorizada. Um projeto é o backend compartilhado: schema, registros, "
      + "papéis, usuários finais e integrações.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async ({ host, token, creds }) =>
      request(host, `/projects?account_id=${encodeURIComponent(creds.account_id)}`, { token }),
  },
  {
    name: "fabapp_list_apps",
    scope: "read",
    description: "Lista as surfaces (frontends) de um projeto. Cada uma tem domínio, tema e papéis próprios sobre "
      + "o MESMO backend.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "o id do projeto" } },
      required: ["project_id"], additionalProperties: false,
    },
    run: ({ host, token }, { project_id }) =>
      request(host, `/projects/${encodeURIComponent(project_id)}/apps`, { token }),
  },
  {
    name: "fabapp_read_definition",
    scope: "read",
    description: "A definição do projeto como arquivos: fab.schema.json (modelos, campos e REGRAS DE ACESSO), "
      + "fab.automations.json, fab.settings.json, fab.connectors.json e apps/<slug>/fab.config.json. "
      + "Leia isto ANTES de escrever qualquer código contra o projeto: sem o schema, um id de modelo errado "
      + "responde 404 e um campo inventado responde 422.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"], additionalProperties: false,
    },
    run: ({ host, token }, { project_id }) =>
      request(host, `/projects/${encodeURIComponent(project_id)}/files`, { token }),
  },
  {
    name: "fabapp_write_definition",
    scope: "write",
    description: "Aplica fab.schema.json / fab.automations.json / fab.settings.json / apps/<slug>/fab.config.json. "
      + "Passa pela MESMA porta que o Studio usa: regra de acesso inválida é recusada com o caminho exato, e "
      + "nada é consertado por adivinhação. fab.connectors.json e fab.integrations.json são só leitura.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        files: {
          type: "array",
          description: "os arquivos a aplicar, cada um { path, content }",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"], additionalProperties: false,
          },
        },
      },
      required: ["project_id", "files"], additionalProperties: false,
    },
    run: ({ host, token }, { project_id, files }) =>
      request(host, `/projects/${encodeURIComponent(project_id)}/files`,
              { method: "POST", token, body: { files } }),
  },
  {
    name: "fabapp_app_status",
    scope: "read",
    description: "O estado de uma surface: publicada ou não, a URL no ar, quando foi o último deploy e com qual "
      + "metade de plataforma (template_sig) ela foi buildada.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_id: { type: "string" } },
      required: ["project_id", "app_id"], additionalProperties: false,
    },
    run: async ({ host, token }, { project_id, app_id }) => {
      const app = await request(host, `/projects/${encodeURIComponent(project_id)}/apps/${encodeURIComponent(app_id)}`,
                                { token });
      return {
        id: app.id, slug: app.slug, name: app.name, status: app.status,
        url: app.bundle_url, published_at: app.published_at, template_sig: app.template_sig,
      };
    },
  },
  {
    name: "fabapp_deploy",
    scope: "write",
    description: "Publica uma surface: o que está salvo no projeto vai para o ar. NÃO envia código local — para "
      + "isso use o comando `fabapp deploy`. Uma conta tem no máximo 2 builds simultâneos; o excedente recebe "
      + "'account_builds_busy' e deve tentar de novo, não é erro.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_id: { type: "string" } },
      required: ["project_id", "app_id"], additionalProperties: false,
    },
    run: async ({ host, token }, { project_id, app_id }) => {
      const out = await request(host,
        `/projects/${encodeURIComponent(project_id)}/apps/${encodeURIComponent(app_id)}/publish`,
        { method: "POST", token });
      return { status: out.status, url: out.bundle_url, published_at: out.published_at };
    },
  },
];

/** As ferramentas que ESTE token consegue usar. Ver a nota no topo. */
export function toolsFor(scopes) {
  const granted = new Set((scopes || "read").split(/[\s,]+/).filter(Boolean));
  return TOOLS.filter((t) => granted.has(t.scope));
}

export function findTool(name, scopes) {
  return toolsFor(scopes).find((t) => t.name === name) || null;
}
