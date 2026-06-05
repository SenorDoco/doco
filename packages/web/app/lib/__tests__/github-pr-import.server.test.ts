import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  captureGenericNode: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  getUserByGithubLogin: vi.fn(async () => null),
}));
vi.mock("../capture.server", () => ({
  NO_FIELDS_CHANGED: "No fields changed.",
  captureGenericNode: mocks.captureGenericNode,
  updateEntity: mocks.updateEntity,
}));

import {
  type GitHubPullRequest,
  type GitHubPullRequestFile,
  changedRangesFromPullRequestFiles,
  linkPullRequestToBusinessProcessReferences,
  linkPullRequestToWork,
  parseCodeReferenceLocator,
  parsePrWorkLinks,
  pullRequestRefLifecycle,
  pullRequestReferenceProse,
  pullRequestToReferenceDraft,
  upsertPullRequestReference,
} from "../github-pr-import.server";

describe("parsePrWorkLinks", () => {
  it("extracts implements/fixes ids from trailer lines (bare id + doco.to URL)", () => {
    const body = [
      "Fixes the retry bug.",
      "Doco-Implements: decision_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "Doco-Fixes: https://doco.to/acme/store/decision/decision_01BX5ZZKBKACTAV9WEVGEMMVRZ",
      "not a trailer",
    ].join("\n");
    expect(parsePrWorkLinks(body)).toEqual({
      implements: ["decision_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      fixes: ["decision_01BX5ZZKBKACTAV9WEVGEMMVRZ"],
    });
  });
  it("is empty when there are no trailers", () => {
    expect(parsePrWorkLinks("just a description")).toEqual({ implements: [], fixes: [] });
    expect(parsePrWorkLinks(null)).toEqual({ implements: [], fixes: [] });
  });
});

describe("linkPullRequestToWork", () => {
  const body =
    "x\nDoco-Implements: decision_01ARZ3NDEKTSV4RRFFQ69G5FAV, intent_01BX5ZZKBKACTAV9WEVGEMMVRZ";
  it("creates implemented_by-flavored supports edges for new links and skips existing ones", async () => {
    const exists = vi.fn(
      async (_d: string, _t: string, from: string) =>
        from === "decision_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    const capture = vi.fn(async () => ({
      ok: true as const,
      id: "edge_x",
      path: "",
      edge: {} as never,
      footer_lines: [],
    }));
    const res = await linkPullRequestToWork(
      { docoId: "doco_1", prRefId: "reference_pr", body, actorId: null },
      { exists: exists as never, capture: capture as never },
    );
    expect(res).toEqual({ linked: 1, existing: 1, skipped: 0 });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeType: "supports",
        fromId: "intent_01BX5ZZKBKACTAV9WEVGEMMVRZ",
        toId: "reference_pr",
      }),
    );
  });
  it("counts a capture rejection (node not in this Doco) as skipped", async () => {
    const res = await linkPullRequestToWork(
      {
        docoId: "doco_1",
        prRefId: "reference_pr",
        body: "Doco-Fixes: decision_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      {
        exists: vi.fn(async () => false) as never,
        capture: vi.fn(async () => ({
          error: "from_id does not exist in this Doco.",
          status: 400,
        })) as never,
      },
    );
    expect(res).toEqual({ linked: 0, existing: 0, skipped: 1 });
  });
});

describe("PR changed-code business-process links", () => {
  const files: GitHubPullRequestFile[] = [
    {
      filename: "packages/web/app/lib/github-pr-import.server.ts",
      patch: [
        "@@ -209,6 +209,8 @@ export async function linkPullRequestToWork(",
        "   const result: PrWorkLinkResult = { linked: 0, existing: 0, skipped: 0 };",
        "+  await linkPullRequestToBusinessProcessReferences(opts);",
        "+  return result;",
        " }",
      ].join("\n"),
    },
  ];

  it("parses changed line ranges from a GitHub PR file patch", () => {
    expect(changedRangesFromPullRequestFiles(files)).toEqual([
      {
        path: "packages/web/app/lib/github-pr-import.server.ts",
        ranges: [{ start: 210, end: 211 }],
      },
    ]);
  });

  it("parses code-reference locators with line anchors", () => {
    expect(
      parseCodeReferenceLocator(
        "https://github.com/torrenegra/doco/blob/main/packages/web/app/lib/github-pr-import.server.ts#L210-L211",
      ),
    ).toEqual({
      path: "github.com/torrenegra/doco/blob/main/packages/web/app/lib/github-pr-import.server.ts",
      start: 210,
      end: 211,
    });
    expect(
      parseCodeReferenceLocator("packages/web/app/lib/github-pr-import.server.ts:210"),
    ).toEqual({
      path: "packages/web/app/lib/github-pr-import.server.ts",
      start: 210,
      end: 210,
    });
  });

  it("links a PR to an existing business-process event when the diff touches its code reference", async () => {
    const exists = vi.fn(async () => false);
    const capture = vi.fn(async () => ({
      ok: true as const,
      id: "edge_pr_to_action",
      path: "",
      edge: {} as never,
      footer_lines: [],
    }));

    const res = await linkPullRequestToBusinessProcessReferences(
      {
        docoId: "doco_1",
        prRefId: "reference_pr",
        changedFiles: files,
        actorId: null,
      },
      {
        exists: exists as never,
        capture: capture as never,
        findTargets: vi.fn(async () => ["action_01ARZ3NDEKTSV4RRFFQ69G5FAV"]),
      },
    );

    expect(res).toEqual({ linked: 1, existing: 0, skipped: 0 });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeType: "supports",
        fromId: "action_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toId: "reference_pr",
        reason:
          "Linked from a GitHub pull request touching an existing business-process code reference.",
      }),
    );
  });
});

const basePr: GitHubPullRequest = {
  number: 482,
  title: "fix(checkout): retry idempotency key on 409",
  body: "Makes the key idempotent.",
  html_url: "https://github.com/acme/store/pull/482",
  state: "open",
};

describe("pullRequestRefLifecycle", () => {
  it("open → queued", () => {
    expect(pullRequestRefLifecycle({ state: "open" })).toEqual({ lifecycle: "queued" });
  });
  it("merged → active + succeeded", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: true })).toEqual({
      lifecycle: "active",
      outcome: "succeeded",
    });
  });
  it("closed unmerged → retired", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: false })).toEqual({
      lifecycle: "retired",
    });
  });
  it("merged via merged_at when the `merged` boolean is absent (list endpoint) → active", () => {
    // GitHub's "list pull requests" endpoint (what the backfill pages) omits the
    // `merged` boolean and only sends `merged_at`. A merged PR there is
    // state:"closed" with merged_at set — it must NOT be mistaken for abandoned.
    expect(pullRequestRefLifecycle({ state: "closed", merged_at: "2026-05-31T18:12:54Z" })).toEqual(
      { lifecycle: "active", outcome: "succeeded" },
    );
  });
  it("closed with merged_at null (genuinely abandoned) → retired", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged_at: null })).toEqual({
      lifecycle: "retired",
    });
  });
  it("open + approved → active (signed off, not yet shipped — no outcome)", () => {
    expect(pullRequestRefLifecycle({ state: "open" }, { approved: true })).toEqual({
      lifecycle: "active",
    });
  });
  it("merge still wins over approval (active + succeeded)", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: true }, { approved: true })).toEqual({
      lifecycle: "active",
      outcome: "succeeded",
    });
  });
  it("approval does not resurrect a closed-unmerged PR (stays retired)", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: false }, { approved: true })).toEqual(
      { lifecycle: "retired" },
    );
  });
});

describe("pullRequestReferenceProse", () => {
  // The PR title is the Reference's only text (`prose`); the PR body is not
  // stored.
  it("is the title only when there's no body", () => {
    expect(pullRequestReferenceProse({ title: "T", body: null })).toBe("T");
  });
  it("is the title only even when the PR has a body", () => {
    expect(pullRequestReferenceProse({ title: "T", body: "why" })).toBe("T");
  });
});

describe("pullRequestToReferenceDraft", () => {
  it("maps to a url Reference keyed on the PR URL", () => {
    const d = pullRequestToReferenceDraft({ ...basePr, state: "closed", merged: true });
    expect(d).toMatchObject({
      ref_type: "url",
      locator: "https://github.com/acme/store/pull/482",
      lifecycle: "active",
      outcome: "succeeded",
    });
    expect(d.reference.split("\n")[0]).toBe(basePr.title);
  });
  it("carries the title in `reference` (single line) — the PR body is not stored", () => {
    const d = pullRequestToReferenceDraft(basePr);
    expect(d.reference).toBe(basePr.title);
    expect(d.reference).not.toContain("\n");
    expect(d).not.toHaveProperty("body");
  });
});

describe("upsertPullRequestReference", () => {
  const opts = { docoDir: "/tmp/d", docoId: "doco_1", ownerSlug: "o", docoSlug: "d" };
  const existing = (id: string) =>
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [{ id }] }) }),
    );
  beforeEach(() => vi.clearAllMocks());

  it("creates a new Reference when no existing one matches the PR URL", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ id: "reference_new" });
    const res = await upsertPullRequestReference(basePr, opts);
    expect(res).toEqual({ status: "created", id: "reference_new" });
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("updates the existing Reference when the PR changed", async () => {
    existing("reference_existing");
    mocks.updateEntity.mockResolvedValue({ id: "reference_existing", changed: ["lifecycle"] });
    const res = await upsertPullRequestReference(
      { ...basePr, state: "closed", merged: true },
      opts,
    );
    expect(res).toEqual({ status: "updated", id: "reference_existing" });
    expect(mocks.captureGenericNode).not.toHaveBeenCalled();
  });

  it("re-sync patches the title prose only — the PR body is not stored", async () => {
    existing("reference_existing");
    mocks.updateEntity.mockResolvedValue({ id: "reference_existing", changed: ["prose"] });
    await upsertPullRequestReference({ ...basePr, body: "Updated rationale." }, opts);
    const patch = mocks.updateEntity.mock.calls[0][0].patch;
    // prose = title only; the body is dropped, so the patch carries no attributes.
    expect(patch.reference).toBe(basePr.title);
    expect(patch).not.toHaveProperty("attributes");
  });

  it("reports a no-op re-import as unchanged — NOT a failure", async () => {
    // updateEntity returns {error: "No fields changed."} when the PR is already
    // current; that must not be counted as a failed import (the bug behind the
    // "Imported 0 of 4 PRs (4 failed)" message on a repeat sync).
    existing("reference_existing");
    mocks.updateEntity.mockResolvedValue({ error: "No fields changed." });
    const res = await upsertPullRequestReference(
      { ...basePr, state: "closed", merged: true },
      opts,
    );
    expect(res).toEqual({ status: "unchanged", id: "reference_existing" });
  });

  it("surfaces a genuine update error", async () => {
    existing("reference_existing");
    mocks.updateEntity.mockResolvedValue({ error: "Authoring policy violation: nope" });
    const res = await upsertPullRequestReference(
      { ...basePr, state: "closed", merged: true },
      opts,
    );
    expect(res).toEqual({ status: "error", error: "Authoring policy violation: nope" });
  });

  it("surfaces a capture error for a new Reference", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ error: "locator is required." });
    const res = await upsertPullRequestReference(basePr, opts);
    expect(res).toEqual({ status: "error", error: "locator is required." });
  });

  it("attributes a created Reference to the PR author resolved from github_login", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ id: "reference_new" });
    const resolveAuthorUserId = vi.fn(async () => "user_octocat");
    await upsertPullRequestReference(
      { ...basePr, user: { login: "octocat" } },
      { ...opts, resolveAuthorUserId },
    );
    expect(resolveAuthorUserId).toHaveBeenCalledWith("octocat");
    // captureGenericNode(dir, docoId, ownerSlug, docoSlug, entityType, draft, …):
    // the PR maps onto the raw row shape — prose = title; ref_type/locator land
    // in attributes. The PR body is not stored.
    expect(mocks.captureGenericNode.mock.calls[0][4]).toBe("reference");
    expect(mocks.captureGenericNode.mock.calls[0][5]).toMatchObject({
      prose: basePr.title,
      attributes: {
        ref_type: "url",
        locator: basePr.html_url,
      },
      created_by_user_id: "user_octocat",
    });
    // prose carries ONLY the title, and the body is never stored.
    expect(mocks.captureGenericNode.mock.calls[0][5].prose).not.toContain("idempotent");
    expect(mocks.captureGenericNode.mock.calls[0][5].attributes).not.toHaveProperty("body_md");
  });

  it("stores no body on create even when the PR has a body", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ id: "reference_new" });
    await upsertPullRequestReference({ ...basePr, body: "Some body text." }, opts);
    const draft = mocks.captureGenericNode.mock.calls[0][5];
    expect(draft.prose).toBe(basePr.title);
    expect(draft.attributes).not.toHaveProperty("body_md");
  });

  it("creates without attribution when the author's github_login is unknown", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ id: "reference_new" });
    const resolveAuthorUserId = vi.fn(async () => null);
    await upsertPullRequestReference(
      { ...basePr, user: { login: "ghost" } },
      { ...opts, resolveAuthorUserId },
    );
    expect(mocks.captureGenericNode.mock.calls[0][5].created_by_user_id).toBeUndefined();
  });

  it("an explicit createdByUserId wins over login resolution (no lookup)", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureGenericNode.mockResolvedValue({ id: "reference_new" });
    const resolveAuthorUserId = vi.fn(async () => "user_resolved");
    await upsertPullRequestReference(
      { ...basePr, user: { login: "octocat" } },
      { ...opts, createdByUserId: "user_explicit", resolveAuthorUserId },
    );
    expect(resolveAuthorUserId).not.toHaveBeenCalled();
    expect(mocks.captureGenericNode.mock.calls[0][5]).toMatchObject({
      created_by_user_id: "user_explicit",
    });
  });

  it("does not resolve an author on the update path", async () => {
    existing("reference_existing");
    mocks.updateEntity.mockResolvedValue({ id: "reference_existing", changed: ["lifecycle"] });
    const resolveAuthorUserId = vi.fn(async () => "user_octocat");
    await upsertPullRequestReference(
      { ...basePr, state: "closed", merged: true, user: { login: "octocat" } },
      { ...opts, resolveAuthorUserId },
    );
    expect(resolveAuthorUserId).not.toHaveBeenCalled();
  });
});
