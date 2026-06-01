// Per-Doco GitHub connection config, stored in docos.data.github_integration.
// This is the glue the webhook (findDocoByInstallation) and backfill read:
// it records which GitHub repo + App installation a Doco is wired to. Written
// by the settings panel / connect endpoint.
import { withClient } from "@doco/db";
import {
  getInstallationAccount,
  listInstallationRepos,
  mintInstallationToken,
} from "./github-app.server";

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
    const r = await c.query<{ gh: unknown }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return normalizeConnections(r.rows[0]?.gh)[0] ?? null;
  });
}

/** Write (upsert) the Doco's GitHub connection into docos.data.github_integration. */
export async function setGitHubConnection(docoId: string, conn: GitHubConnection): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb)
                  || jsonb_build_object(
                       'github_integration',
                       COALESCE(data->'github_integration', '{}'::jsonb)),
                '{github_integration,connections}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify([conn])],
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
    const r = await c.query<{ handle: string; org_handle: string; gh: unknown }>(
      `SELECT d.handle, o.handle AS org_handle, d.data->'github_integration' AS gh
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    return row
      ? {
          handle: row.handle,
          orgHandle: row.org_handle,
          connection: normalizeConnections(row.gh)[0] ?? null,
        }
      : null;
  });
}

// ─── Multi-connection model ──────────────────────────────────────────────
// A Doco can track several repos. Stored as
// docos.data.github_integration.connections = [{ repo, installation_id, ... }].

/** Normalize the raw `docos.data.github_integration` value to a connection list. */
export function normalizeConnections(raw: unknown): GitHubConnection[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { connections?: unknown };
  const list: unknown[] = Array.isArray(obj.connections) ? obj.connections : [];
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
          SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb)
                  || jsonb_build_object(
                       'github_integration',
                       COALESCE(data->'github_integration', '{}'::jsonb)),
                '{github_integration,connections}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(conns)],
    );
  });
}

/**
 * Enforce one-repo-one-Doco: remove `repo` from every Doco's connections
 * EXCEPT `keepDocoId`. Idempotent; the indexed `@>` predicate touches only the
 * Docos that actually hold the repo.
 */
export async function detachRepoFromOtherDocos(repo: string, keepDocoId: string): Promise<void> {
  await withClient(async (c) => {
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

// ─── Backfill progress marker ────────────────────────────────────────────
// A connect kicks off the PR import off the request path (waitUntil); for an
// org with tens of thousands of PRs that runs long. We stamp a marker on the
// Doco so the UI can say "importing in the background — keep working" and the
// user isn't blocked. Stored at docos.data.github_integration.backfill; no
// schema change needed (plain JSONB, like connections/installations).

export interface GitHubBackfillState {
  status: "running" | "done";
  started_at?: string;
  finished_at?: string;
  /** Total repos covered by the backfill (for display). */
  repos?: number;
  /** PR References created so far. */
  imported?: number;
  // ── Resumable cursor (driven by the self-chaining backfill worker) ──
  // The worker processes a time-budgeted slice per invocation, persists this
  // cursor, and re-triggers itself until the queue is exhausted — so an org
  // with tens of thousands of PRs never hits the function timeout in one run.
  /** App installation whose repos are being imported. */
  installation_id?: number;
  /** Repo full-names still to walk (the work queue). */
  queue?: string[];
  /** Index into `queue` of the repo currently importing. */
  repo_index?: number;
  /** GitHub page (1-based) to resume the current repo from. */
  page?: number;
  /** Running tallies across the whole backfill. */
  updated?: number;
  unchanged?: number;
  failed?: number;
  /** ISO time the cursor last advanced — a heartbeat. A "running" marker whose
   *  cursor_at is stale means the self-chaining worker dropped its chain; the
   *  sweep re-kicks it. Absent on pre-resumable markers (treated as stale). */
  cursor_at?: string;
}

/** Read the backfill marker off a raw github_integration value. Pure. */
export function normalizeBackfillState(raw: unknown): GitHubBackfillState | null {
  if (!raw || typeof raw !== "object") return null;
  const b = (raw as { backfill?: unknown }).backfill;
  if (!b || typeof b !== "object") return null;
  const e = b as Record<string, unknown>;
  if (e.status !== "running" && e.status !== "done") return null;
  const num = (k: string) => (typeof e[k] === "number" ? { [k]: e[k] as number } : {});
  return {
    status: e.status,
    ...(typeof e.started_at === "string" ? { started_at: e.started_at } : {}),
    ...(typeof e.finished_at === "string" ? { finished_at: e.finished_at } : {}),
    ...num("repos"),
    ...num("imported"),
    ...num("installation_id"),
    ...(Array.isArray(e.queue)
      ? { queue: e.queue.filter((x): x is string => typeof x === "string") }
      : {}),
    ...num("repo_index"),
    ...num("page"),
    ...num("updated"),
    ...num("unchanged"),
    ...num("failed"),
    ...(typeof e.cursor_at === "string" ? { cursor_at: e.cursor_at } : {}),
  };
}

/**
 * Build a fresh resumable cursor from a Doco's current connections — the work
 * queue is every connected repo's full-name. Used to (re)start or recover a
 * backfill: a stranded "running" marker (chain dropped) or a pre-resumable
 * marker with no `queue` becomes walkable again, and a "done"-but-incomplete
 * import can be re-driven (idempotent upserts fill the gaps). Tallies and
 * started_at carry forward from `prev` when present. Pure.
 */
export function resumeCursorFromConnections(
  connections: GitHubConnection[],
  prev?: GitHubBackfillState | null,
): GitHubBackfillState {
  const queue = connections.map((c) => c.repo);
  return {
    status: "running",
    started_at: prev?.started_at ?? new Date().toISOString(),
    repos: queue.length,
    installation_id: prev?.installation_id ?? connections[0]?.installation_id,
    queue,
    repo_index: 0,
    page: 1,
    imported: prev?.imported ?? 0,
    updated: prev?.updated ?? 0,
    unchanged: prev?.unchanged ?? 0,
    failed: prev?.failed ?? 0,
    cursor_at: new Date().toISOString(),
  };
}

/**
 * Doco ids whose PR backfill is "running" but hasn't advanced since
 * `staleBeforeIso` (its `cursor_at` heartbeat is older than the cutoff, or
 * absent — a pre-resumable marker). These are stranded chains the sweep
 * re-kicks. Indexed-ish: scans only Docos with a github_integration.
 */
export async function findStaleRunningBackfills(
  staleBeforeIso: string,
  limit = 50,
): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM docos
        WHERE data->'github_integration'->'backfill'->>'status' = 'running'
          AND COALESCE(
                (data->'github_integration'->'backfill'->>'cursor_at')::timestamptz,
                'epoch'::timestamptz
              ) < $1::timestamptz
        ORDER BY updated_at ASC
        LIMIT $2`,
      [staleBeforeIso, limit],
    );
    return r.rows.map((row) => row.id);
  });
}

/** Write the backfill marker, preserving sibling github_integration keys. */
export async function setBackfillState(docoId: string, state: GitHubBackfillState): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb)
                  || jsonb_build_object(
                       'github_integration',
                       COALESCE(data->'github_integration', '{}'::jsonb)),
                '{github_integration,backfill}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(state)],
    );
  });
}

export interface DocoConnectionsContext {
  handle: string;
  orgHandle: string;
  connections: GitHubConnection[];
  /** Org/owner installation subscriptions (org-wide auto-sync). */
  installations: GitHubInstallationSub[];
  /** In-progress / last-finished PR import, for the "importing…" banner. */
  backfill: GitHubBackfillState | null;
}

/**
 * Org/owner accounts a Doco's GitHub connection covers — for the "Connected to
 * <org> — all repos auto-syncing" framing. Prefers explicit installation
 * subscriptions (which carry the account login); falls back to the distinct
 * owners of the connected repos (every repo from one install shares the org
 * owner). Pure; de-duped + sorted.
 */
export function githubOrgAccounts(input: {
  installations: GitHubInstallationSub[];
  connections: GitHubConnection[];
}): string[] {
  const fromSubs = input.installations.map((i) => i.account);
  const fromRepos = input.connections
    .map((c) => c.repo.split("/")[0])
    .filter((owner): owner is string => Boolean(owner));
  return [...new Set([...fromSubs, ...fromRepos])].sort();
}

export interface GitHubInstallationChoice {
  /** GitHub App installation id the user has already connected through Doco. */
  installation_id: number;
  /** GitHub org / owner login the installation belongs to. */
  account: string;
  /** Whether the GitHub App installation is authorized for all repos or selected repos. */
  repository_selection?: "all" | "selected";
  /** Repositories currently visible to the installation and selectable here. */
  repositories: string[];
  /** Repositories Doco already knows under this installation. */
  connected_repositories: string[];
  /** Doco handles where this installation was discovered. */
  source_doco_handles: string[];
  /** True when GitHub could not be queried and repositories fell back to known Doco rows. */
  repositories_unavailable?: boolean;
}

type KnownGitHubInstallationChoice = Omit<
  GitHubInstallationChoice,
  "repositories" | "repositories_unavailable"
>;

/**
 * Group GitHub App installations already visible through Doco rows. This is the
 * "does this user already have a GitHub connection?" source for the Doco-level
 * connection flow; the route supplies only Doco ids the user can read.
 */
export function groupKnownGitHubInstallations(
  rows: Array<{ handle: string; githubIntegration: unknown }>,
): KnownGitHubInstallationChoice[] {
  const byInstallation = new Map<
    number,
    {
      accounts: Set<string>;
      repos: Set<string>;
      handles: Set<string>;
      selections: Set<"all" | "selected">;
    }
  >();

  const entryFor = (installationId: number) => {
    let entry = byInstallation.get(installationId);
    if (!entry) {
      entry = {
        accounts: new Set(),
        repos: new Set(),
        handles: new Set(),
        selections: new Set(),
      };
      byInstallation.set(installationId, entry);
    }
    return entry;
  };

  for (const row of rows) {
    for (const auth of normalizeInstallationAuthorizations(row.githubIntegration)) {
      const entry = entryFor(auth.installation_id);
      entry.accounts.add(auth.account);
      entry.handles.add(row.handle);
      if (auth.repository_selection) entry.selections.add(auth.repository_selection);
    }
    for (const sub of normalizeInstallations(row.githubIntegration)) {
      const entry = entryFor(sub.installation_id);
      entry.accounts.add(sub.account);
      entry.handles.add(row.handle);
    }
    for (const conn of normalizeConnections(row.githubIntegration)) {
      const entry = entryFor(conn.installation_id);
      entry.repos.add(conn.repo);
      entry.handles.add(row.handle);
      const account = conn.repo.split("/")[0];
      if (account) entry.accounts.add(account);
    }
  }

  return [...byInstallation.entries()]
    .map(([installation_id, entry]) => {
      const connected = [...entry.repos].sort();
      const [firstAccount] = [...entry.accounts].sort();
      const [repository_selection] = [...entry.selections].sort();
      return {
        installation_id,
        account: firstAccount ?? connected[0]?.split("/")[0] ?? `installation-${installation_id}`,
        ...(repository_selection === "all" || repository_selection === "selected"
          ? { repository_selection }
          : {}),
        connected_repositories: connected,
        source_doco_handles: [...entry.handles].sort(),
      };
    })
    .sort((a, b) => a.account.localeCompare(b.account) || a.installation_id - b.installation_id);
}

async function listKnownGitHubInstallationsForDocos(
  docoIds: string[],
): Promise<KnownGitHubInstallationChoice[]> {
  if (docoIds.length === 0) return [];
  return withClient(async (c) => {
    const { rows } = await c.query<{ handle: string; gh: unknown }>(
      `SELECT handle, data->'github_integration' AS gh
         FROM docos
        WHERE id = ANY($1::text[])
          AND data ? 'github_integration'
        ORDER BY handle`,
      [docoIds],
    );
    return groupKnownGitHubInstallations(
      rows.map((row) => ({ handle: row.handle, githubIntegration: row.gh })),
    );
  });
}

/**
 * List reusable GitHub org/repo choices for a signed-in user. The caller passes
 * accessible Doco ids; this function never widens access on its own.
 */
export async function listGitHubInstallationChoicesForDocos(
  docoIds: string[],
  deps?: {
    getInstallation?: typeof getInstallationAccount;
    mintToken?: typeof mintInstallationToken;
    listRepos?: typeof listInstallationRepos;
  },
): Promise<GitHubInstallationChoice[]> {
  const getInstallation = deps?.getInstallation ?? getInstallationAccount;
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const listRepos = deps?.listRepos ?? listInstallationRepos;
  const known = await listKnownGitHubInstallationsForDocos(docoIds);
  const choices: GitHubInstallationChoice[] = [];

  for (const choice of known) {
    try {
      const installation = await getInstallation(choice.installation_id).catch(() => null);
      const account = installation?.account ?? choice.account;
      const repositorySelection = installation?.repository_selection ?? choice.repository_selection;
      const { token } = await mintToken(choice.installation_id);
      const repositories = await listRepos(token, {
        account,
        repositorySelection,
      });
      choices.push({
        ...choice,
        account,
        ...(repositorySelection ? { repository_selection: repositorySelection } : {}),
        repositories: [
          ...new Set(repositories.length > 0 ? repositories : choice.connected_repositories),
        ].sort(),
      });
    } catch {
      choices.push({
        ...choice,
        repositories: choice.connected_repositories,
        repositories_unavailable: true,
      });
    }
  }

  return choices;
}

/** Doco handle + org handle + all connections + installations + backfill
 *  marker, in one query (for the Integrations UI and per-repo backfill). */
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
      ? {
          handle: row.handle,
          orgHandle: row.org_handle,
          connections: normalizeConnections(row.gh),
          installations: normalizeInstallations(row.gh),
          backfill: normalizeBackfillState(row.gh),
        }
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

export interface GitHubInstallationAuthorization extends GitHubInstallationSub {
  repository_selection?: "all" | "selected";
}

/** GitHub installations the user has authorized for repo selection. These are
 * not org-wide subscriptions; they only make repositories selectable in the
 * Doco UI after GitHub sends the user back from the install flow. */
export function normalizeInstallationAuthorizations(
  raw: unknown,
): GitHubInstallationAuthorization[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { installation_authorizations?: unknown }).installation_authorizations;
  if (!Array.isArray(list)) return [];
  const out: GitHubInstallationAuthorization[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const e = x as {
      installation_id?: unknown;
      account?: unknown;
      connected_at?: unknown;
      repository_selection?: unknown;
    };
    if (typeof e.installation_id !== "number" || typeof e.account !== "string") continue;
    out.push({
      installation_id: e.installation_id,
      account: e.account,
      ...(typeof e.connected_at === "string" ? { connected_at: e.connected_at } : {}),
      ...(e.repository_selection === "all" || e.repository_selection === "selected"
        ? { repository_selection: e.repository_selection }
        : {}),
    });
  }
  return out;
}

export async function listInstallationAuthorizations(
  docoId: string,
): Promise<GitHubInstallationAuthorization[]> {
  return withClient(async (c) => {
    const r = await c.query<{ gh: unknown }>(
      `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
      [docoId],
    );
    return normalizeInstallationAuthorizations(r.rows[0]?.gh);
  });
}

async function writeInstallationAuthorizations(
  docoId: string,
  auths: GitHubInstallationAuthorization[],
): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                COALESCE(data, '{}'::jsonb)
                  || jsonb_build_object(
                       'github_integration',
                       COALESCE(data->'github_integration', '{}'::jsonb)),
                '{github_integration,installation_authorizations}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [docoId, JSON.stringify(auths)],
    );
  });
}

export interface RecordInstallationAuthorizationDeps {
  list: (docoId: string) => Promise<GitHubInstallationAuthorization[]>;
  write: (docoId: string, auths: GitHubInstallationAuthorization[]) => Promise<void>;
}

export async function recordInstallationAuthorization(
  docoId: string,
  auth: GitHubInstallationAuthorization,
  deps?: Partial<RecordInstallationAuthorizationDeps>,
): Promise<GitHubInstallationAuthorization[]> {
  const list = deps?.list ?? listInstallationAuthorizations;
  const write = deps?.write ?? writeInstallationAuthorizations;
  const next = [
    ...(await list(docoId)).filter((a) => a.installation_id !== auth.installation_id),
    auth,
  ];
  await write(docoId, next);
  return next;
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

/**
 * Uninstall cleanup: detach an App installation from EVERY Doco — drop its
 * `installations[]` subscription and any `connections[]` carrying that
 * installation id. Driven by the `installation` webhook's "deleted" action so a
 * Doco doesn't keep syncing a repo the App can no longer see. Idempotent; the
 * indexed `@>` predicates touch only the Docos that actually hold it.
 */
export async function unsubscribeInstallationEverywhere(installationId: number): Promise<void> {
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
        WHERE data->'github_integration'->'installations'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))`,
      [installationId],
    );
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                data,
                '{github_integration,connections}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(data->'github_integration'->'connections') AS elem
                   WHERE (elem->>'installation_id')::int <> $1
                ), '[]'::jsonb)
              ),
              updated_at = now()
        WHERE data->'github_integration'->'connections'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))`,
      [installationId],
    );
  });
}

/**
 * Detach specific repos from EVERY Doco's `connections[]` — driven by the
 * `installation_repositories` webhook's "removed" action (access revoked for
 * those repos). A repo belongs to one Doco, so removing by full-name is
 * unambiguous. No-op for an empty list. Idempotent.
 */
export async function detachReposEverywhere(repos: string[]): Promise<void> {
  if (repos.length === 0) return;
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos
          SET data = jsonb_set(
                data,
                '{github_integration,connections}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(data->'github_integration'->'connections') AS elem
                   WHERE elem->>'repo' <> ALL($1::text[])
                ), '[]'::jsonb)
              ),
              updated_at = now()
        WHERE EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(data->'github_integration'->'connections') AS elem
                 WHERE elem->>'repo' = ANY($1::text[])
              )`,
      [repos],
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

/**
 * Re-discover the current repos for every installation a Doco is connected
 * through and record any that are missing — so a repo added to the org *after*
 * connect (or one whose `installation_repositories` webhook was missed) shows
 * up. Re-lists each distinct installation (from explicit subscriptions and the
 * installation ids carried by existing connections) via
 * importInstallationConnections, which addConnection's each (idempotent).
 * Returns the installation ids reconciled. A failing installation (bad token,
 * revoked) is logged and skipped, not fatal.
 */
export async function reconcileInstallationConnections(
  docoId: string,
  input: { installations: GitHubInstallationSub[]; connections: GitHubConnection[] },
  deps?: { importRepos?: typeof importInstallationConnections },
): Promise<number[]> {
  const importRepos = deps?.importRepos ?? importInstallationConnections;
  const ids = [
    ...new Set([
      ...input.installations.map((i) => i.installation_id),
      ...input.connections.map((c) => c.installation_id),
    ]),
  ].filter((id) => Number.isInteger(id) && id > 0);
  for (const installationId of ids) {
    try {
      await importRepos({ docoId, installationId });
    } catch (err) {
      console.error(`[github reconcile] installation ${installationId} failed:`, err);
    }
  }
  return ids;
}
