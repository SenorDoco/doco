import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../..");
const templateRoot = resolve(repoRoot, "packages/cli/templates/agent-bootstrap");

const runtimeBootstrapFiles = [
  ".agents/doco-agent-client.mjs",
  ".agents/doco-mcp-server.mjs",
  ".claude/bootstrap-fetch.sh",
  ".claude/user-prompt-fetch.sh",
];

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("agent bootstrap templates", () => {
  it("keeps runtime bootstrap templates in sync with this repo's installed copies", () => {
    for (const relativePath of runtimeBootstrapFiles) {
      expect(read(resolve(templateRoot, relativePath)), relativePath).toBe(
        read(resolve(repoRoot, relativePath)),
      );
    }
  });

  it("documents refresh-before-device-flow in default agent guidance", () => {
    const agentsTemplate = read(resolve(templateRoot, "AGENTS.md"));
    expect(agentsTemplate).toContain(
      "refreshes a missing or stale `DOCO_ACCESS` from `DOCO_REFRESH` +",
    );
    expect(agentsTemplate).toMatch(/no usable\s+DOCO_ACCESS and no usable DOCO_REFRESH/);

    const envExample = read(resolve(templateRoot, ".env.example"));
    expect(envExample).toContain(
      "use this with DOCO_CLIENT_ID to refresh a\n# missing/stale access token before asking for device-flow approval",
    );
  });
});
