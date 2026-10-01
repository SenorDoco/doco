// The emails that get a workspace going: the welcome its creator gets the
// moment it exists, and the reminder 15 minutes later while a step is still
// open. When asking the agent is all that's left (always, for someone who
// joined from an invite), the reminder carries the message to send the agent
// itself, the same one the workspace page hands over. Pure.

import { agentInstructionsForWorkspace } from "./agent-instructions";
import type { Email } from "./email.server";
import { ONBOARDING_STEPS, STEP_TITLES, type StepState } from "./onboarding-steps";

type Message = Omit<Email, "to">;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function workspaceUrl(baseUrl: string, handle: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workspaces/${handle}`;
}

/** Paragraphs as HTML: each a <p>, or a <pre> for preformatted text. */
function html(blocks: Array<string | { pre: string } | { link: string; label: string }>): string {
  const body = blocks
    .map((block) => {
      if (typeof block === "string") {
        return `<p style="margin:0 0 16px">${escapeHtml(block)}</p>`;
      }
      if ("pre" in block) {
        return `<pre style="margin:0 0 16px;padding:16px;border:1px solid #ddd;border-radius:8px;background:#f7f7f7;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace">${escapeHtml(block.pre)}</pre>`;
      }
      return `<p style="margin:0 0 16px"><a href="${escapeHtml(block.link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#111;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(block.label)}</a></p>`;
    })
    .join("\n");
  return `<div style="max-width:600px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">\n${body}\n</div>`;
}

export function welcomeEmail(opts: { baseUrl: string; workspaceHandle: string }): Message {
  const url = workspaceUrl(opts.baseUrl, opts.workspaceHandle);
  const intro = `Your workspace ${opts.workspaceHandle} is ready. It holds the shared knowledge and context your team and its agents build on.`;
  const [github, sources, agent] = ONBOARDING_STEPS.creator.map((step) =>
    lowerFirst(STEP_TITLES[step]),
  );
  const steps = `Three steps set it up: ${github}, ${sources}, and ${agent}.`;
  return {
    subject: `Welcome to ${opts.workspaceHandle} on Doco`,
    text: `${intro}\n\n${steps}\n\nOpen ${opts.workspaceHandle}: ${url}\n`,
    html: html([intro, steps, { link: url, label: `Open ${opts.workspaceHandle}` }]),
  };
}

/** The reminder for steps still open, or the agent's message when asking
 *  the agent is the only one left. */
export function reminderEmail(opts: {
  baseUrl: string;
  workspaceHandle: string;
  steps: readonly StepState[];
}): Message {
  const url = workspaceUrl(opts.baseUrl, opts.workspaceHandle);
  const open = opts.steps.filter((s) => !s.done);
  if (open.length === 1 && open[0].step === "agent") {
    const instructions = agentInstructionsForWorkspace(opts.baseUrl, opts.workspaceHandle);
    const intro = `Your agent is one message away from working in ${opts.workspaceHandle}. Send it the message below: it connects your agent to Doco and has it note in ${opts.workspaceHandle}'s Agents chats Doco that it received the instructions.`;
    const after = `You can also copy the message from ${opts.workspaceHandle}: ${url}`;
    return {
      subject: `Ask your agent to start using Doco in ${opts.workspaceHandle}`,
      text: `${intro}\n\n${instructions}\n${after}\n`,
      html: html([intro, { pre: instructions }, after]),
    };
  }
  const intro = `${opts.workspaceHandle} is three simple steps from shared knowledge and context for your team and its agents:`;
  const lines = opts.steps.map(
    (s, i) => `${i + 1}. ${STEP_TITLES[s.step]}${s.done ? " (done)" : ""}`,
  );
  const after = "Pick up where you left off:";
  return {
    subject: `Finish setting up ${opts.workspaceHandle} on Doco`,
    text: `${intro}\n\n${lines.join("\n")}\n\n${after} ${url}\n`,
    html: html([
      intro,
      ...lines,
      { link: url, label: `Finish setting up ${opts.workspaceHandle}` },
    ]),
  };
}
