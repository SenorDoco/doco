// What a project does to run the Doco hook (app/hook/doco-hook.mjs): save the
// script, then name it in the client's hooks. The /agents page shows these
// with Copy buttons; step 3 of the agent instructions points here.

export const DOCO_HOOK_PATH = "/agents/doco-hook.mjs";

export interface HookInstallSnippet {
  title: string;
  text: string;
}

export function hookInstallSnippets(baseUrl: string): HookInstallSnippet[] {
  const host = baseUrl.replace(/\/+$/, "");
  const command = "node .doco/hook.mjs";
  return [
    {
      title: "Save the script in the project",
      text: `mkdir -p .doco && curl -fsSL ${host}${DOCO_HOOK_PATH} -o .doco/hook.mjs`,
    },
    {
      title: "Claude Code: .claude/settings.json",
      text: JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
            PreToolUse: [
              {
                matcher: "Edit|Write|MultiEdit",
                hooks: [{ type: "command", command, timeout: 15 }],
              },
            ],
          },
        },
        null,
        2,
      ),
    },
    {
      title: "Codex: .codex/hooks.json",
      text: JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
            PreToolUse: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
          },
        },
        null,
        2,
      ),
    },
    {
      title: "Gemini CLI: .gemini/settings.json",
      text: JSON.stringify(
        {
          hooks: {
            BeforeAgent: [{ hooks: [{ name: "doco", type: "command", command, timeout: 15000 }] }],
          },
        },
        null,
        2,
      ),
    },
  ];
}
