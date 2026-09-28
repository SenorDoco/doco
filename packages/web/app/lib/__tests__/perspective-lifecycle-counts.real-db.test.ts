// The bug this pins: a perspective renders a lifecycle-filtered canvas (retired
// hidden by default) but its headline counted EVERY lifecycle, so a mostly-
// retired Doco read "137 steps" over a near-empty board. The fix makes each
// loader return a per-lifecycle breakdown of its true total (counted before any
// slice cap), and the header sums only the visible stages. This suite drives the
// non-trivial grouped-count queries against REAL Postgres (PGlite + the real
// schema): the overview-graph domain (with its "principals only when active"
// rule) and the glossary term domain. The BPMN/process perspective renders no
// such headline (it pans over every step uncapped), so it has no count query.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initialVisibleLifecycles } from "../../components/lifecycle-filter";
import { loadOverviewGraph } from "../full-graph.server";
import { loadGlossaryPerspectiveData } from "../glossary-perspective.server";
import { visibleLifecycleTotal } from "../perspective-count";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

const DOCO_ID = "doco_01LIFECYCLECOUNTS0000000001";

let nseq = 0;
async function insertNode(nodeType: string, lifecycle: string, prose = "step"): Promise<string> {
  nseq += 1;
  const id = `${nodeType}_n${nseq}`;
  await dbm.db.query(
    "INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES ($1,$2,$3,$4,$5)",
    [id, DOCO_ID, nodeType, lifecycle, prose],
  );
  return id;
}

async function clearGraph(): Promise<void> {
  await dbm.db.query("DELETE FROM edges WHERE doco_id = $1", [DOCO_ID]);
  await dbm.db.query("DELETE FROM nodes WHERE doco_id = $1", [DOCO_ID]);
}

// The page-level default: every stage visible except retired.
const DEFAULT_VISIBLE = initialVisibleLifecycles(["drafting", "queued", "active", "retired"]);

beforeAll(async () => {
  dbm.db = new PGlite({ extensions: { vector } });
  await dbm.db.exec(schemaSql);
  const workspaceId = "workspace_01LIFECYCLECOUNTS00000001";
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'lc','LC')", [
    workspaceId,
  ]);
  await dbm.db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'lc',$2,$2,'{}'::jsonb)",
    [DOCO_ID, workspaceId],
  );
});

beforeEach(clearGraph);

describe("loadOverviewGraph — per-lifecycle node totals honor the principals-only-when-active rule", () => {
  it("counts retired flow nodes but never retired principals (they aren't graph-eligible)", async () => {
    await insertNode("decision", "active", "live call");
    await insertNode("decision", "retired", "old call");
    await insertNode("principal", "active", "Active Owner");
    // A retired principal is excluded from the overview graph entirely, so it
    // must NOT inflate the retired bucket of the total.
    await insertNode("principal", "retired", "Former Owner");

    const graph = await loadOverviewGraph(dbm.db, DOCO_ID, { handle: "lc" });

    const total = graph.totalNodeByLifecycle;
    expect(total).toEqual({
      drafting: 0,
      queued: 0,
      active: 2, // active decision + active principal
      retired: 1, // retired decision only — the retired principal is not graph-eligible
    });
    expect(graph.totalNodeCount).toBe(3);
    if (!total) throw new Error("loader must set totalNodeByLifecycle");
    // The List header (retired hidden by default) counts the 2 active nodes.
    expect(visibleLifecycleTotal(total, DEFAULT_VISIBLE)).toBe(2);
  });
});

describe("loadGlossaryPerspectiveData — per-lifecycle term totals track the lifecycle filter", () => {
  it("breaks the term total out per stage so a retired entry never inflates the masthead", async () => {
    await insertNode("reference", "active", "alpha");
    await insertNode("reference", "active", "beta");
    await insertNode("reference", "retired", "gamma");

    const data = await loadGlossaryPerspectiveData(dbm.db, DOCO_ID, "lc");

    expect(data.totalByLifecycle).toEqual({ drafting: 0, queued: 0, active: 2, retired: 1 });
    expect(visibleLifecycleTotal(data.totalByLifecycle, DEFAULT_VISIBLE)).toBe(2);
    expect(visibleLifecycleTotal(data.totalByLifecycle)).toBe(3);
  });
});
