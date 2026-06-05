// Real-database exercise of the Pull-requests perspective loader.
//
// Points the loader at an in-process PGlite loaded with the REAL schema, so the
// lifecycle-filter SQL (the `Open` catch-all, the Merged/Closed equalities, the
// filtered COUNT, and the latest-N cap) runs against actual Postgres semantics
// rather than a hand-rolled mock. The only stubbed boundary is the GitHub
// connection lookup, which is orthogonal to the query under test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../github-connection.server", () => ({
  getDocoConnectionsContext: vi.fn(async () => ({
    connections: [{ repo: "acme/web", installation_id: 1 }],
  })),
}));

import { loadPullRequestsPerspective } from "../pull-requests-perspective.server";

type Client = Parameters<typeof loadPullRequestsPerspective>[0];

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

// PR reference nodes, newest first (updated_at = now − i minutes). The
// `drafting` row is an off-canonical lifecycle that must still read as Open.
const PR_NODES: Array<{ id: string; lifecycle: string; prose: string }> = [
  { id: "reference_open", lifecycle: "queued", prose: "Open PR\nbody" },
  { id: "reference_merged", lifecycle: "active", prose: "Merged PR\nbody" },
  { id: "reference_closed", lifecycle: "retired", prose: "Closed PR\nbody" },
  { id: "reference_draftish", lifecycle: "drafting", prose: "Draftish PR\nbody" },
];

async function seed(): Promise<Client> {
  const db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'ws', 'WS')");
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','workspace_1','workspace_1','{}'::jsonb)",
  );
  let minutesAgo = 1;
  for (const node of PR_NODES) {
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes, created_at, updated_at)
       VALUES ($1,'doco_1','reference',$2,$3, jsonb_build_object('ref_type','url','locator',$4::text),
               now() - ($5 || ' minutes')::interval, now() - ($5 || ' minutes')::interval)`,
      [
        node.id,
        node.lifecycle,
        node.prose,
        `https://github.com/acme/web/pull/${minutesAgo}`,
        String(minutesAgo),
      ],
    );
    minutesAgo++;
  }
  // A non-PR reference (no /pull/ in the locator) must never surface here.
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
     VALUES ('reference_doc','doco_1','reference','active','Some doc', jsonb_build_object('ref_type','url','locator','https://example.com/doc'))`,
  );
  return db as unknown as Client;
}

describe("loadPullRequestsPerspective against a real database", () => {
  it("returns every PR newest-first when unfiltered, ignoring non-PR references", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", { limit: 50 });
    expect(data.items.map((i) => i.id)).toEqual([
      "reference_open",
      "reference_merged",
      "reference_closed",
      "reference_draftish",
    ]);
    expect(data.totalCount).toBe(4);
  });

  it("filters to Merged only (active)", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", {
      limit: 50,
      lifecycles: ["active"],
    });
    expect(data.items.map((i) => i.id)).toEqual(["reference_merged"]);
    expect(data.totalCount).toBe(1);
  });

  it("filters to Open (queued) as a catch-all that includes off-canonical stages", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", {
      limit: 50,
      lifecycles: ["queued"],
    });
    expect(new Set(data.items.map((i) => i.id))).toEqual(
      new Set(["reference_open", "reference_draftish"]),
    );
    expect(data.items.every((i) => i.label === "Open")).toBe(true);
    expect(data.totalCount).toBe(2);
  });

  it("filters to Open + Closed, hiding Merged", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", {
      limit: 50,
      lifecycles: ["queued", "retired"],
    });
    expect(new Set(data.items.map((i) => i.id))).toEqual(
      new Set(["reference_open", "reference_draftish", "reference_closed"]),
    );
    expect(data.totalCount).toBe(3);
  });

  it("respects the latest-N cap while reporting the filtered total", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", {
      limit: 1,
      lifecycles: ["queued"],
    });
    expect(data.loadedCount).toBe(1);
    expect(data.totalCount).toBe(2);
    expect(data.hasMore).toBe(true);
  });

  it("returns nothing when no stages are selected", async () => {
    const data = await loadPullRequestsPerspective(await seed(), "doco_1", {
      limit: 50,
      lifecycles: [],
    });
    expect(data.items).toEqual([]);
    expect(data.totalCount).toBe(0);
  });
});
