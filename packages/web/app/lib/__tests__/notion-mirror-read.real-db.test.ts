// Reading the Notion mirror: the Doco home's Notion perspective (the page
// tree, the open page, search) and Notion results in the Doco's search.
// PGlite runs the real schema and full-text search.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadNotionPerspective,
  notionSnippet,
  searchNotionMirror,
} from "../notion-mirror-read.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof loadNotionPerspective>[0];
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
  db = new PGlite();
  await db.exec(schemaSql);
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

describe("loadNotionPerspective", () => {
  it("opens the most recently edited page, with its path, and the tree opened along it", async () => {
    const data = await loadNotionPerspective(c, "doco_notion", {});

    expect(data).toMatchObject({ workspaceName: "Acme", pages: 6, query: "", hits: [] });
    expect(data.page).toMatchObject({
      pageId: R1,
      title: "Ship it",
      lastEditedAt: "2026-09-28T10:00:00.000Z",
      lastEditedBy: null,
    });
    expect(data.page?.path.map((ref) => ref.title)).toEqual(["Handbook", "Tasks"]);

    const [handbook, roadmap] = data.tree;
    expect(handbook).toMatchObject({ title: "Handbook", icon: "📘", hasChildren: true });
    expect(handbook.children?.map((node) => node.title)).toEqual(["Onboarding", "Tasks"]);
    expect(handbook.children?.[0].children).toBeNull();
    const tasks = handbook.children?.[1];
    expect(tasks).toMatchObject({ object: "data_source", hasChildren: true, more: 0 });
    // A data source's rows list newest first; child pages by title.
    expect(tasks?.children?.map((node) => node.title)).toEqual(["Ship it", "Write docs"]);
    expect(roadmap).toMatchObject({ title: "Roadmap", hasChildren: false, children: null });
  });

  it("reads the requested page: its text, editor, links and backlinks", async () => {
    const data = await loadNotionPerspective(c, "doco_notion", { pageId: HB });

    expect(data.page).toMatchObject({
      pageId: HB,
      object: "page",
      title: "Handbook",
      icon: "📘",
      url: url(HB),
      path: [],
      lastEditedBy: "Ana Ruiz",
      truncated: false,
    });
    expect(data.page?.markdown).toContain("# Welcome");
    expect(data.page?.links).toEqual([{ pageId: ONB, title: "Onboarding", icon: null }]);
    expect(data.page?.backlinks).toEqual([{ pageId: ONB, title: "Onboarding", icon: null }]);
    expect(data.tree[0].children?.map((node) => node.title)).toEqual(["Onboarding", "Tasks"]);
    expect(data.tree[0].children?.[1].children).toBeNull();
  });

  it("falls back to the latest page when the requested one isn't mirrored", async () => {
    const data = await loadNotionPerspective(c, "doco_notion", { pageId: UNMIRRORED });
    expect(data.page?.title).toBe("Ship it");
  });

  it("searches every page, giving each hit its path and a snippet around the match", async () => {
    const data = await loadNotionPerspective(c, "doco_notion", { query: "laptop" });

    expect(data.page).toBeNull();
    expect(data.query).toBe("laptop");
    expect(data.hits).toEqual([
      {
        type: "notion_page",
        page_id: ONB,
        title: "Onboarding",
        path: "Handbook",
        url: url(ONB),
        last_edited_time: "2026-09-27T10:00:00.000Z",
        snippet: "Day one: Laptop Badge See Handbook.",
      },
    ]);
    expect(data.tree.map((node) => node.children)).toEqual([null, null]);
  });

  it("is empty for a Doco that doesn't mirror Notion", async () => {
    expect(await loadNotionPerspective(c, "doco_plain", {})).toEqual({
      workspaceName: null,
      pages: 0,
      tree: [],
      moreRoots: 0,
      page: null,
      query: "",
      hits: [],
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
