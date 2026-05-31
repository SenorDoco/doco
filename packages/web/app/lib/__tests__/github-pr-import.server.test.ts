import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
  captureReference: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: mocks.withClient }));
vi.mock("../capture.server", () => ({
  NO_FIELDS_CHANGED: "No fields changed.",
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
  it("merged via merged_at when the `merged` boolean is absent (list endpoint) → asserted", () => {
    // GitHub's "list pull requests" endpoint (what the backfill pages) omits the
    // `merged` boolean and only sends `merged_at`. A merged PR there is
    // state:"closed" with merged_at set — it must NOT be mistaken for abandoned.
    expect(pullRequestRefLifecycle({ state: "closed", merged_at: "2026-05-31T18:12:54Z" })).toEqual(
      { lifecycle: "asserted", outcome: "succeeded" },
    );
  });
  it("closed with merged_at null (genuinely abandoned) → retired", () => {
    expect(pullRequestRefLifecycle({ state: "closed", merged_at: null })).toEqual({
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
  const existing = (id: string) =>
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [{ id }] }) }),
    );
  beforeEach(() => vi.clearAllMocks());

  it("creates a new Reference when no existing one matches the PR URL", async () => {
    mocks.withClient.mockImplementation((fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    mocks.captureReference.mockResolvedValue({ id: "reference_new" });
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
    expect(mocks.captureReference).not.toHaveBeenCalled();
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
    mocks.captureReference.mockResolvedValue({ error: "locator is required." });
    const res = await upsertPullRequestReference(basePr, opts);
    expect(res).toEqual({ status: "error", error: "locator is required." });
  });
});
