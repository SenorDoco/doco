// Per-Doco GitHub connection config, stored in docos.data.github_integration.
// This is the glue the webhook (findDocoByInstallation) and backfill read:
// it records which GitHub repo + App installation a Doco is wired to. Written
// by the settings panel / connect endpoint.
import { createHmac, timingSafeEqual } from "node:crypto";
import { withClient } from "@doco/db";
import {
  getInstallationAccount,
  listInstallationRepos,
  mintInstallationToken,
} from "./github-app.server";
import { GITHUB_IMPORTS, githubImportFor, refusedAccess, skippedRepos } from "./github-imports";
import { isLocalPath } from "./local-path";

/**
 * SQL for what the Doco aliased `alias` brings from GitHub — the template of
 * its GITHUB_IMPORTS choice (see github-imports.ts): its own template when that
 * is a choice, pull requests for any other Doco. Repo events route on it, and
 * one repo (or org subscription) belongs to one Doco per thing brought.
 */
export function githubImportSql(alias: string): string {
  const fallback = githubImportFor(null).template;
  const others = GITHUB_IMPORTS.filter((i) => i.template !== fallback)
    .map((i) => `'${i.template}'`)
    .join(", ");
  const template = `${alias}.data->>'template_handle'`;
  return `(CASE WHEN ${template} IN (${others}) THEN ${template} ELSE '${fallback}' END)`;
}

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
type DocoQueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/**
 * The Doco's connected GitHub repo as an "owner/name" slug, or null when the
 * Doco isn't connected to a repo. Takes a query client so dialog loaders can
 * resolve it on their existing connection. Used to turn a Reference's bare
 * `path:line` locator into a GitHub blob permalink.
 */
export async function getGitHubRepoSlug(
  c: DocoQueryClient,
  docoId: string,
): Promise<string | null> {
  const r = await c.query<{ gh: unknown }>(
    `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
    [docoId],
  );
  const conn = normalizeConnections(r.rows[0]?.gh)[0];
  if (!conn) return null;
  const slug = parseRepoSlug(conn.repo);
  return slug ? `${slug.owner}/${slug.name}` : null;
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

/** What the install flow's `state` carries through GitHub and back. */
export interface InstallState {
  /** The Doco user who started the install; the callback must be them. */
  userId: string;
  /** The Docos the installation's repositories become selectable on. */
  docoIds: string[];
  /** Where the callback sends the user back to: a path on this site. */
  next: string;
  /** Connect every repository the installation grants to each Doco, and the
   *  organization as a whole, as soon as GitHub sends the user back, instead
   *  of having them pick (a workspace's one-click Connect GitHub). */
  connectAll?: boolean;
  issuedAt: number;
}

const INSTALL_STATE_TTL_MS = 60 * 60 * 1000;

/** The App's client secret doubles as the state's HMAC key: the flow can't
 *  verify installs without it anyway (see `exchangeInstallationCode`). */
function installStateKey(): string | null {
  return process.env.DOCO_GITHUB_APP_CLIENT_SECRET || null;
}

function installStateSignature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Sign `state` so the setup callback can trust the Docos + user it names.
 *  Null when the key isn't configured. Pure (given env). */
export function signInstallState(state: InstallState): string | null {
  const key = installStateKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${installStateSignature(payload, key)}`;
}

/** The state `signInstallState` produced, or null if it is unsigned, tampered
 *  with, or older than an hour. Pure (given env). */
export function verifyInstallState(raw: string, now = Date.now()): InstallState | null {
  const key = installStateKey();
  const [payload, signature, extra] = raw.split(".");
  if (!key || !payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(installStateSignature(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as InstallState;
    if (typeof state.userId !== "string" || !isLocalPath(state.next)) return null;
    const docoIds = Array.isArray(state.docoIds) ? state.docoIds : [];
    if (docoIds.length === 0 || docoIds.some((id) => typeof id !== "string")) return null;
    if (!Number.isFinite(state.issuedAt) || now - state.issuedAt > INSTALL_STATE_TTL_MS) {
      return null;
    }
    return {
      userId: state.userId,
      docoIds,
      next: state.next,
      ...(state.connectAll === true ? { connectAll: true } : {}),
      issuedAt: state.issuedAt,
    };
  } catch {
    return null;
  }
}

/** GitHub App install URL for the click-through flow, with a signed `state`
 *  binding the Docos, the installing user and the page to return to; null if
 *  the app slug (DOCO_GITHUB_APP_SLUG) or client secret isn't configured. */
export function buildInstallUrl(target: Omit<InstallState, "issuedAt">): string | null {
  const slug = process.env.DOCO_GITHUB_APP_SLUG;
  const state = signInstallState({ ...target, issuedAt: Date.now() });
  if (!slug || !state) return null;
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
 * Enforce one repo, one Doco per thing brought: remove `repo` from the
 * connections of every OTHER Doco that brings what `keepDocoId` brings, so a
 * repo's pull requests land in one Doco and its bugs in one GitHub bugs Doco.
 * Idempotent; the indexed `@>` predicate touches only the Docos that actually
 * hold the repo.
 */
export async function detachRepoFromOtherDocos(repo: string, keepDocoId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos d
          SET data = jsonb_set(
                d.data,
                '{github_integration,connections}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(d.data->'github_integration'->'connections') AS elem
                   WHERE elem->>'repo' <> $1
                ), '[]'::jsonb)
              ),
              updated_at = now()
         FROM docos keep
        WHERE keep.id = $2
          AND d.id <> $2
          AND ${githubImportSql("d")} = ${githubImportSql("keep")}
          AND d.data->'github_integration'->'connections'
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

type PickableInstallation = Pick<
  GitHubInstallationChoice,
  "installation_id" | "account" | "repositories"
>;

/**
 * What a user picked to connect, checked against the GitHub installations they
 * can use: each repository through the installation that offers it (whatever
 * organization it is in), and each organization picked as a whole, which
 * brings every repository its installation lists now and subscribes to the
 * ones GitHub gives Doco later. Repositories come normalized ("owner/name")
 * and de-duplicated in the order picked. Nothing posted is trusted beyond what
 * those installations show. Pure.
 */
export function pickConnections<C extends PickableInstallation>(
  choices: C[],
  picked: { repos: string[]; installations: string[] },
):
  | { connections: Array<Pick<GitHubConnection, "repo" | "installation_id">>; installations: C[] }
  | { error: string } {
  const installations: C[] = [];
  for (const id of new Set(picked.installations.map(Number))) {
    const choice = choices.find((c) => c.installation_id === id);
    if (!choice) return { error: "That GitHub connection is not available to your account." };
    installations.push(choice);
  }
  const repos: string[] = [];
  for (const input of picked.repos.map((r) => r.trim()).filter(Boolean)) {
    const parsed = parseRepoSlug(input);
    if (!parsed) return { error: `Invalid repo: ${input}` };
    repos.push(`${parsed.owner}/${parsed.name}`);
  }
  const connections: Array<Pick<GitHubConnection, "repo" | "installation_id">> = [];
  for (const repo of [...repos, ...installations.flatMap((c) => c.repositories)]) {
    const choice = choices.find((c) => c.repositories.includes(repo));
    if (!choice) return { error: `${repo} is not available from your GitHub connections.` };
    if (!connections.some((c) => c.repo === repo)) {
      connections.push({ repo, installation_id: choice.installation_id });
    }
  }
  return connections.length + installations.length > 0
    ? { connections, installations }
    : { error: "Pick at least one repository." };
}

/**
 * Connect repositories to a Doco and queue their import. An import already
 * under way keeps its place and takes them at the end of its queue, so adding
 * a repository never abandons the ones still importing. The caller kicks the
 * backfill worker (`kickBackfillRun`) to run it.
 */
export async function connectRepositories(
  docoId: string,
  connections: Array<Pick<GitHubConnection, "repo" | "installation_id">>,
): Promise<void> {
  const connectedAt = new Date().toISOString();
  for (const connection of connections) {
    await addConnection(docoId, { ...connection, connected_at: connectedAt });
  }
  const repos = connections.map((c) => c.repo);
  const running = (await getDocoConnectionsContext(docoId))?.backfill;
  if (running?.status === "running" && running.queue?.length) {
    const queue = [...running.queue, ...repos.filter((r) => !running.queue?.includes(r))];
    await setBackfillState(docoId, { ...running, queue, repos: queue.length });
    return;
  }
  await setBackfillState(docoId, {
    status: "running",
    started_at: connectedAt,
    repos: repos.length,
    queue: repos,
    repo_index: 0,
    page: 1,
    imported: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    cursor_at: connectedAt,
  });
}

/**
 * Connect what a person picked to a Doco: subscribe it to each organization
 * picked as a whole, so repositories GitHub gives Doco later come in too, and
 * queue the import of every picked repository. True when an import is queued
 * for the caller to kick (`kickBackfillRun`).
 */
export async function connectPicked(
  docoId: string,
  picked: {
    connections: Array<Pick<GitHubConnection, "repo" | "installation_id">>;
    installations: Array<Pick<GitHubInstallationSub, "installation_id" | "account">>;
  },
): Promise<boolean> {
  const connectedAt = new Date().toISOString();
  for (const choice of picked.installations) {
    await subscribeInstallation(docoId, {
      installation_id: choice.installation_id,
      account: choice.account,
      connected_at: connectedAt,
    });
  }
  if (picked.connections.length === 0) return false;
  await connectRepositories(docoId, picked.connections);
  return true;
}

/** Remove a connection by repo. Returns the remaining list. */
export async function removeConnection(docoId: string, repo: string): Promise<GitHubConnection[]> {
  const next = (await listConnections(docoId)).filter((c) => c.repo !== repo);
  await writeConnections(docoId, next);
  return next;
}

// ─── Backfill progress marker ────────────────────────────────────────────
// A connect kicks off the PR import off the request path (waitUntil); for an
// org with tens of thousands of PRs that runs long. We stamp a marker on the
// Doco so the UI can say "importing in the background — keep working" and the
// user isn't blocked. Stored at docos.data.github_integration.backfill; no
// schema change needed (plain JSONB, like connections/installations).

/** A repo the backfill could not import (gone, access revoked, or transient
 *  failures past the retry cap) — recorded so the gap is visible, not silent. */
export interface BackfillError {
  repo: string;
  page?: number;
  message: string;
  /** GitHub's HTTP status, when GitHub answered (403: it refused Doco access). */
  status?: number;
  /** ISO time the repo was skipped. */
  at: string;
}

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
  /** Consecutive failed attempts at the current cursor position; resets on any
   *  progress. The driver skips the repo once this reaches the retry cap. */
  attempts?: number;
  /** ISO time before which the worker must not retry — set when a slice paused
   *  on a GitHub rate limit, so the import resumes only once the window clears. */
  retry_after?: string;
  /** Repos skipped (gone/forbidden, or transient failures past the cap). */
  skipped?: number;
  /** The first of them, with why (bounded on a huge org). */
  errors?: BackfillError[];
}

/** Validate a persisted backfill error before trusting it. Pure. */
function isBackfillError(x: unknown): x is BackfillError {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return typeof e.repo === "string" && typeof e.message === "string" && typeof e.at === "string";
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
    ...(Array.isArray(e.queue)
      ? { queue: e.queue.filter((x): x is string => typeof x === "string") }
      : {}),
    ...num("repo_index"),
    ...num("page"),
    ...num("updated"),
    ...num("unchanged"),
    ...num("failed"),
    ...(typeof e.cursor_at === "string" ? { cursor_at: e.cursor_at } : {}),
    ...num("attempts"),
    ...(typeof e.retry_after === "string" ? { retry_after: e.retry_after } : {}),
    ...num("skipped"),
    ...(Array.isArray(e.errors) ? { errors: e.errors.filter(isBackfillError) } : {}),
  };
}

export interface GitHubImportProgress {
  /** Repositories whose PR import has fully finished. */
  done: number;
  /** Total repositories in this import. */
  total: number;
}

/**
 * Repo-level progress for an in-flight PR backfill: how many of the import's
 * repos have finished, out of the total — the data behind an "importing 2 of
 * 4…" indicator. Null unless a backfill is actively running with a known repo
 * total, so callers fall back to a plain "importing…" when there's no count to
 * show. `done` is clamped to `[0, total]`: a slice that just drained the last
 * repo can leave `repo_index === total` (or beyond) for a tick before the
 * marker flips to "done". Pure.
 */
export function githubImportProgress(
  backfill: GitHubBackfillState | null,
): GitHubImportProgress | null {
  if (!backfill || backfill.status !== "running") return null;
  const total = backfill.repos ?? 0;
  if (total <= 0) return null;
  const done = Math.min(Math.max(backfill.repo_index ?? 0, 0), total);
  return { done, total };
}

/** Minutes a "running" import may sit without its cursor advancing before
 *  status.json flags it as stalled. Set above the 5-minute sweep interval (the
 *  worker checkpoints every <200s) so a healthy chain is never falsely flagged
 *  — only a genuinely stranded one. */
export const IMPORT_STALL_MINUTES = 15;

/** PR-import health surfaced on a Doco's status.json — so a stalled or
 *  incomplete backfill is observable instead of silent. */
export interface GitHubImportStatus {
  status: "running" | "done";
  /** PR References created so far. */
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Repos in the import queue. */
  repos: number;
  /** Repos fully imported (clamped to `[0, repos]`). */
  repos_done: number;
  started_at?: string;
  finished_at?: string;
  cursor_at?: string;
  /** True when a "running" import hasn't advanced its cursor in a long time (or
   *  never had a heartbeat) — the signature of a stranded chain a sweep re-kicks. */
  stalled: boolean;
  /** Repos skipped (gone/forbidden, or transient failures past the cap). */
  skipped: number;
  /** The first of them, with why. */
  errors: BackfillError[];
}

/**
 * Condense a backfill marker into the import-health summary status.json
 * exposes. Null when there's no backfill to report. The `stalled` flag turns
 * the exact failure mode that stranded large org imports — a "running" marker
 * whose cursor stopped advancing — into a visible signal. Pure given the clock.
 */
export function summarizeBackfillForStatus(
  backfill: GitHubBackfillState | null,
  nowMs: number = Date.now(),
): GitHubImportStatus | null {
  if (!backfill) return null;
  const repos = backfill.repos ?? 0;
  const repos_done = Math.min(Math.max(backfill.repo_index ?? 0, 0), Math.max(repos, 0));
  const cursorMs = backfill.cursor_at ? Date.parse(backfill.cursor_at) : Number.NaN;
  const stalled =
    backfill.status === "running" &&
    (Number.isNaN(cursorMs) || nowMs - cursorMs > IMPORT_STALL_MINUTES * 60_000);
  return {
    status: backfill.status,
    imported: backfill.imported ?? 0,
    updated: backfill.updated ?? 0,
    unchanged: backfill.unchanged ?? 0,
    failed: backfill.failed ?? 0,
    repos,
    repos_done,
    ...(backfill.started_at ? { started_at: backfill.started_at } : {}),
    ...(backfill.finished_at ? { finished_at: backfill.finished_at } : {}),
    ...(backfill.cursor_at ? { cursor_at: backfill.cursor_at } : {}),
    stalled,
    skipped: skippedRepos(backfill),
    errors: backfill.errors ?? [],
  };
}

/** How far a Doco's import of a source's older items has got. */
export type ImportState = "importing" | "stalled" | "done";

/** The old-PR import's progress, for the Doco's integration status. */
export interface GitHubImportState {
  state: ImportState;
  reposDone: number;
  repos: number;
  /** Repositories the import skipped. */
  skipped: number;
  /** GitHub refused Doco's GitHub App access to one of them (a permission not accepted). */
  refused: boolean;
}

/**
 * The old-PR import's progress from a raw `docos.data.github_integration`
 * value: null when the Doco tracks no repo and no org installation, else
 * whether the import is running, stalled (see summarizeBackfillForStatus), or
 * done. A Doco counts as connected the moment it subscribes to an org
 * installation, even before the first repo syncs — same "connected" rule as the
 * Integrations page. Pure given the clock.
 */
export function githubImportState(
  raw: unknown,
  nowMs: number = Date.now(),
): GitHubImportState | null {
  const connected = normalizeConnections(raw).length > 0 || normalizeInstallations(raw).length > 0;
  if (!connected) return null;
  const summary = summarizeBackfillForStatus(normalizeBackfillState(raw), nowMs);
  return {
    state: summary?.status !== "running" ? "done" : summary.stalled ? "stalled" : "importing",
    reposDone: summary?.repos_done ?? 0,
    repos: summary?.repos ?? 0,
    skipped: summary?.skipped ?? 0,
    refused: refusedAccess({ errors: summary?.errors }),
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
          AND deleted_at IS NULL
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
  workspaceHandle: string;
  /** The template the Doco was created from, which decides what it brings
   *  from GitHub (github-imports). */
  template: string | null;
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
          AND deleted_at IS NULL
        ORDER BY handle`,
      [docoIds],
    );
    return groupKnownGitHubInstallations(
      rows.map((row) => ({ handle: row.handle, githubIntegration: row.gh })),
    );
  });
}

/** The GitHub accounts (organizations and users) Doco already reaches through
 *  these Docos, without asking GitHub for their repositories. */
export async function listKnownGitHubAccounts(
  docoIds: string[],
): Promise<Array<Pick<GitHubInstallationChoice, "installation_id" | "account">>> {
  return (await listKnownGitHubInstallationsForDocos(docoIds)).map((choice) => ({
    installation_id: choice.installation_id,
    account: choice.account,
  }));
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

/** Doco handle + org handle + template + all connections + installations +
 *  backfill marker, in one query (for the Integrations UI and per-repo backfill). */
export async function getDocoConnectionsContext(
  docoId: string,
): Promise<DocoConnectionsContext | null> {
  return withClient(async (c) => {
    const r = await c.query<{
      handle: string;
      workspace_handle: string;
      template: string | null;
      gh: unknown;
    }>(
      `SELECT d.handle, o.handle AS workspace_handle, d.data->>'template_handle' AS template,
              d.data->'github_integration' AS gh
         FROM docos d
         JOIN workspaces o ON o.id = d.workspace_id
        WHERE d.id = $1`,
      [docoId],
    );
    const row = r.rows[0];
    return row
      ? {
          handle: row.handle,
          workspaceHandle: row.workspace_handle,
          template: row.template,
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
 * Enforce one installation, one Doco per thing brought: drop the installation
 * from the installations[] of every OTHER Doco that brings what `keepDocoId`
 * brings. Idempotent; the indexed `@>` predicate touches only the Docos that
 * actually hold the installation.
 */
export async function detachInstallationFromOtherDocos(
  installationId: number,
  keepDocoId: string,
): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE docos d
          SET data = jsonb_set(
                d.data,
                '{github_integration,installations}',
                COALESCE((
                  SELECT jsonb_agg(elem)
                    FROM jsonb_array_elements(d.data->'github_integration'->'installations') AS elem
                   WHERE (elem->>'installation_id')::int <> $1
                ), '[]'::jsonb)
              ),
              updated_at = now()
         FROM docos keep
        WHERE keep.id = $2
          AND d.id <> $2
          AND ${githubImportSql("d")} = ${githubImportSql("keep")}
          AND d.data->'github_integration'->'installations'
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
 * Re-discover the current repos of every organization a Doco subscribes to as a
 * whole and record any that are missing, so a repo added to the org after
 * connect (or one whose `installation_repositories` webhook was missed) shows
 * up. A Doco that picked its repositories one by one gets none added. Returns
 * the installation ids reconciled. A failing installation (bad token, revoked)
 * is logged and skipped, not fatal.
 */
export async function reconcileInstallationConnections(
  docoId: string,
  installations: GitHubInstallationSub[],
  deps?: { importRepos?: typeof importInstallationConnections },
): Promise<number[]> {
  const importRepos = deps?.importRepos ?? importInstallationConnections;
  const ids = [...new Set(installations.map((i) => i.installation_id))];
  for (const installationId of ids) {
    try {
      await importRepos({ docoId, installationId });
    } catch (err) {
      console.error(`[github reconcile] installation ${installationId} failed:`, err);
    }
  }
  return ids;
}

/**
 * Once an installation accepts new permissions, the repositories GitHub refused
 * Doco before may be readable: start the import again for every Doco connected
 * through it whose last import skipped a repository. Returns their ids; the
 * caller kicks the backfill worker for each.
 */
export async function restartSkippedImports(installationId: number): Promise<string[]> {
  const ids = await withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM docos
        WHERE data->'github_integration'->'connections'
                @> jsonb_build_array(jsonb_build_object('installation_id', $1::int))
          AND data->'github_integration'->'backfill'->'errors' <> '[]'::jsonb
          AND deleted_at IS NULL
        ORDER BY id`,
      [installationId],
    );
    return r.rows.map((row) => row.id);
  });
  for (const id of ids) {
    const ctx = await getDocoConnectionsContext(id);
    if (ctx) await setBackfillState(id, resumeCursorFromConnections(ctx.connections, ctx.backfill));
  }
  return ids;
}
