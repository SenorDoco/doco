import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import type { OnboardingView } from "~/lib/onboarding-view.server";
import { OnboardingStepper } from "../onboarding-stepper";

const CREATOR: OnboardingView = {
  workspaceHandle: "acme",
  joinedAs: "creator",
  steps: [
    { step: "github", done: false },
    { step: "sources", done: false },
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
  agent: {
    instructions: agentInstructionsForWorkspace("https://doco.to", "acme"),
    agentsChatsHandle: "acme-agents-chats",
  },
};

const ON_SOURCES: OnboardingView = {
  ...CREATOR,
  steps: [
    { step: "github", done: true },
    { step: "sources", done: false },
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

const ON_AGENT: OnboardingView = {
  ...ON_SOURCES,
  steps: [
    { step: "github", done: true },
    { step: "sources", done: true },
    { step: "agent", done: false },
  ],
  pending: "agent",
};

const INVITEE: OnboardingView = {
  ...ON_AGENT,
  joinedAs: "invitee",
  steps: [{ step: "agent", done: false }],
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
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect other sources of knowledge");
    expect(html).toContain("Ask your agent to start using Doco");
    const step = currentStep(html);
    // The GitHub setup: it creates the workspace's GitHub Docos and has the
    // person pick every repository of an organization, or the ones they want.
    expect(step).toContain('action="/integrations/github"');
    expect(step).toContain('name="intent" value="choose"');
    expect(step).toContain('name="workspace" value="acme"');
    for (const id of ["pull-requests", "github-bugs", "codebase"]) {
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

  it("gives the message for the agent with a copy button and waits for its note", () => {
    const html = render(ON_AGENT);
    const step = currentStep(html);
    expect(step).toContain("Message for your agent");
    expect(step).toContain("Copy");
    expect(step).toContain("in the workspace acme");
    expect(step).toContain("Waiting for your agent to write in");
    expect(step).toContain("acme-agents-chats");
    // Done without a source connected: skipped, or agents already work here.
    expect(html).toContain(
      "No other sources connected. Connect them any time from App integrations.",
    );
    expect(html).not.toContain("Skipped");
  });

  it("walks someone who joined from an invite only through asking their agent", () => {
    const html = render(INVITEE);
    expect(html).toContain("Get started in acme");
    expect(html).toContain("One step left");
    expect(html).not.toContain("Connect GitHub");
    expect(html).not.toContain("Connect other sources of knowledge");
    expect(currentStep(html)).toContain("Message for your agent");
  });

  it("explains a step that came back refused", () => {
    expect(render(CREATOR, "/workspaces/acme?onboarding=not_owner")).toContain(
      "Only an owner of this workspace can connect its sources.",
    );
  });
});
