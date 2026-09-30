// GitHub bug issue → Doco bug import. A GitHub bugs Doco connected to GitHub
// files each bug issue as a bug: an Eval (the Bug tracker's shape for a bug)
// whose prose is the issue title and whose `locator` is the issue URL, the
// idempotency key. Re-syncing the same issue updates that Eval rather than
// duplicating it.
//
// The Eval's lifecycle follows the issue: an open issue is a reported bug still
// to triage (`drafting`), and a closed one is retired with the `resolution` GitHub's close reason maps to.
// An issue that stops being a bug (its bug label removed) or is deleted retires
// the bug it had filed. Like a pull request's Reference, the Eval holds only
// the title; the issue body stays on GitHub, a click away through the locator.
import { NO_FIELDS_CHANGED, captureGenericNode, updateEntity } from "./capture.server";
import {
  type GitHubSyncResult,
  findNodeIdByLocator,
  resolveAuthorUserIdByLogin,
} from "./github-pr-import.server";

/** The subset of a GitHub issue (REST list item or webhook `issue`) Doco maps to a bug. */
export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  /** Why a closed issue closed: "completed" | "not_planned" | "duplicate" | "reopened" | null. */
  state_reason?: string | null;
  labels?: Array<{ name?: string } | string>;
  /** The issue type, where the repository's organization uses issue types. */
  type?: { name?: string } | null;
  user?: { login?: string } | null;
  /** Present when the item is a pull request (GitHub lists PRs as issues too). */
  pull_request?: unknown;
}

const BUG_LABEL_RE = /\bbugs?\b/i;

/**
 * Whether a GitHub issue is a bug: it carries a label naming "bug" ("bug",
 * "type: bug", "kind/bug") or is of the Bug issue type. Pull requests never
 * are. Pure.
 */
export function isBugIssue(issue: Pick<GitHubIssue, "labels" | "type" | "pull_request">): boolean {
  if (issue.pull_request) return false;
  if (issue.type?.name && BUG_LABEL_RE.test(issue.type.name)) return true;
  return (issue.labels ?? []).some((label) =>
    BUG_LABEL_RE.test(typeof label === "string" ? label : (label.name ?? "")),
  );
}

export type BugResolution = "fixed" | "wont_fix" | "duplicate";

export interface IssueBugState {
  lifecycle: "drafting" | "retired";
  resolution: BugResolution | null;
}

/**
 * The bug's lifecycle and resolution for an issue's state. Pure.
 *   open                      → drafting (reported, triage pending)
 *   closed as completed       → retired, fixed
 *   closed as not planned     → retired, wont_fix
 *   closed as duplicate       → retired, duplicate
 *   closed for another reason → retired, no resolution
 */
export function issueBugState(issue: Pick<GitHubIssue, "state" | "state_reason">): IssueBugState {
  if (issue.state !== "closed") return { lifecycle: "drafting", resolution: null };
  const resolution: BugResolution | null =
    issue.state_reason === "completed"
      ? "fixed"
      : issue.state_reason === "not_planned"
        ? "wont_fix"
        : issue.state_reason === "duplicate"
          ? "duplicate"
          : null;
  return { lifecycle: "retired", resolution };
}

export interface SyncBugIssueOpts {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoHost?: string;
  actorId?: string | null;
  /** The issue was deleted on GitHub: retire the bug it filed. */
  deleted?: boolean;
  /** Override the github_login → Doco-user-id lookup (testing seam). */
  resolveAuthorUserId?: (login: string) => Promise<string | null>;
}

/**
 * Idempotently sync one GitHub issue into its GitHub bugs Doco: create the bug for a
 * new bug issue, update the one it filed before, or retire it once the issue is
 * no longer a bug. An issue that isn't a bug and never filed one is a no-op
 * (`unchanged`).
 */
export async function syncBugIssue(
  issue: GitHubIssue,
  opts: SyncBugIssueOpts,
): Promise<GitHubSyncResult> {
  const existingId = await findNodeIdByLocator(opts.docoId, "eval", issue.html_url);
  const stillABug = !opts.deleted && isBugIssue(issue);
  if (!stillABug && !existingId) return { status: "unchanged" };

  const patch = stillABug
    ? (() => {
        const { lifecycle, resolution } = issueBugState(issue);
        return { prose: issue.title.trim(), lifecycle, resolution };
      })()
    : { lifecycle: "retired" };

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

  // Attribute a new bug to whoever opened the issue, when they signed in to
  // Doco with the same GitHub account.
  let createdByUserId: string | null = null;
  if (issue.user?.login) {
    const resolve = opts.resolveAuthorUserId ?? resolveAuthorUserIdByLogin;
    createdByUserId = await resolve(issue.user.login).catch(() => null);
  }
  const { lifecycle, resolution } = issueBugState(issue);
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
