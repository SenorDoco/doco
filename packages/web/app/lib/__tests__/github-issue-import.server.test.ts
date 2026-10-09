import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findNodeIdByLocator: vi.fn(async (): Promise<string | null> => null),
  captureGenericNode: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock("../capture.server", () => ({
  NO_FIELDS_CHANGED: "No fields changed.",
  captureGenericNode: mocks.captureGenericNode,
  updateEntity: mocks.updateEntity,
}));
vi.mock("../github-pr-import.server", () => ({
  findNodeIdByLocator: mocks.findNodeIdByLocator,
  resolveAuthorUserIdByLogin: vi.fn(async () => null),
}));

import { type GitHubIssue, issueState, syncIssue } from "../github-issue-import.server";

const URL = "https://github.com/acme/app/issues/7";
const issue: GitHubIssue = {
  number: 7,
  title: "Login fails with a 500 ",
  html_url: URL,
  state: "open",
  user: { login: "ana" },
};
const target = { docoDir: "/d", docoId: "doco_1", ownerSlug: "acme", docoSlug: "acme-issues" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findNodeIdByLocator.mockResolvedValue(null);
});

describe("issueState", () => {
  it("files an open issue as reported, awaiting triage", () => {
    expect(issueState({ state: "open" })).toEqual({ lifecycle: "drafting", resolution: null });
  });

  it("retires a closed issue with GitHub's reason for closing it", () => {
    const closed = (state_reason: string | null) => issueState({ state: "closed", state_reason });
    expect(closed("completed")).toEqual({ lifecycle: "retired", resolution: "completed" });
    expect(closed("not_planned")).toEqual({ lifecycle: "retired", resolution: "not_planned" });
    expect(closed("duplicate")).toEqual({ lifecycle: "retired", resolution: "duplicate" });
    expect(closed(null)).toEqual({ lifecycle: "retired", resolution: null });
    expect(closed("something_new")).toEqual({ lifecycle: "retired", resolution: null });
  });
});

describe("syncIssue", () => {
  it("files a new issue as an Eval keyed on the issue URL", async () => {
    mocks.captureGenericNode.mockResolvedValue({ ok: true, id: "eval_new" });
    const res = await syncIssue(issue, {
      ...target,
      resolveAuthorUserId: async (login) => (login === "ana" ? "user_ana" : null),
    });
    expect(res).toEqual({ status: "created", id: "eval_new" });
    expect(mocks.findNodeIdByLocator).toHaveBeenCalledWith("doco_1", "eval", URL);
    expect(mocks.captureGenericNode).toHaveBeenCalledWith(
      "/d",
      "doco_1",
      "acme",
      "acme-issues",
      "eval",
      {
        prose: "Login fails with a 500",
        extra: { locator: URL },
        lifecycle: "drafting",
        created_by_user_id: "user_ana",
      },
      undefined,
    );
  });

  it("files a closed issue as retired with its resolution", async () => {
    mocks.captureGenericNode.mockResolvedValue({ ok: true, id: "eval_new" });
    await syncIssue({ ...issue, state: "closed", state_reason: "completed" }, target);
    expect(mocks.captureGenericNode.mock.calls[0]?.[5]).toMatchObject({
      extra: { locator: URL, resolution: "completed" },
      lifecycle: "retired",
    });
  });

  it("updates the Eval it filed before instead of duplicating it", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    const res = await syncIssue({ ...issue, state: "closed", state_reason: "not_planned" }, target);
    expect(res).toEqual({ status: "updated", id: "eval_old" });
    expect(mocks.captureGenericNode).not.toHaveBeenCalled();
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeType: "eval",
        id: "eval_old",
        patch: { prose: "Login fails with a 500", lifecycle: "retired", resolution: "not_planned" },
      }),
    );
  });

  it("clears the resolution when a closed issue is reopened", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    await syncIssue(issue, target);
    expect(mocks.updateEntity.mock.calls[0]?.[0].patch).toEqual({
      prose: "Login fails with a 500",
      lifecycle: "drafting",
      resolution: null,
    });
  });

  it("reports an unchanged re-sync as unchanged, not as a failure", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ error: "No fields changed." });
    expect(await syncIssue(issue, target)).toEqual({ status: "unchanged", id: "eval_old" });
  });

  it("retires the Eval of an issue deleted on GitHub", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    await syncIssue(issue, { ...target, deleted: true });
    expect(mocks.updateEntity.mock.calls[0]?.[0].patch).toEqual({ lifecycle: "retired" });
  });

  it("ignores a deleted issue it never filed, and a pull request", async () => {
    expect(await syncIssue(issue, { ...target, deleted: true })).toEqual({ status: "unchanged" });
    expect(await syncIssue({ ...issue, pull_request: {} }, target)).toEqual({
      status: "unchanged",
    });
    expect(mocks.captureGenericNode).not.toHaveBeenCalled();
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("surfaces a capture error", async () => {
    mocks.captureGenericNode.mockResolvedValue({ error: "Authoring policy violation: x" });
    expect(await syncIssue(issue, target)).toEqual({
      status: "error",
      error: "Authoring policy violation: x",
    });
  });
});
