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
    name: "fabapp_docs",
    scope: "read",
    description: "The platform's contract: the COMPLETE list of field types, the access-rule grammar, how a project "
      + "is laid out, and the SDK surface an app imports. READ THIS FIRST, before writing a schema or any code — "
      + "the field types are a closed list and a type that is not on it is refused, and the access rules are the "
      + "only thing standing between an app's data and the public.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async ({ host }) => {
      // Fetched LIVE from the same host the tools already talk to, rather than shipped as a copy in this package.
      // A copy would be a second source for a contract that changes — the schema gains a field type, a rule gains a
      // form — and an agent reading a stale copy writes a schema the server then refuses, which is a worse failure
      // than not having the docs at all: it looks like the platform is broken.
      const res = await fetch(`${host.replace(/\/$/, "")}/llms-full.txt`);
      if (!res.ok) throw new Error(`the docs are not reachable (${res.status})`);
      return await res.text();
    },
  },
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
    name: "fabapp_create_project",
    scope: "write",
    description: "Creates a project and its first surface, so an agent can START an app instead of only editing one "
      + "a person created for it. Returns the project id and the app id — feed them to the other tools. The project "
      + "is born with an EMPTY schema: call fabapp_write_definition next to give it models.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "the project name" },
        app_name: { type: "string", description: "the first surface's name (defaults to the project name)" },
      },
      required: ["name"], additionalProperties: false,
    },
    run: async ({ host, token, creds }, { name, app_name }) => {
      const project = await request(host, "/projects", {
        method: "POST", token, body: { account_id: creds.account_id, name, schema: { models: [] } },
      });
      const app = await request(host, `/projects/${encodeURIComponent(project.id)}/apps`, {
        method: "POST", token, body: { name: app_name || name },
      });
      return { project_id: project.id, app_id: app.id, slug: app.slug };
    },
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
      + "nothing is fixed by guessing. fab.connectors.json and fab.integrations.json are read-only.\n"
      // Repeated HERE, and not only in the docs, because a tool description is the one text every MCP client puts
      // in front of the model — it is read even by an agent that skipped everything else. The docs carry the whole
      // contract; these two lines carry the part that is most often guessed wrong.
      + "FIELD TYPES are a CLOSED list — anything else is refused: text, richtext, number, money, boolean, date, "
      + "datetime, time, image, file, video, audio, url, email, phone, color, icon, enum (with options), ref (with "
      + "to), list, geo, json, autonumber. There is no 'select' (use enum), no 'longtext' (use richtext), no "
      + "'relation' (use ref).\n"
      + "ACCESS defaults are CLOSED: with no rule, read is 'authenticated' and never public. Call fabapp_docs for "
      + "the full grammar (owner_field, owner_in, owner_via, any, all, role:, plan:).",
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
      + "use the `fabapp deploy` command for that. Two refusals, and they are opposites: 'account_builds_busy' (409) "
      + "means an account is limited to 2 concurrent builds and the call SHOULD be retried, it is not an error; "
      + "'build_failed' (422) means the app's code does not compile and the message carries the file, line and "
      + "column — DO NOT retry it, fix the code first, because every attempt pays for a full build and the answer "
      + "will not change.",
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
