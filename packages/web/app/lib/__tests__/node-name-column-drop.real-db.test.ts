// Regression: the node-shape slim-down (#1015) dropped the `nodes.name`
// column — a principal's display label moved into `prose` like every other
// type — but three read queries still referenced `name`, so any page that ran
// them 500'd against the real schema:
//   • full-graph.server  → the overview graph (home / graph / list perspective)
//   • node-detail.server → a node detail page with related nodes (relatedDetailsSql)
//   • edge-detail.server → an edge detail page
// Reported as "/<doco>/state/<id> 500": a BPMN Doco's home renders the process
// perspective (which never touched `name`), so the home page looked fine, but
// opening any node that has an edge dragged in relatedDetailsSql and threw
// `column "name" does not exist`.
//
// Runs against an in-process PGlite loaded with the REAL schema, so the
// dropped column is genuinely gone — the only thing that proves the fix.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

// node-detail resolves the viewer's role via a pooled connection; stub that one
// boundary so the test stays in-process. Everything else runs the real SQL.
vi.mock("../doco-access.server", () => ({
  getDocoLevelRole: vi.fn(async () => "owner"),
}));

import { loadDocoHomePerspectiveData } from "../doco-home-perspective.server";
import { loadEdgeDialogDetail } from "../edge-detail.server";
import { loadNodeDialogDetail } from "../node-detail.server";

const DOCO = "doco_01KT7G5PCX4273VHWW8SAAVSJC";
const OWNER = "workspace_01KT23DN3W2WPV4Y78849DRDZ4";
const USER = "user_01KT1Z5BA8RMGXKSNRFS9Z0EYM";
const INTENT = "intent_01KT9QD2Y0JHV1PXMCS9GMW2P6";
const STATE = "state_01KTA0NAHBX3E7MC7Y65MJJY2Y";
const PRINCIPAL = "principal_01KT9PRINCIPALAAAAAAAAAAAA";
const EDGE = "edge_01KTA0NHD73WR1ZB9ZFTE7WEKA";
const EDGE2 = "edge_01KTA0NHD73WR1ZB9ZFTE7WEKB";

let db: InstanceType<typeof PGlite>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schemaSql);

  await db.query(`INSERT INTO workspaces (id, handle, name) VALUES ($1, 'torre', 'torre')`, [
    OWNER,
  ]);
  await db.query(`INSERT INTO users (id, data) VALUES ($1, '{}'::jsonb)`, [USER]);
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, goal, data)
     VALUES ($1,'torre-bpm',$2,$2,'private','','{}'::jsonb)`,
    [DOCO, OWNER],
  );
  await db.query(`INSERT INTO doco_users (doco_id, user_id, role) VALUES ($1,$2,'owner')`, [
    DOCO,
    USER,
  ]);

  // Intent (pool header) + the focused State + a Principal, mirroring the real
  // torre-bpm shape. The Principal's label lives in `prose` (post-slim-down).
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
     VALUES ($1,$2,'intent','active','Onboard a new hire', $3)`,
    [INTENT, DOCO, USER],
  );
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, kind, created_by)
     VALUES ($1,$2,'state','drafting','Visits Torre','initial', $3)`,
    [STATE, DOCO, USER],
  );
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
     VALUES ($1,$2,'principal','active','Alex Torrenegra', $3)`,
    [PRINCIPAL, DOCO, USER],
  );
  // State supports the Intent, and is attributed to the Principal — two related
  // rows so relatedDetailsSql actually runs (it short-circuits on zero).
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, created_by)
     VALUES ($1,$2,'supports',$3,'state',$4,'intent',$5)`,
    [EDGE, DOCO, STATE, INTENT, USER],
  );
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, created_by)
     VALUES ($1,$2,'attributed_to',$3,'state',$4,'principal',$5)`,
    [EDGE2, DOCO, STATE, PRINCIPAL, USER],
  );
});

describe("torre-bpm state node page focus path (post name-column drop)", () => {
  it("loads the node dialog detail for the state node and its related rows", async () => {
    const detail = await loadNodeDialogDetail(
      db as never,
      { docoId: DOCO, ownerId: OWNER },
      { handle: "torre-bpm", entityType: "state", id: STATE, principalId: USER },
    );
    expect(detail?.id).toBe(STATE);
    expect(detail?.summary).toBe("Visits Torre");
    // The related Principal's name must resolve from `prose` (not the dropped
    // `name` column).
    const principalEdge = detail?.outgoing.find((e) => e.other_id === PRINCIPAL);
    expect(principalEdge?.other_name).toBe("Alex Torrenegra");
    const intentEdge = detail?.outgoing.find((e) => e.other_id === INTENT);
    expect(intentEdge?.other_summary).toBe("Onboard a new hire");
  });

  it("loads the edge dialog detail for an edge touching the state node", async () => {
    const detail = await loadEdgeDialogDetail(
      db as never,
      { docoId: DOCO },
      { handle: "torre-bpm", id: EDGE2 },
    );
    expect(detail?.from.id).toBe(STATE);
    expect(detail?.to.name).toBe("Alex Torrenegra");
  });

  it("loads the graph perspective focused on the state node", async () => {
    const data = await loadDocoHomePerspectiveData(db as never, {
      activeKind: "graph",
      docoId: DOCO,
      handle: "torre-bpm",
      focusNodeId: STATE,
    });
    expect(data.graph).not.toBeNull();
    const principalNode = data.graph?.nodes.find((n) => n.id === PRINCIPAL);
    expect(principalNode?.name).toBe("Alex Torrenegra");
  });

  it("loads the process perspective focused on the state node", async () => {
    const data = await loadDocoHomePerspectiveData(db as never, {
      activeKind: "process",
      docoId: DOCO,
      handle: "torre-bpm",
      focusNodeId: STATE,
    });
    expect(data.processGraph).not.toBeNull();
  });
});
