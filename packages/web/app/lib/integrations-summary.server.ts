// Server-side rollup for the new Integrations pages.
//
// Each scope's "existing integrations" left pane needs a different fan-out:
//
//   account  → Slack workspaces (account-wide) + per-org installs (rolled up)
//              + per-Doco connections across every org/Doco the user can read
//   org      → org-level installs (none today) + per-Doco connections under this org
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
  orgHandle: string;
  githubRepoCount: number;
}

export interface OrgIntegrationSummary {
  orgId: string;
  handle: string;
  /** Integrations configured at the org level (placeholder until we add any). */
  installCount: number;
}

export interface AccountIntegrationsRollup {
  slack: SlackInstallationSummary[];
  orgs: OrgIntegrationSummary[];
  docos: DocoIntegrationSummary[];
}

export interface OrgIntegrationsRollup {
  orgId: string;
  orgHandle: string;
  docos: DocoIntegrationSummary[];
}

async function listDocoIntegrationsForOrgs(orgIds: string[]): Promise<DocoIntegrationSummary[]> {
  if (orgIds.length === 0) return [];
  return withClient(async (c) => {
    const { rows } = await c.query<{
      doco_id: string;
      handle: string;
      org_handle: string;
      gh: unknown;
    }>(
      `SELECT d.id AS doco_id,
              d.handle,
              o.handle AS org_handle,
              d.data->'github_integration' AS gh
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.org_id = ANY($1::text[])
          AND d.data ? 'github_integration'
        ORDER BY o.handle, d.handle`,
      [orgIds],
    );
    return rows.map((r) => ({
      docoId: String(r.doco_id),
      handle: String(r.handle),
      orgHandle: String(r.org_handle),
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
  const orgRows = await withClient(async (c) =>
    c.query<{ id: string; handle: string }>(
      `SELECT DISTINCT o.id, o.handle
         FROM organizations o
         JOIN org_users ou ON ou.org_id = o.id
        WHERE ou.user_id = $1
        ORDER BY o.handle`,
      [opts.userId],
    ),
  );
  const orgIds = orgRows.rows.map((r) => String(r.id));
  const orgs: OrgIntegrationSummary[] = orgRows.rows.map((r) => ({
    orgId: String(r.id),
    handle: String(r.handle),
    installCount: 0,
  }));
  const docos = await listDocoIntegrationsForOrgs(orgIds);
  const slack = await listSlackInstallations();
  return { slack, orgs, docos };
}

export async function loadOrgIntegrationsRollup(opts: {
  orgId: string;
  orgHandle: string;
}): Promise<OrgIntegrationsRollup> {
  const docos = await listDocoIntegrationsForOrgs([opts.orgId]);
  return { orgId: opts.orgId, orgHandle: opts.orgHandle, docos };
}
