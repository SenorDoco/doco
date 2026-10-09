// The GitHub setup asks a person which workspace and what to bring from GitHub
// (github-imports), then brings each choice into that workspace's Doco for it:
// the oldest live Doco made from the choice's template, or a new one,
// `<workspace>-<choice id>`, when the workspace has none. Issues come only
// from the picked repositories that use GitHub issues, so without one the
// issues Doco is neither created nor connected (prepareImport).
import { withClient } from "@doco/db";
import { mintInstallationToken, reposUsingIssues } from "./github-app.server";
import type { GitHubConnection, GitHubInstallationSub } from "./github-connection.server";
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

/** How many repositories one question to GitHub asks about. */
const ISSUES_BATCH = 50;

/**
 * The picked repositories that use GitHub issues (reposUsingIssues), asked
 * through each repository's installation, a batch at a time. An installation
 * GitHub won't answer for counts as using none: issues come over only when
 * GitHub says the repositories use them.
 */
export async function reposUsingGitHubIssues(
  connections: Array<Pick<GitHubConnection, "repo" | "installation_id">>,
  deps: {
    mintToken?: typeof mintInstallationToken;
    reposUsingIssues?: (token: string, repos: string[]) => Promise<Set<string>>;
  } = {},
): Promise<Set<string>> {
  const mintToken = deps.mintToken ?? mintInstallationToken;
  const ask = deps.reposUsingIssues ?? reposUsingIssues;
  const byInstallation = new Map<number, string[]>();
  for (const { repo, installation_id } of connections) {
    byInstallation.set(installation_id, [...(byInstallation.get(installation_id) ?? []), repo]);
  }
  const using = new Set<string>();
  for (const [installationId, repos] of byInstallation) {
    try {
      const { token } = await mintToken(installationId);
      for (let i = 0; i < repos.length; i += ISSUES_BATCH) {
        for (const repo of await ask(token, repos.slice(i, i + ISSUES_BATCH))) using.add(repo);
      }
    } catch (err) {
      console.warn(
        `[github setup] couldn't tell which repositories of installation ${installationId} use GitHub issues: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return using;
}

/** The repositories a person picked: each one, and the organizations picked whole. */
export interface PickedRepos {
  connections: Array<Pick<GitHubConnection, "repo" | "installation_id">>;
  installations: Array<Pick<GitHubInstallationSub, "installation_id" | "account">>;
}

/**
 * What each choice brings from the picked repositories, into the workspace's
 * Doco for it (created when missing): every choice takes them all, except
 * issues, which take only the repositories that use GitHub issues and, when
 * none does, are left out, their Doco not created. An organization picked
 * whole stays picked for issues too, so its repositories added later come in.
 */
export async function prepareImport(opts: {
  workspace: { id: string; handle: string };
  imports: readonly GitHubImport[];
  picked: PickedRepos;
  userId: string;
  usingIssues?: (connections: PickedRepos["connections"]) => Promise<Set<string>>;
}): Promise<Array<ImportTarget & { picked: PickedRepos }>> {
  const using = opts.imports.some((i) => i.onlyFromReposUsingIssues)
    ? await (opts.usingIssues ?? reposUsingGitHubIssues)(opts.picked.connections)
    : new Set<string>();
  const plans = opts.imports.flatMap((choice) => {
    if (!choice.onlyFromReposUsingIssues) return [{ choice, picked: opts.picked }];
    const connections = opts.picked.connections.filter((c) => using.has(c.repo));
    return connections.length > 0 ? [{ choice, picked: { ...opts.picked, connections } }] : [];
  });
  const targets = await ensureImportDocos({
    workspace: opts.workspace,
    imports: plans.map((p) => p.choice),
    userId: opts.userId,
  });
  return targets.map((t, i) => ({ ...t, picked: plans[i].picked }));
}
