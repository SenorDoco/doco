// Server-side rollup for the new Integrations pages.
//
// Each scope's "existing integrations" left pane needs a different fan-out:
//
//   account  → Slack workspaces (account-wide) + per-workspace installs (rolled up)
//              + per-Doco connections across every workspace/Doco the user can read
//   workspace      → workspace-level installs (none today) + per-Doco connections under this workspace
//   doco     → just this Doco's connections
//
// The Slack workspace install is account-wide (one row per workspace);
// channel-to-target mappings live in group_chat_channel_connections — those
// are aggregated by the higher-scope pages but rendered per-target.

import { withClient } from "@doco/db";
import { type SlackInstallationSummary, listSlackInstallations } from "~/lib/slack.server";

export interface DocoIntegrationSummary {
  docoId: string;
  handle: string;
  workspaceHandle: string;
  githubRepoCount: number;
}

export interface WorkspaceIntegrationSummary {
  workspaceId: string;
  handle: string;
  /** Integrations configured at the workspace level (placeholder until we add any). */
  installCount: number;
}

export interface AccountIntegrationsRollup {
  slack: SlackInstallationSummary[];
  workspaces: WorkspaceIntegrationSummary[];
  docos: DocoIntegrationSummary[];
}

export interface WorkspaceIntegrationsRollup {
  workspaceId: string;
  workspaceHandle: string;
  docos: DocoIntegrationSummary[];
}

async function listDocoIntegrationsForWorkspaces(
  workspaceIds: string[],
): Promise<DocoIntegrationSummary[]> {
  if (workspaceIds.length === 0) return [];
  return withClient(async (c) => {
    const { rows } = await c.query<{
      doco_id: string;
      handle: string;
      workspace_handle: string;
      gh: unknown;
    }>(
      `SELECT d.id AS doco_id,
              d.handle,
              o.handle AS workspace_handle,
              d.data->'github_integration' AS gh
         FROM docos d
         JOIN workspaces o ON o.id = d.workspace_id
        WHERE d.workspace_id = ANY($1::text[])
          AND d.data ? 'github_integration'
        ORDER BY o.handle, d.handle`,
      [workspaceIds],
    );
    return rows.map((r) => ({
      docoId: String(r.doco_id),
      handle: String(r.handle),
      workspaceHandle: String(r.workspace_handle),
      githubRepoCount: countGithubRepos(r.gh),
    }));
  });
}

function countGithubRepos(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const obj = raw as { connections?: unknown; repo?: unknown };
  if (Array.isArray(obj.connections)) return obj.connections.length;
  if (typeof obj.repo === "string") return 1;
  return 0;
}

export async function loadAccountIntegrationsRollup(opts: {
  userId: string;
}): Promise<AccountIntegrationsRollup> {
  const workspaceRows = await withClient(async (c) =>
    c.query<{ id: string; handle: string }>(
      `SELECT DISTINCT o.id, o.handle
         FROM workspaces o
         JOIN workspace_users ou ON ou.workspace_id = o.id
        WHERE ou.user_id = $1
        ORDER BY o.handle`,
      [opts.userId],
    ),
  );
  const workspaceIds = workspaceRows.rows.map((r) => String(r.id));
  const workspaces: WorkspaceIntegrationSummary[] = workspaceRows.rows.map((r) => ({
    workspaceId: String(r.id),
    handle: String(r.handle),
    installCount: 0,
  }));
  const docos = await listDocoIntegrationsForWorkspaces(workspaceIds);
  const slack = await listSlackInstallations();
  return { slack, workspaces, docos };
}

export async function loadWorkspaceIntegrationsRollup(opts: {
  workspaceId: string;
  workspaceHandle: string;
}): Promise<WorkspaceIntegrationsRollup> {
  const docos = await listDocoIntegrationsForWorkspaces([opts.workspaceId]);
  return { workspaceId: opts.workspaceId, workspaceHandle: opts.workspaceHandle, docos };
}
