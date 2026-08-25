/**
 * `fabapp link <project-id>` — points this directory at a project.
 *
 * It VERIFIES access before writing anything to disk. A link file written first and validated later leaves a
 * directory claiming to be a project that the person cannot reach, and every later command then fails with a
 * confusing error instead of the honest one, at the moment it can still be fixed.
 */
import { request } from "../api.mjs";
import { write } from "../config.mjs";

export async function link({ host, token, projectId, root, log }) {
  try {
    await request(host, `/projects/${encodeURIComponent(projectId)}/files`, { token });
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      // The SAME message for both. The API still distinguishes them today; repeating that distinction here would
      // only spread it, and the person on this side gains nothing from knowing which one it was.
      throw new Error(`projeto ${projectId} não encontrado, ou esta conta não tem acesso a ele`);
    }
    throw e;
  }
  write(root, { host, project_id: projectId });
  log(`  ✓ Este diretório está ligado ao projeto ${projectId}.`);
  log("    Rode `fabapp pull` para trazer a definição.");
}
