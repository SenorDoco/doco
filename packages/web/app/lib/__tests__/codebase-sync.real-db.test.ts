// A codebase Doco's copy of a repository follows the repository's default
// branch: new and changed files are fetched, unchanged ones skipped, removed
// ones dropped. PGlite runs the real schema; GitHub is stubbed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { MAX_FILE_BYTES, backfillRepoCodebase, syncRepoCodebase } from "../codebase-sync.server";
import type { RepoFile } from "../github-app.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const sha = (n: number) => n.toString(16).padStart(40, "0");
const opts = {
  docoDir: "/d",
  docoId: "doco_code",
  ownerSlug: "acme",
  docoSlug: "acme-codebase",
  owner: "acme",
  repo: "app",
  installationId: 9,
};

function github(files: RepoFile[], texts: Record<string, string | null>) {
  const getTexts = vi.fn(async (_t: string, _o: string, _r: string, shas: string[]) => {
    const out = new Map<string, string | null>();
    for (const s of shas) if (s in texts) out.set(s, texts[s] ?? null);
    return out;
  });
  return {
    deps: {
      mintToken: vi.fn(async () => ({ token: "ghs_x", expires_at: "" })),
      getTree: vi.fn(async () => ({ branch: "main", files, truncated: false })),
      getTexts,
    },
    getTexts,
  };
}

async function copied() {
  const r = await state.db.query<{ path: string; content: string; omitted: string | null }>(
    "SELECT path, content, omitted FROM code_files WHERE doco_id = 'doco_code' ORDER BY path",
  );
  return r.rows;
}

const connected = JSON.stringify({
  template_handle: "codebase",
  github_integration: { connections: [{ repo: "acme/app", installation_id: 9 }] },
});

beforeEach(async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  state.db = db;
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
       ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme', 'private', $1),
       ('doco_public', 'acme-public', 'workspace_acme', 'workspace_acme', 'public', $1)`,
    [connected],
  );
});

describe("backfillRepoCodebase", () => {
  it("copies each file's text, keeping binary and oversized files by name only", async () => {
    const { deps, getTexts } = github(
      [
        { path: "src/a.ts", sha: sha(1), size: 20 },
        { path: "logo.png", sha: sha(2), size: 900 },
        { path: "data/big.json", sha: sha(3), size: MAX_FILE_BYTES + 1 },
        { path: "gone.ts", sha: sha(4), size: 10 },
      ],
      { [sha(1)]: "export const a = 1;\u0000", [sha(2)]: null },
    );
    const res = await backfillRepoCodebase(opts, deps);
    expect(res).toMatchObject({ total: 4, created: 4, updated: 0, unchanged: 0, nextPage: null });
    // The oversized file is never fetched; the rest go in path order.
    expect(getTexts.mock.calls[0]?.[3]).toEqual([sha(4), sha(2), sha(1)]);
    expect(await copied()).toEqual([
      { path: "data/big.json", content: "", omitted: "too_large" },
      { path: "gone.ts", content: "", omitted: "unavailable" },
      { path: "logo.png", content: "", omitted: "binary" },
      { path: "src/a.ts", content: "export const a = 1;", omitted: null },
    ]);
  });

  it("fetches only what changed and drops what the branch no longer has", async () => {
    await backfillRepoCodebase(
      opts,
      github(
        [
          { path: "a.ts", sha: sha(1), size: 5 },
          { path: "b.ts", sha: sha(2), size: 5 },
        ],
        { [sha(1)]: "one", [sha(2)]: "two" },
      ).deps,
    );
    const { deps, getTexts } = github(
      [
        { path: "a.ts", sha: sha(11), size: 5 },
        { path: "c.ts", sha: sha(3), size: 5 },
      ],
      { [sha(11)]: "one, changed", [sha(3)]: "three" },
    );
    const res = await backfillRepoCodebase(opts, deps);
    expect(res).toMatchObject({ created: 1, updated: 1, nextPage: null });
    expect(getTexts.mock.calls[0]?.[3]).toEqual([sha(11), sha(3)]);
    expect((await copied()).map((f) => [f.path, f.content])).toEqual([
      ["a.ts", "one, changed"],
      ["c.ts", "three"],
    ]);
  });

  it("copies a large repository a window at a time", async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      path: `f${String(i).padStart(3, "0")}.ts`,
      sha: sha(i + 1),
      size: 1,
    }));
    const texts = Object.fromEntries(files.map((f) => [f.sha, "x"]));
    const first = await backfillRepoCodebase(
      { ...opts, pagesPerBatch: 1 },
      github(files, texts).deps,
    );
    expect(first).toMatchObject({ created: 100, nextPage: 2 });
    const second = await backfillRepoCodebase(
      { ...opts, startPage: 2, pagesPerBatch: 1 },
      github(files, texts).deps,
    );
    expect(second).toMatchObject({ created: 50, unchanged: 0, nextPage: null });
    expect(await copied()).toHaveLength(150);
  });

  it("copies nothing once the Doco no longer brings the repository", async () => {
    await state.db.query(
      `UPDATE docos SET data = '{"template_handle": "codebase"}' WHERE id = 'doco_code'`,
    );
    const { deps } = github([{ path: "a.ts", sha: sha(1), size: 1 }], { [sha(1)]: "x" });
    await backfillRepoCodebase(opts, deps);
    expect(await copied()).toEqual([]);
  });

  it("never copies code into a public Doco", async () => {
    const { deps } = github([{ path: "a.ts", sha: sha(1), size: 1 }], { [sha(1)]: "x" });
    await expect(backfillRepoCodebase({ ...opts, docoId: "doco_public" }, deps)).rejects.toThrow(
      "Only a private Doco can be a mirror.",
    );
  });
});

describe("syncRepoCodebase", () => {
  const files = Array.from({ length: 150 }, (_, i) => ({
    path: `f${String(i).padStart(3, "0")}.ts`,
    sha: sha(i + 1),
    size: 1,
  }));
  const texts = Object.fromEntries(files.map((f) => [f.sha, "x"]));

  it("walks every window after a push", async () => {
    const { deps } = github(files, texts);
    expect(await syncRepoCodebase({ ...opts, pagesPerBatch: 1 }, deps)).toEqual({ done: true });
    expect(deps.getTree).toHaveBeenCalledTimes(2);
    expect(await copied()).toHaveLength(150);
  });

  it("stops at its time budget, leaving the rest to the next push", async () => {
    const { deps } = github(files, texts);
    expect(await syncRepoCodebase({ ...opts, pagesPerBatch: 1 }, deps, 0)).toEqual({
      done: false,
    });
    expect(await copied()).toHaveLength(100);
  });
});
