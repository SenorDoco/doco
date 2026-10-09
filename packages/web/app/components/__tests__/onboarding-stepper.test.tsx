import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { agentConnectGuides } from "~/lib/agent-connect-guides";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import type { OnboardingView } from "~/lib/onboarding-view.server";
import { OnboardingStepper } from "../onboarding-stepper";

const CREATOR: OnboardingView = {
  workspaceHandle: "acme",
  joinedAs: "creator",
  steps: [
    { step: "github", done: false },
    { step: "sources", done: false },
    { step: "mcp", done: false },
    { step: "agent", done: false },
  ],
  pending: "github",
  github: { available: true, docos: [] },
  sources: [
    {
      id: "slack",
      name: "Slack",
      description: "A copy of a Slack workspace's public channels.",
      available: true,
      docoHandle: null,
      connected: false,
    },
    {
      id: "notion",
      name: "Notion",
      description: "A copy of the Notion pages you share.",
      available: true,
      docoHandle: null,
      connected: false,
    },
  ],
  mcp: { guides: agentConnectGuides("https://doco.to") },
  agent: {
    instructions: agentInstructionsForWorkspace("https://doco.to", "acme"),
    agentsChatsHandle: "acme-agents-chats",
    wrote: false,
    hook: false,
  },
};

const ON_SOURCES: OnboardingView = {
  ...CREATOR,
  steps: [
    { step: "github", done: true },
    { step: "sources", done: false },
    { step: "mcp", done: false },
    { step: "agent", done: false },
  ],
  pending: "sources",
  github: {
    ...CREATOR.github,
    docos: [
      { handle: "acme-pull-requests", template: "github-pull-requests", label: "Pull requests" },
      { handle: "acme-codebase", template: "codebase", label: "Codebase" },
    ],
  },
};

const ON_MCP: OnboardingView = {
  ...ON_SOURCES,
  steps: [
    { step: "github", done: true },
    { step: "sources", done: true },
    { step: "mcp", done: false },
    { step: "agent", done: false },
  ],
  pending: "mcp",
};

const ON_AGENT: OnboardingView = {
  ...ON_MCP,
  steps: [
    { step: "github", done: true },
    { step: "sources", done: true },
    { step: "mcp", done: true },
    { step: "agent", done: false },
  ],
  pending: "agent",
};

const INVITEE: OnboardingView = {
  ...ON_MCP,
  joinedAs: "invitee",
  steps: [
    { step: "mcp", done: false },
    { step: "agent", done: false },
  ],
  github: { available: true, docos: [] },
  sources: [],
};

function render(view: OnboardingView, path = "/workspaces/acme"): string {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(OnboardingStepper, { view }) }],
    { initialEntries: [path] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

const STEP_ROW = "flex items-start gap-3 px-5 py-4";

/** The text of the step marked as the one the person is on. */
function currentStep(html: string): string {
  const start = html.indexOf('aria-current="step"');
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf(STEP_ROW, start + STEP_ROW.length + 30);
  return html.slice(start, next === -1 ? html.indexOf("</ol>", start) : next);
}

describe("OnboardingStepper", () => {
  it("starts a workspace's creator on connecting GitHub, which asks which repositories", () => {
    const html = render(CREATOR);
    expect(html).toContain("Set up acme");
    expect(html).toContain("Four steps to shared knowledge");
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect other sources of knowledge");
    expect(html).toContain("Connect Doco to your agent");
    expect(html).toContain("Ask your agent to start using Doco");
    // The agent turns the hook on itself, so that isn't a step.
    expect(html).not.toContain("Turn on the Doco hook");
    const step = currentStep(html);
    // The GitHub setup: it creates the workspace's GitHub Docos and has the
    // person pick every repository of an organization, or the ones they want.
    expect(step).toContain('action="/integrations/github"');
    expect(step).toContain('name="intent" value="choose"');
    expect(step).toContain('name="workspace" value="acme"');
    for (const id of ["pull-requests", "github-issues", "codebase"]) {
      expect(step).toContain(`name="bring" value="${id}"`);
    }
    expect(step).toContain("Nothing comes over until you pick");
    // Names the Docos GitHub fills.
    expect(step).toContain("Pull requests");
    expect(step).toContain("Codebase");
  });

  it("offers every other source one click each, and a skip", () => {
    const html = render(ON_SOURCES);
    const step = currentStep(html);
    expect(step).toContain("Connect Slack");
    expect(step).toContain("Connect Notion");
    expect(step).toContain('name="intent" value="source"');
    expect(step).toContain('name="intent" value="finish-sources"');
    expect(step).toContain("Skip for now");
    // The finished GitHub step says where its import is going.
    expect(html).toContain('href="/acme-pull-requests"');
    expect(html).toContain('href="/acme-codebase"');
  });

  it("says which sources are connected and moves on with Continue", () => {
    const html = render({
      ...ON_SOURCES,
      sources: ON_SOURCES.sources.map((s) =>
        s.id === "slack" ? { ...s, connected: true, docoHandle: "acme-slack" } : s,
      ),
    });
    const step = currentStep(html);
    expect(step).toContain("Connected, copying into");
    expect(step).toContain('href="/acme-slack"');
    expect(step).toContain("Continue");
    expect(step).not.toContain("Skip for now");
  });

  // Alexander, 2026-10-09: the person connects Doco to their agent before
  // inviting it ("ask the user to first install the Doco MCP and then invite
  // the agent"), from a terminal or the agent's desktop app, and the step
  // waits for the sign-in, which the poll sees as a live connection.
  it("walks the person through connecting Doco to their agent, each way, and waits for the sign-in", () => {
    const html = render(ON_MCP);
    const step = currentStep(html);
    expect(step).toContain("Which agent do you use?");
    expect(step).toContain("claude mcp add --transport http --scope user doco https://doco.to/mcp");
    expect(step).toContain("In the Claude desktop app");
    expect(step).toContain("claude_desktop_config.json");
    expect(step).toContain("[mcp_servers.doco]");
    expect(step).toContain("~/.gemini/settings.json");
    expect(step).toContain("Waiting for you to sign in to Doco from your agent");
    expect(step).not.toContain("Message for your agent");
    expect(step).not.toContain("Copy this message");
  });

  // The message comes after the connection, so it only has the agent start
  // using Doco here and turn on the Doco hook: the step waits for the agent's
  // note and the hook's first brief, and says which is still missing.
  it("gives the message for the agent with a copy button and waits for its note and its hook", () => {
    const html = render(ON_AGENT);
    const step = currentStep(html);
    expect(step).toContain("Message for your agent");
    expect(step).toContain("Copy");
    expect(step).toContain("send it to the agent you just connected, in your project");
    expect(step).not.toContain("adds Doco to itself");
    expect(step).not.toContain("Claude Code, Codex or Gemini CLI");
    expect(step).toContain("in the workspace acme");
    expect(step).toContain("turns on the Doco hook");
    expect(step).toContain("before each prompt and each file edit");
    expect(step).not.toContain("Which agent do you use?");
    expect(step).not.toContain("claude mcp add");
    expect(step).toContain("Waiting for your agent&#x27;s note in");
    expect(step).toContain("acme-agents-chats");
    expect(step).toContain("and the hook&#x27;s first brief");
    expect(step).not.toContain("hook token");
    expect(step).not.toContain('type="checkbox"');
    // Done without a source connected: skipped, or agents already work here.
    expect(html).toContain(
      "No other sources connected. Connect them any time from App integrations.",
    );
    expect(html).not.toContain("Skipped");
  });

  it("says which of the two is still missing", () => {
    const wrote = currentStep(render({ ...ON_AGENT, agent: { ...ON_AGENT.agent, wrote: true } }));
    expect(wrote).toContain("Your agent wrote in");
    expect(wrote).toContain("Waiting for the hook&#x27;s first brief");
    const hooked = currentStep(render({ ...ON_AGENT, agent: { ...ON_AGENT.agent, hook: true } }));
    expect(hooked).toContain("The hook is on. Waiting for your agent to write in");
    expect(hooked).not.toContain("My agent doesn&#x27;t run hooks");
  });

  // Every agent Doco supports runs hooks, so nobody skips the hook: the step
  // has no "My agent doesn't run hooks" way out (PR #1369 removed it). The
  // message in the step may say "run hooks" itself: its instructions tell an
  // agent that doesn't to have the user send them to one that does.
  it("offers no way around the hook", () => {
    const step = currentStep(render(ON_AGENT));
    expect(step).not.toContain("finish-hook");
    expect(step).not.toContain("My agent doesn&#x27;t run hooks");
  });

  it("walks someone who joined from an invite through connecting their agent, then asking it", () => {
    const html = render(INVITEE);
    expect(html).toContain("Get started in acme");
    expect(html).toContain(
      "Two steps left: connect Doco to your agent, then ask it to start using Doco here.",
    );
    expect(html).not.toContain("Connect GitHub");
    expect(html).not.toContain("Connect other sources of knowledge");
    expect(currentStep(html)).toContain("Which agent do you use?");
    const asking = render({
      ...INVITEE,
      steps: [
        { step: "mcp", done: true },
        { step: "agent", done: false },
      ],
      pending: "agent",
    });
    expect(currentStep(asking)).toContain("Message for your agent");
  });

  it("explains a step that came back refused", () => {
    expect(render(CREATOR, "/workspaces/acme?onboarding=not_owner")).toContain(
      "Only an owner of this workspace can take this step.",
    );
  });
});
