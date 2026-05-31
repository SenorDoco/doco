import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import {
  type GitHubConnection,
  addConnection,
  buildInstallUrl,
  buildRepoPickerChoices,
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

describe("addConnection — one repo ↔ one Doco", () => {
  it("detaches the repo from every other Doco (move) before attaching it here", async () => {
    const order: string[] = [];
    const detachElsewhere = vi.fn(async (repo: string, keep: string) => {
      order.push(`detach:${repo}:${keep}`);
    });
    const list = vi.fn(async () => [{ repo: "x/old", installation_id: 1 }] as GitHubConnection[]);
    const write = vi.fn(async (_id: string, conns: GitHubConnection[]) => {
      order.push(`write:${conns.map((c) => c.repo).join(",")}`);
    });
    const result = await addConnection(
      "doco_target",
      { repo: "acme/store", installation_id: 9 },
      { detachElsewhere, list, write },
    );
    expect(detachElsewhere).toHaveBeenCalledWith("acme/store", "doco_target");
    // Detach must happen before the write, and the existing repo is kept.
    expect(order).toEqual(["detach:acme/store:doco_target", "write:x/old,acme/store"]);
    expect(result).toEqual([
      { repo: "x/old", installation_id: 1 },
      { repo: "acme/store", installation_id: 9 },
    ]);
  });

  it("replaces a stale entry for the same repo on this Doco (no duplicate)", async () => {
    const list = vi.fn(
      async () => [{ repo: "acme/store", installation_id: 1 }] as GitHubConnection[],
    );
    const result = await addConnection(
      "doco_1",
      { repo: "acme/store", installation_id: 2 },
      { detachElsewhere: vi.fn(async () => {}), list, write: vi.fn(async () => {}) },
    );
    expect(result).toEqual([{ repo: "acme/store", installation_id: 2 }]);
  });
});

describe("buildRepoPickerChoices", () => {
  it("annotates each installation repo with its current Doco and whether it's already here", () => {
    expect(
      buildRepoPickerChoices(
        ["acme/store", "acme/site", "acme/api"],
        { "acme/store": "this-doco", "acme/site": "other-doco" },
        "this-doco",
      ),
    ).toEqual([
      { repo: "acme/store", attachedTo: "this-doco", here: true },
      { repo: "acme/site", attachedTo: "other-doco", here: false },
      { repo: "acme/api", attachedTo: null, here: false },
    ]);
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
