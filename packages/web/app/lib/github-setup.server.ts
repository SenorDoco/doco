// The GitHub setup asks a person which workspace and what to bring from GitHub
// (github-imports), then brings each choice into that workspace's Doco for it:
// the oldest live Doco made from the choice's template, or a new one,
// `<workspace>-<choice id>`, when the workspace has none.
import { withClient } from "@doco/db";
import { GITHUB_IMPORTS, type GitHubImport } from "./github-imports";
import { ensureWorkspaceDoco } from "./workspace-helpers.server";

export interface ImportDoco {
  id: string;
  handle: string;
}

/** For each workspace, its Doco for each GitHub choice, by choice id. */
export type ImportDocosByWorkspace = Record<string, Record<string, ImportDoco>>;

export async function listImportDocos(workspaceIds: string[]): Promise<ImportDocosByWorkspace> {
  if (workspaceIds.length === 0) return {};
  const rows = await withClient(async (c) => {
    const r = await c.query<{ workspace_id: string; template: string; id: string; handle: string }>(
      `SELECT DISTINCT ON (workspace_id, data->>'template_handle')
              workspace_id, data->>'template_handle' AS template, id, handle
         FROM docos
        WHERE workspace_id = ANY($1::text[])
          AND deleted_at IS NULL
          AND data->>'template_handle' = ANY($2::text[])
        ORDER BY workspace_id, data->>'template_handle', created_at, id`,
      [workspaceIds, GITHUB_IMPORTS.map((i) => i.template)],
    );
    return r.rows;
  });
  const out: ImportDocosByWorkspace = {};
  for (const row of rows) {
    const choice = GITHUB_IMPORTS.find((i) => i.template === row.template);
    if (!choice) continue;
    out[row.workspace_id] ??= {};
    out[row.workspace_id][choice.id] = { id: row.id, handle: row.handle };
  }
  return out;
}

export interface ImportTarget {
  import: GitHubImport;
  doco: ImportDoco;
}

/** The workspace's Doco for each choice, creating the ones it lacks. */
export async function ensureImportDocos(opts: {
  workspace: { id: string; handle: string };
  imports: readonly GitHubImport[];
  userId: string;
}): Promise<ImportTarget[]> {
  const targets: ImportTarget[] = [];
  for (const choice of opts.imports) {
    const { id, handle } = await ensureWorkspaceDoco({
      workspace: opts.workspace,
      template: choice.template,
      handleSuffix: choice.id,
      userId: opts.userId,
    });
    targets.push({ import: choice, doco: { id, handle } });
  }
  return targets;
}
