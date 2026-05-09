import { defineCommand } from "citty";
import { reindex } from "@evalo/index";
import { findEvaloRoot } from "../find-root.js";
import { c, checkmark, cross } from "../output.js";

export const reindexCmd = defineCommand({
  meta: {
    name: "reindex",
    description: "Wipe .evalo/ and rebuild the SQLite + FTS5 index from source files.",
  },
  args: {
    root: { type: "string", description: "Path to the Evalo root (default: walk upward from cwd)." },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findEvaloRoot());
    if (!root) {
      console.error(cross("Could not find evalo.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    const report = await reindex(root);
    console.log();
    console.log(checkmark(`Reindexed ${c.bold(String(report.inserted))} entities in ${report.durationMs} ms.`));
    console.log(c.dim(`Cache: ${root}/.evalo/cache.db`));
    console.log();
  },
});
