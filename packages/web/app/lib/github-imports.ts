// What a Doco brings from GitHub. The GitHub setup asks which of these to
// bring, and each fills its own Doco of the matching template: pull requests
// into a GitHub pull requests Doco, bugs into the Bug tracker. A Doco's
// template decides what it brings; any other Doco connected to GitHub keeps
// bringing pull requests, which is what every GitHub connection brought before
// there was a choice.

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
}

export const GITHUB_IMPORTS: readonly GitHubImport[] = [
  {
    id: "pull-requests",
    template: "github-pull-requests",
    label: "Pull requests",
    description: "Every pull request, tracked as a Reference that settles when it merges.",
    item: "pull request",
    items: "pull requests",
  },
  {
    id: "bugs",
    template: "bugs",
    label: "Bugs",
    description:
      "Issues labeled bug (or of the Bug issue type), filed as bugs in the Bug tracker and closed when the issue closes.",
    item: "bug",
    items: "bugs",
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
