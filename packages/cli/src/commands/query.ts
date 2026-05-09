import { defineCommand } from "citty";
import { openDb } from "@evalo/index";
import { findEvaloRoot } from "../find-root.js";
import { c, cross } from "../output.js";

export const queryCmd = defineCommand({
  meta: {
    name: "query",
    description: "Run a SQL query against the local index. Returns JSON rows.",
  },
  args: {
    sql: {
      type: "positional",
      description: "SQL statement (read-only). Use 'evalo query --tables' to list available tables.",
      required: false,
    },
    root: { type: "string", description: "Path to the Evalo root (default: walk upward from cwd)." },
    tables: {
      type: "boolean",
      description: "List the index's tables and column schemas instead of running a query.",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Pretty-print as JSON (default).",
      default: true,
    },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findEvaloRoot());
    if (!root) {
      console.error(cross("Could not find evalo.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    const db = await openDb(root, { readonly: true, fileMustExist: true });
    try {
      if (args.tables) {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%' ORDER BY name",
          )
          .all() as { name: string }[];
        for (const t of tables) {
          const cols = db.prepare(`PRAGMA table_info('${t.name}')`).all() as { name: string; type: string }[];
          console.log(c.bold(t.name));
          for (const col of cols) {
            console.log(`  ${col.name.padEnd(22)} ${c.dim(col.type)}`);
          }
          console.log();
        }
        return;
      }

      const sql = args.sql as string | undefined;
      if (!sql) {
        console.error(cross("Provide a SQL statement or pass --tables to list tables."));
        process.exitCode = 2;
        return;
      }

      const start = performance.now();
      const rows = db.prepare(sql).all();
      const elapsed = performance.now() - start;
      console.log(JSON.stringify(rows, null, 2));
      console.error(c.dim(`-- ${rows.length} row(s) in ${elapsed.toFixed(2)} ms`));
    } catch (err) {
      console.error(cross(`Query failed: ${(err as Error).message}`));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  },
});
