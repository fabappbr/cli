/**
 * What an agent can do with a Fabapp project.
 *
 * The tools are declared here, apart from the transport, because the transport is going to change: today it is
 * stdio (Claude Code starts the process), and the connector directory requires HTTP with OAuth. Each tool's
 * implementation is the same on both — what changes is who delivers the message.
 *
 * ⚠️ THE SCOPE DECIDES THE LIST. A token granted read-only never sees the write tools: `tools/list` returns only
 * what that token can actually use. Advertising a tool that will answer 403 is worse than not advertising it — the
 * model tries, fails, and tries again with different arguments, because the refusal looks like a problem with the
 * request rather than with the permission.
 */
import { request } from "../api.mjs";

/** `scope` is "read" or "write": the least the tool requires. */
export const TOOLS = [
  {
    name: "fabapp_list_projects",
    scope: "read",
    description: "Lists the projects of the authorised account. A project is the shared backend: schema, records, "
      + "roles, end users and integrations.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async ({ host, token, creds }) =>
      request(host, `/projects?account_id=${encodeURIComponent(creds.account_id)}`, { token }),
  },
  {
    name: "fabapp_list_apps",
    scope: "read",
    description: "Lists the surfaces (frontends) of a project. Each one has its own domain, theme and roles over "
      + "the SAME backend.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "the project id" } },
      required: ["project_id"], additionalProperties: false,
    },
    run: ({ host, token }, { project_id }) =>
      request(host, `/projects/${encodeURIComponent(project_id)}/apps`, { token }),
  },
  {
    name: "fabapp_read_definition",
    scope: "read",
    description: "The project definition as files: fab.schema.json (models, fields and ACCESS RULES), "
      + "fab.automations.json, fab.settings.json, fab.connectors.json and apps/<slug>/fab.config.json. "
      + "Read this BEFORE writing any code against the project: without the schema, a wrong model id answers "
      + "404 and an invented field answers 422.",
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
    description: "Applies fab.schema.json / fab.automations.json / fab.settings.json / apps/<slug>/fab.config.json. "
      + "It goes through the SAME door the Studio uses: an invalid access rule is refused with the exact path, and "
      + "nothing is fixed by guessing. fab.connectors.json and fab.integrations.json are read-only.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        files: {
          type: "array",
          description: "the files to apply, each one { path, content }",
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
    description: "The state of a surface: published or not, the live URL, when the last deploy happened and which "
      + "platform half (template_sig) it was built with.",
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
    description: "Publishes a surface: whatever is saved in the project goes live. It does NOT upload local code — "
      + "use the `fabapp deploy` command for that. An account has at most 2 concurrent builds; anything beyond that "
      + "gets 'account_builds_busy' and should be retried, it is not an error.",
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

/** The tools THIS token can use. See the note at the top. */
export function toolsFor(scopes) {
  const granted = new Set((scopes || "read").split(/[\s,]+/).filter(Boolean));
  return TOOLS.filter((t) => granted.has(t.scope));
}

export function findTool(name, scopes) {
  return toolsFor(scopes).find((t) => t.name === name) || null;
}
