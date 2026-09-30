// Reading a codebase Doco's copy: browsing a repository's folders and files,
// and searching paths and contents. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCodePerspective, searchCodebase } from "../codebase-read.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
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
       ('doco_other', 'acme-other', 'workspace_acme', 'workspace_acme', 'private', $1)`,
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
       ('doco_other', 'acme/app', 'src/billing/invoice.ts', 'c1', 20, 'totalInvoice', NULL)`,
  );
});

describe("searchCodebase", () => {
  it("finds files by what they contain, pointing at the line", async () => {
    const hits = await searchCodebase(db, "doco_code", "totalInvoice", 10);
    expect(hits).toEqual([
      {
        type: "code_file",
        repo: "acme/app",
        path: "src/billing/invoice.ts",
        url: "https://github.com/acme/app/blob/HEAD/src/billing/invoice.ts",
        snippet: "export function totalInvoice(lines) {",
        line: 3,
      },
    ]);
  });

  it("finds files by path, those ahead of files that only mention the words", async () => {
    const hits = await searchCodebase(db, "doco_code", "tax", 10);
    expect(hits.map((h) => [h.path, h.line])).toEqual([
      ["src/billing/tax.ts", 1],
      ["src/billing/invoice.ts", 1],
    ]);
  });

  it("finds nothing for an empty query", async () => {
    expect(await searchCodebase(db, "doco_code", "  ", 10)).toEqual([]);
  });
});

describe("loadCodePerspective", () => {
  it("opens the first repository's root, folders first", async () => {
    const data = await loadCodePerspective(db, "doco_code", {});
    expect(data.repos).toEqual([
      { repo: "acme/api", files: 1 },
      { repo: "acme/app", files: 5 },
    ]);
    expect(data.repo).toBe("acme/api");
    expect(data.entries).toEqual([{ name: "main.go", path: "main.go", kind: "file" }]);
  });

  it("lists a folder of the chosen repository", async () => {
    const data = await loadCodePerspective(db, "doco_code", { repo: "acme/app", path: "src" });
    expect(data.dir).toBe("src");
    expect(data.entries).toEqual([
      { name: "billing", path: "src/billing", kind: "dir" },
      { name: "index.ts", path: "src/index.ts", kind: "file" },
    ]);
    expect(data.file).toBeNull();
  });

  it("opens a file beside the rest of its folder", async () => {
    const data = await loadCodePerspective(db, "doco_code", {
      repo: "acme/app",
      path: "src/billing/tax.ts",
    });
    expect(data.dir).toBe("src/billing");
    expect(data.entries.map((e) => e.name)).toEqual(["invoice.ts", "tax.ts"]);
    expect(data.file).toMatchObject({
      path: "src/billing/tax.ts",
      content: "export const tax = (l) => l;",
      omitted: null,
      url: "https://github.com/acme/app/blob/HEAD/src/billing/tax.ts",
    });
  });

  it("falls back to the root for a folder the copy doesn't have", async () => {
    const data = await loadCodePerspective(db, "doco_code", { repo: "acme/app", path: "nope" });
    expect(data.dir).toBe("");
    expect(data.entries.map((e) => e.name)).toEqual(["src", "logo.png", "README.md"]);
  });

  it("searches instead while there is a query", async () => {
    const data = await loadCodePerspective(db, "doco_code", { query: "package" });
    expect(data.query).toBe("package");
    expect(data.hits.map((h) => h.path)).toEqual(["main.go"]);
  });

  it("is empty for a Doco that copies no code", async () => {
    const data = await loadCodePerspective(db, "doco_missing", {});
    expect(data).toMatchObject({ repos: [], repo: null, entries: [], file: null });
  });
});
