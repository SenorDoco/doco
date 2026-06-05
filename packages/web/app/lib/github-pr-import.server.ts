// GitHub PR → Doco Reference import (References model — no dedicated node type).
//
// A pull request is stored as a `reference` node: ref_type "url", locator = the
// canonical PR URL (the idempotency key), prose = title; the PR body lives in
// attributes.body_md (omitted when the PR has no body). Re-importing
// the same PR upserts the existing Reference (open->queued, merged->active,
// closed->retired) rather than duplicating - possible because the node freeze
// was removed, so References are editable. Decisions/Actions link to the PR via
// the canonical `supports` edge with an implemented_by role; no new edge or
// node type is introduced.
//
// Pure mapping (the lifecycle / prose / draft helpers) is unit-tested directly;
// the upsert orchestration delegates to the already-tested captureReference /
// updateEntity write paths. Author attribution (github_login → Doco user) is
// resolved by the caller and passed as createdByUserId.
import { getUserByGithubLogin, withClient } from "@doco/db";
import { isEntityId } from "@doco/shared";
import { NO_FIELDS_CHANGED, captureGenericNode, updateEntity } from "./capture.server";
import { normalizePath, parseCodeReferenceLocator } from "./code-locator";
import {
  type CaptureEdgeInput,
  type EdgeCaptureResult,
  captureEdge,
  edgeExists,
} from "./edge-capture.server";

export type { CodeReferenceLocator } from "./code-locator";
export { parseCodeReferenceLocator };

/** The subset of the GitHub `pull_request` payload Doco maps to a Reference. */
export interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  user?: { login?: string } | null;
}

/** The subset of GitHub's `List pull request files` response used for code-linking. */
export interface GitHubPullRequestFile {
  filename: string;
  patch?: string | null;
}

export interface PullRequestRefLifecycle {
  lifecycle: "queued" | "active" | "retired";
  outcome?: "succeeded";
}

/**
 * Map a GitHub PR's state to the Reference's lifecycle. Pure.
 *   open            → queued (in-flight, ready for review, may still change)
 *   open + approved → active (the team has signed off, not yet shipped)
 *   merged          → active + outcome succeeded (a settled fact: it shipped)
 *   closed-unmerged → retired (abandoned)
 *
 * "Merged" is detected from `merged === true` OR a non-null `merged_at`. The
 * distinction matters because GitHub's "list pull requests" endpoint — which the
 * backfill pages — omits the `merged` boolean and only sends `merged_at`. Keying
 * off `merged` alone would mis-map every backfilled merged PR (state "closed",
 * merged boolean absent) to retired. merged_at is present on both the list and
 * webhook payloads, so it's the reliable signal.
 *
 * `approved` is supplied by the `pull_request_review` webhook (an approving
 * review on an open PR). Approval lifts an open PR queued → active; merge
 * then adds `outcome: succeeded`. New commits (a later `synchronize` re-sync
 * without `approved`) drop it back to queued, mirroring GitHub dismissing a
 * stale review.
 */
export function pullRequestRefLifecycle(
  pr: Pick<GitHubPullRequest, "state" | "merged" | "merged_at">,
  opts?: { approved?: boolean },
): PullRequestRefLifecycle {
  if (pr.merged || pr.merged_at) return { lifecycle: "active", outcome: "succeeded" };
  if (pr.state === "closed") return { lifecycle: "retired" };
  if (opts?.approved) return { lifecycle: "active" };
  return { lifecycle: "queued" };
}

/**
 * The Reference fields a PR maps to. An internal GitHub→Doco import struct
 * (not the public capture API): `pullRequestToReferenceDraft` fills it, then
 * the create path hands it to the generic node writer and the update path
 * maps it onto a PATCH.
 */
export interface ReferenceDraft {
  /** The Reference's prose: the PR title only (single line). */
  reference: string;
  /** The PR body → attributes.body_md. Undefined when the PR has no body. */
  body?: string;
  ref_type: string;
  locator: string;
  content_hash?: string | null;
  created_by_user_id?: string;
  lifecycle?: string;
  outcome?: "succeeded" | "failed";
}

/**
 * Reference prose for a PR: the title ONLY (the node label). The PR body is
 * split out to attributes.body_md (see `pullRequestToReferenceDraft`), so the
 * prose is a single line. Pure.
 */
export function pullRequestReferenceProse(pr: Pick<GitHubPullRequest, "title" | "body">): string {
  return pr.title.trim();
}

/**
 * Map a GitHub PR → a ReferenceDraft (ref_type "url"; locator = PR URL, the
 * idempotency key). Pure. The caller fills `created_by_user_id` from the PR
 * author's github_login → Doco user mapping.
 */
export function pullRequestToReferenceDraft(
  pr: GitHubPullRequest,
  opts?: { approved?: boolean },
): ReferenceDraft {
  const { lifecycle, outcome } = pullRequestRefLifecycle(pr, opts);
  const body = (pr.body ?? "").trim();
  return {
    reference: pr.title.trim(),
    ...(body ? { body } : {}),
    ref_type: "url",
    locator: pr.html_url,
    lifecycle,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Find an existing, in-scope Reference in this Doco whose `locator` equals the
 * PR URL — the dedupe key for idempotent import. Returns the oldest match's id
 * (or null). Keyed on `attributes->>'locator'`, kept an indexed lookup by the
 * partial expression index `nodes_ref_locator_idx`.
 */
export async function findReferenceIdByLocator(
  docoId: string,
  locator: string,
): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM nodes
        WHERE doco_id = $1 AND node_type = 'reference' AND attributes->>'locator' = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [docoId, locator],
    );
    return r.rows[0]?.id ?? null;
  });
}

export interface UpsertPullRequestOpts {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoHost?: string;
  actorId?: string | null;
  /** Resolved Doco user id for the PR author (from github_login), if any.
   *  When omitted, the upsert resolves it from the PR author's github_login. */
  createdByUserId?: string | null;
  /** Override the github_login → Doco-user-id lookup (testing seam). */
  resolveAuthorUserId?: (login: string) => Promise<string | null>;
  /** The PR carries an approving review (from `pull_request_review`): an open
   *  PR maps queued → active. Ignored once merged/closed. */
  approved?: boolean;
  /** Changed files for the PR, when the caller has a GitHub installation token. */
  changedFiles?: GitHubPullRequestFile[];
}

/**
 * Map a PR author's github_login to a Doco user id, so an imported PR is
 * attributed to the person who opened it (when they've signed into this Doco
 * with the same GitHub account). Null when the login isn't a known Doco user.
 */
export async function resolveAuthorUserIdByLogin(login: string): Promise<string | null> {
  const u = await getUserByGithubLogin(login);
  return u?.id ?? null;
}

/**
 * Outcome of a single PR → Reference sync.
 *   created   — a new Reference was captured.
 *   updated   — an existing Reference changed (lifecycle/prose moved).
 *   unchanged — the Reference already matched; nothing to do (NOT a failure —
 *               this is the common case on a repeat backfill or webhook re-delivery).
 *   error     — the write failed; `error` carries the reason.
 */
export type PullRequestSyncStatus = "created" | "updated" | "unchanged" | "error";
export interface PullRequestSyncResult {
  status: PullRequestSyncStatus;
  id?: string;
  error?: string;
}

// ─── PR → work linking ───────────────────────────────────────────────────
// A PR declares the Doco nodes it implements / fixes via trailer lines in its
// body (the convention in .github/PULL_REQUEST_TEMPLATE.md):
//   Doco-Implements: <node id or doco.to URL>[, …]
//   Doco-Fixes:      <node id or doco.to URL>[, …]
// Both map to a `supports` edge with role=implemented_by - the work node is
// implemented_by the PR's Reference node. Connecting a PR to the BPM event /
// bug / decision it ships was the original ask for this integration.

const WORK_TRAILER_RE = /^(doco-implements|doco-fixes)\s*:\s*(.+)$/i;
// <type>_<26-char ULID>; matched loosely here, then validated by isEntityId.
const ENTITY_ID_RE = /[a-z][a-z_]*_[0-9A-Za-z]{26}/g;

/**
 * Extract the work-node ids a PR claims to implement / fix from its body's
 * trailer lines. Accepts bare entity ids or doco.to URLs embedding one. Pure.
 */
export function parsePrWorkLinks(body: string | null | undefined): {
  implements: string[];
  fixes: string[];
} {
  const out = { implements: [] as string[], fixes: [] as string[] };
  for (const line of (body ?? "").split(/\r?\n/)) {
    const m = WORK_TRAILER_RE.exec(line.trim());
    if (!m) continue;
    const bucket = m[1].toLowerCase() === "doco-fixes" ? out.fixes : out.implements;
    for (const tok of m[2].match(ENTITY_ID_RE) ?? []) {
      if (isEntityId(tok) && !bucket.includes(tok)) bucket.push(tok);
    }
  }
  return out;
}

export interface LinkPrToWorkDeps {
  exists: typeof edgeExists;
  capture: (input: CaptureEdgeInput) => Promise<EdgeCaptureResult>;
}
export interface PrWorkLinkResult {
  /** Edges newly created. */
  linked: number;
  /** Edges that already existed. */
  existing: number;
  /** Referenced ids that couldn't be linked (not a node in this Doco, etc.). */
  skipped: number;
}

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface ChangedFileLineRanges {
  path: string;
  ranges: ChangedLineRange[];
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parse the added/changed new-file line ranges out of GitHub's unified patch. */
export function changedRangesFromPullRequestFiles(
  files: readonly GitHubPullRequestFile[],
): ChangedFileLineRanges[] {
  const out: ChangedFileLineRanges[] = [];
  for (const file of files) {
    const ranges: ChangedLineRange[] = [];
    let newLine = 0;
    let pendingStart: number | null = null;
    let pendingEnd: number | null = null;

    const flush = () => {
      if (pendingStart !== null && pendingEnd !== null) {
        ranges.push({ start: pendingStart, end: pendingEnd });
      }
      pendingStart = null;
      pendingEnd = null;
    };

    for (const line of (file.patch ?? "").split(/\r?\n/)) {
      const hunk = HUNK_RE.exec(line);
      if (hunk) {
        flush();
        newLine = Number(hunk[1]);
        continue;
      }
      if (!newLine) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        pendingStart ??= newLine;
        pendingEnd = newLine;
        newLine++;
        continue;
      }
      flush();
      if (line.startsWith("-") && !line.startsWith("---")) continue;
      if (line.startsWith("\\")) continue;
      newLine++;
    }
    flush();
    if (ranges.length > 0) out.push({ path: normalizePath(file.filename), ranges });
  }
  return out;
}

// `parseCodeReferenceLocator` and the path-normalization helpers now live in
// ./code-locator so the note/edge dialogs can share them client-side.

function pathsMatch(referencePath: string, changedPath: string): boolean {
  const ref = normalizePath(referencePath);
  const changed = normalizePath(changedPath);
  return ref === changed || ref.endsWith(`/${changed}`) || changed.endsWith(`/${ref}`);
}

function rangesOverlap(a: ChangedLineRange, b: ChangedLineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function locatorOverlapsChangedLines(
  locator: string | null | undefined,
  changedRanges: readonly ChangedFileLineRanges[],
): boolean {
  const parsed = parseCodeReferenceLocator(locator);
  if (!parsed) return false;
  for (const file of changedRanges) {
    if (!pathsMatch(parsed.path, file.path)) continue;
    for (const range of file.ranges) {
      if (rangesOverlap(range, parsed)) return true;
    }
  }
  return false;
}

interface BusinessProcessReferenceRow {
  reference_id: string;
  locator: string | null;
  implemented_by_from_id: string | null;
}

/**
 * Find business-process nodes already connected to code-artifact References
 * whose locator line range overlaps this PR's changed lines.
 */
export async function findBusinessProcessReferenceTargetsForChangedLines(
  docoId: string,
  changedRanges: readonly ChangedFileLineRanges[],
): Promise<string[]> {
  if (changedRanges.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query<BusinessProcessReferenceRow>(
      `SELECT r.id AS reference_id,
              r.attributes->>'locator' AS locator,
              e.from_id AS implemented_by_from_id
         FROM nodes r
         LEFT JOIN edges e
           ON e.doco_id = r.doco_id
          AND e.edge_type = 'supports'
          AND e.to_id = r.id
          AND e.lifecycle <> 'retired'
        WHERE r.doco_id = $1
          AND r.node_type = 'reference'
          AND COALESCE(r.lifecycle, 'active') <> 'retired'
          AND r.attributes->>'locator' IS NOT NULL
          AND e.from_id IS NOT NULL`,
      [docoId],
    );
    const targetIds: string[] = [];
    for (const row of r.rows) {
      if (!locatorOverlapsChangedLines(row.locator, changedRanges)) continue;
      for (const candidate of [row.implemented_by_from_id]) {
        if (!candidate || candidate === row.reference_id || !isEntityId(candidate)) continue;
        if (!targetIds.includes(candidate)) targetIds.push(candidate);
      }
    }
    return targetIds;
  });
}

/** Cheap preflight so GitHub sync only fetches PR files when code references exist. */
export async function hasBusinessProcessCodeReferences(docoId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query<{ x: number }>(
      `SELECT 1 AS x
         FROM nodes r
         LEFT JOIN edges e
           ON e.doco_id = r.doco_id
          AND e.edge_type = 'supports'
          AND e.to_id = r.id
          AND e.lifecycle <> 'retired'
        WHERE r.doco_id = $1
          AND r.node_type = 'reference'
          AND COALESCE(r.lifecycle, 'active') <> 'retired'
          AND r.attributes->>'locator' IS NOT NULL
          AND e.from_id IS NOT NULL
        LIMIT 1`,
      [docoId],
    );
    return r.rows.length > 0;
  });
}

export interface LinkPrToBusinessProcessReferencesDeps {
  findTargets: typeof findBusinessProcessReferenceTargetsForChangedLines;
  exists: typeof edgeExists;
  capture: (input: CaptureEdgeInput) => Promise<EdgeCaptureResult>;
}

/**
 * Ensure an implemented_by-flavored `supports` edge from each work node to the
 * Reference node. Idempotent (skips edges that already exist) and forgiving
 * (skips ids that aren't nodes in this Doco — captureEdge rejects them).
 * Injectable deps so it's unit-testable without a DB.
 */
export async function linkPullRequestToWork(
  opts: {
    docoId: string;
    prRefId: string;
    body: string | null | undefined;
    actorId?: string | null;
  },
  deps?: Partial<LinkPrToWorkDeps>,
): Promise<PrWorkLinkResult> {
  const exists = deps?.exists ?? edgeExists;
  const capture = deps?.capture ?? captureEdge;
  const { implements: imp, fixes } = parsePrWorkLinks(opts.body);
  const nodeIds = [...new Set([...imp, ...fixes])];
  const result: PrWorkLinkResult = { linked: 0, existing: 0, skipped: 0 };
  for (const nodeId of nodeIds) {
    if (nodeId === opts.prRefId) continue; // no self-edge
    if (await exists(opts.docoId, "supports", nodeId, opts.prRefId)) {
      result.existing++;
      continue;
    }
    const res = await capture({
      docoId: opts.docoId,
      actorId: opts.actorId ?? null,
      edgeType: "supports",
      fromId: nodeId,
      toId: opts.prRefId,
      reason: "Linked from a GitHub pull request trailer (Doco-Implements / Doco-Fixes).",
    });
    if ("ok" in res) result.linked++;
    else result.skipped++;
  }
  return result;
}

/**
 * Ensure an `implemented_by` edge from each business-process event whose
 * existing code Reference overlaps the PR's changed lines → the PR Reference.
 */
export async function linkPullRequestToBusinessProcessReferences(
  opts: {
    docoId: string;
    prRefId: string;
    changedFiles?: readonly GitHubPullRequestFile[];
    actorId?: string | null;
  },
  deps?: Partial<LinkPrToBusinessProcessReferencesDeps>,
): Promise<PrWorkLinkResult> {
  const result: PrWorkLinkResult = { linked: 0, existing: 0, skipped: 0 };
  const changedRanges = changedRangesFromPullRequestFiles(opts.changedFiles ?? []);
  if (changedRanges.length === 0) return result;

  const findTargets = deps?.findTargets ?? findBusinessProcessReferenceTargetsForChangedLines;
  const exists = deps?.exists ?? edgeExists;
  const capture = deps?.capture ?? captureEdge;
  const nodeIds = [...new Set(await findTargets(opts.docoId, changedRanges))];
  for (const nodeId of nodeIds) {
    if (nodeId === opts.prRefId) continue;
    if (await exists(opts.docoId, "supports", nodeId, opts.prRefId)) {
      result.existing++;
      continue;
    }
    const res = await capture({
      docoId: opts.docoId,
      actorId: opts.actorId ?? null,
      edgeType: "supports",
      fromId: nodeId,
      toId: opts.prRefId,
      reason:
        "Linked from a GitHub pull request touching an existing business-process code reference.",
    });
    if ("ok" in res) result.linked++;
    else result.skipped++;
  }
  return result;
}

async function linkPullRequestContext(opts: {
  docoId: string;
  prRefId: string;
  body: string | null | undefined;
  changedFiles?: readonly GitHubPullRequestFile[];
  actorId?: string | null;
}): Promise<PrWorkLinkResult> {
  const work = await linkPullRequestToWork(opts);
  const businessProcess = await linkPullRequestToBusinessProcessReferences(opts);
  return {
    linked: work.linked + businessProcess.linked,
    existing: work.existing + businessProcess.existing,
    skipped: work.skipped + businessProcess.skipped,
  };
}

/**
 * Idempotently import a PR as a Reference: PATCH the existing Reference that
 * shares the PR URL, or capture a new one. Keyed on `locator`, so a webhook
 * re-delivery or a backfill overlap never duplicates. A no-op PATCH (the PR is
 * already current) surfaces as `unchanged`, never `error`, so repeat syncs
 * don't masquerade as failures.
 */
export async function upsertPullRequestReference(
  pr: GitHubPullRequest,
  opts: UpsertPullRequestOpts,
): Promise<PullRequestSyncResult> {
  const draft = pullRequestToReferenceDraft(pr, { approved: opts.approved });
  const existingId = await findReferenceIdByLocator(opts.docoId, draft.locator);

  if (existingId) {
    const res = await updateEntity({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      entityType: "reference",
      pluralDir: "references",
      id: existingId,
      // Patch the title prose AND the body. The body rides in
      // `attributes.body_md`; updateEntity flattens that onto the node's data
      // bag. Always send the key — set to the body, or `null` to CLEAR it when
      // the PR body became empty — so a body→empty edit doesn't leave a stale
      // body_md behind. When title+body+lifecycle are all unchanged the patch
      // is a no-op (NO_FIELDS_CHANGED → `unchanged`), preserving idempotence.
      patch: {
        reference: draft.reference,
        lifecycle: draft.lifecycle,
        attributes: { body_md: draft.body ?? null },
        ...(draft.outcome ? { outcome: draft.outcome } : {}),
      },
      ...(opts.docoHost ? { docoHost: opts.docoHost } : {}),
      actorId: opts.actorId ?? null,
    });
    if ("error" in res) {
      // An idempotent re-sync that finds the Reference already current isn't a
      // failure — it's the steady state.
      if (res.error === NO_FIELDS_CHANGED) {
        const links = await linkPullRequestContext({
          docoId: opts.docoId,
          prRefId: existingId,
          body: pr.body,
          changedFiles: opts.changedFiles,
          actorId: opts.actorId,
        });
        return { status: links.linked > 0 ? "updated" : "unchanged", id: existingId };
      }
      return { status: "error", error: res.error };
    }
    await linkPullRequestContext({
      docoId: opts.docoId,
      prRefId: existingId,
      body: pr.body,
      changedFiles: opts.changedFiles,
      actorId: opts.actorId,
    });
    return { status: "updated", id: existingId };
  }

  // Attribute the new Reference to the PR author. Prefer an explicitly-passed
  // id; otherwise resolve the PR author's github_login → Doco user. Resolution
  // only happens on create (an existing Reference's author never changes) and
  // only when the PR carries an author login, so a repeat backfill that finds
  // everything `unchanged` never pays for a lookup.
  let createdByUserId = opts.createdByUserId ?? null;
  if (!createdByUserId && pr.user?.login) {
    const resolve = opts.resolveAuthorUserId ?? resolveAuthorUserIdByLogin;
    try {
      createdByUserId = await resolve(pr.user.login);
    } catch {
      createdByUserId = null;
    }
  }
  // Map the import struct onto the generic row shape: prose → prose, the
  // ref_type/locator/content_hash scalars → attributes.
  const res = await captureGenericNode(
    opts.docoDir,
    opts.docoId,
    opts.ownerSlug,
    opts.docoSlug,
    "reference",
    {
      prose: draft.reference,
      attributes: {
        ref_type: draft.ref_type,
        locator: draft.locator,
        ...(draft.content_hash ? { content_hash: draft.content_hash } : {}),
        ...(draft.body ? { body_md: draft.body } : {}),
      },
      ...(draft.lifecycle ? { lifecycle: draft.lifecycle } : {}),
      ...(draft.outcome ? { outcome: draft.outcome } : {}),
      ...(createdByUserId ? { created_by_user_id: createdByUserId } : {}),
    },
    opts.docoHost,
  );
  if ("error" in res) return { status: "error", error: res.error };
  await linkPullRequestContext({
    docoId: opts.docoId,
    prRefId: res.id,
    body: pr.body,
    changedFiles: opts.changedFiles,
    actorId: opts.actorId,
  });
  return { status: "created", id: res.id };
}
