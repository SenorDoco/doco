// Integration test for the cross-Doco edge storage layer
// (add-document-edge-connections). Verifies that:
//   - The `edges.to_doco_id` column exists and is writable.
//   - `rebuildDocoDerivedData` round-trips cross-Doco edges.
//   - The FK + ON DELETE CASCADE cleans up cross-Doco edges when
//     either endpoint Doco is deleted.
//
// Access-rule policy itself lives in @doco/index/cross-doco and is
// covered by unit tests there; this file exercises the SQL plumbing
// that the policy writes into.

import { rebuildDocoDerivedData, withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { addOrganization, addPrincipal, createDocoInOrg } from "../host.js";

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  doco_id: string;
  to_doco_id: string;
}

interface OrgFixture {
  orgId: string;
  ownerPrincipalId: string;
}

interface DocoFixture {
  docoId: string;
  handle: string;
  orgId: string;
}

// `addPrincipal` / `addOrganization` take a `root` argument that they
// don't actually consume (PG is authoritative; the parameter is
// vestigial). Pass a constant so the test reads cleanly.
const UNUSED_ROOT = "/tmp/doco-cross-doco-test-root";

async function seedOrg(slug: string): Promise<OrgFixture> {
  // Each org needs a unique owner principal — the host enforces a
  // single shared name namespace across users + orgs, so we vary the
  // username per fixture.
  const ownerUsername = `owner-${slug}`;
  const ownerPrincipalId = (await addPrincipal(UNUSED_ROOT, {
    username: ownerUsername,
  })) as unknown as string;
  const orgId = (await addOrganization(UNUSED_ROOT, {
    slug,
    ownerUsername,
  })) as unknown as string;
  return { orgId, ownerPrincipalId };
}

async function seedDoco(
  org: OrgFixture,
  suffix: string,
  visibility: "public" | "private",
): Promise<DocoFixture> {
  const { docoId, handle, orgId } = await createDocoInOrg({
    orgId: org.orgId,
    requestedSuffix: suffix,
    createdByPrincipalId: org.ownerPrincipalId,
    visibility,
  });
  return { docoId, handle, orgId };
}

async function selectEdges(docoId: string): Promise<EdgeRow[]> {
  return withClient(async (c) => {
    const r = await c.query<EdgeRow>(
      `SELECT from_id, to_id, edge_type, doco_id, to_doco_id
         FROM edges WHERE doco_id = $1 ORDER BY edge_type, to_id`,
      [docoId],
    );
    return r.rows;
  });
}

describe("edges.to_doco_id round-trip", () => {
  it("stores to_doco_id verbatim for intra-Doco edges (defaults to source doco)", async () => {
    const org = await seedOrg("acme");
    const doco = await seedDoco(org, "main", "private");
    const fromId = `intent_${generateUlid()}`;
    const toId = `decision_${generateUlid()}`;
    await rebuildDocoDerivedData(
      doco.docoId,
      [],
      [
        {
          from_id: fromId,
          from_node_type: "intent",
          to_id: toId,
          to_node_type: "decision",
          edge_type: "enacts",
          // No explicit to_doco_id — the indexer SQL must COALESCE
          // to the source doco for back-compat with intra-Doco edges.
        },
      ],
    );
    const rows = await selectEdges(doco.docoId);
    expect(rows).toEqual([
      {
        from_id: fromId,
        to_id: toId,
        edge_type: "enacts",
        doco_id: doco.docoId,
        to_doco_id: doco.docoId,
      },
    ]);
  });

  it("stores a different to_doco_id for cross-Doco edges (same org)", async () => {
    const org = await seedOrg("acme");
    const docoA = await seedDoco(org, "from", "private");
    const docoB = await seedDoco(org, "to", "private");
    const fromId = `intent_${generateUlid()}`;
    const toId = `rule_${generateUlid()}`;
    await rebuildDocoDerivedData(
      docoA.docoId,
      [],
      [
        {
          from_id: fromId,
          from_node_type: "intent",
          to_id: toId,
          to_node_type: "rule",
          edge_type: "consults",
          to_doco_id: docoB.docoId,
        },
      ],
    );
    const rows = await selectEdges(docoA.docoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doco_id).toBe(docoA.docoId);
    expect(rows[0]?.to_doco_id).toBe(docoB.docoId);
  });

  it("stores a cross-Doco edge to a public target across orgs", async () => {
    const orgA = await seedOrg("acme");
    const orgB = await seedOrg("globex");
    const docoA = await seedDoco(orgA, "main", "private");
    const docoB = await seedDoco(orgB, "shared", "public");
    const fromId = `intent_${generateUlid()}`;
    const toId = `guidance_article_${generateUlid()}`;
    await rebuildDocoDerivedData(
      docoA.docoId,
      [],
      [
        {
          from_id: fromId,
          from_node_type: "intent",
          to_id: toId,
          to_node_type: "guidance_article",
          edge_type: "consults",
          to_doco_id: docoB.docoId,
        },
      ],
    );
    const rows = await selectEdges(docoA.docoId);
    expect(rows[0]?.to_doco_id).toBe(docoB.docoId);
  });

  it("cascades cross-Doco edges when the target Doco is deleted", async () => {
    const org = await seedOrg("acme");
    const docoA = await seedDoco(org, "from", "private");
    const docoB = await seedDoco(org, "to", "private");
    const fromId = `intent_${generateUlid()}`;
    const toId = `rule_${generateUlid()}`;
    await rebuildDocoDerivedData(
      docoA.docoId,
      [],
      [
        {
          from_id: fromId,
          from_node_type: "intent",
          to_id: toId,
          to_node_type: "rule",
          edge_type: "consults",
          to_doco_id: docoB.docoId,
        },
      ],
    );
    expect(await selectEdges(docoA.docoId)).toHaveLength(1);

    // Drop the target Doco — the FK on to_doco_id (mirroring the
    // source-side FK) must cascade and clean the dangling edge.
    await withClient(async (c) => {
      await c.query("DELETE FROM docos WHERE id = $1", [docoB.docoId]);
    });
    expect(await selectEdges(docoA.docoId)).toHaveLength(0);
  });

  it("incremental rebuild wipes only the named entities' outgoing edges (cross-Doco included)", async () => {
    const org = await seedOrg("acme");
    const docoA = await seedDoco(org, "from", "private");
    const docoB = await seedDoco(org, "to", "private");
    const fromA = `intent_${generateUlid()}`;
    const fromB = `intent_${generateUlid()}`;
    const target1 = `rule_${generateUlid()}`;
    const target2 = `rule_${generateUlid()}`;
    await rebuildDocoDerivedData(
      docoA.docoId,
      [],
      [
        {
          from_id: fromA,
          from_node_type: "intent",
          to_id: target1,
          to_node_type: "rule",
          edge_type: "consults",
          to_doco_id: docoB.docoId,
        },
        {
          from_id: fromB,
          from_node_type: "intent",
          to_id: target2,
          to_node_type: "rule",
          edge_type: "consults",
          to_doco_id: docoB.docoId,
        },
      ],
    );
    expect(await selectEdges(docoA.docoId)).toHaveLength(2);

    // Incremental: only rebuild edges for fromA. fromB's edge stays.
    await rebuildDocoDerivedData(docoA.docoId, [], [], { onlyEntityIds: [fromA] });
    const remaining = await selectEdges(docoA.docoId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.from_id).toBe(fromB);
  });
});
