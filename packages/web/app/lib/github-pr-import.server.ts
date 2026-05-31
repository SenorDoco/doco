// GitHub PR → Doco Reference import (References model — no dedicated node type).
//
// A pull request is stored as a `reference` node: ref_type "url", locator = the
// canonical PR URL (the idempotency key), prose = title + body. Re-importing
// the same PR upserts the existing Reference (open→drafting, merged→asserted,
// closed→retired) rather than duplicating — possible because the node freeze
// was removed, so References are editable. Decisions/Actions link to the PR via
// the existing `implemented_by` edge; no new edge or node type is introduced.
//
// Pure mapping (the lifecycle / prose / draft helpers) is unit-tested directly;
// the upsert orchestration delegates to the already-tested captureReference /
// updateEntity write paths. Author attribution (github_login → Doco user) is
// resolved by the caller and passed as createdByUserId.
import { withClient } from "@doco/db";
import {
  type CaptureError,
  type CaptureResult,
  type ReferenceDraft,
  captureReference,
  updateEntity,
} from "./capture.server";

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

export interface PullRequestRefLifecycle {
  lifecycle: "drafting" | "asserted" | "retired";
  outcome?: "succeeded";
}

/**
 * Map a GitHub PR's state to the Reference's lifecycle. Pure.
 *   open            → drafting (in-flight, may still change)
 *   merged          → asserted + outcome succeeded (a settled fact: it shipped)
 *   closed-unmerged → retired (abandoned)
 *
 * "Merged" is detected from `merged === true` OR a non-null `merged_at`. The
 * distinction matters because GitHub's "list pull requests" endpoint — which the
 * backfill pages — omits the `merged` boolean and only sends `merged_at`. Keying
 * off `merged` alone would mis-map every backfilled merged PR (state "closed",
 * merged boolean absent) to retired. merged_at is present on both the list and
 * webhook payloads, so it's the reliable signal.
 */
export function pullRequestRefLifecycle(
  pr: Pick<GitHubPullRequest, "state" | "merged" | "merged_at">,
): PullRequestRefLifecycle {
  if (pr.merged || pr.merged_at) return { lifecycle: "asserted", outcome: "succeeded" };
  if (pr.state === "closed") return { lifecycle: "retired" };
  return { lifecycle: "drafting" };
}

/** Reference prose for a PR: first line = title (the node label), then the body. Pure. */
export function pullRequestReferenceProse(pr: Pick<GitHubPullRequest, "title" | "body">): string {
  const title = pr.title.trim();
  const body = (pr.body ?? "").trim();
  return body ? `${title}\n\n${body}` : title;
}

/**
 * Map a GitHub PR → a ReferenceDraft (ref_type "url"; locator = PR URL, the
 * idempotency key). Pure. The caller fills `created_by_user_id` from the PR
 * author's github_login → Doco user mapping.
 */
export function pullRequestToReferenceDraft(pr: GitHubPullRequest): ReferenceDraft {
  const { lifecycle, outcome } = pullRequestRefLifecycle(pr);
  return {
    reference: pullRequestReferenceProse(pr),
    ref_type: "url",
    locator: pr.html_url,
    lifecycle,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Find an existing, in-scope Reference in this Doco whose `locator` equals the
 * PR URL — the dedupe key for idempotent import. Returns the oldest match's id
 * (or null). `locator` is a promoted column on `nodes`, so this is an indexed
 * lookup, not a JSONB scan.
 */
export async function findReferenceIdByLocator(
  docoId: string,
  locator: string,
): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM nodes
        WHERE doco_id = $1 AND node_type = 'reference' AND locator = $2
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
  /** Resolved Doco user id for the PR author (from github_login), if any. */
  createdByUserId?: string | null;
}

/**
 * Idempotently import a PR as a Reference: PATCH the existing Reference that
 * shares the PR URL, or capture a new one. Keyed on `locator`, so a webhook
 * re-delivery or a backfill overlap never duplicates.
 */
export async function upsertPullRequestReference(
  pr: GitHubPullRequest,
  opts: UpsertPullRequestOpts,
): Promise<CaptureResult | CaptureError> {
  const draft = pullRequestToReferenceDraft(pr);
  const existingId = await findReferenceIdByLocator(opts.docoId, draft.locator);

  if (existingId) {
    return updateEntity({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      entityType: "reference",
      pluralDir: "references",
      id: existingId,
      patch: {
        reference: draft.reference,
        lifecycle: draft.lifecycle,
        ...(draft.outcome ? { outcome: draft.outcome } : {}),
      },
      ...(opts.docoHost ? { docoHost: opts.docoHost } : {}),
      actorId: opts.actorId ?? null,
    });
  }

  return captureReference(
    opts.docoDir,
    opts.docoId,
    opts.ownerSlug,
    opts.docoSlug,
    { ...draft, ...(opts.createdByUserId ? { created_by_user_id: opts.createdByUserId } : {}) },
    opts.docoHost,
  );
}
