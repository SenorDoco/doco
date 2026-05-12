import { watch } from "node:fs";
import { defineCommand } from "citty";
import { reindex } from "@doco/index";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

/**
 * `doco watch` — keep the cache in sync with entity files on disk.
 *
 * Watches the entity directories (intents/, ideas/, rules/, decisions/,
 * actions/, reasoning/, references/, scopes/, evaluations/) plus
 * doco.yaml and triggers a full reindex on any change. Debounced so a
 * batch of writes doesn't trigger N reindexes.
 *
 * Per ADR-089 follow-up — pairs with the live Recent feed so new entities
 * surface in the next poll cycle without a manual `doco reindex`.
 */
export const watchCmd = defineCommand({
  meta: {
    name: "watch",
    description: "Reindex on entity-file change (pairs with the live Recent feed).",
  },
  args: {
    root: { type: "string", description: "Doco root (default: walk upward from cwd)." },
    debounce: {
      type: "string",
      description: "Debounce window in milliseconds (default 250).",
      default: "250",
    },
  },
  async run({ args }) {
    const root = (args.root as string | undefined) ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml."));
      process.exitCode = 2;
      return;
    }
    const debounceMs = Math.max(50, Number(args.debounce));

    const watchedDirs = [
      "intents",
      "ideas",
      "rules",
      "decisions",
      "actions",
      "reasoning",
      "references",
      "scopes",
      "evaluations",
    ];

    console.log();
    console.log(header("Doco watch"));
    console.log(rule());
    console.log(checkmark(`Root:      ${c.dim(root)}`));
    console.log(checkmark(`Watching:  ${watchedDirs.join(", ")}, doco.yaml`));
    console.log(checkmark(`Debounce:  ${debounceMs}ms`));
    console.log(rule());
    console.log(c.dim("Reindexes the cache on every entity-file change. Ctrl-C to stop."));
    console.log();

    // Initial reindex so subsequent edits trigger incremental refreshes.
    try {
      const r = await reindex(root);
      console.log(checkmark(`Initial reindex: ${r.inserted} entities in ${r.durationMs}ms`));
    } catch (e) {
      console.error(cross(`Initial reindex failed: ${(e as Error).message}`));
    }

    let timer: NodeJS.Timeout | undefined;
    let pendingPaths = new Set<string>();
    const trigger = (path: string) => {
      pendingPaths.add(path);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const batch = Array.from(pendingPaths);
        pendingPaths = new Set();
        try {
          const r = await reindex(root);
          console.log(
            `${checkmark(`Reindex: ${r.inserted} entities in ${r.durationMs}ms`)}  ${c.dim(`(triggered by ${batch.length} change(s): ${batch.slice(0, 2).join(", ")}${batch.length > 2 ? ", …" : ""})`)}`,
          );
        } catch (e) {
          console.error(cross(`Reindex failed: ${(e as Error).message}`));
        }
      }, debounceMs);
    };

    const watchers: ReturnType<typeof watch>[] = [];
    for (const sub of watchedDirs) {
      try {
        watchers.push(
          watch(`${root}/${sub}`, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            // Only care about entity files we'd actually index.
            if (!filename.match(/\.(md|yaml|yml|json)$/)) return;
            trigger(`${sub}/${filename}`);
          }),
        );
      } catch {
        // Subdir may not exist (e.g., empty Doco). Skip.
      }
    }
    try {
      watchers.push(
        watch(`${root}/doco.yaml`, () => trigger("doco.yaml")),
      );
    } catch {
      // doco.yaml not found — should be unreachable since findDocoRoot succeeded.
    }

    // Keep alive until SIGINT.
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        for (const w of watchers) w.close();
        if (timer) clearTimeout(timer);
        console.log();
        console.log(checkmark("Stopped."));
        resolve();
      });
    });
  },
});
