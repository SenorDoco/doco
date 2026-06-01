import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import {
  parseInstallationRepositoriesEvent,
  parsePullRequestEvent,
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
  it("extracts action, installation id, and added repo full-names", () => {
    expect(
      parseInstallationRepositoriesEvent({
        action: "added",
        installation: { id: 42 },
        repositories_added: [{ full_name: "acme/a" }, { full_name: "acme/b" }],
        repositories_removed: [],
      }),
    ).toEqual({ action: "added", installationId: 42, addedRepos: ["acme/a", "acme/b"] });
  });
  it("tolerates missing / junk fields", () => {
    expect(parseInstallationRepositoriesEvent({ action: "removed", installation: {} })).toEqual({
      action: "removed",
      installationId: null,
      addedRepos: [],
    });
    expect(parseInstallationRepositoriesEvent(null)).toBeNull();
  });
});
