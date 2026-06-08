import { describe, expect, it } from "vitest";
import { computeExternalNeighbours } from "../process-boundary";
import {
  computeNearestProcessByNode,
  loadProcessGraph,
  shapeForEntityType,
} from "../process-perspective.server";

describe("shapeForEntityType", () => {
  it("renders a State as a pill (rounded), distinct from an Action's task glyph", () => {
    // States are milestones/outcomes — a condition that holds — and read
    // as a stadium pill, visually separate from the work-in-flight Action.
    expect(shapeForEntityType("state")).toBe("rounded");
    expect(shapeForEntityType("action")).toBe("task");
    expect(shapeForEntityType("state")).not.toBe(shapeForEntityType("action"));
  });

  it("does not reserve the pill for Ideas — Ideas are not process content", () => {
    // Ideas live in their own home (barred by the process
    // node-type allowlist), so the pill belongs unambiguously to States.
    expect(shapeForEntityType("idea")).not.toBe("rounded");
  });
});

interface CapturedQuery {
  sql: string;
  params?: unknown[];
}

interface QueryClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function makeQueryClient(rows: Record<string, unknown[]>) {
  const captured: CapturedQuery[] = [];
  const client: QueryClientLike = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      captured.push({ sql, params });
      if (/FROM edges/i.test(sql)) {
        return { rows: (rows.edges ?? []) as T[] };
      }
      if (/FROM users/i.test(sql)) return { rows: (rows.users ?? []) as T[] };
      // Principals are loaded via `FROM nodes WHERE node_type = 'principal'`.
      if (/node_type = 'principal'/i.test(sql)) return { rows: (rows.principals ?? []) as T[] };
      // Per-lifecycle step totals (loadNodeLifecycleTotals) — GROUP BY lifecycle
      // over the step node types in `params[1]`. Aggregate the seeded nodes the
      // same way real Postgres would so totalByLifecycle is exercised.
      if (/COUNT\(\*\)::text AS n/i.test(sql)) {
        const allowed = new Set((params?.[1] as string[] | undefined) ?? []);
        const counts = new Map<string, number>();
        for (const node of (rows.nodes ?? []) as { entity_type?: string; lifecycle?: string }[]) {
          if (allowed.size > 0 && !allowed.has(node.entity_type ?? "")) continue;
          const lifecycle = node.lifecycle ?? "active";
          counts.set(lifecycle, (counts.get(lifecycle) ?? 0) + 1);
        }
        return {
          rows: [...counts].map(([lifecycle, n]) => ({ lifecycle, n: String(n) })) as T[],
        };
      }
      return { rows: (rows.nodes ?? []) as T[] };
    },
  };
  return { client, captured };
}

function edge(
  id: string,
  from_id: string,
  to_id: string,
  edge_type: string,
  meta: { label?: string; condition?: string; kind?: string } = {},
) {
  // Friendly aliases map to canonical edge types (edge `role` is gone — an
  // edge's meaning is its type plus its endpoint node types). A flow node's
  // `has_parent` to a process Action is its pool membership; `member_of` reads
  // that intent. flows_to BPMN metadata rides in the typed columns.
  const aliasEdgeTypes: Record<string, string> = {
    member_of: "has_parent",
    serves: "has_parent",
    tests: "supports",
    implemented_by: "supports",
    gated_by: "constrained_by",
    consults: "constrained_by",
    performed_by: "attributed_to",
    owned_by: "attributed_to",
    decided_by: "attributed_to",
  };
  return {
    id,
    from_id,
    to_id,
    edge_type: aliasEdgeTypes[edge_type] ?? edge_type,
    label: meta.label ?? null,
    condition: meta.condition ?? null,
    kind: meta.kind ?? null,
  };
}

// A process Action (pool header) plus a member node belonging to it. Most
// tests below set up one process with a handful of members.
function processNode(
  id: string,
  summary: string,
  lifecycle = "active",
  at = "2026-05-26T00:00:00.000Z",
) {
  return { id, entity_type: "action", summary, lifecycle, created_at: at, data: {} };
}

describe("cross-pool neighbours feed computeExternalNeighbours (real loader output)", () => {
  // Regression for the bug behind the #1144 revert: a pool-heading Action is the
  // pool header, NOT a member node, so it never appears in `graph.nodes`. A valid
  // external neighbour is therefore a MEMBER of another pool (it has a
  // `has_parent`), reached/left by a cross-pool `flows_to`. This proves the
  // classifier the renderer drives picks those up against the real loader output
  // — both when the edge touches a focal-pool member (node-to-node) and when it
  // touches the focal pool's own process Action (the title band).
  it("classifies a member of another pool as an external box (node + title attach)", async () => {
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_FOCALPOOL", "Focal process"),
        processNode("action_FMEMBER", "Focal member", "active", "2026-05-26T00:01:00.000Z"),
        processNode("action_OTHERPOOL", "Other process", "active", "2026-05-26T00:02:00.000Z"),
        processNode("action_EXTNODE", "External to a member", "active", "2026-05-26T00:03:00.000Z"),
        processNode(
          "action_EXTTITLE",
          "External to the Action",
          "active",
          "2026-05-26T00:04:00.000Z",
        ),
      ],
      principals: [],
      users: [],
      edges: [
        edge("e_fm", "action_FMEMBER", "action_FOCALPOOL", "member_of"),
        edge("e_en", "action_EXTNODE", "action_OTHERPOOL", "member_of"),
        edge("e_et", "action_EXTTITLE", "action_OTHERPOOL", "member_of"),
        // External member flows INTO a focal member → node-to-node entry box.
        edge("e_flow_node", "action_EXTNODE", "action_FMEMBER", "flows_to"),
        // External member flows INTO the focal pool's process Action → title entry box.
        edge("e_flow_title", "action_EXTTITLE", "action_FOCALPOOL", "flows_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "refunds" });

    // The pool-heading Actions are headers, not member nodes; the members are.
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain("action_FOCALPOOL");
    expect(nodeIds).toContain("action_EXTNODE");
    expect(nodeIds).toContain("action_EXTTITLE");

    const focalPoolIds = new Set(["pool:action_FOCALPOOL"]);
    const neighbours = computeExternalNeighbours(focalPoolIds, graph.nodes, graph.links);
    expect(neighbours).toContainEqual({
      id: "action_EXTNODE",
      direction: "entry",
      attach: { kind: "node", nodeId: "action_FMEMBER" },
      edgeType: "flows_to",
      label: null,
    });
    expect(neighbours).toContainEqual({
      id: "action_EXTTITLE",
      direction: "entry",
      attach: { kind: "title", poolId: "pool:action_FOCALPOOL" },
      edgeType: "flows_to",
      label: null,
    });
  });
});

describe("loadProcessGraph", () => {
  it("selects the full prose as the node summary, not just the first line", async () => {
    // Perspectives render the full node name — the loader must not truncate
    // the summary to the first line of prose with split_part().
    const { client, captured } = makeQueryClient({
      nodes: [],
      principals: [],
      users: [],
      edges: [],
    });

    await loadProcessGraph(client, "doco_01", { handle: "refunds" });

    const nodeQuery = captured.find((q) => /AS summary/i.test(q.sql));
    expect(nodeQuery?.sql).toMatch(/t\.prose AS summary/);
    expect(nodeQuery?.sql).not.toMatch(/split_part\([^)]*prose/);
  });

  it("does not fetch Intent nodes — they are no longer part of the process model", async () => {
    const { client, captured } = makeQueryClient({
      nodes: [],
      principals: [],
      users: [],
      edges: [],
    });
    await loadProcessGraph(client, "doco_01", { handle: "refunds" });
    const nodeQuery = captured.find(
      (q) => /FROM nodes t/i.test(q.sql) && /node_type IN/i.test(q.sql),
    );
    expect(nodeQuery?.sql).not.toMatch(/'intent'/);
  });

  it("makes an Action with has_parent children a pool, with its children as members", async () => {
    const { client, captured } = makeQueryClient({
      nodes: [
        processNode("action_01PROCESS", "Handle the refund request", "drafting"),
        processNode(
          "action_01CHECK",
          "Review refund request",
          "drafting",
          "2026-05-26T00:01:00.000Z",
        ),
      ],
      principals: [{ id: "principal_support", name: "Support", lifecycle: "drafting" }],
      users: [],
      edges: [
        edge("edge_01MEMBER", "action_01CHECK", "action_01PROCESS", "member_of"),
        edge("edge_01ACTOR", "action_01CHECK", "principal_support", "performed_by"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "refunds" });

    const principalQuery = captured.find((q) => /node_type = 'principal'/i.test(q.sql));
    expect(principalQuery?.sql).not.toMatch(/COALESCE\(lifecycle, 'active'\) = 'active'/);

    // The process Action is the pool header, labelled by its prose.
    expect(graph.pools).toContainEqual(
      expect.objectContaining({
        id: "pool:action_01PROCESS",
        process_id: "action_01PROCESS",
        label: "Handle the refund request",
      }),
    );
    // It is NOT itself a member node of its own pool.
    expect(graph.nodes.map((n) => n.id)).not.toContain("action_01PROCESS");
    // Its child renders in the pool, in the actor's lane.
    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        id: "pool:action_01PROCESS::principal_support",
        kind: "actor",
        label: "Support",
        lifecycle: "drafting",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "action_01CHECK",
        laneId: "pool:action_01PROCESS::principal_support",
        pool_id: "pool:action_01PROCESS",
      }),
    );
  });

  it("marks a member Action that itself has children as a subprocess", async () => {
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_ROOT", "Onboard a customer"),
        processNode("action_SUB", "Verify identity", "active", "2026-05-26T00:01:00.000Z"),
        processNode("action_LEAF", "Check the passport", "active", "2026-05-26T00:02:00.000Z"),
      ],
      principals: [{ id: "principal_ops", name: "Ops", lifecycle: "active" }],
      users: [],
      edges: [
        // action_SUB is a member of ROOT, and itself the parent of LEAF → a subprocess.
        edge("edge_SUB_ROOT", "action_SUB", "action_ROOT", "member_of"),
        edge("edge_LEAF_SUB", "action_LEAF", "action_SUB", "member_of"),
        edge("edge_SUB_ACTOR", "action_SUB", "principal_ops", "performed_by"),
        edge("edge_LEAF_ACTOR", "action_LEAF", "principal_ops", "performed_by"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "onboard" });

    // action_SUB renders as a member of ROOT's pool AND is flagged is_process.
    const sub = graph.nodes.find((n) => n.id === "action_SUB");
    expect(sub?.pool_id).toBe("pool:action_ROOT");
    expect(sub?.is_process).toBe(true);
    // action_SUB also has its own pool; ROOT is top-level (no parent).
    expect(graph.pools.map((p) => p.id)).toEqual(
      expect.arrayContaining(["pool:action_ROOT", "pool:action_SUB"]),
    );
    // The leaf is an ordinary member of the subprocess pool, not a process.
    const leaf = graph.nodes.find((n) => n.id === "action_LEAF");
    expect(leaf?.pool_id).toBe("pool:action_SUB");
    expect(leaf?.is_process).toBeUndefined();
  });

  it("a member Action whose only child is a gateway Decision is NOT a subprocess", async () => {
    // A process is an Action with CHILD ACTIONS. A gateway Decision (or
    // milestone State) is a member of a process, not what makes one — so an
    // Action whose only `has_parent` child is a Decision is not itself a
    // process. (Under the old "any has_parent child" rule, action_GATE would
    // have been wrongly flagged a subprocess.)
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_ROOT", "Run the hiring process"),
        // action_SUBPROC has an action child → it IS a subprocess.
        processNode("action_SUBPROC", "Screen the applicant", "active", "2026-05-26T00:01:00.000Z"),
        processNode("action_GRAND", "Read the résumé", "active", "2026-05-26T00:02:00.000Z"),
        // action_GATE's only child is a gateway Decision → it is NOT a process.
        processNode("action_GATE", "Branch on seniority", "active", "2026-05-26T00:03:00.000Z"),
        {
          id: "decision_DGATE",
          entity_type: "decision",
          summary: "Senior?",
          lifecycle: "active",
          created_at: "2026-05-26T00:04:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_ops", name: "Ops", lifecycle: "active" }],
      users: [],
      edges: [
        edge("e_subproc_root", "action_SUBPROC", "action_ROOT", "member_of"),
        edge("e_grand_subproc", "action_GRAND", "action_SUBPROC", "member_of"),
        edge("e_gate_root", "action_GATE", "action_ROOT", "member_of"),
        edge("e_dgate_gate", "decision_DGATE", "action_GATE", "member_of"),
        edge("e_subproc_actor", "action_SUBPROC", "principal_ops", "performed_by"),
        edge("e_gate_actor", "action_GATE", "principal_ops", "performed_by"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "hiring" });

    // action_SUBPROC has an action child (action_GRAND) → a subprocess.
    const subproc = graph.nodes.find((n) => n.id === "action_SUBPROC");
    expect(subproc?.pool_id).toBe("pool:action_ROOT");
    expect(subproc?.is_process).toBe(true);
    // action_GATE's only child is a Decision → NOT a process, even though it is
    // an ordinary member of ROOT's pool.
    const gate = graph.nodes.find((n) => n.id === "action_GATE");
    expect(gate?.pool_id).toBe("pool:action_ROOT");
    expect(gate?.is_process).toBeUndefined();
  });

  it("resolves an actor lane's name even when the Principal is outside the focus window", async () => {
    const processId = "action_01PROCESS";
    const memberId = "action_01POST";
    const principalId = "principal_01TALENT";

    // The window holds the flow nodes but NOT the Principal.
    const window = { focusNodeId: processId, nodeIds: [processId, memberId] };

    const principalRows = [{ id: principalId, name: "Talent seeker", lifecycle: "active" }];
    const captured: CapturedQuery[] = [];
    const client: QueryClientLike = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        captured.push({ sql, params });
        if (/FROM edges/i.test(sql)) {
          return {
            rows: [
              edge("edge_MEMBER", memberId, processId, "member_of"),
              edge("edge_ACTOR", memberId, principalId, "performed_by"),
            ] as T[],
          };
        }
        if (/FROM users/i.test(sql)) return { rows: [] as T[] };
        if (/node_type = 'principal'/i.test(sql)) {
          if (/id = ANY\(\$2/i.test(sql)) {
            const ids = (params?.[1] as string[]) ?? [];
            return { rows: principalRows.filter((p) => ids.includes(p.id)) as T[] };
          }
          return { rows: principalRows as T[] };
        }
        return {
          rows: [
            processNode(processId, "Post a job"),
            processNode(
              memberId,
              "Talent seeker posts a job",
              "active",
              "2026-06-03T00:01:00.000Z",
            ),
          ] as T[],
        };
      },
    };

    const graph = await loadProcessGraph(client, "doco_01", { handle: "torre-bpm", window });

    expect(graph.lanes).toContainEqual(
      expect.objectContaining({ kind: "actor", label: "Talent seeker" }),
    );
    expect(graph.lanes.map((lane) => lane.label)).not.toContain(principalId);
  });

  it("places a Decision attributed via performed_by in that actor's lane (decided_by ?? performed_by)", async () => {
    const processId = "action_01VERIFYPROC";
    const decisionId = "decision_01VERIFY";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Verify the user"),
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Is the user verified?",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_torre", name: "Torre", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_VERIFY_MEMBER", decisionId, processId, "member_of"),
        edge("edge_VERIFY_ACTOR", decisionId, "principal_torre", "performed_by"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "verify" });

    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        id: `pool:${processId}::principal_torre`,
        kind: "actor",
        label: "Torre",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: decisionId,
        laneId: `pool:${processId}::principal_torre`,
        pool_id: `pool:${processId}`,
      }),
    );
  });

  it("loads every lifecycle so the client filter can reveal retired nodes", async () => {
    const processId = "action_01RETIRED";
    const firstId = "action_01RET_A";
    const secondId = "action_01RET_B";

    const { client, captured } = makeQueryClient({
      nodes: [
        processNode(processId, "Retired process", "retired"),
        processNode(firstId, "Retired step one", "retired", "2026-05-26T00:01:00.000Z"),
        processNode(secondId, "Retired step two", "retired", "2026-05-26T00:02:00.000Z"),
      ],
      principals: [{ id: "principal_retired", name: "Retired Actor", lifecycle: "retired" }],
      users: [],
      edges: [
        edge("edge_07A_MEMBER", firstId, processId, "member_of"),
        edge("edge_07B_MEMBER", secondId, processId, "member_of"),
        edge("edge_07A_ACTOR", firstId, "principal_retired", "performed_by"),
        edge("edge_07B_ACTOR", secondId, "principal_retired", "performed_by"),
        edge("edge_07FLOW", firstId, secondId, "flows_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "retired-flow" });

    const nodeQuery = captured.find(
      (q) => /FROM nodes t/i.test(q.sql) && /node_type IN/i.test(q.sql),
    );
    const principalQuery = captured.find((q) => /node_type = 'principal'/i.test(q.sql));
    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));

    expect(nodeQuery?.sql).not.toMatch(/<> 'retired'/);
    expect(principalQuery?.sql).not.toMatch(/<> 'retired'/);
    expect(edgeQuery?.sql).not.toMatch(/<> 'retired'/);

    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_07FLOW", source: firstId, target: secondId }),
    );
    expect(graph.lanes).toContainEqual(
      expect.objectContaining({ kind: "actor", label: "Retired Actor", lifecycle: "retired" }),
    );
  });

  it("orders actor lanes by when their Actions enter the flow", async () => {
    const processId = "action_01PROCESS";
    const stateId = "state_01START";
    const requestId = "action_01REQUEST";
    const presentId = "action_01PRESENT";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Talent seeker pays to activate Torre Reach", "drafting"),
        {
          id: "decision_01CREDITS",
          entity_type: "decision",
          summary: "Does the user have Reach credits?",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: stateId,
          entity_type: "state",
          summary: "Process started",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: { kind: "initial" },
        },
        processNode(
          requestId,
          "Requests to activate Torre Reach",
          "active",
          "2026-05-26T00:03:00.000Z",
        ),
        processNode(presentId, "Presents payment options", "active", "2026-05-26T00:04:00.000Z"),
      ],
      principals: [
        { id: "principal_sud", name: "SuD", lifecycle: "active" },
        { id: "principal_talent", name: "Talent seeker", lifecycle: "active" },
      ],
      users: [],
      edges: [
        edge("edge_01DECISION_MEMBER", "decision_01CREDITS", processId, "member_of"),
        edge("edge_01STATE_MEMBER", stateId, processId, "member_of"),
        edge("edge_01REQUEST_MEMBER", requestId, processId, "member_of"),
        edge("edge_01PRESENT_MEMBER", presentId, processId, "member_of"),
        edge("edge_01DECIDER", "decision_01CREDITS", "principal_sud", "decided_by"),
        edge("edge_01REQUEST_ACTOR", requestId, "principal_talent", "performed_by"),
        edge("edge_01PRESENT_ACTOR", presentId, "principal_sud", "performed_by"),
        edge("edge_01STATE_TO_REQUEST", stateId, requestId, "flows_to"),
        edge("edge_01REQUEST_TO_PRESENT", requestId, presentId, "flows_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "activation" });

    const actorLabels = graph.lanes
      .filter((lane) => lane.pool_id === `pool:${processId}` && lane.kind === "actor")
      .map((lane) => lane.label);

    expect(actorLabels).toEqual(["Talent seeker", "SuD"]);
  });

  it("preserves sequence flow labels for BPMN edge tags", async () => {
    const processId = "action_01PROCESS";
    const decisionId = "decision_01ROUTE";
    const yesId = "action_01YES";
    const noId = "action_01NO";

    const { client, captured } = makeQueryClient({
      nodes: [
        processNode(processId, "Route yes/no process"),
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Does the user qualify?",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        processNode(yesId, "Approve request", "active", "2026-05-26T00:02:00.000Z"),
        processNode(noId, "Reject request", "active", "2026-05-26T00:03:00.000Z"),
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_02DECISION_MEMBER", decisionId, processId, "member_of"),
        edge("edge_02YES_MEMBER", yesId, processId, "member_of"),
        edge("edge_02NO_MEMBER", noId, processId, "member_of"),
        edge("edge_02DECIDER", decisionId, "principal_system", "decided_by"),
        edge("edge_02YES_ACTOR", yesId, "principal_system", "performed_by"),
        edge("edge_02NO_ACTOR", noId, "principal_system", "performed_by"),
        edge("edge_02YES", decisionId, yesId, "flows_to", { label: "Yes" }),
        edge("edge_02NO", decisionId, noId, "flows_to", { condition: "No" }),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "activation" });
    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));

    expect(edgeQuery?.sql).toMatch(/label, condition/);
    expect(graph.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: decisionId,
          target: yesId,
          edge_type: "flows_to",
          label: "Yes",
        }),
        expect.objectContaining({
          source: decisionId,
          target: noId,
          edge_type: "flows_to",
          label: "No",
        }),
      ]),
    );
  });

  it("renders flows_to edges as forward BPMN sequence links", async () => {
    const processId = "action_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Legacy process"),
        processNode(firstId, "First step", "active", "2026-05-26T00:01:00.000Z"),
        processNode(secondId, "Second step", "active", "2026-05-26T00:02:00.000Z"),
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_03FIRST_MEMBER", firstId, processId, "member_of"),
        edge("edge_03SECOND_MEMBER", secondId, processId, "member_of"),
        edge("edge_03FIRST_ACTOR", firstId, "principal_system", "performed_by"),
        edge("edge_03SECOND_ACTOR", secondId, "principal_system", "performed_by"),
        edge("edge_flows_to", firstId, secondId, "flows_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "process" });

    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "edge_flows_to",
        source: firstId,
        target: secondId,
        edge_type: "flows_to",
        href: "/process/edges/edge_flows_to",
      }),
    );
    expect(graph.nodes.find((node) => node.id === secondId)?.bfs_depth).toBeGreaterThan(
      graph.nodes.find((node) => node.id === firstId)?.bfs_depth ?? 0,
    );
  });

  it("carries each link's own lifecycle so the filter can hide retired edges", async () => {
    const processId = "action_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";

    const { client, captured } = makeQueryClient({
      nodes: [
        processNode(processId, "A process"),
        processNode(firstId, "First step", "active", "2026-05-26T00:01:00.000Z"),
        processNode(secondId, "Second step", "active", "2026-05-26T00:02:00.000Z"),
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_03FIRST_MEMBER", firstId, processId, "member_of"),
        edge("edge_03SECOND_MEMBER", secondId, processId, "member_of"),
        { ...edge("edge_live", firstId, secondId, "flows_to"), lifecycle: "active" },
        { ...edge("edge_dead", secondId, firstId, "flows_to"), lifecycle: "retired" },
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "process" });

    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));
    expect(edgeQuery?.sql).toMatch(/lifecycle/i);
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_live", lifecycle: "active" }),
    );
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_dead", lifecycle: "retired" }),
    );
  });

  it("does not render sequence links from node JSON", async () => {
    const processId = "action_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";
    const thirdId = "action_01THIRD";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Reserved-key process"),
        {
          ...processNode(firstId, "First step", "active", "2026-05-26T00:01:00.000Z"),
          data: { graph_hint: { target: secondId, label: "next" } },
        },
        processNode(secondId, "Second step", "active", "2026-05-26T00:02:00.000Z"),
        {
          ...processNode(thirdId, "Third step", "active", "2026-05-26T00:03:00.000Z"),
          data: { graph_hint: { source: secondId } },
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_F_MEMBER", firstId, processId, "member_of"),
        edge("edge_S_MEMBER", secondId, processId, "member_of"),
        edge("edge_T_MEMBER", thirdId, processId, "member_of"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "field-flow" });

    // Membership (`has_parent`) edges are real and appear in links, but no
    // sequence flow is conjured from the JSON `graph_hint` fields.
    expect(graph.links.filter((l) => l.edge_type === "flows_to")).toEqual([]);
    expect(graph.nodes.find((node) => node.id === secondId)?.bfs_depth).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === thirdId)?.bfs_depth).toBeUndefined();
  });

  it("assigns later sequence targets a greater layout depth even when a loop points back", async () => {
    const processId = "action_01PROCESS";
    const decisionId = "decision_01ROUTE";
    const checkoutId = "action_01CHECKOUT";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Talent seeker pays to activate Torre Reach"),
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Are credits enough for the first day?",
          lifecycle: "active",
          created_at: "2026-05-26T00:07:00.000Z",
          data: {},
        },
        processNode(
          checkoutId,
          "Talent seeker completes Stripe checkout for credits",
          "active",
          "2026-05-26T00:15:00.000Z",
        ),
      ],
      principals: [
        { id: "principal_system", name: "System", lifecycle: "active" },
        { id: "principal_talent", name: "Talent seeker", lifecycle: "active" },
      ],
      users: [],
      edges: [
        edge("edge_05DECISION_MEMBER", decisionId, processId, "member_of"),
        edge("edge_05CHECKOUT_MEMBER", checkoutId, processId, "member_of"),
        edge("edge_05DECIDER", decisionId, "principal_system", "decided_by"),
        edge("edge_05CHECKOUT_ACTOR", checkoutId, "principal_talent", "performed_by"),
        edge("edge_05DECISION_TO_CHECKOUT", decisionId, checkoutId, "flows_to"),
        edge("edge_05CHECKOUT_TO_DECISION", checkoutId, decisionId, "flows_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "activation" });
    const decision = graph.nodes.find((node) => node.id === decisionId);
    const checkout = graph.nodes.find((node) => node.id === checkoutId);

    expect(checkout?.bfs_depth).toBeGreaterThan(decision?.bfs_depth ?? 0);
  });

  it("renders a bounded active-first slice for large Docos", async () => {
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_proc_active", "Active process"),
        processNode("action_proc_drafting", "Drafting process", "drafting"),
        processNode("action_step_active", "Active work", "active", "2026-05-26T00:10:00.000Z"),
        processNode(
          "action_step_drafting",
          "Drafting work",
          "drafting",
          "2026-05-26T00:20:00.000Z",
        ),
      ],
      principals: [{ id: "principal_owner", name: "Owner", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_06ACTIVE_MEMBER", "action_step_active", "action_proc_active", "member_of"),
        edge("edge_06DRAFTING_MEMBER", "action_step_drafting", "action_proc_drafting", "member_of"),
        edge("edge_06ACTIVE_ACTOR", "action_step_active", "principal_owner", "performed_by"),
        edge("edge_06DRAFTING_ACTOR", "action_step_drafting", "principal_owner", "performed_by"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "large", nodeLimit: 1 });

    expect(graph.nodes.map((node) => node.id)).toEqual(["action_step_active"]);
    expect(graph.pools.map((pool) => pool.id)).toEqual(["pool:action_proc_active"]);
    expect(graph.lanes).toHaveLength(1);
    // totalByLifecycle is the pre-cap per-stage breakdown of every step node
    // (both processes + both members), even though the delivered slice holds
    // one. The header sums the visible stages — with retired hidden by default
    // that's 4 — to say "Showing the latest 1 of 4 steps", and the active-only
    // count it shows tracks whatever the lifecycle filter leaves on.
    expect(graph.totalByLifecycle).toEqual({ drafting: 2, queued: 0, active: 2, retired: 0 });
    expect(graph.nodes).toHaveLength(1);
  });

  it("excludes Reference nodes and their citation edges from the BPMN graph", async () => {
    const processId = "action_01PROCESS";
    const memberId = "action_01STEP";
    const referenceId = "reference_01DOC";

    const { client } = makeQueryClient({
      nodes: [
        processNode(processId, "Process"),
        processNode(memberId, "Do the thing", "active", "2026-05-26T00:01:00.000Z"),
        {
          id: referenceId,
          entity_type: "reference",
          summary: "Background doc",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_MEMBER", memberId, processId, "member_of"),
        edge("edge_ACTOR", memberId, "principal_system", "performed_by"),
        edge("edge_CITES", memberId, referenceId, "relates_to"),
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "proc" });

    expect(graph.nodes.map((n) => n.id)).toContain(memberId);
    expect(graph.nodes.map((n) => n.entity_type)).not.toContain("reference");
    expect(graph.nodes.map((n) => n.id)).not.toContain(referenceId);
    expect(graph.links.some((l) => l.source === referenceId || l.target === referenceId)).toBe(
      false,
    );
  });

  it("heads a top-level pool for a disconnected Action, and keeps a non-Action orphan in Unassigned", async () => {
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_01PROCESS", "Post a job"),
        processNode(
          "action_01CONNECTED",
          "Serves the process",
          "active",
          "2026-05-26T00:01:00.000Z",
        ),
        // A disconnected Action: no parent, no children — a top-level Action,
        // so it heads its OWN pool (surfaced in the home view), never homed
        // into another process's pool.
        processNode(
          "action_01ORPHAN",
          "Spider assembles Torre opportunity payload",
          "drafting",
          "2026-05-26T00:02:00.000Z",
        ),
        // A disconnected non-Action flow node (a gateway) has no pool of its
        // own and falls to Unassigned.
        {
          id: "decision_01ORPHAN",
          entity_type: "decision",
          summary: "Dangling gateway",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_MEMBER", "action_01CONNECTED", "action_01PROCESS", "member_of"),
        edge("edge_ACTOR", "action_01CONNECTED", "principal_system", "performed_by"),
        // Both orphans deliberately have no membership edges.
      ],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "jobs" });

    const connected = graph.nodes.find((n) => n.id === "action_01CONNECTED");
    const decisionOrphan = graph.nodes.find((n) => n.id === "decision_01ORPHAN");
    expect(connected?.pool_id).toBe("pool:action_01PROCESS");
    // The disconnected Action is a top-level pool header — its own pool exists
    // and it is NOT emitted as a member node (and never lands in Unassigned).
    expect(graph.pools.map((p) => p.id)).toContain("pool:action_01ORPHAN");
    expect(graph.nodes.map((n) => n.id)).not.toContain("action_01ORPHAN");
    // The non-Action orphan stays in the real Unassigned pool, pinned last.
    expect(decisionOrphan?.pool_id).toBe("pool:unassigned");
    expect(graph.pools.map((p) => p.id)).toContain("pool:unassigned");
    expect(graph.pools[graph.pools.length - 1]?.id).toBe("pool:unassigned");
  });

  it("heads a pool for every parentless Action so each stays drillable, even with no sub-steps", async () => {
    // Pool construction is structural: a standalone Action with no `has_parent`
    // and no children still heads its OWN pool so it can be opened directly.
    // (Which of these the *overview pool* surfaces is a separate question — it
    // holds only the Actions flagged `top_level`.)
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_alpha", "Onboard a customer"),
        processNode("action_beta", "Close the books", "active", "2026-05-26T00:01:00.000Z"),
      ],
      principals: [],
      users: [],
      edges: [], // neither Action has a parent or children
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "flat" });

    expect(graph.pools.map((p) => p.id).sort()).toEqual(["pool:action_alpha", "pool:action_beta"]);
    expect(graph.pools.every((p) => p.process_id !== null)).toBe(true);
    // Pool headers are not emitted as member nodes.
    expect(graph.nodes).toEqual([]);
  });

  it("renders top-level Actions as task nodes in one synthetic pool, in their principal lanes", async () => {
    // The overview (home) view renders every Action the author *marked*
    // top-level (`top_level` in its `extra`) as a task node inside ONE
    // synthetic pool that is not itself an Action, each placed in its
    // principal's actor lane. A parentless draft the author never flagged
    // (`action_flat`) stays out of that pool. The flagged Action still heads
    // its own pool so opening it drills into its members.
    const { client } = makeQueryClient({
      nodes: [
        {
          ...processNode("action_top", "Run the hiring process"),
          data: { top_level: true },
        },
        processNode("action_flat", "Stray unlinked step", "drafting", "2026-05-26T00:01:00.000Z"),
      ],
      principals: [{ id: "principal_recruiter", name: "Recruiter", lifecycle: "active" }],
      users: [],
      edges: [edge("edge_top_actor", "action_top", "principal_recruiter", "performed_by")],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "hiring" });

    // The synthetic pool exists, is not backed by an Action, and is pinned first.
    expect(graph.pools[0]).toEqual(
      expect.objectContaining({ id: "pool:top-level", process_id: null }),
    );
    // The flagged Action renders as a task node in that pool, in its actor lane.
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "action_top",
        entity_type: "action",
        shape: "task",
        pool_id: "pool:top-level",
        laneId: "pool:top-level::principal_recruiter",
      }),
    );
    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        id: "pool:top-level::principal_recruiter",
        pool_id: "pool:top-level",
        kind: "actor",
        label: "Recruiter",
      }),
    );
    // It still heads its own (drill-in) pool. The never-flagged draft is not in
    // the synthetic pool.
    expect(graph.pools.map((p) => p.id)).toContain("pool:action_top");
    expect(graph.nodes.filter((n) => n.pool_id === "pool:top-level").map((n) => n.id)).toEqual([
      "action_top",
    ]);
  });

  it("carries the entry_point flag onto a top-level Action's synthetic-pool node", async () => {
    // A top-level Action can also be the entry point of its flow — the two
    // BPMN markings are not mutually exclusive. The synthetic-pool node (the
    // overview/home view) must surface the same `entry_point` the regular pool
    // node does, so the start-event glyph / "Entry" tag renders there too.
    const { client } = makeQueryClient({
      nodes: [
        {
          ...processNode("action_top", "Run the hiring process"),
          data: { top_level: true, entry_point: true },
        },
      ],
      principals: [{ id: "principal_recruiter", name: "Recruiter", lifecycle: "active" }],
      users: [],
      edges: [edge("edge_top_actor", "action_top", "principal_recruiter", "performed_by")],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "hiring" });

    const topLevelNode = graph.nodes.find(
      (n) => n.id === "action_top" && n.pool_id === "pool:top-level",
    );
    expect(topLevelNode?.entry_point).toBe(true);
    expect(topLevelNode?.top_level).toBe(true);
  });

  it("omits the synthetic top-level pool when no Action is flagged top-level", async () => {
    // No flag → no synthetic pool (it only appears when it has members).
    const { client } = makeQueryClient({
      nodes: [
        processNode("action_alpha", "Onboard a customer"),
        processNode("action_beta", "Close the books", "active", "2026-05-26T00:01:00.000Z"),
      ],
      principals: [],
      users: [],
      edges: [],
    });

    const graph = await loadProcessGraph(client, "doco_01", { handle: "flat" });

    expect(graph.pools.map((p) => p.id)).not.toContain("pool:top-level");
  });
});

describe("computeNearestProcessByNode", () => {
  it("assigns nodes to the nearest connected process", () => {
    const ranks = new Map([
      ["action_pb", 0.9],
      ["action_pa", 0.1],
    ]);
    const nearest = computeNearestProcessByNode(
      ["action_pa", "action_pb"],
      [
        { source: "member_a", target: "action_pa", edge_type: "has_parent" },
        { source: "member_a", target: "decision_a", edge_type: "flows_to" },
        { source: "member_b", target: "action_pb", edge_type: "has_parent" },
      ],
      ranks,
    );

    expect(nearest.get("decision_a")).toBe("action_pa");
    expect(nearest.get("member_b")).toBe("action_pb");
  });

  it("uses PageRank to break equal-distance process ties", () => {
    const ranks = new Map([
      ["action_pb", 0.9],
      ["action_pa", 0.1],
    ]);
    const nearest = computeNearestProcessByNode(
      ["action_pa", "action_pb"],
      [
        { source: "shared", target: "action_pa", edge_type: "has_parent" },
        { source: "shared", target: "action_pb", edge_type: "has_parent" },
      ],
      ranks,
    );

    expect(nearest.get("shared")).toBe("action_pb");
  });
});
