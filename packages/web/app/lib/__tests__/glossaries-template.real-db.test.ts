// Behavioral exercise of the **glossaries** template against a real DB.
//
// Points `@doco/db`'s `withClient` at an in-process PGlite loaded with the
// REAL schema, seeds a Doco from the `glossaries` template through the REAL
// host seeder (`createDocoInWorkspace`), then drives real-life term scenarios
// (plus a few structural guards) through the REAL authoring evaluator
// (`runAuthoringPolicies`). The ONLY stubbed boundary is the LLM judge
// (`judgeProbabilisticPredicate`) — it has no API key in CI, so each
// probabilistic verdict is scripted from a careful reading of the policy's
// spec against the candidate (see the judge mock below).
//
// The model under test: a glossary **term entry is a Reference** whose prose
// (`reference`) is the *word being defined* — the headword — while the
// **definition lives in the `definition` attribute**, off the prose. There is
// no `chosen`/`question` shape and no deterministic uniqueness gate anymore;
// the prose-is-the-word / definition-in-attributes checks are folded into the
// combined term-quality judge, which WARNs rather than blocking.
//
// What this pins, machine-checked:
//   • the deterministic gates (node-type allowlist; Eval `supports` edge +
//     `how_to_run`)
//   • the two-stage lifecycle: gates fire on `active`, a `drafting` stub is
//     exempt, and a `retired` term winds down without re-running the gates
//   • warn-vs-block routing (a quality miss WARNs; a wrong node type or a
//     missing Eval edge BLOCKs)
//
// What it documents (judge scripted): the probabilistic specs — membership,
// the combined term-quality judge (prose-is-the-word / definition-in-
// attributes / one-concept / acronym-on-the-headword), and the Eval rerun-path
// judge — produce the right verdict on each scenario, including the acronym-
// scoping false-positive probe (scenario 3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

// PGlite instance, swapped per test. `@doco/db`'s withClient is rerouted at it.
const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
// The scripted LLM judge.
const judge = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return {
    ...actual,
    withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  };
});
vi.mock("../llm-judge.server", () => ({ judgeProbabilisticPredicate: judge.fn }));

import { createDocoInWorkspace } from "@doco/host";
import { runAuthoringPolicies } from "../authoring-runner.server";

const USER_ID = "user_01TESTGLOSSARYUSER00000001";
const WS_ID = "workspace_01TESTGLOSSARYWS00000001";
let docoId = "";

// ── Scenario candidate ids. The judge mock routes its scripted verdicts by id.
const ID = {
  workspace: "reference_01GLOSSWORKSPACE00000001",
  acronym: "reference_01GLOSSACRONYMMRR000001",
  retro: "reference_01GLOSSRETROSPECTIVE0001",
  multiConcept: "reference_01GLOSSCHURNRETENTION01",
  proseIsDefinition: "reference_01GLOSSPROSEISDEFN0001",
  circular: "reference_01GLOSSCIRCULAR0000001",
  homograph: "reference_01GLOSSORDERSORTING001",
  acronymOk: "reference_01GLOSSSSOEXPANDED00001",
  borrowed: "reference_01GLOSSIDEMPOTENCY00001",
  retiredTerm: "reference_01GLOSSORGRETIRED000001",
  draftStub: "reference_01GLOSSPRINCIPALDRAFT01",
  // structural guards
  action: "action_01GLOSSSENDINVOICE0000001",
  evalGood: "eval_01GLOSSEVALGOOD000000001",
  evalNoEdge: "eval_01GLOSSEVALNOEDGE00000001",
  offTopic: "reference_01GLOSSDEPLOYPROD00001",
  // seeded population / edge endpoints
  evalTermTarget: "reference_01GLOSSEVALTARGET00001",
} as const;

// Term-quality FAILs only where the entry's shape is genuinely wrong (acronym
// unexpanded, two concepts, definition crammed into the prose, circular
// definition); membership FAILs only on the off-topic runbook. Everything else
// PASSes — matching the judge's "be conservative, pass when plausible" contract.
const TERM_QUALITY_FAIL = new Set<string>([
  ID.acronym,
  ID.multiConcept,
  ID.proseIsDefinition,
  ID.circular,
]);
const MEMBERSHIP_FAIL = new Set<string>([ID.offTopic]);

function scriptedJudge(spec: string, candidate: Record<string, unknown>) {
  const id = String(candidate.id ?? "");
  const isMembership = /belongs in glossaries/i.test(spec);
  const isTermQuality = /ONE CONCEPT/i.test(spec);
  const isEvalRerun = /concrete rerun path/i.test(spec);
  if (!isMembership && !isTermQuality && !isEvalRerun) {
    throw new Error(`Unexpected probabilistic spec handed to the judge: ${spec.slice(0, 80)}`);
  }
  if (isTermQuality && TERM_QUALITY_FAIL.has(id)) {
    return { ok: false, reason: `term-quality miss for ${id}` };
  }
  if (isMembership && MEMBERSHIP_FAIL.has(id)) {
    return { ok: false, reason: "reads as a deployment runbook, not a terminology entry" };
  }
  return { ok: true };
}

async function insertNode(
  id: string,
  nodeType: string,
  lifecycle: string,
  data: Record<string, unknown>,
): Promise<void> {
  // Slim-down: the catch-all `data` jsonb is gone; per-node domain fields live
  // in `attributes`. The glossary loader reads them via `attributes AS data`.
  // Identity/lifecycle stay in their real columns, so only the domain fields go
  // into the bag.
  await dbm.db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
       VALUES ($1, $2, $3, $4, '', $5::jsonb)`,
    [id, docoId, nodeType, lifecycle, JSON.stringify(data)],
  );
}

async function insertEdge(
  fromId: string,
  fromType: string,
  toId: string,
  toType: string,
  edgeType: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  await dbm.db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, props, lifecycle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active')`,
    [
      `edge_${fromId}_${toId}`,
      docoId,
      edgeType,
      fromId,
      fromType,
      toId,
      toType,
      JSON.stringify(props),
    ],
  );
}

function run(candidate: Record<string, unknown> & { id: string }) {
  return runAuthoringPolicies({ docoId, candidate });
}

const hasSubKind = (vs: { sub_kind?: string }[], k: string) => vs.some((v) => v.sub_kind === k);

beforeAll(async () => {
  // Apply the (expensive) schema once; beforeEach truncates + re-seeds.
  dbm.db = new PGlite();
  await dbm.db.exec(schemaSql);
});

beforeEach(async () => {
  // DELETE (not TRUNCATE) so the cascade through `docos` trips the
  // allow-history-delete trigger; TRUNCATE is blocked on append-only tables.
  await dbm.db.exec("DELETE FROM workspaces; DELETE FROM users;");
  judge.fn.mockReset();
  judge.fn.mockImplementation(scriptedJudge);

  await dbm.db.query(
    `INSERT INTO users (id, github_login, data) VALUES ($1, 'glossary-tester', '{}'::jsonb)`,
    [USER_ID],
  );
  await dbm.db.query(
    `INSERT INTO workspaces (id, handle, name, data) VALUES ($1, 'glossary-ws', 'Glossary WS', '{}'::jsonb)`,
    [WS_ID],
  );
  await dbm.db.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [WS_ID, USER_ID],
  );
  const res = await createDocoInWorkspace({
    workspaceId: WS_ID,
    requestedHandle: "glossary-test",
    createdByUserId: USER_ID,
    templateHandle: "glossaries",
  });
  docoId = res.docoId;
});

describe("glossaries template — seeded shape (real host seeder)", () => {
  it("seeds the expected kinds of policy from the template", async () => {
    const { rows } = await dbm.db.query<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*)::int AS n FROM policies WHERE doco_id = $1 GROUP BY kind",
      [docoId],
    );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    // 4 deterministic gates (node-type allowlist, edge-type allowlist, Eval
    // `supports` edge, Eval `how_to_run`), 3 probabilistic judges (membership,
    // term-quality, Eval rerun), 9 prose suggestions. Dropping the
    // Decision-era `requires_field` + `unique_field` gates took deterministic
    // from 6 → 4; the new term-model guidance took suggestions from 8 → 9.
    expect(byKind.deterministic).toBe(4);
    expect(byKind.probabilistic).toBe(3);
    expect(byKind.suggestion).toBe(9);
    // The enforcer loads only the 4 + 3 enforceable policies; suggestions
    // are advisory and never reach it.
  });
});

describe("glossaries template — real-life term scenarios", () => {
  it("1. a clean term entry (word in prose, meaning in `definition`) → passes everything", async () => {
    const r = await run({
      id: ID.workspace,
      node_type: "reference",
      lifecycle: "active",
      reference: "Workspace",
      definition:
        "A Workspace is the top-level container that groups related Docos and the people and agents who can reach them. Scope: Doco's access model. For example, the `acme` workspace holds Acme's product and engineering Docos. Not to be confused with a Doco, which lives inside a workspace.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("2. an acronym headword left unexpanded → quality WARN (not block)", async () => {
    const r = await run({
      id: ID.acronym,
      node_type: "reference",
      lifecycle: "active",
      reference: "MRR",
      definition:
        "MRR is the headline growth number finance reviews every month. Scope: Doco's billing analytics. For example, 50 seats on the $20/mo plan contribute $1,000.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.kind).toBe("probabilistic");
  });

  it("3. a full-word headword whose definition uses casual abbreviations → passes (acronym check is scoped to the headword)", async () => {
    // Misfire probe: the headword `Retrospective` is NOT an acronym, so aspect
    // (d) must ignore the incidental `retro` / `Fri` / `PMs` / `async` in the
    // definition body.
    const r = await run({
      id: ID.retro,
      node_type: "reference",
      lifecycle: "active",
      reference: "Retrospective",
      definition:
        "A Retrospective is the team's recurring meeting to reflect on the last sprint and agree on improvements. Scope: Doco's agile rituals. For example, eng runs a 60-min retro every other Fri and PMs join async. Not a status update.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("4. one entry bundling two concepts → quality WARN", async () => {
    const r = await run({
      id: ID.multiConcept,
      node_type: "reference",
      lifecycle: "active",
      reference: "Churn and Retention",
      definition:
        "Churn is the rate at which customers cancel; retention is the share who stay. Together they describe account health.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.kind).toBe("probabilistic");
  });

  it("5. the definition crammed into the prose instead of the `definition` attribute → quality WARN", async () => {
    // The central new check: the prose is a definition sentence, not the bare
    // term, and no `definition` attribute carries the meaning. The first line
    // of prose would become the node name, so this is exactly the shape the
    // template now warns against — a WARN, never a hard block.
    const r = await run({
      id: ID.proseIsDefinition,
      node_type: "reference",
      lifecycle: "active",
      reference:
        "An Eval is a check that verifies a terminology claim still holds across the docs.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.kind).toBe("probabilistic");
  });

  it("6. a circular definition that merely restates the headword → quality WARN", async () => {
    const r = await run({
      id: ID.circular,
      node_type: "reference",
      lifecycle: "active",
      reference: "Backfill",
      definition: "A backfill is when you backfill.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.kind).toBe("probabilistic");
  });

  it("7. a disambiguated homograph → passes", async () => {
    const r = await run({
      id: ID.homograph,
      node_type: "reference",
      lifecycle: "active",
      reference: "Order (sorting)",
      definition:
        "Order (sorting) is the arrangement of rows by a key, ascending or descending. Scope: Doco's list views. For example, ordering decisions by `decided_at` descending. Distinct from Order (commerce), a customer purchase.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("8. a borrowed/standards term with a cited source → passes", async () => {
    const r = await run({
      id: ID.borrowed,
      node_type: "reference",
      lifecycle: "active",
      reference: "Idempotency",
      definition:
        "Idempotency means an operation can be applied repeatedly without changing the result beyond the first application — a standard distributed-systems property cited from the HTTP semantics RFC. Scope: Doco's write API, where retried changeset POSTs must not double-apply. For example, re-POSTing the same changeset id is a no-op.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("9. retiring a deprecated term → winds down, gates do not re-run", async () => {
    // `retired` is the OTHER stage a glossary uses. The runner keeps only
    // lifecycle-independent invariants (the node-type allowlist) on the way
    // out — term-quality / membership gates are skipped — so a term closes
    // out cleanly even if it predates today's bar.
    const r = await run({
      id: ID.retiredTerm,
      node_type: "reference",
      lifecycle: "retired",
      reference: "Org",
      definition:
        "Org was the old name for a Workspace before the 2026 rename. Deprecated — use Workspace. Kept so old tickets and URLs still resolve.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("10. a rough drafting stub → exempt until activated", async () => {
    // A `drafting` sketch is not part of the glossary yet, so the
    // completeness gates (which fire on `active`) skip it — even with the
    // definition still sitting in the prose and no `definition` attribute.
    const r = await run({
      id: ID.draftStub,
      node_type: "reference",
      lifecycle: "drafting",
      reference: "principal = a role/persona that participates in flows. flesh out later.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});

describe("glossaries template — structural guards", () => {
  it("rejects a non-glossary node type (Action) → BLOCK (allowlist)", async () => {
    const r = await run({
      id: ID.action,
      node_type: "action",
      lifecycle: "active",
      action: "send the renewal invoice",
      verb: "send",
    });
    expect(r.blocking).not.toBeNull();
    expect(r.blocking?.sub_kind).toBe("requires_node_type");
  });

  it("accepts an acronym headword that IS expanded (paired with scenario 2)", async () => {
    // The complement of scenario 2: aspect (d) must PASS when the acronym
    // headword is spelled out in the definition and the short-form's use is
    // stated, so the check doesn't false-positive on a well-formed acronym.
    const r = await run({
      id: ID.acronymOk,
      node_type: "reference",
      lifecycle: "active",
      reference: "SSO",
      definition:
        "SSO, or single sign-on, lets a user authenticate once and then reach every connected app without re-entering credentials. Scope: Doco's auth. For example, signing in with GitHub then reaching the dashboard and the API without another prompt. Spell out `single sign-on` on first mention in UI copy; the short form `SSO` is fine thereafter. Not the same as social login.",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("accepts a consistency Eval with a supports edge and a concrete how_to_run", async () => {
    await insertNode(ID.evalTermTarget, "reference", "active", {
      definition: "the canonical term",
    });
    await insertNode(ID.evalGood, "eval", "active", {});
    await insertEdge(ID.evalGood, "eval", ID.evalTermTarget, "reference", "supports");
    const r = await run({
      id: ID.evalGood,
      node_type: "eval",
      lifecycle: "active",
      eval: "Scan the docs for `log in` drift against the canonical `Sign in` term.",
      how_to_run: "rg -i 'log[ -]?in' docs/ and reconcile every hit against the `Sign in` entry",
    });
    expect(r.blocking).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("blocks an active Eval with no supports edge → BLOCK (requires_edge)", async () => {
    const r = await run({
      id: ID.evalNoEdge,
      node_type: "eval",
      lifecycle: "active",
      eval: "Scan the docs for terminology drift.",
      how_to_run: "rg -i 'log[ -]?in' docs/",
    });
    expect(r.blocking).not.toBeNull();
    expect(r.blocking?.sub_kind).toBe("requires_edge");
  });

  it("warns on an off-topic Reference that isn't terminology → membership WARN", async () => {
    const r = await run({
      id: ID.offTopic,
      node_type: "reference",
      lifecycle: "active",
      reference: "Deploy to prod",
      definition:
        "Run the deploy pipeline: build the image, run migrations, flip traffic. On failure, roll back to the previous release.",
    });
    expect(r.blocking).toBeNull();
    expect(hasSubKind(r.warnings, "requires_node_type")).toBe(false);
    expect(r.warnings.some((w) => w.kind === "probabilistic")).toBe(true);
  });
});
