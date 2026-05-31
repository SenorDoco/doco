// Per-Doco GitHub connection config, stored in docos.data.github_integration.
// This is the glue the webhook (findDocoByInstallation) and backfill read:
// it records which GitHub repo + App installation a Doco is wired to. Written
// by the settings panel / connect endpoint.
import { withClient } from "@doco/db";
import { listInstallationRepos, mintInstallationToken } from "./github-app.server";

export interface GitHubConnection {
  /** "owner/name". */
  repo: string;
  /** GitHub App installation id covering the repo. */
  installation_id: number;
  connected_at?: string;
}

/**
 * Normalize a repo reference to `{ owner, name }`. Accepts "owner/name" or a
 * full GitHub URL (trailing `.git` / slashes tolerated). Null if malformed.
 * Pure.
 */
export function parseRepoSlug(input: string): { owner: string; name: string } | null {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Read the Doco's GitHub connection, or null if it isn't connected. */
export async function getGitHubConnection(docoId: string): Promise<GitHubConnection | null> {
  return withClient(async (c) => {
    const r = await c.query<{ gh: GitHubConnection | null }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return r.rows[0]?.gh ?? null;
  });
}

/** Write (upsert) the Doco's GitHub connection into docos.data.github_integration. */
export async function setGitHubConnection(docoId: string, conn: GitHubConnection): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{github_integration}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(conn)],
    );
  });
}

/** Remove the Doco's GitHub connection (disconnect). */
export async function clearGitHubConnection(docoId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos SET data = data - 'github_integration', updated_at = now() WHERE id = $1`,
      [docoId],
    );
  });
}

export interface DocoGitHubContext {
  handle: string;
  orgHandle: string;
  connection: GitHubConnection | null;
}

/**
 * One-query fetch of the Doco's handle, its org handle, and its GitHub
 * connection — the fields a backfill needs (docoSlug, ownerSlug, repo +
 * installation id).
 */
export async function getDocoGitHubContext(docoId: string): Promise<DocoGitHubContext | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string; org_handle: string; gh: GitHubConnection | null }>(
      `SELECT d.handle, o.handle AS org_handle, d.data->'github_integration' AS gh
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    return row
      ? { handle: row.handle, orgHandle: row.org_handle, connection: row.gh ?? null }
      : null;
  });
}

// ─── Multi-connection model ──────────────────────────────────────────────
// A Doco can track several repos. Stored as
// docos.data.github_integration.connections = [{ repo, installation_id, ... }].
// normalizeConnections reads both the new list shape and the legacy single
// { repo, installation_id } shape, so old and new data interoperate.

/** Normalize the raw `docos.data.github_integration` value to a connection
 *  list. Accepts the new `{ connections: [...] }` shape and the legacy single
 *  `{ repo, installation_id }` shape. Pure. */
export function normalizeConnections(raw: unknown): GitHubConnection[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { connections?: unknown; repo?: unknown; installation_id?: unknown };
  const list: unknown[] = Array.isArray(obj.connections)
    ? obj.connections
    : typeof obj.repo === "string"
      ? [obj]
      : [];
  const out: GitHubConnection[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const e = c as { repo?: unknown; installation_id?: unknown; connected_at?: unknown };
    if (typeof e.repo !== "string" || typeof e.installation_id !== "number") continue;
    out.push({
      repo: e.repo,
      installation_id: e.installation_id,
      ...(typeof e.connected_at === "string" ? { connected_at: e.connected_at } : {}),
    });
  }
  return out;
}

/** GitHub App install URL for the click-through flow; null if the app slug
 *  (DOCO_GITHUB_APP_SLUG) isn't configured. `state` round-trips the Doco. Pure. */
export function buildInstallUrl(state: string): string | null {
  const slug = process.env.DOCO_GITHUB_APP_SLUG;
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function listConnections(docoId: string): Promise<GitHubConnection[]> {
  return withClient(async (c) => {
    const r = await c.query<{ gh: unknown }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return normalizeConnections(r.rows[0]?.gh);
  });
}

async function writeConnections(docoId: string, conns: GitHubConnection[]): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{github_integration}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify({ connections: conns })],
    );
  });
}

/**
 * Enforce one-repo-one-Doco: remove `repo` from every Doco's connections
 * EXCEPT `keepDocoId`. Covers both the connections[] list shape and the legacy
 * single { repo, installation_id } shape. Idempotent; the indexed `@>`/`->>'`
 * predicates touch only the Docos that actually hold the repo.
 */
export async function detachRepoFromOtherDocos(repo: string, keepDocoId: string): Promise<void> {
  await withClient(async (c) => {
    // List shape: filter the matching element out of connections[].
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                data,
                '{github_integration,connections}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(data->'github_integration'->'connections') AS elem
                   WHERE elem->>'repo' <> $1
                ), '[]'::jsonb)
              ),
              updated_at = now()
        WHERE id <> $2
          AND data->'github_integration'->'connections'
                @> jsonb_build_array(jsonb_build_object('repo', $1::text))`,
      [repo, keepDocoId],
    );
    // Legacy single shape: if the whole github_integration *is* this repo, drop it.
    await c.query(
      `UPDATE docos
          SET data = data - 'github_integration', updated_at = now()
        WHERE id <> $2
          AND data->'github_integration'->>'repo' = $1`,
      [repo, keepDocoId],
    );
  });
}

/** Injectable seams so the move orchestration is unit-testable without a DB. */
export interface AddConnectionDeps {
  detachElsewhere: (repo: string, keepDocoId: string) => Promise<void>;
  list: (docoId: string) => Promise<GitHubConnection[]>;
  write: (docoId: string, conns: GitHubConnection[]) => Promise<void>;
}

/**
 * Attach `conn` to `docoId`, enforcing one-repo-one-Doco. The repo is first
 * detached from any OTHER Doco (move semantics, per the project decision), then
 * added here — replacing any stale entry for the same repo on this Doco so a
 * re-connect never duplicates. Returns this Doco's new connection list.
 */
export async function addConnection(
  docoId: string,
  conn: GitHubConnection,
  deps?: Partial<AddConnectionDeps>,
): Promise<GitHubConnection[]> {
  const detach = deps?.detachElsewhere ?? detachRepoFromOtherDocos;
  const list = deps?.list ?? listConnections;
  const write = deps?.write ?? writeConnections;
  await detach(conn.repo, docoId);
  const next = [...(await list(docoId)).filter((c) => c.repo !== conn.repo), conn];
  await write(docoId, next);
  return next;
}

/** Remove a connection by repo. Returns the remaining list. */
export async function removeConnection(docoId: string, repo: string): Promise<GitHubConnection[]> {
  const next = (await listConnections(docoId)).filter((c) => c.repo !== repo);
  await writeConnections(docoId, next);
  return next;
}

/** Remove the whole GitHub integration from the Doco. */
export async function clearAllConnections(docoId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos SET data = data - 'github_integration', updated_at = now() WHERE id = $1`,
      [docoId],
    );
  });
}

export interface DocoConnectionsContext {
  handle: string;
  orgHandle: string;
  connections: GitHubConnection[];
}

/** Doco handle + org handle + all connections, in one query (for the
 *  Integrations UI and per-repo backfill). */
export async function getDocoConnectionsContext(
  docoId: string,
): Promise<DocoConnectionsContext | null> {
  return withClient(async (c) => {
    const r = await c.query<{ handle: string; org_handle: string; gh: unknown }>(
      `SELECT d.handle, o.handle AS org_handle, d.data->'github_integration' AS gh
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    return row
      ? { handle: row.handle, orgHandle: row.org_handle, connections: normalizeConnections(row.gh) }
      : null;
  });
}

// ─── Org-level installation subscription ─────────────────────────────────
// A Doco subscribes to a GitHub App *installation* (an org/owner). The webhook
// routes every PR carrying that installation id to the subscribed Doco, so new
// repos in the org are covered automatically — no per-repo management. Stored
// as docos.data.github_integration.installations = [{ installation_id, account }].
// One installation maps to one Doco (subscribing moves it), so a PR is never
// duplicated across Docos.

export interface GitHubInstallationSub {
  /** GitHub App installation id (the org/owner install). */
  installation_id: number;
  /** Org / owner login the installation belongs to. */
  account: string;
  connected_at?: string;
}

/** Read docos.data.github_integration.installations as a list. Pure. */
export function normalizeInstallations(raw: unknown): GitHubInstallationSub[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { installations?: unknown }).installations;
  if (!Array.isArray(list)) return [];
  const out: GitHubInstallationSub[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const e = x as { installation_id?: unknown; account?: unknown; connected_at?: unknown };
    if (typeof e.installation_id !== "number" || typeof e.account !== "string") continue;
    out.push({
      installation_id: e.installation_id,
      account: e.account,
      ...(typeof e.connected_at === "string" ? { connected_at: e.connected_at } : {}),
    });
  }
  return out;
}

export async function listInstallations(docoId: string): Promise<GitHubInstallationSub[]> {
  return withClient(async (c) => {
    const r = await c.query<{ gh: unknown }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return normalizeInstallations(r.rows[0]?.gh);
  });
}

/** Write the Doco's installation subscriptions, preserving sibling keys (e.g.
 *  connections) under github_integration. */
async function writeInstallations(docoId: string, subs: GitHubInstallationSub[]): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb)
                  || jsonb_build_object(
                       'github_integration',
                       COALESCE(data->'github_integration', '{}'::jsonb)),
                '{github_integration,installations}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(subs)],
    );
  });
}

/**
 * Enforce one-installation-one-Doco: drop the installation from every OTHER
 * Doco's installations[]. Idempotent; the indexed `@>` predicate touches only
 * the Docos that actually hold the installation.
 */
export async function detachInstallationFromOtherDocos(
  installationId: number,
  keepDocoId: string,
): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                data,
                '{github_integration,installations}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(data->'github_integration'->'installations') AS elem
                   WHERE (elem->>'installation_id')::int <> $1
                ), '[]'::jsonb)
              ),
              updated_at = now()
        WHERE id <> $2
          AND data->'github_integration'->'installations'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))`,
      [installationId, keepDocoId],
    );
  });
}

/** Injectable seams so the move orchestration is unit-testable without a DB. */
export interface SubscribeInstallationDeps {
  detachElsewhere: (installationId: number, keepDocoId: string) => Promise<void>;
  list: (docoId: string) => Promise<GitHubInstallationSub[]>;
  write: (docoId: string, subs: GitHubInstallationSub[]) => Promise<void>;
}

/**
 * Subscribe `docoId` to an App installation (an org), enforcing
 * one-installation-one-Doco: the installation is first detached from any other
 * Doco (move), then recorded here — replacing any stale entry for the same
 * installation id. Returns this Doco's new subscription list.
 */
export async function subscribeInstallation(
  docoId: string,
  sub: GitHubInstallationSub,
  deps?: Partial<SubscribeInstallationDeps>,
): Promise<GitHubInstallationSub[]> {
  const detach = deps?.detachElsewhere ?? detachInstallationFromOtherDocos;
  const list = deps?.list ?? listInstallations;
  const write = deps?.write ?? writeInstallations;
  await detach(sub.installation_id, docoId);
  const next = [
    ...(await list(docoId)).filter((s) => s.installation_id !== sub.installation_id),
    sub,
  ];
  await write(docoId, next);
  return next;
}

/**
 * Import every repo a fresh App installation covers as a connection on the
 * Doco — the click-through setup callback's core. Mints an installation token,
 * lists its repos, and addConnection's each. Returns the connected repos.
 * Injectable deps for testing.
 */
export async function importInstallationConnections(
  opts: { docoId: string; installationId: number },
  deps?: {
    mintToken?: typeof mintInstallationToken;
    listRepos?: typeof listInstallationRepos;
    add?: typeof addConnection;
  },
): Promise<{ repos: string[] }> {
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const listRepos = deps?.listRepos ?? listInstallationRepos;
  const add = deps?.add ?? addConnection;
  const { token } = await mintToken(opts.installationId);
  const repos = await listRepos(token);
  const now = new Date().toISOString();
  for (const repo of repos) {
    await add(opts.docoId, { repo, installation_id: opts.installationId, connected_at: now });
  }
  return { repos };
}
