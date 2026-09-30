// Real-life exercise of the `agents-chats` Doco template: the template
// definition (`@doco/host` DEFAULT_DOCO_TEMPLATES), the host seam that seeds a
// Doco's policies and perspectives from it (`createDocoInWorkspace`, against
// in-process PGlite loaded with the real schema.sql), and the pure authoring
// evaluator (`@doco/shared`), driven as `authoring-runner.server` drives it.
// The template's one probabilistic check is a warn, so no LLM judge runs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CandidateFields,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluatePolicies,
} from "@doco/shared";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeAll, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});

import { createDocoInWorkspace } from "@doco/host";

const WORKSPACE_ID = "workspace_01CHATSTEST00000000000001";
const USER_ID = "user_01CHATSTEST0000000000000001";

let docoId = "";
let policies: LoadedPolicy[] = [];

async function loadSeededPolicies(id: string): Promise<LoadedPolicy[]> {
  const r = await dbm.db.query<{ id: string; data: unknown }>(
    "SELECT id, data FROM policies WHERE doco_id = $1 AND COALESCE(lifecycle,'active') = 'active'",
    [id],
  );
  const out: LoadedPolicy[] = [];
  for (const row of r.rows) {
    const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Record<
      string,
      unknown
    >;
    const kind = data.kind;
    if (kind !== "deterministic" && kind !== "probabilistic") continue;
    out.push({
      policy_id: row.id,
      kind,
      predicate: data.predicate as LoadedPolicy["predicate"],
      ...(typeof data.on_violation === "string"
        ? { on_violation: data.on_violation as LoadedPolicy["on_violation"] }
        : {}),
      ...(Array.isArray(data.fires_when_node_lifecycle)
        ? { fires_when_node_lifecycle: data.fires_when_node_lifecycle as Lifecycle[] }
        : {}),
    });
  }
  return out;
}

beforeAll(async () => {
  dbm.db = new PGlite({ extensions: { vector } });
  await dbm.db.exec(schemaSql);
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1,'chats','{}')", [
    USER_ID,
  ]);
  await dbm.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'chats','Chats')", [
    WORKSPACE_ID,
  ]);
  await dbm.db.query(
    "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
    [WORKSPACE_ID, USER_ID],
  );
  const created = await createDocoInWorkspace({
    workspaceId: WORKSPACE_ID,
    requestedHandle: "chats-agents-chats",
    createdByUserId: USER_ID,
    templateHandle: "agents-chats",
  });
  docoId = created.docoId;
  policies = await loadSeededPolicies(docoId);
});

let seq = 0;
function node(type: string, fields: Record<string, unknown>): CandidateFields {
  seq += 1;
  return {
    id: `${type}_chat-${seq}`,
    node_type: type as CandidateFields["node_type"],
    doco_id: docoId,
    lifecycle: "active",
    ...fields,
  };
}

function blocks(candidate: CandidateFields): Violation[] {
  return evaluatePolicies({
    candidate,
    policies,
    candidateEdges: [],
    edges: [],
    principals: new Set(),
    population: [],
  }).filter((v) => v.kind === "deterministic" && v.on_violation === "block");
}

describe("agents-chats template", () => {
  it("opens on the List perspective", async () => {
    const r = await dbm.db.query<{ slug: string; is_default: boolean }>(
      `SELECT p.slug, dp.is_default
         FROM doco_perspectives dp
         JOIN perspectives p ON p.id = dp.perspective_id
        WHERE dp.doco_id = $1`,
      [docoId],
    );
    expect(r.rows.filter((x) => x.is_default).map((x) => x.slug)).toEqual(["list"]);
  });

  it("accepts a chat recorded as a Log", () => {
    const chat = node("log", {
      prose:
        "Alexander and Claude Code (doco-agent) chatted about the Agents chats Doco. The Doco was added to the default workspace Docos; the backfill for existing workspaces was left open.",
      verb: "chatted",
      happened_at: "2026-09-30T04:07:14Z",
      outputs: { decisions: ["decision_01EXAMPLE"], pull_requests: ["#1275"] },
    });
    expect(blocks(chat)).toEqual([]);
  });

  it("blocks a Decision or an Idea: they go in the Docos that hold them", () => {
    const decision = node("decision", { prose: "Use Postgres", question: "Which database?" });
    const idea = node("idea", { prose: "Summarize chats weekly" });
    expect(blocks(decision).map((v) => v.sub_kind)).toEqual(["requires_node_type"]);
    expect(blocks(idea).map((v) => v.sub_kind)).toEqual(["requires_node_type"]);
  });
});
