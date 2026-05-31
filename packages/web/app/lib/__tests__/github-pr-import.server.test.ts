import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  captureReference: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: mocks.withClient }));
vi.mock("../capture.server", () => ({
  captureReference: mocks.captureReference,
  updateEntity: mocks.updateEntity,
}));

import {
  type GitHubPullRequest,
  pullRequestRefLifecycle,
  pullRequestReferenceProse,
  pullRequestToReferenceDraft,
  upsertPullRequestReference,
} from "../github-pr-import.server";

const basePr: GitHubPullRequest = {
  number: 482,
  title: "fix(checkout): retry idempotency key on 409",
  body: "Makes the key idempotent.",
  html_url: "https://github.com/acme/store/pull/482",
  state: "open",
};

describe("pullRequestRefLifecycle", () => {
  it("open → drafting", () => {
    expect(pullRequestRefLifecycle({ state: "open" })).toEqual({ lifecycle: "drafting" });
  });
  it("merged → asserted + succeeded", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: true })).toEqual({
      lifecycle: "asserted",
      outcome: "succeeded",
    });
  });
  it("closed unmerged → retired", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged: false })).toEqual({
      lifecycle: "retired",
    });
  });
});

describe("pullRequestReferenceProse", () => {
  it("title only when there's no body", () => {
    expect(pullRequestReferenceProse({ title: "T", body: null })).toBe("T");
  });
  it("title on the first line, then the body", () => {
    expect(pullRequestReferenceProse({ title: "T", body: "why" })).toBe("T\n\nwhy");
  });
});

describe("pullRequestToReferenceDraft", () => {
  it("maps to a url Reference keyed on the PR URL", () => {
    const d = pullRequestToReferenceDraft({ ...basePr, state: "closed", merged: true });
    expect(d).toMatchObject({
      ref_type: "url",
      locator: "https://github.com/acme/store/pull/482",
      lifecycle: "asserted",
      outcome: "succeeded",
    });
    expect(d.reference.split("\n")[0]).toBe(basePr.title);
  });
});

describe("upsertPullRequestReference", () => {
  const opts = { docoDir: "/tmp/d", docoId: "doco_1", ownerSlug: "o", docoSlug: "d" };
  beforeEach(() => vi.clearAllMocks());

  it("captures a new Reference when no existing one matches the PR URL", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureReference.mockResolvedValue({ id: "reference_new" });
    await upsertPullRequestReference(basePr, opts);
    expect(mocks.captureReference).toHaveBeenCalledTimes(1);
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("updates the existing Reference when the PR URL is already present", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [{ id: "reference_existing" }] }) }),
    );
    mocks.updateEntity.mockResolvedValue({ id: "reference_existing", changed: ["reference"] });
    await upsertPullRequestReference({ ...basePr, state: "closed", merged: true }, opts);
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "reference", id: "reference_existing" }),
    );
    expect(mocks.captureReference).not.toHaveBeenCalled();
  });
});
