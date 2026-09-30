import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// House style: the documentation-unit noun is lowercase ("a doco", "this
// doco", "docos in this workspace"). #943 lowercased the integrations landing,
// Slack, and catalog copy; these two pages render the same noun further down
// (the per-doco GitHub page and the per-workspace rollup) and still need it.
//
// The *product/agent* name stays capitalized — "Doco can see <repo>",
// "Give Doco access to it in GitHub" — so we assert those survive untouched, to keep the
// sweep from over-lowercasing the brand. (Sentence/heading-initial "Docos in
// this workspace" also stays, like any first word.)
// The per-doco GitHub page renders copy from the shared GitHub repo picker too.
const githubSource = () =>
  ["../$docoHandle.integrations.github.tsx", "../../components/github-repo-picker.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
const workspaceRollupSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle.integrations.tsx", import.meta.url), "utf8");

describe("integrations pages — doco noun is lowercase, brand is not", () => {
  it("lowercases the doco noun on the per-doco GitHub integration page", () => {
    const src = githubSource();

    // Demonstrative/quantified noun usages render lowercase.
    expect(src).toContain("connect this doco.");
    expect(src).toContain("this doco brings {brings.items} from.");
    expect(src).toContain("A writer on this doco can connect them.");

    // No capital-D noun phrase survives in the rendered copy.
    expect(src).not.toContain("this Doco");

    // The product/agent name stays capitalized — these are not the noun.
    expect(src).toContain("Give Doco access to it in GitHub");
    expect(src).toContain("Every repository Doco can see");
  });

  it("lowercases the doco noun on the per-workspace integrations rollup", () => {
    const src = workspaceRollupSource();

    expect(src).toContain("each doco&apos;s");
    expect(src).toContain("every doco in this workspace");
    expect(src).toContain("No docos in this workspace have integrations configured yet.");

    expect(src).not.toContain("every Doco in this workspace");
    expect(src).not.toContain("No Docos in this workspace");
    expect(src).not.toContain("each Doco&apos;s");

    // The card title is the first word of a heading — capitalized like any
    // sentence start, matching the workspace-home docos list.
    expect(src).toContain('<CardTitle className="text-base">Docos in this workspace</CardTitle>');
  });
});
