// The digest's top three: a score shortlists what was added in the period,
// Claude ranks the shortlist and writes one sentence on each, and without a
// model (or when its answer can't be used) the score's order stands, each with
// its first line.
import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  key: "sk-test" as string | null,
  requests: [] as unknown[],
  reply: null as unknown,
}));

vi.mock("~/lib/assistant-runtime.server", () => ({
  getSenorDocoAnthropicApiKey: () => model.key,
  createSenorDocoMessage: async (params: unknown) => {
    model.requests.push(params);
    if (model.reply instanceof Error) throw model.reply;
    return model.reply;
  },
}));

import {
  type Candidate,
  SHORTLIST,
  TOP_THREE_MODEL,
  mergeRanking,
  rankWithModel,
  rankingPrompt,
  shortlist,
} from "../digest-top-three.server";

const candidate = (over: Partial<Candidate> & { id: string }): Candidate => ({
  docoId: "doco_notes",
  docoHandle: "acme-notes",
  nodeType: "decision",
  prose: `${over.id} first line\n\nThe rest of it.`,
  createdAt: "2026-09-10T09:00:00.000Z",
  replaces: false,
  links: 0,
  served: 0,
  ...over,
});

describe("shortlist", () => {
  it("puts rules before decisions before the rest", () => {
    const ids = shortlist([
      candidate({ id: "idea_1", nodeType: "idea" }),
      candidate({ id: "decision_1" }),
      candidate({ id: "rule_1", nodeType: "rule" }),
    ]).map((c) => c.id);
    expect(ids).toEqual(["rule_1", "decision_1", "idea_1"]);
  });

  it("lifts what replaced an earlier record, what briefs served and what records link to", () => {
    const ids = shortlist([
      candidate({ id: "rule_1", nodeType: "rule" }),
      candidate({ id: "decision_replaces", replaces: true }),
      candidate({ id: "idea_served", nodeType: "idea", served: 15 }),
      candidate({ id: "idea_linked", nodeType: "idea", links: 3 }),
      candidate({ id: "idea_plain", nodeType: "idea" }),
    ]).map((c) => c.id);
    expect(ids).toEqual([
      "idea_served",
      "decision_replaces",
      "rule_1",
      "idea_linked",
      "idea_plain",
    ]);
  });

  it("keeps the newest first among equals, and at most the shortlist's size", () => {
    const many = Array.from({ length: SHORTLIST + 5 }, (_, i) =>
      candidate({
        id: `decision_${i}`,
        createdAt: new Date(Date.UTC(2026, 8, 10, i)).toISOString(),
      }),
    );
    const ids = shortlist(many).map((c) => c.id);
    expect(ids).toHaveLength(SHORTLIST);
    expect(ids[0]).toBe(`decision_${SHORTLIST + 4}`);
  });
});

describe("rankingPrompt", () => {
  it("gives each record's id, type, Doco and text", () => {
    const prompt = rankingPrompt("the last 24 hours", [
      candidate({ id: "rule_1", nodeType: "rule", prose: "Ship to main." }),
    ]);
    expect(prompt).toContain("the last 24 hours");
    expect(prompt).toContain("[rule_1 · rule · acme-notes]\nShip to main.");
  });

  it("cuts a long record short", () => {
    const prompt = rankingPrompt("the last 24 hours", [
      candidate({ id: "decision_long", prose: "x".repeat(5000) }),
    ]);
    expect(prompt.length).toBeLessThan(2000);
  });
});

describe("mergeRanking", () => {
  const base = "https://doco.test";
  const items = [
    candidate({ id: "rule_1", nodeType: "rule" }),
    candidate({ id: "decision_1" }),
    candidate({ id: "idea_1", nodeType: "idea", docoHandle: "acme-ideas", docoId: "doco_ideas" }),
  ];

  it("follows the model's order and takeaways, linking each record", () => {
    const ranked = mergeRanking(
      items,
      [
        { id: "idea_1", takeaway: "Ideas now go to the ideas Doco." },
        { id: "rule_1", takeaway: "Everything ships to main." },
        { id: "decision_1", takeaway: "The digest is daily." },
      ],
      base,
    );
    expect(ranked).toEqual([
      {
        id: "idea_1",
        docoId: "doco_ideas",
        docoHandle: "acme-ideas",
        takeaway: "Ideas now go to the ideas Doco.",
        url: "https://doco.test/acme-ideas/idea/idea_1",
      },
      expect.objectContaining({ id: "rule_1", takeaway: "Everything ships to main." }),
      expect.objectContaining({ id: "decision_1", takeaway: "The digest is daily." }),
    ]);
  });

  it("drops ids it wasn't given and repeats, and adds what the model left out with its first line", () => {
    const ranked = mergeRanking(
      items,
      [
        { id: "decision_1", takeaway: "  " },
        { id: "decision_made_up", takeaway: "Nope." },
        { id: "decision_1", takeaway: "Again." },
      ],
      base,
    );
    expect(ranked.map((r) => [r.id, r.takeaway])).toEqual([
      ["decision_1", "decision_1 first line"],
      ["rule_1", "rule_1 first line"],
      ["idea_1", "idea_1 first line"],
    ]);
  });

  it("keeps the score's order and first lines without a model", () => {
    expect(mergeRanking(items, null, base).map((r) => [r.id, r.takeaway])).toEqual([
      ["rule_1", "rule_1 first line"],
      ["decision_1", "decision_1 first line"],
      ["idea_1", "idea_1 first line"],
    ]);
  });
});

describe("rankWithModel", () => {
  const answer = (text: string, stop_reason = "end_turn") => ({
    stop_reason,
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text },
    ],
  });

  beforeEach(() => {
    model.key = "sk-test";
    model.requests = [];
  });

  it("asks Claude for a ranking as JSON and returns it", async () => {
    model.reply = answer(
      JSON.stringify({ items: [{ id: "rule_1", takeaway: "Everything ships to main." }] }),
    );
    expect(await rankWithModel("the prompt")).toEqual([
      { id: "rule_1", takeaway: "Everything ships to main." },
    ]);
    expect(model.requests[0]).toMatchObject({
      model: TOP_THREE_MODEL,
      output_config: { format: { type: "json_schema" } },
      messages: [{ role: "user", content: "the prompt" }],
    });
  });

  it("gives up without a key, on a refusal, on bad JSON and on an error", async () => {
    model.key = null;
    expect(await rankWithModel("p")).toBeNull();
    model.key = "sk-test";
    model.reply = answer("{}", "refusal");
    expect(await rankWithModel("p")).toBeNull();
    model.reply = answer("not json");
    expect(await rankWithModel("p")).toBeNull();
    model.reply = answer(JSON.stringify({ items: [{ id: 7 }] }));
    expect(await rankWithModel("p")).toBeNull();
    model.reply = new Error("overloaded");
    expect(await rankWithModel("p")).toBeNull();
  });
});
