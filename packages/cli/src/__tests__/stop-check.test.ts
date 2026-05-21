import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(testDir, "../../templates/agent-bootstrap/.claude/stop-check.sh");

function writeFakeJq(dir: string) {
  const jqPath = join(dir, "jq");
  writeFileSync(
    jqPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");

if (args.includes("-r")) {
  const parsed = JSON.parse(stdin || "{}");
  process.stdout.write(parsed.transcript_path || "");
  process.stdout.write("\\n");
  process.exit(0);
}

const argIndex = args.indexOf("--arg");
if (args.includes("-nc") && argIndex !== -1 && args[argIndex + 1] === "c") {
  const additionalContext = args[argIndex + 2] || "";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext,
    },
  }));
  process.exit(0);
}

process.exit(1);
`,
    "utf8",
  );
  chmodSync(jqPath, 0o755);
}

function runHook(events: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "doco-stop-hook-"));
  try {
    writeFakeJq(dir);
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(transcriptPath, events.map((event) => JSON.stringify(event)).join("\n"), "utf8");

    const result = spawnSync("bash", [hookPath], {
      input: JSON.stringify({ transcript_path: transcriptPath }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    if (!result.stdout.trim()) return "";
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const userPrompt = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: "fix the capture feedback" }],
  },
};

const captureToolUse = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: "Bash",
        input: {
          command:
            'doco capture decision --question "How should footer drops be guarded?" --chosen "Compare tool output footer_lines to assistant text."',
        },
      },
    ],
  },
};

const twoFooterToolResult = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        content:
          "[🔮 Doco] ✍️ Intent added: [Agents must keep capture feedback visible.](https://doco.to/intent) — ⚙️ framework\n[🔮 Doco] ✍️ Decision added: [Compare Doco write footer_lines against assistant text before Stop.](https://doco.to/decision) — ⚙️ framework (0.2s)",
      },
    ],
  },
};

describe("agent bootstrap Stop hook", () => {
  it("nudges when Doco write tool output has footer_lines that assistant text drops", () => {
    const nudge = runHook([
      userPrompt,
      captureToolUse,
      twoFooterToolResult,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Captured the rationale.\n\n[🔮 Doco] doco_abc: **2** nodes added/updated",
            },
          ],
        },
      },
    ]);

    expect(nudge).toContain("Doco write footer_lines not shown to user");
    expect(nudge).toContain("contained 2 footer line(s), but assistant text emitted 0");
  });

  it("nudges when only some returned footer_lines reach assistant text", () => {
    const nudge = runHook([
      userPrompt,
      captureToolUse,
      twoFooterToolResult,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "[🔮 Doco] ✍️ Intent added: [Agents must keep capture feedback visible.](https://doco.to/intent) — ⚙️ framework\n\n[🔮 Doco] doco_abc: **2** nodes added/updated",
            },
          ],
        },
      },
    ]);

    expect(nudge).toContain("Doco write footer_lines not shown to user");
    expect(nudge).toContain("contained 2 footer line(s), but assistant text emitted 1");
  });

  it("stays quiet when every returned footer_line is pasted", () => {
    const nudge = runHook([
      userPrompt,
      captureToolUse,
      twoFooterToolResult,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "[🔮 Doco] ✍️ Intent added: [Agents must keep capture feedback visible.](https://doco.to/intent) — ⚙️ framework\n[🔮 Doco] ✍️ Decision added: [Compare Doco write footer_lines against assistant text before Stop.](https://doco.to/decision) — ⚙️ framework (0.2s)\n\n[🔮 Doco] doco_abc: **2** nodes added/updated",
            },
          ],
        },
      },
    ]);

    expect(nudge).toBe("");
  });

  it("keeps the edits-without-capture nudge", () => {
    const nudge = runHook([
      userPrompt,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: "packages/web/app/lib/instructions.server.ts" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);

    expect(nudge).toContain("turn had edits but no captures");
  });
});
