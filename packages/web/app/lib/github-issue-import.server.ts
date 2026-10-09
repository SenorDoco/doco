// GitHub issue → Doco import. A GitHub issues Doco connected to GitHub files
// each issue as an Eval whose prose is the issue title and whose `locator` is
// the issue URL, the idempotency key. Re-syncing the same issue updates that
// Eval rather than duplicating it.
//
// The Eval's lifecycle follows the issue: an open issue is reported and still
// to triage (`drafting`), and a closed one is retired with GitHub's reason for
// closing it as its `resolution`. A deleted issue retires the Eval it had
// filed. Like a pull request's Reference, the Eval holds only the title; the
// issue body stays on GitHub, a click away through the locator.
import { NO_FIELDS_CHANGED, captureGenericNode, updateEntity } from "./capture.server";
import {
  type GitHubSyncResult,
  findNodeIdByLocator,
  resolveAuthorUserIdByLogin,
} from "./github-pr-import.server";

/** The subset of a GitHub issue (REST list item or webhook `issue`) Doco keeps. */
export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  /** Why a closed issue closed: "completed" | "not_planned" | "duplicate" | "reopened" | null. */
  state_reason?: string | null;
  user?: { login?: string } | null;
  /** Present when the item is a pull request (GitHub lists PRs as issues too). */
  pull_request?: unknown;
}

/** GitHub's reasons for closing an issue. */
const CLOSE_REASONS = ["completed", "not_planned", "duplicate"] as const;
export type IssueResolution = (typeof CLOSE_REASONS)[number];

export interface IssueState {
  lifecycle: "drafting" | "retired";
  resolution: IssueResolution | null;
}

/**
 * The Eval's lifecycle and resolution for an issue's state. Pure.
 *   open   → drafting (reported, triage pending)
 *   closed → retired, resolved with GitHub's close reason (completed,
 *            not_planned or duplicate), or none for any other
 */
export function issueState(issue: Pick<GitHubIssue, "state" | "state_reason">): IssueState {
  if (issue.state !== "closed") return { lifecycle: "drafting", resolution: null };
  const reason = CLOSE_REASONS.find((r) => r === issue.state_reason);
  return { lifecycle: "retired", resolution: reason ?? null };
}

export interface SyncIssueOpts {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoHost?: string;
  actorId?: string | null;
  /** The issue was deleted on GitHub: retire the Eval it filed. */
  deleted?: boolean;
  /** Override the github_login → Doco-user-id lookup (testing seam). */
  resolveAuthorUserId?: (login: string) => Promise<string | null>;
}

/**
 * Idempotently sync one GitHub issue into its GitHub issues Doco: file a new
 * issue, update the Eval it filed before, or retire that Eval once the issue
 * is deleted. A pull request, and a deleted issue that never filed an Eval,
 * is a no-op (`unchanged`).
 */
export async function syncIssue(
  issue: GitHubIssue,
  opts: SyncIssueOpts,
): Promise<GitHubSyncResult> {
  if (issue.pull_request) return { status: "unchanged" };
  const existingId = await findNodeIdByLocator(opts.docoId, "eval", issue.html_url);
  if (opts.deleted && !existingId) return { status: "unchanged" };

  const patch = opts.deleted
    ? { lifecycle: "retired" }
    : { prose: issue.title.trim(), ...issueState(issue) };

  if (existingId) {
    const res = await updateEntity({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      nodeType: "eval",
      pluralDir: "evals",
      id: existingId,
      patch,
      ...(opts.docoHost ? { docoHost: opts.docoHost } : {}),
      actorId: opts.actorId ?? null,
    });
    if ("error" in res) {
      return res.error === NO_FIELDS_CHANGED
        ? { status: "unchanged", id: existingId }
        : { status: "error", error: res.error };
    }
    return { status: "updated", id: existingId };
  }

  // Attribute a new issue to whoever opened it, when they signed in to Doco
  // with the same GitHub account.
  let createdByUserId: string | null = null;
  if (issue.user?.login) {
    const resolve = opts.resolveAuthorUserId ?? resolveAuthorUserIdByLogin;
    createdByUserId = await resolve(issue.user.login).catch(() => null);
  }
  const { lifecycle, resolution } = issueState(issue);
  const res = await captureGenericNode(
    opts.docoDir,
    opts.docoId,
    opts.ownerSlug,
    opts.docoSlug,
    "eval",
    {
      prose: issue.title.trim(),
      extra: { locator: issue.html_url, ...(resolution ? { resolution } : {}) },
      lifecycle,
      ...(createdByUserId ? { created_by_user_id: createdByUserId } : {}),
    },
    opts.docoHost,
  );
  if ("error" in res) return { status: "error", error: res.error };
  return { status: "created", id: res.id };
}
