// Reading the Notion mirror: the reader's page tree, finding pages by title, its home,
// each page, search, and Notion results in the Doco's search.
// PGlite runs the real schema and full-text search.
import { vectorLiteral } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  findPages,
  listPageTree,
  loadPagesView,
  notionSnippet,
  pageTreeAt,
  searchNotionMirror,
} from "../notion-mirror-read.server";

type Client = Parameters<typeof loadPagesView>[0];
let db: PGlite;
let c: Client;

const HB = "11111111-0000-4000-8000-000000000001";
const ONB = "11111111-0000-4000-8000-000000000002";
const DS = "22222222-0000-4000-8000-000000000001";
const R1 = "22222222-0000-4000-8000-000000000002";
const R2 = "22222222-0000-4000-8000-000000000003";
const RM = "33333333-0000-4000-8000-000000000001";
const UNMIRRORED = "99999999-0000-4000-8000-000000000009";
const url = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

async function seedPage(row: {
  id: string;
  object?: "page" | "data_source";
  parent: string | null;
  parentType: string;
  title: string;
  icon?: string;
  markdown: string;
  plain: string;
  edited: string;
  editedBy?: string;
}) {
  await db.query(
    `INSERT INTO notion_pages
       (doco_id, page_id, object, parent_id, parent_type, title, icon, url, markdown, plain_text,
        last_edited_time, last_edited_by, fetch_pending, synced_at)
     VALUES ('doco_notion', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, now())`,
    [
      row.id,
      row.object ?? "page",
      row.parent,
      row.parentType,
      row.title,
      row.icon ?? null,
      url(row.id),
      row.markdown,
      row.plain,
      row.edited,
      row.editedBy ?? null,
    ],
  );
}

beforeEach(async () => {
  db = await freshDb();
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_notion', 'acme-notion', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_plain', 'acme-notes', 'workspace_1', 'workspace_1', '{}'::jsonb);
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_notion', 'ws_acme', 'Acme', 'bot_1', 'encrypted', now());
    INSERT INTO notion_users (doco_id, user_id, name) VALUES ('doco_notion', 'u_ana', 'Ana Ruiz');
  `);
  await seedPage({
    id: HB,
    parent: null,
    parentType: "workspace",
    title: "Handbook",
    icon: "📘",
    markdown: `# Welcome\n\nStart with <page url="${url(ONB)}">Onboarding</page>.`,
    plain: "Welcome\n\nStart with Onboarding.",
    edited: "2026-09-20T10:00:00Z",
    editedBy: "u_ana",
  });
  await seedPage({
    id: ONB,
    parent: HB,
    parentType: "page",
    title: "Onboarding",
    markdown: `Day one:\n\n- [ ] Laptop\n- [x] Badge\n\nSee [Handbook](${url(HB)}).`,
    plain: "Day one:\n\nLaptop\nBadge\n\nSee Handbook.",
    edited: "2026-09-27T10:00:00Z",
    editedBy: "u_ana",
  });
  await seedPage({
    id: DS,
    object: "data_source",
    parent: HB,
    parentType: "page",
    title: "Tasks",
    markdown:
      "What the team is doing.\n\nProperties:\n- **Name**: title\n- **Status**: status (Todo, Done)",
    plain: "What the team is doing.\n\nProperties:\nName: title\nStatus: status (Todo, Done)",
    edited: "2026-09-21T10:00:00Z",
  });
  await seedPage({
    id: R1,
    parent: DS,
    parentType: "data_source",
    title: "Ship it",
    markdown: "**Name:** Ship it · **Status:** Done\n\nDetails of the task.",
    plain: "Name: Ship it · Status: Done\n\nDetails of the task.",
    edited: "2026-09-28T10:00:00Z",
    editedBy: "u_bob",
  });
  await seedPage({
    id: R2,
    parent: DS,
    parentType: "data_source",
    title: "Write docs",
    markdown: "**Name:** Write docs · **Status:** Todo\n\nWrite the docs for the task runner.",
    plain: "Name: Write docs · Status: Todo\n\nWrite the docs for the task runner.",
    edited: "2026-09-25T10:00:00Z",
  });
  await seedPage({
    id: RM,
    parent: UNMIRRORED,
    parentType: "page",
    title: "Roadmap",
    markdown: "Q4 plans.",
    plain: "Q4 plans.",
    edited: "2026-09-22T10:00:00Z",
  });
  await db.exec(`
    INSERT INTO notion_links (doco_id, from_page_id, to_page_id) VALUES
      ('doco_notion', '${HB}', '${ONB}'),
      ('doco_notion', '${ONB}', '${HB}');
  `);
});

const page = (
  id: string,
  name: string,
  extra: Partial<{
    kind: string;
    icon: string | null;
    hasChildren: boolean;
    pending: boolean;
    where: string;
  }> = {},
) => ({
  id,
  name,
  kind: "page",
  icon: null,
  hasChildren: false,
  files: null,
  pending: false,
  where: "",
  ...extra,
});

const BLANK = "00000000-0000-4000-8000-000000000001";
const seedUntitled = () =>
  seedPage({
    id: BLANK,
    parent: UNMIRRORED,
    parentType: "page",
    title: "",
    markdown: "",
    plain: "",
    edited: "2022-08-05T00:46:00Z",
  });

describe("listPageTree", () => {
  it("lists the pages whose parent isn't in the copy at the root, by title", async () => {
    expect(await listPageTree(c, "doco_notion", "")).toEqual({
      items: [page(HB, "Handbook", { icon: "📘", hasChildren: true }), page(RM, "Roadmap")],
      more: 0,
    });
  });

  it("lists untitled pages after the titled ones", async () => {
    await seedUntitled();
    expect((await listPageTree(c, "doco_notion", "")).items.map((i) => i.name)).toEqual([
      "Handbook",
      "Roadmap",
      "",
    ]);
  });

  it("lists a page's children by title, and a database's rows newest first", async () => {
    expect((await listPageTree(c, "doco_notion", HB)).items).toEqual([
      page(ONB, "Onboarding"),
      page(DS, "Tasks", { kind: "database", hasChildren: true }),
    ]);
    expect((await listPageTree(c, "doco_notion", DS)).items.map((i) => i.name)).toEqual([
      "Ship it",
      "Write docs",
    ]);
  });

  it("is empty under a page without children, or one the copy doesn't have", async () => {
    expect(await listPageTree(c, "doco_notion", ONB)).toEqual({ items: [], more: 0 });
    expect(await listPageTree(c, "doco_notion", UNMIRRORED)).toEqual({ items: [], more: 0 });
  });
});

describe("pageTreeAt", () => {
  it("lists the top and every page down to the open one, which has nothing under it", async () => {
    const tree = await pageTreeAt(c, "doco_notion", R1);
    expect(Object.keys(tree)).toEqual(["", HB, DS]);
    expect(tree[DS].items.map((i) => i.name)).toEqual(["Ship it", "Write docs"]);
  });

  it("lists the open page's children when it has some", async () => {
    expect(Object.keys(await pageTreeAt(c, "doco_notion", HB))).toEqual(["", HB]);
  });

  it("lists just the top at the home, or for a page the copy doesn't have", async () => {
    expect(Object.keys(await pageTreeAt(c, "doco_notion", ""))).toEqual([""]);
    expect(Object.keys(await pageTreeAt(c, "doco_notion", "nope"))).toEqual([""]);
  });
});

describe("findPages", () => {
  it("finds pages by title, those starting with the words first, each with where it lives", async () => {
    expect(await findPages(c, "doco_notion", "o", 10)).toEqual([
      page(ONB, "Onboarding", { where: "Handbook" }),
      page(HB, "Handbook", { icon: "📘", hasChildren: true }),
      page(RM, "Roadmap"),
      page(R2, "Write docs", { where: "Handbook / Tasks" }),
    ]);
  });

  it("finds nothing for an empty query", async () => {
    expect(await findPages(c, "doco_notion", " ", 10)).toEqual([]);
  });
});

describe("loadPagesView", () => {
  it("opens on the pages edited most recently and the top-level pages", async () => {
    const view = await loadPagesView(c, "doco_notion", { pageId: "", query: "" });
    if (view?.view !== "home") throw new Error("expected the home");
    expect(view.trail).toEqual([]);
    expect(view.recent.map((p) => [p.title, p.where, p.lastEditedBy])).toEqual([
      ["Ship it", "Handbook / Tasks", null],
      ["Onboarding", "Handbook", "Ana Ruiz"],
      ["Write docs", "Handbook / Tasks", null],
      ["Roadmap", "", null],
      ["Tasks", "Handbook", null],
      ["Handbook", "", "Ana Ruiz"],
    ]);
    expect(view.recent[0]).toMatchObject({
      pageId: R1,
      lastEditedAt: "2026-09-28T10:00:00.000Z",
      copied: true,
    });
    expect(view.top.map((p) => [p.title, p.children])).toEqual([
      ["Handbook", 2],
      ["Roadmap", 0],
    ]);
  });

  it("lists untitled top-level pages after the titled ones", async () => {
    await seedUntitled();
    const view = await loadPagesView(c, "doco_notion", { pageId: "", query: "" });
    if (view?.view !== "home") throw new Error("expected the home");
    expect(view.top.map((p) => p.title)).toEqual(["Handbook", "Roadmap", ""]);
  });

  it("reads a page: its path, text, editor, links and backlinks", async () => {
    const view = await loadPagesView(c, "doco_notion", { pageId: ONB, query: "" });
    if (view?.view !== "page") throw new Error("expected a page");
    expect(view.trail).toEqual([HB, ONB]);
    expect(view.page).toMatchObject({
      pageId: ONB,
      object: "page",
      title: "Onboarding",
      url: url(ONB),
      path: [{ pageId: HB, title: "Handbook", icon: "📘", copied: true }],
      lastEditedBy: "Ana Ruiz",
      truncated: false,
    });
    expect(view.page.markdown).toContain("Day one:");
    expect(view.page.links).toEqual([{ pageId: HB, title: "Handbook", icon: "📘", copied: true }]);
    expect(view.page.backlinks).toEqual([
      { pageId: HB, title: "Handbook", icon: "📘", copied: true },
    ]);
  });

  it("is null for a page the copy doesn't have", async () => {
    expect(await loadPagesView(c, "doco_notion", { pageId: UNMIRRORED, query: "" })).toBeNull();
  });

  it("searches every page, giving each hit its path and a snippet around the match", async () => {
    const view = await loadPagesView(c, "doco_notion", { pageId: ONB, query: " laptop " });

    expect(view).toEqual({
      view: "search",
      query: "laptop",
      trail: [],
      hits: [
        {
          type: "notion_page",
          page_id: ONB,
          title: "Onboarding",
          path: "Handbook",
          url: url(ONB),
          last_edited_time: "2026-09-27T10:00:00.000Z",
          snippet: "Day one: Laptop Badge See Handbook.",
          copied: true,
        },
      ],
    });
  });

  it("resolves the pages a page's text names from the text itself, in Notion's own URL form", async () => {
    const NOTES = "55555555-0000-4000-8000-000000000001";
    // No notion_links row for this page: copied before links were recorded.
    await seedPage({
      id: NOTES,
      parent: null,
      parentType: "workspace",
      title: "Notes",
      markdown: `See <page url="https://app.notion.com/p/Onboarding-${ONB.replace(/-/g, "")}">Onboarding</page>.`,
      plain: "See Onboarding.",
      edited: "2026-09-23T10:00:00Z",
    });

    const view = await loadPagesView(c, "doco_notion", { pageId: NOTES, query: "" });

    expect(view?.view === "page" && view.page.links).toEqual([
      { pageId: ONB, title: "Onboarding", icon: null, copied: true },
    ]);
  });

  it("knows a queued page by its title and place, but not its content, until it is copied", async () => {
    const QUEUED = "44444444-0000-4000-8000-000000000001";
    await db.query(
      `INSERT INTO notion_pages
         (doco_id, page_id, object, parent_id, parent_type, title, url, fetch_pending, fetch_reason)
       VALUES ('doco_notion', $1, 'page', $2, 'page', 'Manifesto', $3, true, 'child')`,
      [QUEUED, HB, url(QUEUED)],
    );

    const view = await loadPagesView(c, "doco_notion", { pageId: QUEUED, query: "" });

    expect(view).toMatchObject({
      view: "page",
      page: { pageId: QUEUED, title: "Manifesto", copied: false, markdown: "" },
    });
    expect(
      (await listPageTree(c, "doco_notion", HB)).items.map((i) => [i.name, i.pending]),
    ).toEqual([
      ["Manifesto", true],
      ["Onboarding", false],
      ["Tasks", false],
    ]);
    const home = await loadPagesView(c, "doco_notion", { pageId: "", query: "" });
    expect(home?.view === "home" && home.recent.map((p) => p.title)).not.toContain("Manifesto");
    const hits = await searchNotionMirror(c, "doco_notion", "manifesto", 10);
    expect(hits.map((hit) => [hit.title, hit.copied])).toEqual([["Manifesto", false]]);
  });

  it("opens an empty home for a Doco that doesn't mirror Notion", async () => {
    expect(await loadPagesView(c, "doco_plain", { pageId: "", query: "" })).toEqual({
      view: "home",
      recent: [],
      top: [],
      trail: [],
    });
  });
});

describe("searchNotionMirror", () => {
  it("returns matching pages, best match first, then newest", async () => {
    const hits = await searchNotionMirror(c, "doco_notion", "task", 10);

    expect(hits.map((hit) => [hit.title, hit.path])).toEqual([
      ["Ship it", "Handbook / Tasks"],
      ["Write docs", "Handbook / Tasks"],
    ]);
    expect(hits[0].snippet).toContain("Details of the task.");
  });

  it("finds nothing in a Doco that doesn't mirror Notion, or for an empty query", async () => {
    expect(await searchNotionMirror(c, "doco_plain", "task", 10)).toEqual([]);
    expect(await searchNotionMirror(c, "doco_notion", "  ", 10)).toEqual([]);
  });
});

describe("notionSnippet", () => {
  it("opens the text when no term matches", () => {
    expect(notionSnippet("short text", "zzz")).toBe("short text");
  });

  it("cuts around the first matching term, on word boundaries", () => {
    const text = `${"word ".repeat(60)}needle here ${"tail ".repeat(60)}`;
    const snippet = notionSnippet(text, "needle", 60);
    expect(snippet).toMatch(/^…word/);
    expect(snippet).toContain("needle here");
    expect(snippet).toMatch(/tail…$/);
    expect(snippet.length).toBeLessThanOrEqual(64);
  });

  it("collapses whitespace", () => {
    expect(notionSnippet("a\n\n  b", "b")).toBe("a b");
  });
});

describe("search with a query embedding", () => {
  const MODEL = "test:model";
  async function embed(pageId: string, chunk: string, axis: number[], model = MODEL) {
    await db.query(
      `INSERT INTO embeddings
         (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('doco_notion', 'notion', $1, 0, $2, 'h', $3, $4::vector)`,
      [pageId, model, chunk, vectorLiteral(axis)],
    );
  }

  it("fuses the nearest chunks with the word matches; a chunk hit shows its chunk", async () => {
    await embed(RM, "Roadmap\n\nQ4 plans.", [0, 1, 0]);
    await embed(R2, "Write docs\n\nWrite the docs for the task runner.", [1, 0, 0]);
    // Another model's vectors are not comparable: this one never ranks.
    await embed(ONB, "Onboarding\n\nDay one.", [0, 1, 0], "other:model");

    const hits = await searchNotionMirror(c, "doco_notion", "task", 10, {
      queryEmbedding: [0, 1, 0],
      modelId: MODEL,
    });

    expect(hits.map((hit) => [hit.title, hit.snippet])).toEqual([
      ["Write docs", "Write the docs for the task runner."],
      ["Ship it", expect.stringContaining("Details of the task.")],
      ["Roadmap", "Q4 plans."],
    ]);
  });

  it("ranks the reader's search the same way", async () => {
    await embed(RM, "Roadmap\n\nQ4 plans.", [0, 1, 0]);

    const view = await loadPagesView(c, "doco_notion", {
      pageId: "",
      query: "task",
      semantic: { queryEmbedding: [0, 1, 0], modelId: MODEL },
    });

    expect(view?.view === "search" && view.hits.map((hit) => hit.title)).toEqual([
      "Ship it",
      "Roadmap",
      "Write docs",
    ]);
  });
});
