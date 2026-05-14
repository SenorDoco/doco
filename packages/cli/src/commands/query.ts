import { defineCommand } from "citty";
import { withClient } from "@doco/db";
import { cross } from "../output.js";

/**
 * Run a read-only SQL query against the Doco's Postgres database.
 * Statements run inside a transaction that's rolled back at the end —
 * no accidental writes from a typo'd query.
 */
export const queryCmd = defineCommand({
  meta: {
    name: "query",
    description: "Run a read-only SQL query against the Doco's Postgres database. Returns JSON rows.",
  },
  args: {
    sql: {
      type: "positional",
      description: "SQL statement (read-only).",
      required: false,
    },
    tables: {
      type: "boolean",
      description: "List Postgres tables and column schemas instead of running a query.",
      default: false,
    },
  },
  async run({ args }) {
    try {
      await withClient(async (c) => {
        if (args.tables) {
          const tables = (
            await c.query<{ table_name: string }>(
              `SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public'
                ORDER BY table_name`,
            )
          ).rows;
          for (const t of tables) {
            console.log(t.table_name);
            const cols = (
              await c.query<{ column_name: string; data_type: string }>(
                `SELECT column_name, data_type FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = $1
                  ORDER BY ordinal_position`,
                [t.table_name],
              )
            ).rows;
            for (const col of cols) {
              console.log(`  ${col.column_name.padEnd(22)} ${col.data_type}`);
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
        await c.query("BEGIN READ ONLY");
        try {
          const r = await c.query(sql);
          const elapsed = performance.now() - start;
          console.log(JSON.stringify(r.rows, null, 2));
          console.error(`-- ${r.rows.length} row(s) in ${elapsed.toFixed(2)} ms`);
        } finally {
          await c.query("ROLLBACK");
        }
      });
    } catch (err) {
      console.error(cross(`Query failed: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  },
});
