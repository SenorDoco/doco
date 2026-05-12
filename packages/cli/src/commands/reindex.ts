import { defineCommand } from "citty";
import { reindex } from "@doco/index";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross } from "../output.js";

export const reindexCmd = defineCommand({
  meta: {
    name: "reindex",
    description: "Wipe .doco/ and rebuild the SQLite + FTS5 index from source files.",
  },
  args: {
    root: { type: "string", description: "Path to the Doco root (default: walk upward from cwd)." },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    const report = await reindex(root);
    console.log();
    console.log(checkmark(`Reindexed ${c.bold(String(report.inserted))} entities in ${report.durationMs} ms.`));
    console.log(c.dim(`Cache: ${root}/.doco/cache.db`));
    console.log();
  },
});
