/**
 * `fabapp link <project-id>` — points this directory at a project.
 *
 * It VERIFIES access before writing anything to disk. A link file written first and validated later leaves a
 * directory claiming to be a project the person cannot reach, and every later command then fails with a confusing
 * error instead of the honest one, at the moment it can still be fixed.
 */
import { request } from "../api.mjs";
import { write } from "../config.mjs";

export async function link({ host, token, projectId, root, log }) {
  try {
    await request(host, `/projects/${encodeURIComponent(projectId)}/files`, { token });
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      // The SAME message for both. The API still tells them apart today; repeating that distinction here would
      // only spread it, and the person on this side gains nothing from knowing which one it was.
      throw new Error(`project ${projectId} not found, or this account has no access to it`);
    }
    throw e;
  }
  write(root, { host, project_id: projectId });
  log(`  ✓ This directory is linked to project ${projectId}.`);
  log("    Run `fabapp pull` to bring the definition down.");
}
