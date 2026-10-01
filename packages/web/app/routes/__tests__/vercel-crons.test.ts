// Vercel builds this project from packages/web (its Root Directory) and reads
// vercel.json from there only: cron jobs listed anywhere else are never
// registered, and silently never run.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Vercel cron jobs", () => {
  it("are scheduled in the vercel.json Vercel reads", () => {
    const config = JSON.parse(readFileSync(join(webRoot, "vercel.json"), "utf8")) as {
      crons?: { path: string }[];
    };
    expect(config.crons?.map((cron) => cron.path).sort()).toEqual([
      "/admin/agent-health-cron",
      "/admin/purge-deleted-docos",
      "/api/alerts/silence-check",
      "/api/embeddings/sweep",
      "/api/github/backfill-sweep",
      "/api/notion/mirror-sync",
      "/api/slack/mirror-sync",
    ]);
  });

  it("have no second vercel.json at the repository root", () => {
    expect(existsSync(join(webRoot, "../../vercel.json"))).toBe(false);
  });
});
