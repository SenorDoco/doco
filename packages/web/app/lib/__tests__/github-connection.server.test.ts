import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import {
  buildInstallUrl,
  importInstallationConnections,
  normalizeConnections,
  parseRepoSlug,
} from "../github-connection.server";

describe("parseRepoSlug", () => {
  it("splits owner/name", () => {
    expect(parseRepoSlug("acme/store")).toEqual({ owner: "acme", name: "store" });
  });
  it("trims surrounding whitespace", () => {
    expect(parseRepoSlug("  acme/store  ")).toEqual({ owner: "acme", name: "store" });
  });
  it("accepts a full GitHub URL", () => {
    expect(parseRepoSlug("https://github.com/acme/store")).toEqual({
      owner: "acme",
      name: "store",
    });
    expect(parseRepoSlug("https://github.com/acme/store.git")).toEqual({
      owner: "acme",
      name: "store",
    });
  });
  it("rejects malformed input", () => {
    expect(parseRepoSlug("acme")).toBeNull();
    expect(parseRepoSlug("a/b/c")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

describe("normalizeConnections", () => {
  it("reads the new connections[] shape", () => {
    expect(normalizeConnections({ connections: [{ repo: "a/b", installation_id: 1 }] })).toEqual([
      { repo: "a/b", installation_id: 1 },
    ]);
  });
  it("reads the legacy single { repo, installation_id } shape", () => {
    expect(normalizeConnections({ repo: "a/b", installation_id: 2, connected_at: "t" })).toEqual([
      { repo: "a/b", installation_id: 2, connected_at: "t" },
    ]);
  });
  it("drops invalid entries and handles junk", () => {
    expect(normalizeConnections(null)).toEqual([]);
    expect(
      normalizeConnections({ connections: [{ repo: "a/b" }, { installation_id: 3 }] }),
    ).toEqual([]);
  });
});

describe("buildInstallUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("builds the install URL with the app slug + encoded state", () => {
    process.env.DOCO_GITHUB_APP_SLUG = "doco-pr-sync";
    expect(buildInstallUrl("doco_1")).toBe(
      "https://github.com/apps/doco-pr-sync/installations/new?state=doco_1",
    );
  });
  it("returns null when the slug isn't configured", () => {
    process.env.DOCO_GITHUB_APP_SLUG = "";
    expect(buildInstallUrl("doco_1")).toBeNull();
  });
});

describe("importInstallationConnections", () => {
  it("mints a token, lists the installation's repos, and connects each", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listRepos = vi.fn(async () => ["acme/a", "acme/b"]);
    const add = vi.fn(async () => []);
    const { repos } = await importInstallationConnections(
      { docoId: "doco_1", installationId: 42 },
      { mintToken: mintToken as never, listRepos: listRepos as never, add: add as never },
    );
    expect(repos).toEqual(["acme/a", "acme/b"]);
    expect(mintToken).toHaveBeenCalledWith(42);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/a", installation_id: 42 }),
    );
  });
});
