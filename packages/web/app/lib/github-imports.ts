// What a Doco brings from GitHub. The GitHub setup asks which of these to
// bring, and each fills a standalone Doco of its own template: pull requests
// into a GitHub pull requests Doco, issues into a GitHub issues Doco (never the
// Bug tracker people file bugs in), the codebase into a codebase Doco. A Doco's
// template decides what it brings; any other Doco connected to GitHub keeps
// bringing pull requests, which is what every GitHub connection brought before
// there was a choice.

import type { GitHubBackfillState } from "./github-connection.server";

export interface GitHubImport {
  /** The choice's id, and the suffix of the handle a new Doco for it gets:
   *  `<workspace>-<id>`. */
  id: string;
  /** The Doco template the choice fills. */
  template: string;
  label: string;
  /** One line on what comes over and where it lands. */
  description: string;
  /** What one copied item is called, and several, for progress and status copy. */
  item: string;
  items: string;
  /** The GitHub App's repository permission that reads them. */
  permission: string;
  /** Only repositories that use GitHub issues have any: the GitHub setup
   *  brings this choice only when one of the picked repositories does
   *  (github-setup). */
  onlyFromReposUsingIssues?: true;
}

export const GITHUB_IMPORTS: readonly GitHubImport[] = [
  {
    id: "pull-requests",
    template: "github-pull-requests",
    label: "Pull requests",
    description: "Every pull request, tracked as a Reference that settles when it merges.",
    item: "pull request",
    items: "pull requests",
    permission: "Pull requests",
  },
  {
    id: "github-issues",
    template: "github-issues",
    label: "Issues",
    description:
      "Every issue, from the repositories that use GitHub issues, tracked until it closes.",
    item: "issue",
    items: "issues",
    permission: "Issues",
    onlyFromReposUsingIssues: true,
  },
  {
    id: "codebase",
    template: "codebase",
    label: "Codebase",
    description:
      "Every file on each repository's default branch, kept in sync on every push and searchable by people and agents.",
    item: "file",
    items: "files",
    permission: "Contents",
  },
];

const [PULL_REQUESTS] = GITHUB_IMPORTS;

/** What a Doco created from `template` brings from GitHub. Pure. */
export function githubImportFor(template: string | null | undefined): GitHubImport {
  return GITHUB_IMPORTS.find((i) => i.template === template) ?? PULL_REQUESTS;
}

/** The choice with this id, or undefined. Pure. */
export function findGitHubImport(id: string): GitHubImport | undefined {
  return GITHUB_IMPORTS.find((i) => i.id === id);
}

/** Whether GitHub refused Doco's GitHub App a repository the import skipped
 *  (403): the account hasn't accepted the access the App asks for. Pure. */
export function refusedAccess(backfill: Pick<GitHubBackfillState, "errors">): boolean {
  return (backfill.errors ?? []).some((e) => e.status === 403);
}

/** What to tell someone when GitHub refused Doco's GitHub App the repositories
 *  an import skipped: accept the App's request for the permission that reads
 *  what the Doco brings. Only the App's owner can add a permission to the App;
 *  everyone else accepts it in GitHub. Pure. */
export function refusedAccessNote(brings: Pick<GitHubImport, "items" | "permission">): string {
  return `GitHub hasn't given Doco's GitHub App access to their ${brings.items} yet. Accept the App's request for ${brings.permission} access in GitHub.`;
}

/** How many repositories an import skipped. A marker written before the count
 *  was kept counts the repositories it names. Pure. */
export function skippedRepos(backfill: GitHubBackfillState): number {
  return backfill.skipped ?? new Set((backfill.errors ?? []).map((e) => e.repo)).size;
}
