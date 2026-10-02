// The brief engine against a real database: seeds from touches, meaning and
// words across every readable Doco, one hop along edges, replacements of
// retired decisions, the four tiers with their reasons, the budget, and the
// reranker and synthesis switches. The embedding model, the reranker and the
// synthesis model are stubbed; everything else is the real code.
import { vectorLiteral } from "@doco/db";
import type { Reranker } from "@doco/index";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../../db/src/__tests__/fresh-db";
import { type BriefClient, type BriefDeps, composeBrief } from "../brief.server";

const MODEL = "test:model";
const ORIGIN = "https://doco.test";
const NOW = new Date("2026-10-02T12:00:00Z");
const DAY = 86_400_000;
const SCOPE = { docoIds: ["doco_dec", "doco_glossary", "doco_prs"], origin: ORIGIN };

let c: BriefClient;

const embedApple: BriefDeps["embed"] = async () => ({
  semantic: { queryEmbedding: Float32Array.from([1, 0, 0]), modelId: MODEL },
  warning: null,
});
const OFF: BriefDeps = {
  embed: async () => ({ semantic: null, warning: null }),
  reranker: null,
  synthesize: null,
  now: () => NOW,
};

beforeEach(async () => {
  const db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, constitution)
      VALUES ('workspace_1', 'acme', 'Acme', 'Ship small pull requests.');
    INSERT INTO docos (id, handle, owner_id, workspace_id, goal, data) VALUES
      ('doco_dec', 'decisions', 'workspace_1', 'workspace_1', 'What was decided and why.',
         '{"template_handle":"product-decisions"}'::jsonb),
      ('doco_glossary', 'glossary', 'workspace_1', 'workspace_1', '',
         '{"template_handle":"glossary"}'::jsonb),
      ('doco_prs', 'prs', 'workspace_1', 'workspace_1', '',
         '{"template_handle":"github-pull-requests"}'::jsonb),
      ('doco_other', 'other', 'workspace_1', 'workspace_1', '', '{}'::jsonb);
    INSERT INTO policies (id, doco_id, kind, data) VALUES
      ('policy_1', 'doco_dec', 'suggestion',
         '{"predicate":{"agent_instruction":"Name the alternatives that lost."}}'::jsonb);
  `);
  const node = async (
    id: string,
    doco: string,
    prose: string,
    opts: { lifecycle?: string; locator?: string | null; daysAgo?: number } = {},
  ) => {
    const at = new Date(NOW.getTime() - (opts.daysAgo ?? 20) * DAY).toISOString();
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator, created_at, updated_at)
       VALUES ($1, $2, split_part($1, '_', 1), $3, $4, $5, $6, $6)`,
      [id, doco, opts.lifecycle ?? "active", prose, opts.locator ?? null, at],
    );
    await db.query(
      `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body)
       VALUES ($1, $2, split_part($1, '_', 1), split_part($3, E'\\n', 1), $3)`,
      [id, doco, prose],
    );
  };
  await node("rule_small", "doco_dec", "Never auto-connect a whole organization.");
  await node(
    "decision_hybrid",
    "doco_dec",
    "Keep search hybrid.\nVector plus full text, fused by rank, in packages/web/app/lib/search.server.ts.",
  );
  await node("decision_rerank", "doco_dec", "Move the reranker into the hybrid search ranking.", {
    lifecycle: "drafting",
    daysAgo: 1,
  });
  await node("decision_cosine", "doco_dec", "Rank search by cosine only.", {
    lifecycle: "retired",
  });
  await node("decision_rrf", "doco_dec", "Rank by reciprocal rank fusion over cosine and words.");
  await node("idea_brief", "doco_dec", "The Doco brief: one call before an agent acts.", {
    daysAgo: 2,
  });
  await node("log_old", "doco_dec", "Session on search quality, a month ago.", { daysAgo: 30 });
  await node("reference_pr", "doco_prs", "Touches table (#1333)", {
    lifecycle: "queued",
    locator: "https://github.com/torrenegra/doco/pull/1333",
    daysAgo: 10,
  });
  await node("reference_term", "doco_glossary", "Hybrid search\nRanking by meaning and by words.");
  await node(
    "decision_elsewhere",
    "doco_other",
    "A decision the caller cannot read, in search.server.ts.",
  );
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type) VALUES
       ('edge_1', 'doco_dec', 'derived_from', 'decision_hybrid', 'decision', 'idea_brief', 'idea'),
       ('edge_2', 'doco_dec', 'replaces', 'decision_rrf', 'decision', 'decision_cosine', 'decision')`,
  );
  await db.query(
    `INSERT INTO embeddings
       (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     VALUES
       ('doco_dec', 'node', 'decision_hybrid', 0, $1, 'h1', 'hybrid', $2::vector),
       ('doco_dec', 'node', 'log_old', 0, $1, 'h2', 'old', $3::vector)`,
    [MODEL, vectorLiteral([1, 0, 0]), vectorLiteral([0.8, 0.6, 0])],
  );
  c = db as unknown as BriefClient;
});

function ids(brief: Awaited<ReturnType<typeof composeBrief>>, tier: string): string[] {
  return brief.items.filter((i) => i.tier === tier).map((i) => i.id);
}

describe("composeBrief", () => {
  it("binds the constitution, the standing rules and the decisions that name what is touched", async () => {
    const brief = await composeBrief(
      c,
      SCOPE,
      { about: "", touching: ["packages/web/app/lib/search.server.ts"], target: "decisions" },
      OFF,
    );
    expect(ids(brief, "must_obey")).toEqual([
      "workspace_1",
      "doco_dec",
      "policy_1",
      "rule_small",
      "decision_hybrid",
    ]);
    const decision = brief.items.find((i) => i.id === "decision_hybrid");
    expect(decision?.because).toBe("names packages/web/app/lib/search.server.ts");
    expect(decision?.url).toBe(`${ORIGIN}/decisions/decision/decision_hybrid`);
    expect(decision?.detail).toBe("expanded");
    expect(brief.items.find((i) => i.id === "rule_small")?.because).toBe("standing rule");
    expect(brief.items.find((i) => i.id === "policy_1")?.text).toBe(
      "Name the alternatives that lost.",
    );
    expect(brief.items.map((i) => i.id)).not.toContain("decision_elsewhere");
    expect(brief.gaps).toEqual([]);
    expect(brief.brief_id).toMatch(/^brief_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("seeds by meaning and words, hops one edge, shows replacements and what is in motion", async () => {
    const brief = await composeBrief(
      c,
      SCOPE,
      {
        about: "improve the hybrid search ranking",
        touching: ["#1333"],
        rerank: false,
        synthesize: false,
      },
      { ...OFF, embed: embedApple },
    );
    expect(ids(brief, "must_obey")).toEqual(["workspace_1", "rule_small"]);
    expect(ids(brief, "decided")).toEqual(["decision_hybrid", "decision_rerank", "decision_rrf"]);
    expect(ids(brief, "in_motion")).toEqual(["reference_pr", "idea_brief"]);
    expect(ids(brief, "background")).toEqual(["reference_term", "log_old"]);
    const because = Object.fromEntries(brief.items.map((i) => [i.id, i.because]));
    expect(because.decision_hybrid).toBe("matches your ask");
    expect(because.decision_rerank).toBe("matches your words; still drafting");
    expect(because.decision_rrf).toBe("replaces decision_cosine, now retired; matches your words");
    expect(because.reference_pr).toBe("names #1333; open");
    expect(because.idea_brief).toBe("decision_hybrid derives from it");
    expect(because.reference_term).toBe('defines "Hybrid search"; matches your words');
    expect(because.log_old).toBe("matches your ask");
    expect(brief.items.find((i) => i.id === "reference_pr")?.url).toBe(
      "https://github.com/torrenegra/doco/pull/1333",
    );
    expect(brief.items.map((i) => i.id)).not.toContain("decision_cosine");
    expect(brief.warnings).toEqual([]);
    expect(Object.keys(brief.steps)).toEqual(["embed", "seeds", "expand", "rank", "total"]);
  });

  it("names the gaps: nothing found for a touch, no decision on it, a target it cannot read", async () => {
    const brief = await composeBrief(
      c,
      SCOPE,
      { about: "", touching: ["app/nowhere.ts"], target: "other" },
      OFF,
    );
    expect(brief.gaps).toEqual([
      "Target Doco other is not one you can read.",
      "Nothing in Doco names app/nowhere.ts.",
      "No decision mentions what you touch.",
    ]);
    expect(ids(brief, "must_obey")).toEqual(["workspace_1", "rule_small"]);
  });

  it("keeps the first tier whole and holds the rest back when the budget is small", async () => {
    const brief = await composeBrief(
      c,
      SCOPE,
      { about: "improve the hybrid search ranking", budget: 120 },
      { ...OFF, embed: embedApple },
    );
    expect(ids(brief, "must_obey")).toEqual(["workspace_1", "rule_small"]);
    expect(brief.held_back).toBeGreaterThan(0);
    expect(brief.items.length + brief.held_back).toBe(8);
    expect(brief.budget).toBe(120);
  });

  it("reranks within tiers and opens with the synthesis when both are on, and skips them when off", async () => {
    const reversed: Reranker = {
      modelId: "test:reranker",
      rerank: vi.fn(async (_q: string, documents: string[]) =>
        documents.map((_, index) => ({ index, score: index })),
      ),
    };
    const synthesize = vi.fn(async ({ about, items }) => `About ${about}: obey [${items[0].id}].`);
    const on = await composeBrief(
      c,
      SCOPE,
      { about: "improve the hybrid search ranking" },
      { ...OFF, embed: embedApple, reranker: reversed, synthesize },
    );
    expect(ids(on, "decided")).toEqual(["decision_rrf", "decision_rerank", "decision_hybrid"]);
    expect(ids(on, "in_motion")).toEqual(["idea_brief"]);
    expect(on.synthesis).toBe("About improve the hybrid search ranking: obey [workspace_1].");
    expect(synthesize.mock.calls[0][0].items.map((i: { id: string }) => i.id)).toEqual([
      "workspace_1",
      "rule_small",
      "decision_rrf",
      "decision_rerank",
      "decision_hybrid",
      "idea_brief",
    ]);
    expect(Object.keys(on.steps)).toContain("rerank");
    expect(Object.keys(on.steps)).toContain("synthesize");

    const off = await composeBrief(
      c,
      SCOPE,
      { about: "improve the hybrid search ranking", rerank: false, synthesize: false },
      { ...OFF, embed: embedApple, reranker: reversed, synthesize },
    );
    expect(reversed.rerank).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(off.synthesis).toBeNull();
    expect(ids(off, "decided")).toEqual(["decision_hybrid", "decision_rerank", "decision_rrf"]);
  });

  it("says so when the reranker and the synthesis are wanted but unavailable", async () => {
    const brief = await composeBrief(
      c,
      SCOPE,
      { about: "improve the hybrid search ranking" },
      { ...OFF, embed: embedApple, reranker: null, synthesize: async () => null },
    );
    expect(brief.warnings).toEqual([
      "No reranker is configured; order is by rank fusion alone.",
      "No model is configured for the synthesis.",
    ]);
  });
});
