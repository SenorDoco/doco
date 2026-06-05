// End-to-end test of the web edge-authoring layer against real Postgres.
// Seeds a Doco + two nodes, then drives captureEdge / retireEdgeRequest /
// getEdgeById exactly as the API routes do.
//
//   DOCO_DATABASE_URL=postgres://postgres:doco@127.0.0.1:5433/doco \
//     pnpm exec tsx packages/web/scripts/edge-capture-test.ts

import { getVersions, withClient } from "@doco/db";
import { generateUlid, makeEntityId } from "@doco/shared";
import pg from "pg";
import { captureEdge, getEdgeById, retireEdgeRequest } from "../app/lib/edge-capture.server.js";

const URL = process.env.DOCO_DATABASE_URL ?? "postgres://postgres:doco@127.0.0.1:5433/doco";

let passed = 0;
function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

async function main(): Promise<void> {
  const workspaceId = makeEntityId("workspace", generateUlid());
  const userId = makeEntityId("user", generateUlid());
  const docoId = makeEntityId("doco", generateUlid());
  const decisionId = makeEntityId("decision", generateUlid());
  const refId = makeEntityId("reference", generateUlid());

  // Seed (committed) so the route layer can resolve endpoints.
  const pool = new pg.Pool({ connectionString: URL, max: 2 });
  {
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}')`, [
        workspaceId,
        `workspace-${generateUlid().slice(0, 10).toLowerCase()}`,
        "Edge Test Workspace",
      ]);
      await c.query(`INSERT INTO users (id, data) VALUES ($1,'{}')`, [userId]);
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, goal, data)
         VALUES ($1,$2,$3,$4,'private','edge test','{}')`,
        [docoId, `doco-${generateUlid().slice(0, 10).toLowerCase()}`, workspaceId, workspaceId],
      );
      await c.query(
        `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
         VALUES ($1,$2,'decision','active','Adopt first-class edges',$3)`,
        [decisionId, docoId, userId],
      );
      await c.query(
        `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
         VALUES ($1,$2,'reference','active','PR #634',$3)`,
        [refId, docoId, userId],
      );
    } finally {
      c.release();
      await pool.end();
    }
  }

  // --- create ---
  const created = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "supports",
    fromId: decisionId,
    toId: refId,
    label: "ships in PR #634",
    reason: "link decision to the PR that ships it",
  });
  check("captureEdge succeeds", "ok" in created && created.ok === true);
  const edgeId = "ok" in created ? created.id : "";
  check("edge id is edge_<ulid>", /^edge_[0-9A-HJKMNP-TV-Z]{26}$/.test(edgeId));

  // --- duplicate live edge → 409 ---
  const dup = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "supports",
    fromId: decisionId,
    toId: refId,
  });
  check("duplicate live edge rejected (409)", "error" in dup && dup.status === 409);

  // --- validation ---
  const badType = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "nope",
    fromId: decisionId,
    toId: refId,
  });
  check("unknown edge_type rejected (400)", "error" in badType && badType.status === 400);
  const selfEdge = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "supports",
    fromId: decisionId,
    toId: decisionId,
  });
  check("self-edge rejected (400)", "error" in selfEdge && selfEdge.status === 400);
  const missing = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "supports",
    fromId: decisionId,
    toId: makeEntityId("reference", generateUlid()),
  });
  check("missing endpoint rejected (400)", "error" in missing && missing.status === 400);

  // --- read + history ---
  const read = await getEdgeById(docoId, edgeId);
  check("getEdgeById returns the live edge", read?.lifecycle === "active");
  let versions = await withClient((c) => getVersions(c, "edge", edgeId));
  check("history has create version", versions.length === 1 && versions[0].op === "create");

  // --- retire ---
  const retired = await retireEdgeRequest({
    docoId,
    actorId: userId,
    id: edgeId,
    reason: "superseded",
  });
  check("retireEdgeRequest succeeds", "ok" in retired && retired.ok === true);
  const afterRetire = await getEdgeById(docoId, edgeId);
  check("edge lifecycle now retired (not deleted)", afterRetire?.lifecycle === "retired");
  versions = await withClient((c) => getVersions(c, "edge", edgeId));
  check(
    "history append-only (create,retire)",
    versions.map((v) => v.op).join(",") === "create,retire",
  );

  // --- recreate after retire (live slot freed) ---
  const recreated = await captureEdge({
    docoId,
    actorId: userId,
    edgeType: "supports",
    fromId: decisionId,
    toId: refId,
  });
  check("recreate after retire succeeds", "ok" in recreated && recreated.ok === true);

  console.log(`\n✅ edge-capture (web layer): ${passed} checks passed against real Postgres.`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
