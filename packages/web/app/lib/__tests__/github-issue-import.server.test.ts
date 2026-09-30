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

import {
  type GitHubIssue,
  isBugIssue,
  issueBugState,
  syncBugIssue,
} from "../github-issue-import.server";

const URL = "https://github.com/acme/app/issues/7";
const bug: GitHubIssue = {
  number: 7,
  title: "Login fails with a 500 ",
  html_url: URL,
  state: "open",
  labels: [{ name: "bug" }],
  user: { login: "ana" },
};
const target = { docoDir: "/d", docoId: "doco_1", ownerSlug: "acme", docoSlug: "acme-bugs" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findNodeIdByLocator.mockResolvedValue(null);
});

describe("isBugIssue", () => {
  it("is a bug when a label names bug, whatever its prefix or case", () => {
    for (const name of ["bug", "Bug", "type: bug", "kind/bug", "bugs", "🐛 Bug"]) {
      expect(isBugIssue({ labels: [{ name }] }), name).toBe(true);
    }
    expect(isBugIssue({ labels: ["bug"] })).toBe(true);
  });

  it("is a bug when the issue is of the Bug issue type", () => {
    expect(isBugIssue({ labels: [], type: { name: "Bug" } })).toBe(true);
  });

  it("is not a bug otherwise, and a pull request never is", () => {
    expect(isBugIssue({ labels: [{ name: "enhancement" }, { name: "debugging" }] })).toBe(false);
    expect(isBugIssue({ labels: [], type: { name: "Feature" } })).toBe(false);
    expect(isBugIssue({ labels: [{ name: "bug" }], pull_request: {} })).toBe(false);
  });
});

describe("issueBugState", () => {
  it("files an open issue as a reported bug awaiting triage", () => {
    expect(issueBugState({ state: "open" })).toEqual({ lifecycle: "drafting", resolution: null });
  });

  it("retires a closed issue with the resolution its close reason maps to", () => {
    const closed = (state_reason: string | null) =>
      issueBugState({ state: "closed", state_reason });
    expect(closed("completed")).toEqual({ lifecycle: "retired", resolution: "fixed" });
    expect(closed("not_planned")).toEqual({ lifecycle: "retired", resolution: "wont_fix" });
    expect(closed("duplicate")).toEqual({ lifecycle: "retired", resolution: "duplicate" });
    expect(closed(null)).toEqual({ lifecycle: "retired", resolution: null });
  });
});

describe("syncBugIssue", () => {
  it("files a new bug issue as an Eval keyed on the issue URL", async () => {
    mocks.captureGenericNode.mockResolvedValue({ ok: true, id: "eval_new" });
    const res = await syncBugIssue(bug, {
      ...target,
      resolveAuthorUserId: async (login) => (login === "ana" ? "user_ana" : null),
    });
    expect(res).toEqual({ status: "created", id: "eval_new" });
    expect(mocks.findNodeIdByLocator).toHaveBeenCalledWith("doco_1", "eval", URL);
    expect(mocks.captureGenericNode).toHaveBeenCalledWith(
      "/d",
      "doco_1",
      "acme",
      "acme-bugs",
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

  it("files a closed bug as retired with its resolution", async () => {
    mocks.captureGenericNode.mockResolvedValue({ ok: true, id: "eval_new" });
    await syncBugIssue({ ...bug, state: "closed", state_reason: "completed" }, target);
    expect(mocks.captureGenericNode.mock.calls[0]?.[5]).toMatchObject({
      extra: { locator: URL, resolution: "fixed" },
      lifecycle: "retired",
    });
  });

  it("updates the bug it filed before instead of duplicating it", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    const res = await syncBugIssue(
      { ...bug, state: "closed", state_reason: "not_planned" },
      target,
    );
    expect(res).toEqual({ status: "updated", id: "eval_old" });
    expect(mocks.captureGenericNode).not.toHaveBeenCalled();
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeType: "eval",
        id: "eval_old",
        patch: { prose: "Login fails with a 500", lifecycle: "retired", resolution: "wont_fix" },
      }),
    );
  });

  it("clears the resolution when a closed bug is reopened", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    await syncBugIssue(bug, target);
    expect(mocks.updateEntity.mock.calls[0]?.[0].patch).toEqual({
      prose: "Login fails with a 500",
      lifecycle: "drafting",
      resolution: null,
    });
  });

  it("reports an unchanged re-sync as unchanged, not as a failure", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ error: "No fields changed." });
    expect(await syncBugIssue(bug, target)).toEqual({ status: "unchanged", id: "eval_old" });
  });

  it("retires the bug an issue filed once it stops being a bug or is deleted", async () => {
    mocks.findNodeIdByLocator.mockResolvedValue("eval_old");
    mocks.updateEntity.mockResolvedValue({ ok: true });
    await syncBugIssue({ ...bug, labels: [{ name: "enhancement" }] }, target);
    await syncBugIssue(bug, { ...target, deleted: true });
    for (const [call] of mocks.updateEntity.mock.calls) {
      expect(call.patch).toEqual({ lifecycle: "retired" });
    }
  });

  it("ignores an issue that isn't a bug and never filed one", async () => {
    const res = await syncBugIssue({ ...bug, labels: [] }, target);
    expect(res).toEqual({ status: "unchanged" });
    expect(mocks.captureGenericNode).not.toHaveBeenCalled();
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("surfaces a capture error", async () => {
    mocks.captureGenericNode.mockResolvedValue({ error: "Authoring policy violation: x" });
    expect(await syncBugIssue(bug, target)).toEqual({
      status: "error",
      error: "Authoring policy violation: x",
    });
  });
});
