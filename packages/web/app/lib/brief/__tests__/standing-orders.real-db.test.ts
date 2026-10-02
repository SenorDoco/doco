// Standing orders against a real database: the constitution, the active
// rules, a line per readable Doco with what it holds and expects, and what
// changed since the agent last looked, within one workspace.
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../../db/src/__tests__/fresh-db";
import type { BriefClient } from "../brief.server";
import { composeStandingOrders } from "../standing-orders.server";

const ORIGIN = "https://doco.test";
const NOW = new Date("2026-10-02T12:00:00Z");
const DAY = 86_400_000;
let c: BriefClient;

beforeEach(async () => {
  const db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, constitution) VALUES
      ('workspace_1', 'acme', 'Acme', 'Ship small pull requests.'),
      ('workspace_2', 'beta', 'Beta', '');
    INSERT INTO docos (id, handle, owner_id, workspace_id, goal, data) VALUES
      ('doco_dec', 'decisions', 'workspace_1', 'workspace_1', 'What was decided and why.',
         '{"template_handle":"product-decisions"}'::jsonb),
      ('doco_glossary', 'glossary', 'workspace_1', 'workspace_1', '',
         '{"template_handle":"glossary"}'::jsonb),
      ('doco_other', 'other', 'workspace_1', 'workspace_1', 'Odds and ends.', '{}'::jsonb),
      ('doco_beta', 'beta', 'workspace_2', 'workspace_2', '', '{}'::jsonb);
    INSERT INTO policies (id, doco_id, kind, data) VALUES
      ('policy_1', 'doco_dec', 'suggestion',
         '{"predicate":{"agent_instruction":"Name the alternatives that lost."}}'::jsonb),
      ('policy_2', 'doco_dec', 'suggestion',
         '{"predicate":{"agent_instruction":"Cite the intent it serves."}}'::jsonb);
  `);
  const node = async (
    id: string,
    doco: string,
    prose: string,
    opts: { lifecycle?: string; daysAgo?: number } = {},
  ) => {
    const at = new Date(NOW.getTime() - (opts.daysAgo ?? 20) * DAY).toISOString();
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_at, updated_at)
       VALUES ($1, $2, split_part($1, '_', 1), $3, $4, $5, $5)`,
      [id, doco, opts.lifecycle ?? "active", prose, at],
    );
  };
  await node("rule_small", "doco_dec", "Never auto-connect a whole organization.\nAsk first.");
  await node("rule_gone", "doco_dec", "Retired rule.", { lifecycle: "retired" });
  await node("decision_hybrid", "doco_dec", "Keep search hybrid.");
  await node("decision_rerank", "doco_dec", "Move the reranker into the ranking.", {
    lifecycle: "drafting",
    daysAgo: 1,
  });
  await node("decision_cosine", "doco_dec", "Rank by cosine only.", { lifecycle: "retired" });
  await node("idea_brief", "doco_other", "The Doco brief.", { daysAgo: 2 });
  await node("reference_term", "doco_glossary", "Hybrid search\nRanking by meaning and words.");
  await node("rule_beta", "doco_beta", "Beta's rule.", { daysAgo: 1 });
  c = db as unknown as BriefClient;
});

describe("composeStandingOrders", () => {
  it("compiles the constitution, the rules, the Doco map and the changes of one workspace", async () => {
    const orders = await composeStandingOrders(
      c,
      { workspaceId: "workspace_1", origin: ORIGIN, docoIds: null, member: true },
      { now: () => NOW },
    );
    expect(orders?.constitution).toBe("Ship small pull requests.");
    expect(orders?.rules).toEqual([
      {
        id: "rule_small",
        doco: "decisions",
        summary: "Never auto-connect a whole organization.",
        text: "Never auto-connect a whole organization.\nAsk first.",
        url: `${ORIGIN}/decisions/rule/rule_small`,
      },
    ]);
    expect(orders?.docos).toEqual([
      {
        handle: "decisions",
        template: "product-decisions",
        label: "Product decisions",
        items: "2 decisions",
        goal: "What was decided and why.",
        expects: ["Name the alternatives that lost.", "Cite the intent it serves."],
        url: `${ORIGIN}/decisions`,
      },
      {
        handle: "glossary",
        template: "glossary",
        label: "Glossary",
        items: "1 term",
        goal: "",
        expects: [],
        url: `${ORIGIN}/glossary`,
      },
      {
        handle: "other",
        template: null,
        label: "Generic",
        items: "1 node",
        goal: "Odds and ends.",
        expects: [],
        url: `${ORIGIN}/other`,
      },
    ]);
    expect(orders?.changes).toEqual({
      since: "2026-09-25T12:00:00.000Z",
      items: [
        {
          id: "decision_rerank",
          doco: "decisions",
          type: "decision",
          lifecycle: "drafting",
          summary: "Move the reranker into the ranking.",
          updated_at: "2026-10-01T12:00:00.000Z",
          url: `${ORIGIN}/decisions/decision/decision_rerank`,
        },
        {
          id: "idea_brief",
          doco: "other",
          type: "idea",
          lifecycle: "active",
          summary: "The Doco brief.",
          updated_at: "2026-09-30T12:00:00.000Z",
          url: `${ORIGIN}/other/idea/idea_brief`,
        },
      ],
      more: 0,
    });
    expect(orders?.warnings).toEqual([]);
    expect(orders?.text).toBe(
      [
        `Standing orders for Acme (acme) · ${ORIGIN}/workspaces/acme`,
        "",
        "## Constitution",
        "Ship small pull requests.",
        "",
        "## Rules",
        "- rule_small (decisions) — Never auto-connect a whole organization.",
        "  Ask first.",
        "",
        "## Docos",
        "- decisions (Product decisions, 2 decisions): What was decided and why. Expects: Name the alternatives that lost.; Cite the intent it serves.",
        "- glossary (Glossary, 1 term)",
        "- other (Generic, 1 node): Odds and ends.",
        "",
        "## Changed since 2026-09-25 12:00 UTC",
        "- decision_rerank (decisions · drafting) — Move the reranker into the ranking.",
        "- idea_brief (other · active) — The Doco brief.",
      ].join("\n"),
    );
    expect(orders?.tokens).toBeGreaterThan(0);
  });

  it("keeps to the Docos the caller may read, moves the window with since, and names what is missing", async () => {
    const orders = await composeStandingOrders(
      c,
      {
        workspaceId: "workspace_1",
        origin: ORIGIN,
        docoIds: ["doco_glossary", "doco_other"],
        member: false,
      },
      { since: "2026-10-01T00:00:00Z", now: () => NOW },
    );
    // Not a member: the constitution is not theirs to read, and no gap says so.
    expect(orders?.constitution).toBeNull();
    expect(orders?.text).not.toContain("## Constitution");
    expect(orders?.rules).toEqual([]);
    expect(orders?.docos.map((d) => d.handle)).toEqual(["glossary", "other"]);
    expect(orders?.changes.items).toEqual([]);
    expect(orders?.warnings).toEqual(["No active rules in the Docos you can read."]);
    expect(orders?.text).toContain("## Changed since 2026-10-01 00:00 UTC\nNothing.");

    const beta = await composeStandingOrders(
      c,
      { workspaceId: "workspace_2", origin: ORIGIN, docoIds: null, member: true },
      { since: "not a date", now: () => NOW },
    );
    expect(beta?.constitution).toBeNull();
    expect(beta?.rules.map((r) => r.id)).toEqual(["rule_beta"]);
    expect(beta?.changes.items.map((i) => i.id)).toEqual(["rule_beta"]);
    expect(beta?.warnings).toEqual([
      "Ignored since=not a date: not a date.",
      "Workspace Beta has no constitution.",
    ]);
    expect(
      await composeStandingOrders(c, {
        workspaceId: "workspace_none",
        origin: ORIGIN,
        docoIds: null,
        member: true,
      }),
    ).toBeNull();
  });
});
