// The emails that get a workspace going: the welcome its creator gets the
// moment it exists, and the reminder 15 minutes later while a step is still
// open. When asking the agent is the next step, the reminder carries the
// message to send the agent itself, the same one the workspace page hands
// over. Pure.

import { agentInstructionsForWorkspace } from "./agent-instructions";
import { emailHtml } from "./email-html";
import type { Email } from "./email.server";
import { ONBOARDING_STEPS, STEP_TITLES, type StepState, pendingStep } from "./onboarding-steps";

type Message = Omit<Email, "to">;

function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

const COUNTS = ["no", "one", "two", "three", "four"];

function workspaceUrl(baseUrl: string, handle: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workspaces/${handle}`;
}

export function welcomeEmail(opts: { baseUrl: string; workspaceHandle: string }): Message {
  const url = workspaceUrl(opts.baseUrl, opts.workspaceHandle);
  const intro = `Your workspace ${opts.workspaceHandle} is ready. It holds the shared knowledge and context your team and its agents build on.`;
  const titles = ONBOARDING_STEPS.creator.map((step) => lowerFirst(STEP_TITLES[step]));
  const steps = `${upperFirst(COUNTS[titles.length])} steps set it up: ${new Intl.ListFormat("en", { type: "conjunction" }).format(titles)}.`;
  return {
    subject: `Welcome to ${opts.workspaceHandle} on Doco`,
    text: `${intro}\n\n${steps}\n\nOpen ${opts.workspaceHandle}: ${url}\n`,
    html: emailHtml([intro, steps, { link: url, label: `Open ${opts.workspaceHandle}` }]),
  };
}

/** The reminder for steps still open, or the agent's message when asking
 *  the agent is the next one. */
export function reminderEmail(opts: {
  baseUrl: string;
  workspaceHandle: string;
  steps: readonly StepState[];
}): Message {
  const url = workspaceUrl(opts.baseUrl, opts.workspaceHandle);
  if (pendingStep(opts) === "agent") {
    const instructions = agentInstructionsForWorkspace(opts.baseUrl, opts.workspaceHandle);
    const intro = `Your agent is one message away from working in ${opts.workspaceHandle}. Send it the message below: it has your agent start using Doco there, note in ${opts.workspaceHandle}'s Agents chats Doco that it received the instructions, and turn on the Doco hook.`;
    const after = `You can also copy the message from ${opts.workspaceHandle}: ${url}`;
    return {
      subject: `Ask your agent to start using Doco in ${opts.workspaceHandle}`,
      text: `${intro}\n\n${instructions}\n${after}\n`,
      html: emailHtml([intro, { pre: instructions }, after]),
    };
  }
  const intro = `${opts.workspaceHandle} is ${COUNTS[opts.steps.length]} simple steps from shared knowledge and context for your team and its agents:`;
  const lines = opts.steps.map(
    (s, i) => `${i + 1}. ${STEP_TITLES[s.step]}${s.done ? " (done)" : ""}`,
  );
  const after = "Pick up where you left off:";
  return {
    subject: `Finish setting up ${opts.workspaceHandle} on Doco`,
    text: `${intro}\n\n${lines.join("\n")}\n\n${after} ${url}\n`,
    html: emailHtml([
      intro,
      ...lines,
      { link: url, label: `Finish setting up ${opts.workspaceHandle}` },
    ]),
  };
}
