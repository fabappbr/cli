/**
 * `fabapp create <name>` — a project and its first surface, without a browser.
 *
 * This was the last human-only step in a chain that is otherwise open to machines. A token granted `write` could
 * write the schema, write the code and publish, but not create the container to put any of it in — so every agent
 * workflow began with "now go and click New project in the Studio".
 *
 * Two calls, and the order is not decorative: a project with no surface has nothing to publish, so the surface is
 * created here rather than left for a later command to remember. If the surface fails, the project is REPORTED and
 * kept, never rolled back — deleting somebody's just-created project because a second call failed is a worse
 * outcome than an empty project they can finish by hand.
 */
import { request } from "../api.mjs";
import { write } from "../config.mjs";

export async function create({ host, token, accountId, name, appName, root, log, link = true }) {
  if (!name?.trim()) throw new Error("give the project a name: `fabapp create \"My app\"`");

  const project = await request(host, "/projects", {
    method: "POST", token,
    body: { account_id: accountId, name: name.trim(), schema: { models: [] } },
  });
  log(`  ✓ Project ${project.name} · ${project.id}`);

  let app = null;
  try {
    app = await request(host, `/projects/${encodeURIComponent(project.id)}/apps`, {
      method: "POST", token, body: { name: (appName || name).trim() },
    });
    log(`  ✓ Surface ${app.slug} · ${app.id}`);
  } catch (e) {
    // Kept, not rolled back. See the note at the top.
    log(`\n  ⚠ The project was created but the surface was not: ${e.message}`);
    log(`    Add one in Studio, or run \`fabapp create\` again — the project ${project.id} stays.`);
    return { project, app: null };
  }

  if (link) {
    write(root, { host, project_id: project.id });
    log(`  ✓ This directory is linked to it.`);
    log("    `fabapp pull` brings the definition down; `fabapp deploy` sends code back and publishes.");
  }
  return { project, app };
}
