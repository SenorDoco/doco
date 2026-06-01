import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import {
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  parsePullRequestEvent,
  parsePullRequestReviewEvent,
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
