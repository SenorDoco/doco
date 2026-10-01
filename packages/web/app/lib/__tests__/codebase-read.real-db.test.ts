// Reading a codebase Doco's copy: the reader's tree, folders and files, finding
// a file by name, and searching paths and contents. PGlite runs the real schema.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  codeTreeAt,
  findCodeFiles,
  listCodeTree,
  loadCodeView,
  searchCodebase,
} from "../codebase-read.server";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  const data = JSON.stringify({
    template_handle: "codebase",
    github_integration: {
      connections: [
        { repo: "acme/app", installation_id: 9 },
        { repo: "acme/api", installation_id: 9 },
      ],
    },
  });
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
       ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme', 'private', $1),
       ('doco_other', 'acme-other', 'workspace_acme', 'workspace_acme', 'private', $1),
       ('doco_many', 'acme-many', 'workspace_acme', 'workspace_acme', 'private', $1)`,
    [data],
  );
  await db.query(
    `INSERT INTO code_files (doco_id, repo, path, sha, size, content, omitted) VALUES
       ('doco_code', 'acme/app', 'README.md', 'a1', 10, '# App', NULL),
       ('doco_code', 'acme/app', 'src/billing/invoice.ts', 'a2', 60,
         E'import { tax } from "./tax";\\n\\nexport function totalInvoice(lines) {\\n  return tax(lines);\\n}', NULL),
       ('doco_code', 'acme/app', 'src/billing/tax.ts', 'a3', 30, 'export const tax = (l) => l;', NULL),
       ('doco_code', 'acme/app', 'src/index.ts', 'a4', 20, 'export * from "./billing/invoice";', NULL),
       ('doco_code', 'acme/app', 'logo.png', 'a5', 900, '', 'binary'),
       ('doco_code', 'acme/api', 'main.go', 'b1', 12, 'package main', NULL),
       ('doco_other', 'acme/app', 'src/billing/invoice.ts', 'c1', 20, 'totalInvoice', NULL),
       ('doco_many', 'acme/app', 'notes.txt', 'd1', 40,
         E'fee one\\nfee two\\nnothing\\nfee three\\nfee four\\nfee five', NULL)`,
  );
});

const repoItem = (id: string, files: number) => ({
  id,
  name: id,
  kind: "repo",
  icon: null,
  hasChildren: true,
  files,
  pending: false,
  where: "",
});

describe("searchCodebase", () => {
  it("finds files by what they contain, with the lines that name the term", async () => {
    const hits = await searchCodebase(db, "doco_code", "totalInvoice", 10);
    expect(hits).toEqual([
      {
        type: "code_file",
        repo: "acme/app",
        path: "src/billing/invoice.ts",
        url: "https://github.com/acme/app/blob/HEAD/src/billing/invoice.ts",
        matches: [{ line: 3, text: "export function totalInvoice(lines) {" }],
        matchCount: 1,
      },
    ]);
  });

  it("finds files by path, those ahead of files that only mention the words", async () => {
    const hits = await searchCodebase(db, "doco_code", "tax", 10);
    expect(hits.map((h) => [h.path, h.matches.map((m) => m.line), h.matchCount])).toEqual([
      ["src/billing/tax.ts", [1], 1],
      ["src/billing/invoice.ts", [1, 4], 2],
    ]);
  });

  it("keeps a file's first three matching lines and counts them all", async () => {
    const [hit] = await searchCodebase(db, "doco_many", "fee", 10);
    expect(hit.matches).toEqual([
      { line: 1, text: "fee one" },
      { line: 2, text: "fee two" },
      { line: 4, text: "fee three" },
    ]);
    expect(hit.matchCount).toBe(5);
  });

  it("finds nothing for an empty query", async () => {
    expect(await searchCodebase(db, "doco_code", "  ", 10)).toEqual([]);
  });
});

describe("listCodeTree", () => {
  it("lists the repositories at the root, with their file counts", async () => {
    expect(await listCodeTree(db, "doco_code", "")).toEqual({
      items: [repoItem("acme/api", 1), repoItem("acme/app", 5)],
      more: 0,
    });
  });

  it("lists a folder's folders first, then its files, each folder with its file count", async () => {
    const { items } = await listCodeTree(db, "doco_code", "acme/app");
    expect(items.map((i) => [i.id, i.name, i.kind, i.hasChildren, i.files])).toEqual([
      ["acme/app/src", "src", "dir", true, 3],
      ["acme/app/logo.png", "logo.png", "file", false, null],
      ["acme/app/README.md", "README.md", "file", false, null],
    ]);
    const sub = await listCodeTree(db, "doco_code", "acme/app/src/billing");
    expect(sub.items.map((i) => i.id)).toEqual([
      "acme/app/src/billing/invoice.ts",
      "acme/app/src/billing/tax.ts",
    ]);
  });

  it("is empty under a file, or a folder the copy doesn't have", async () => {
    expect(await listCodeTree(db, "doco_code", "acme/app/src/index.ts")).toEqual({
      items: [],
      more: 0,
    });
    expect(await listCodeTree(db, "doco_code", "acme/app/nope")).toEqual({ items: [], more: 0 });
    expect(await listCodeTree(db, "doco_code", "acme")).toEqual({ items: [], more: 0 });
  });
});

describe("codeTreeAt", () => {
  it("lists the top and every folder down to the open file, which has nothing under it", async () => {
    const tree = await codeTreeAt(db, "doco_code", "acme/app/src/billing/tax.ts");
    expect(Object.keys(tree)).toEqual(["", "acme/app", "acme/app/src", "acme/app/src/billing"]);
    expect(tree["acme/app/src/billing"].items.map((i) => i.name)).toEqual(["invoice.ts", "tax.ts"]);
  });

  it("lists just the top at the reader's home, or for a path the copy doesn't have", async () => {
    expect(Object.keys(await codeTreeAt(db, "doco_code", ""))).toEqual([""]);
    expect(Object.keys(await codeTreeAt(db, "doco_code", "acme/nope/x"))).toEqual([""]);
  });
});

describe("findCodeFiles", () => {
  it("finds files by name, those whose name starts with the words first", async () => {
    const items = await findCodeFiles(db, "doco_code", "in", 10);
    expect(items.map((i) => [i.id, i.name, i.where])).toEqual([
      ["acme/app/src/index.ts", "index.ts", "acme/app/src"],
      ["acme/app/src/billing/invoice.ts", "invoice.ts", "acme/app/src/billing"],
      ["acme/api/main.go", "main.go", "acme/api"],
      ["acme/app/src/billing/tax.ts", "tax.ts", "acme/app/src/billing"],
    ]);
    expect(items[0]).toMatchObject({ kind: "file", hasChildren: false, pending: false });
  });

  it("needs every word somewhere in the path", async () => {
    const items = await findCodeFiles(db, "doco_code", "billing tax", 10);
    expect(items.map((i) => i.id)).toEqual(["acme/app/src/billing/tax.ts"]);
  });

  it("finds nothing for an empty query", async () => {
    expect(await findCodeFiles(db, "doco_code", " ", 10)).toEqual([]);
  });
});

describe("loadCodeView", () => {
  it("opens a Doco with several repositories on the list of them", async () => {
    expect(await loadCodeView(db, "doco_code", { id: "", query: "" })).toEqual({
      view: "repos",
      repos: [repoItem("acme/api", 1), repoItem("acme/app", 5)],
      trail: [],
    });
  });

  it("opens a Doco with one repository on that repository's root", async () => {
    const view = await loadCodeView(db, "doco_other", { id: "", query: "" });
    expect(view).toMatchObject({ view: "folder", repo: "acme/app", dir: "", trail: ["acme/app"] });
  });

  it("opens a folder on its entries and its README", async () => {
    const view = await loadCodeView(db, "doco_code", { id: "acme/app", query: "" });
    expect(view).toMatchObject({
      view: "folder",
      repo: "acme/app",
      dir: "",
      more: 0,
      readme: { path: "README.md", markdown: "# App" },
      trail: ["acme/app"],
    });
    if (view?.view !== "folder") throw new Error("expected a folder");
    expect(view.entries.map((e) => e.name)).toEqual(["src", "logo.png", "README.md"]);

    const sub = await loadCodeView(db, "doco_code", { id: "acme/app/src", query: "" });
    expect(sub).toMatchObject({ view: "folder", dir: "src", readme: null });
    expect(sub?.trail).toEqual(["acme/app", "acme/app/src"]);
  });

  it("opens a file with its lines colored", async () => {
    const view = await loadCodeView(db, "doco_code", {
      id: "acme/app/src/billing/tax.ts",
      query: "",
    });
    expect(view).toMatchObject({
      view: "file",
      file: {
        repo: "acme/app",
        path: "src/billing/tax.ts",
        url: "https://github.com/acme/app/blob/HEAD/src/billing/tax.ts",
        size: 30,
        omitted: null,
      },
      markdown: null,
      trail: ["acme/app", "acme/app/src", "acme/app/src/billing", "acme/app/src/billing/tax.ts"],
    });
    if (view?.view !== "file") throw new Error("expected a file");
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0][0]).toEqual(["k", "export"]);
    expect(view.file).not.toHaveProperty("content");
  });

  it("keeps a Markdown file's text for its preview", async () => {
    const view = await loadCodeView(db, "doco_code", { id: "acme/app/README.md", query: "" });
    expect(view).toMatchObject({ view: "file", markdown: "# App" });
  });

  it("shows a file the copy keeps by name only without lines", async () => {
    const view = await loadCodeView(db, "doco_code", { id: "acme/app/logo.png", query: "" });
    expect(view).toMatchObject({ view: "file", file: { omitted: "binary" }, lines: [] });
  });

  it("searches instead while there is a query", async () => {
    const view = await loadCodeView(db, "doco_code", { id: "acme/app/src", query: " package " });
    expect(view).toMatchObject({ view: "search", query: "package", trail: [] });
    if (view?.view !== "search") throw new Error("expected a search");
    expect(view.hits.map((h) => h.path)).toEqual(["main.go"]);
  });

  it("is null for a path the copy doesn't have", async () => {
    expect(await loadCodeView(db, "doco_code", { id: "acme/app/nope", query: "" })).toBeNull();
    expect(await loadCodeView(db, "doco_code", { id: "acme/nope", query: "" })).toBeNull();
    expect(await loadCodeView(db, "doco_code", { id: "acme", query: "" })).toBeNull();
  });

  it("is an empty list of repositories for a Doco that copies no code", async () => {
    expect(await loadCodeView(db, "doco_missing", { id: "", query: "" })).toEqual({
      view: "repos",
      repos: [],
      trail: [],
    });
  });
});
