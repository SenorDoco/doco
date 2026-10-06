// The brief's evaluation set comes from the workspace's own records (Logs of
// Agents chats, pull requests linked to their work), and scoring it reports
// where the brief misses. Real database, stubbed models.
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../../db/src/__tests__/fresh-db";
import type { BriefClient, BriefDeps } from "../brief.server";
import { aboutOf, evaluateBriefs, loadBriefEvaluationSet } from "../evaluate";

const SCOPE = { docoIds: ["doco_dec", "doco_chats", "doco_prs"], origin: "https://doco.test" };
const OFF: BriefDeps = {
  embed: async () => ({ semantic: null, warning: null }),
  reranker: null,
  synthesize: null,
};

let c: BriefClient;

beforeEach(async () => {
  const db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_dec', 'decisions', 'workspace_1', 'workspace_1',
         '{"template_handle":"product-decisions"}'::jsonb),
      ('doco_chats', 'chats', 'workspace_1', 'workspace_1',
         '{"template_handle":"agents-chats"}'::jsonb),
      ('doco_prs', 'prs', 'workspace_1', 'workspace_1',
         '{"template_handle":"github-pull-requests"}'::jsonb);
  `);
  const node = async (
    id: string,
    doco: string,
    prose: string,
    opts: { lifecycle?: string; locator?: string | null } = {},
  ) => {
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator)
       VALUES ($1, $2, split_part($1, '_', 1), $3, $4, $5)`,
      [id, doco, opts.lifecycle ?? "active", prose, opts.locator ?? null],
    );
    await db.query(
      `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body)
       VALUES ($1, $2, split_part($1, '_', 1), split_part($3, E'\\n', 1), $3)`,
      [id, doco, prose],
    );
  };
  await node("decision_01AAAAAAAAAAAAAAAAAAAAAAAA", "doco_dec", "Keep search hybrid.");
  await node("decision_01BBBBBBBBBBBBBBBBBBBBBBBB", "doco_dec", "Use a small model for synthesis.");
  await node(
    "log_01CCCCCCCCCCCCCCCCCCCCCCCC",
    "doco_chats",
    "Session on search ranking with decision_01AAAAAAAAAAAAAAAAAAAAAAAA\nAlso produced decision_01BBBBBBBBBBBBBBBBBBBBBBBB and cites log_01DDDDDDDDDDDDDDDDDDDDDDDD.",
  );
  await node("log_01DDDDDDDDDDDDDDDDDDDDDDDD", "doco_chats", "A chat that cites nothing.");
  await node("reference_01EEEEEEEEEEEEEEEEEEEEEEEE", "doco_prs", "Brief engine (#1334)", {
    locator: "https://github.com/torrenegra/doco/pull/1334",
  });
  await node(
    "rule_01FFFFFFFFFFFFFFFFFFFFFFFF",
    "doco_dec",
    "Always ship through a pull request with auto-merge.",
  );
  await node(
    "rule_01GGGGGGGGGGGGGGGGGGGGGGGG",
    "doco_dec",
    "Push finished work directly to main.",
    { lifecycle: "retired" },
  );
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type)
     VALUES ('edge_1', 'doco_prs', 'supports', 'decision_01AAAAAAAAAAAAAAAAAAAAAAAA', 'decision',
             'reference_01EEEEEEEEEEEEEEEEEEEEEEEE', 'reference')`,
  );
  c = db as unknown as BriefClient;
});

describe("aboutOf", () => {
  it("takes the first line and leaves the cited ids out", () => {
    expect(aboutOf("\nFix login with decision_01AAAAAAAAAAAAAAAAAAAAAAAA now\nmore")).toBe(
      "Fix login with now",
    );
  });
});

describe("loadBriefEvaluationSet", () => {
  it("draws one query from each citing Log and each linked pull request", async () => {
    expect(await loadBriefEvaluationSet(c, SCOPE.docoIds)).toEqual([
      {
        id: "log_01CCCCCCCCCCCCCCCCCCCCCCCC",
        kind: "log",
        about: "Session on search ranking with",
        required: ["decision_01AAAAAAAAAAAAAAAAAAAAAAAA", "decision_01BBBBBBBBBBBBBBBBBBBBBBBB"],
        exclude: ["log_01CCCCCCCCCCCCCCCCCCCCCCCC"],
      },
      {
        id: "reference_01EEEEEEEEEEEEEEEEEEEEEEEE",
        kind: "pull_request",
        about: "Brief engine (#1334)",
        required: ["decision_01AAAAAAAAAAAAAAAAAAAAAAAA"],
        exclude: ["reference_01EEEEEEEEEEEEEEEEEEEEEEEE"],
      },
    ]);
  });
});

describe("evaluateBriefs", () => {
  it("scores what each brief served against what the record cites, and names the misses", async () => {
    const set = await loadBriefEvaluationSet(c, SCOPE.docoIds);
    const { passed, report, results } = await evaluateBriefs(c, SCOPE, set, OFF, { ks: [1, 5] });
    // Words alone find the search decision for the session (and, one hop on,
    // the pull request it supports), nothing for the pull request's own title
    // once the pull request itself is hidden: half the session's citations,
    // none of the PR's.
    expect(results.map((r) => [r.id, r.served, r.requiredMissing])).toEqual([
      [
        "log_01CCCCCCCCCCCCCCCCCCCCCCCC",
        [
          "rule_01FFFFFFFFFFFFFFFFFFFFFFFF",
          "decision_01AAAAAAAAAAAAAAAAAAAAAAAA",
          "reference_01EEEEEEEEEEEEEEEEEEEEEEEE",
        ],
        ["decision_01BBBBBBBBBBBBBBBBBBBBBBBB"],
      ],
      [
        "reference_01EEEEEEEEEEEEEEEEEEEEEEEE",
        ["rule_01FFFFFFFFFFFFFFFFFFFFFFFF"],
        ["decision_01AAAAAAAAAAAAAAAAAAAAAAAA"],
      ],
    ]);
    expect(passed).toBe(false);
    expect(report.queries).toBe(2);
    expect(report.recall[5]).toBeCloseTo(0.25, 5);
    expect(report.recall[1]).toBe(0);
    expect(report.mrr).toBeCloseTo(0.25, 5);
  });

  it("passes a gold case only when required evidence is delivered under the production budget", async () => {
    const evaluation = await evaluateBriefs(
      c,
      SCOPE,
      [
        {
          id: "shipping-workflow",
          kind: "gold",
          about: "How should I ship this change?",
          required: ["rule_01FFFFFFFFFFFFFFFFFFFFFFFF"],
          forbidden: ["rule_01GGGGGGGGGGGGGGGGGGGGGGGG"],
          mustObey: ["rule_01FFFFFFFFFFFFFFFFFFFFFFFF"],
        },
      ],
      OFF,
    );

    expect(evaluation.passed).toBe(true);
    expect(evaluation.results[0]).toMatchObject({
      passed: true,
      served: ["rule_01FFFFFFFFFFFFFFFFFFFFFFFF"],
      requiredMissing: [],
      forbiddenServed: [],
      mustObeyViolations: [],
      duplicateIds: [],
      budgetExceededBy: 0,
      budget: 4_000,
    });
  });

  it("keeps excluded records out even when graph expansion reaches them", async () => {
    const evaluation = await evaluateBriefs(
      c,
      SCOPE,
      [
        {
          id: "excluded-graph-neighbour",
          kind: "gold",
          about: "search ranking",
          required: ["decision_01AAAAAAAAAAAAAAAAAAAAAAAA"],
          forbidden: ["reference_01EEEEEEEEEEEEEEEEEEEEEEEE"],
          exclude: ["reference_01EEEEEEEEEEEEEEEEEEEEEEEE"],
        },
      ],
      OFF,
    );

    expect(evaluation.results[0]).toMatchObject({
      passed: true,
      requiredMissing: [],
      forbiddenServed: [],
    });
  });
});
