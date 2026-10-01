// What a Doco brings from GitHub. The GitHub setup asks which of these to
// bring, and each fills a standalone Doco of its own template: pull requests
// into a GitHub pull requests Doco, bugs into a GitHub bugs Doco (never the
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
    id: "github-bugs",
    template: "github-bugs",
    label: "Bugs",
    description:
      "Issues labeled bug (or of the Bug issue type), tracked as bugs that close when the issue closes.",
    item: "bug",
    items: "bugs",
    permission: "Issues",
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

/** What to tell someone when GitHub refused Doco's GitHub App the repositories
 *  an import skipped: the permission that reads what the Doco brings. Pure. */
export function refusedAccessNote(brings: Pick<GitHubImport, "items" | "permission">): string {
  return `GitHub doesn't let Doco's GitHub App read their ${brings.items}: give the App ${brings.permission} read access in GitHub.`;
}

/** How many repositories an import skipped. A marker written before the count
 *  was kept counts the repositories it names. Pure. */
export function skippedRepos(backfill: GitHubBackfillState): number {
  return backfill.skipped ?? new Set((backfill.errors ?? []).map((e) => e.repo)).size;
}
