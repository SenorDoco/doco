import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "~/lib/workspace-summaries.server";
import { WorkspaceSummaryCard } from "../workspace-summary-card";

const TORRE: WorkspaceSummary = {
  id: "workspace_torre",
  handle: "torre",
  name: "Torre",
  role: "owner",
  docos: [
    { id: "doco_dec", handle: "torre-decisions", template: "architectural-decisions" },
    { id: "doco_slack", handle: "torre-slack", template: "slack" },
  ],
  lastActivity: {
    at: "2026-09-20T00:00:00.000Z",
    byUsername: "bo",
    op: "entity.create",
    entityType: "decision",
    entityId: "decision_1",
    docoHandle: "torre-decisions",
    summary: "Use Postgres",
  },
};

function render(workspace: WorkspaceSummary, showName?: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(WorkspaceSummaryCard, {
        workspace,
        ...(showName === undefined ? {} : { showName }),
      }),
    ),
  );
}

describe("WorkspaceSummaryCard", () => {
  it("shows each Doco as its type icon, linked to the Doco", () => {
    const html = render(TORRE);
    expect(html).toContain('href="/workspaces/torre"');
    expect(html).toContain('href="/torre-decisions"');
    expect(html).toContain('aria-label="Architectural decisions (ADR)"');
    expect(html).toContain('href="/torre-slack"');
    expect(html).toContain('aria-label="Slack workspace"');
  });

  it("offers the three next steps: a Doco or source, a person, an agent", () => {
    const html = render(TORRE);
    expect(html).toContain(">New Doco or source</a>");
    expect(html).toContain('href="/new-doco?workspace_id=workspace_torre"');
    expect(html).toContain(">Invite person</a>");
    expect(html).toContain('href="/users?scope=workspace%3Aworkspace_torre"');
    expect(html).toContain(">Invite agent</a>");
    expect(html).toContain('href="/workspaces/torre/agent"');
  });

  it("names the latest thing that happened", () => {
    const html = render(TORRE);
    expect(html).toContain("Decision added");
    expect(html).toContain("Use Postgres");
    expect(html).toContain("torre-decisions");
    expect(html).toContain("bo");
  });

  it("says so when nothing has happened yet", () => {
    expect(render({ ...TORRE, lastActivity: null })).toContain("No activity yet.");
  });

  // Reaching only an invited Doco doesn't make a person a member who can add
  // Docos or invite people to the workspace; they can still bring an agent.
  it("offers only the agent invite to someone who reaches just some Docos", () => {
    const html = render({ ...TORRE, role: null });
    expect(html).not.toContain("New Doco or source");
    expect(html).not.toContain("Invite person");
    expect(html).toContain("Invite agent");
  });

  it("leaves the name out on the workspace's own page", () => {
    expect(render(TORRE, false)).not.toContain('href="/workspaces/torre"');
  });
});
