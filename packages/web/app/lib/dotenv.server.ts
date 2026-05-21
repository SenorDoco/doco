// Tiny helper: walk up from cwd looking for a `.env` and load it via
// Node 22's built-in `process.loadEnvFile`. Idempotent — multiple
// callers all hit the same file; second + later calls are no-ops once
// process.env carries the relevant key.
//
// Used by both the OpenAI-backed implicit-edge detector (llm.server.ts)
// and the Anthropic-backed in-page assistant (agent-chat.server.ts) so
// neither has to source the .env at launch.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";

let loaded = false;

export function ensureEnvLoaded(): void {
  if (loaded) return;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        loadEnvFile(candidate);
      } catch {
        // Malformed .env or older Node; ignore.
      }
      loaded = true;
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      loaded = true; // no .env found — don't re-walk
      return;
    }
    dir = parent;
  }
  loaded = true;
}
