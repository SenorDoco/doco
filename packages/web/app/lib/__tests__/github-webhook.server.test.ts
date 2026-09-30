import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import {
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  parseIssuesEvent,
  parsePullRequestEvent,
  parsePullRequestReviewEvent,
  parsePushEvent,
  verifyGitHubSignature,
} from "../github-webhook.server";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGitHubSignature", () => {
  const secret = "s3cr3t";
  const body = '{"hello":"world"}';
  it("accepts a correct signature", () => {
    expect(verifyGitHubSignature({ rawBody: body, signature: sign(secret, body), secret })).toBe(
      true,
    );
  });
  it("rejects a tampered body", () => {
    expect(
      verifyGitHubSignature({ rawBody: `${body} `, signature: sign(secret, body), secret }),
    ).toBe(false);
  });
  it("rejects a missing signature or secret", () => {
    expect(verifyGitHubSignature({ rawBody: body, signature: null, secret })).toBe(false);
    expect(
      verifyGitHubSignature({ rawBody: body, signature: sign(secret, body), secret: "" }),
    ).toBe(false);
  });
});

describe("parsePullRequestEvent", () => {
  const payload = {
    action: "closed",
    repository: { full_name: "acme/store" },
    installation: { id: 99 },
    pull_request: {
      number: 482,
      title: "fix: x",
      body: "why",
      html_url: "https://github.com/acme/store/pull/482",
      state: "closed",
      merged_at: "2026-05-30T00:00:00Z",
      user: { login: "octocat" },
    },
  };
  it("extracts the PR, repo, installation, and action (merged inferred from merged_at)", () => {
    expect(parsePullRequestEvent(payload)).toMatchObject({
      action: "closed",
      repoFullName: "acme/store",
      installationId: 99,
      pr: {
        number: 482,
        html_url: "https://github.com/acme/store/pull/482",
        state: "closed",
        merged: true,
      },
    });
  });
  it("returns null for a non-PR or malformed payload", () => {
    expect(
      parsePullRequestEvent({ action: "created", repository: { full_name: "a/b" } }),
    ).toBeNull();
    expect(parsePullRequestEvent(null)).toBeNull();
  });
});

describe("parseIssuesEvent", () => {
  const payload = {
    action: "closed",
    repository: { full_name: "acme/store" },
    installation: { id: 99 },
    issue: {
      number: 7,
      title: "Login fails",
      html_url: "https://github.com/acme/store/issues/7",
      state: "closed",
      state_reason: "completed",
      labels: [{ name: "bug", color: "d73a4a" }, "not-an-object", { color: "x" }],
      type: { name: "Bug" },
      user: { login: "octocat" },
    },
  };
  it("extracts the issue, repo, installation, and action", () => {
    expect(parseIssuesEvent(payload)).toEqual({
      action: "closed",
      repoFullName: "acme/store",
      installationId: 99,
      issue: {
        number: 7,
        title: "Login fails",
        html_url: "https://github.com/acme/store/issues/7",
        state: "closed",
        state_reason: "completed",
        labels: [{ name: "bug" }],
        type: { name: "Bug" },
        user: { login: "octocat" },
      },
    });
  });
  it("keeps the pull-request marker so a PR is never taken for a bug", () => {
    const pr = { ...payload, issue: { ...payload.issue, pull_request: { url: "x" } } };
    expect(parseIssuesEvent(pr)?.issue.pull_request).toBeTruthy();
  });
  it("returns null for a malformed payload", () => {
    expect(parseIssuesEvent({ action: "opened", repository: { full_name: "a/b" } })).toBeNull();
    expect(parseIssuesEvent(null)).toBeNull();
  });
});

describe("parseInstallationRepositoriesEvent", () => {
  it("extracts action, installation id, and added + removed repo full-names", () => {
    expect(
      parseInstallationRepositoriesEvent({
        action: "removed",
        installation: { id: 42 },
        repositories_added: [{ full_name: "acme/a" }],
        repositories_removed: [{ full_name: "acme/old" }, { full_name: "acme/gone" }],
      }),
    ).toEqual({
      action: "removed",
      installationId: 42,
      addedRepos: ["acme/a"],
      removedRepos: ["acme/old", "acme/gone"],
    });
  });
  it("tolerates missing / junk fields", () => {
    expect(parseInstallationRepositoriesEvent({ action: "removed", installation: {} })).toEqual({
      action: "removed",
      installationId: null,
      addedRepos: [],
      removedRepos: [],
    });
    expect(parseInstallationRepositoriesEvent(null)).toBeNull();
  });
});

describe("parsePullRequestReviewEvent", () => {
  const payload = {
    action: "submitted",
    review: { state: "approved" },
    repository: { full_name: "acme/store" },
    installation: { id: 99 },
    pull_request: {
      number: 482,
      title: "fix: x",
      html_url: "https://github.com/acme/store/pull/482",
      state: "open",
    },
  };
  it("extracts the review state (lowercased), PR, repo, and installation", () => {
    expect(parsePullRequestReviewEvent(payload)).toMatchObject({
      action: "submitted",
      reviewState: "approved",
      repoFullName: "acme/store",
      installationId: 99,
      pr: { number: 482, state: "open" },
    });
  });
  it("lowercases an APPROVED state and tolerates a missing review", () => {
    expect(
      parsePullRequestReviewEvent({ ...payload, review: { state: "APPROVED" } })?.reviewState,
    ).toBe("approved");
    expect(parsePullRequestReviewEvent({ ...payload, review: undefined })?.reviewState).toBe("");
  });
  it("returns null without a usable PR", () => {
    expect(parsePullRequestReviewEvent({ action: "submitted", repository: {} })).toBeNull();
    expect(parsePullRequestReviewEvent(null)).toBeNull();
  });
});

describe("parsePushEvent", () => {
  const push = {
    ref: "refs/heads/main",
    deleted: false,
    repository: { full_name: "acme/store", default_branch: "main" },
    installation: { id: 99 },
  };
  it("extracts the repo and installation of a push to the default branch", () => {
    expect(parsePushEvent(push)).toEqual({ repoFullName: "acme/store", installationId: 99 });
  });
  it("ignores other branches, tags and a deleted branch", () => {
    expect(parsePushEvent({ ...push, ref: "refs/heads/feature" })).toBeNull();
    expect(parsePushEvent({ ...push, ref: "refs/tags/main" })).toBeNull();
    expect(parsePushEvent({ ...push, deleted: true })).toBeNull();
  });
  it("tolerates junk", () => {
    expect(parsePushEvent(null)).toBeNull();
    expect(parsePushEvent({ ref: "refs/heads/main", repository: {} })).toBeNull();
    expect(parsePushEvent({ ...push, installation: undefined })).toBeNull();
  });
});

describe("parseInstallationEvent", () => {
  it("extracts action and installation id", () => {
    expect(parseInstallationEvent({ action: "deleted", installation: { id: 7 } })).toEqual({
      action: "deleted",
      installationId: 7,
    });
  });
  it("tolerates junk", () => {
    expect(parseInstallationEvent({})).toEqual({ action: "", installationId: null });
    expect(parseInstallationEvent(null)).toBeNull();
  });
});
