// The brief's pure parts: what the agent names is parsed the way the touches
// trigger parses prose, candidates land in the right tier with a reason, and
// the budget fill keeps every standing order while holding the rest back.
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  becauseOf,
  fillBudget,
  parseTouching,
  renderBriefText,
  renderItem,
  tierOf,
  tokensOf,
} from "../brief";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const CTX = { sinceMs: NOW - 7 * 86_400_000 };

function candidate(over: Partial<Candidate>): Candidate {
  return {
    id: "decision_1",
    doco: "decisions",
    type: "decision",
    lifecycle: "active",
    text: "Keep search hybrid.",
    url: null,
    updated_at: "2026-09-01T00:00:00Z",
    signals: [],
    ...over,
  };
}

describe("parseTouching", () => {
  it("sorts what the agent names into paths, URLs, node ids and pull requests", () => {
    expect(
      parseTouching([
        "./packages/web/app/lib/search.server.ts",
        "/home/user/doco/AGENTS.md:12-20",
        "https://github.com/torrenegra/doco/pull/1333.",
        "#1330",
        "1331",
        "decision_01M3YXBFVNKEN703EAMWCW26QH",
        " ",
        "#1330",
      ]),
    ).toEqual([
      { kind: "path", value: "packages/web/app/lib/search.server.ts" },
      { kind: "path", value: "home/user/doco/AGENTS.md" },
      { kind: "url", value: "https://github.com/torrenegra/doco/pull/1333" },
      { kind: "pr", value: "#1333" },
      { kind: "pr", value: "#1330" },
      { kind: "pr", value: "#1331" },
      { kind: "node", value: "decision_01M3YXBFVNKEN703EAMWCW26QH" },
    ]);
  });
});

describe("tierOf", () => {
  it("binds active rules, and active decisions that name what the agent touches", () => {
    expect(tierOf(candidate({ type: "rule" }), CTX)).toBe("must_obey");
    expect(tierOf(candidate({ type: "rule", lifecycle: "drafting" }), CTX)).toBe("decided");
    expect(tierOf(candidate({ signals: [{ kind: "touch", value: "app/x.ts" }] }), CTX)).toBe(
      "must_obey",
    );
    expect(tierOf(candidate({ signals: [{ kind: "vector", rank: 0 }] }), CTX)).toBe("decided");
    expect(
      tierOf(candidate({ lifecycle: "drafting", signals: [{ kind: "touch", value: "a" }] }), CTX),
    ).toBe("decided");
  });

  it("puts recent nodes and open pull requests in motion, the rest in the background", () => {
    const recent = new Date(NOW - 86_400_000).toISOString();
    const old = new Date(NOW - 30 * 86_400_000).toISOString();
    expect(tierOf(candidate({ type: "log", updated_at: recent }), CTX)).toBe("in_motion");
    expect(tierOf(candidate({ type: "log", updated_at: old }), CTX)).toBe("background");
    expect(
      tierOf(candidate({ type: "reference", lifecycle: "queued", updated_at: old }), CTX),
    ).toBe("in_motion");
    expect(tierOf(candidate({ type: "slack", updated_at: null }), CTX)).toBe("background");
    expect(tierOf(candidate({ lifecycle: "retired" }), CTX)).toBeNull();
  });
});

describe("becauseOf", () => {
  it("says how the item was found and flags its lifecycle", () => {
    expect(
      becauseOf(
        candidate({
          lifecycle: "drafting",
          signals: [
            { kind: "touch", value: "app/x.ts" },
            { kind: "touch", value: "#12" },
            { kind: "touch", value: "app/y.ts" },
            { kind: "hop", edge_type: "derived_from", via: "idea_1", direction: "out" },
            { kind: "vector", rank: 3 },
            { kind: "fts", rank: 1 },
          ],
        }),
      ),
    ).toBe(
      "names app/x.ts and #12 and 1 more; derives from idea_1; matches your ask; still drafting",
    );
    expect(
      becauseOf(
        candidate({
          type: "reference",
          lifecycle: "queued",
          signals: [{ kind: "hop", edge_type: "supports", via: "intent_1", direction: "in" }],
        }),
      ),
    ).toBe("intent_1 supports it; open");
  });
});

describe("fillBudget", () => {
  const long = "x".repeat(400);
  const items = [
    { ...candidate({ type: "rule", id: "rule_1", text: long }), tier: "must_obey" as const },
    { ...candidate({ id: "decision_1", text: long }), tier: "decided" as const },
    { ...candidate({ id: "decision_2", text: long }), tier: "decided" as const },
    { ...candidate({ id: "decision_3", text: long }), tier: "decided" as const },
  ].map((c) => ({ ...c, summary: "Summary", because: "because" }));

  const expanded = tokensOf(renderItem(items[1], "expanded"));
  const compact = tokensOf(renderItem(items[1], "compact"));

  it("always serves the first tier expanded, then expands until the share, then compacts", () => {
    // Two expanded items pass 60% of this budget; the next two go compact.
    const budget = 2 * expanded + 2 * compact + 10;
    const { served, held_back, tokens_used } = fillBudget(items, budget, 10);
    expect(served.map((i) => [i.id, i.detail])).toEqual([
      ["rule_1", "expanded"],
      ["decision_1", "expanded"],
      ["decision_2", "compact"],
      ["decision_3", "compact"],
    ]);
    expect(held_back).toBe(0);
    expect(tokens_used).toBeLessThanOrEqual(budget);
  });

  it("holds back what does not fit, keeping the served items a prefix", () => {
    // The rule alone passes 60%, so the decisions go compact; one fits.
    const { served, held_back } = fillBudget(items, expanded + compact + 1, 0);
    expect(served.map((i) => [i.id, i.detail])).toEqual([
      ["rule_1", "expanded"],
      ["decision_1", "compact"],
    ]);
    expect(held_back).toBe(2);
  });

  it("serves the first tier even past the budget", () => {
    const { served, held_back } = fillBudget(items, 1, 0);
    expect(served.map((i) => i.id)).toEqual(["rule_1"]);
    expect(held_back).toBe(3);
  });
});

describe("renderBriefText", () => {
  it("prints the synthesis, the tiers in order, the gaps and the budget note", () => {
    const text = renderBriefText({
      brief_id: "brief_1",
      about: "add a brief route",
      touching: ["app/routes/brief.tsx"],
      synthesis: "Obey [rule_1].",
      items: [
        {
          id: "decision_1",
          tier: "decided",
          type: "decision",
          doco: "decisions",
          lifecycle: "active",
          summary: "Keep search hybrid.",
          text: "Keep search hybrid.\nVector plus full text.",
          because: "matches your ask",
          url: "https://doco.to/decisions/decision/decision_1",
          updated_at: null,
          detail: "expanded",
        },
        {
          id: "rule_1",
          tier: "must_obey",
          type: "rule",
          doco: "rules",
          lifecycle: "active",
          summary: "Ship small PRs.",
          text: "Ship small PRs.",
          because: "standing rule",
          url: null,
          updated_at: null,
          detail: "expanded",
        },
      ],
      gaps: ["Nothing in Doco names app/routes/brief.tsx."],
      held_back: 2,
      budget: 400,
      tokens_used: 120,
      steps: {},
      warnings: ["No reranker is configured; order is by rank fusion alone."],
    });
    expect(text).toBe(
      [
        "Doco brief brief_1 · about: add a brief route",
        "Touching: app/routes/brief.tsx",
        "",
        "Obey [rule_1].",
        "",
        "## Must obey",
        "- rule_1 (rules · active) — Ship small PRs.",
        "  because: standing rule",
        "",
        "## Already decided",
        "- decision_1 (decisions · active) — Keep search hybrid.",
        "  because: matches your ask",
        "  Keep search hybrid.",
        "  Vector plus full text.",
        "  https://doco.to/decisions/decision/decision_1",
        "",
        "## Gaps",
        "- Nothing in Doco names app/routes/brief.tsx.",
        "",
        "Cite these ids in what you capture; brief brief_1. 2 more held back by the budget of 400 tokens. No reranker is configured; order is by rank fusion alone.",
      ].join("\n"),
    );
  });
});
