import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { SilenceAlert } from "~/lib/silence-alerts.server";
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
  lastActivityAt: "2026-09-20T00:00:00.000Z",
  alerts: [],
};

const QUIET_SLACK: SilenceAlert = {
  id: "alert_slack",
  kind: "integration",
  workspaceHandle: "torre",
  quietSince: "2026-09-18T00:00:00.000Z",
  usual: 40,
  docoHandle: "torre-slack",
  source: "slack",
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

  // No button outshouts the others; the purple goes to the name instead.
  it("draws the three buttons alike", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render(TORRE);
    const classes = ["/new-doco", "/users", "/workspaces/torre/agent"].map(
      (href) => doc.querySelector(`a[href^="${href}"]`)?.className,
    );
    expect(new Set(classes).size).toBe(1);
    expect(classes[0]).not.toContain("bg-primary");
  });

  it("makes the name big and purple so it reads as a link", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render(TORRE);
    const name = doc.querySelector('a[href="/workspaces/torre"]')?.className.split(" ");
    expect(name).toContain("text-primary");
    expect(name).toContain("text-lg");
  });

  // Just when, not what: the card stays one glance long.
  it("says when the last activity was, without its details", () => {
    const html = render(TORRE);
    expect(html).toContain("Last activity:");
    expect(html).toContain('dateTime="2026-09-20T00:00:00.000Z"');
    expect(html).not.toContain("Use Postgres");
    expect(html).not.toContain("Decision added");
  });

  it("says so when nothing has happened yet", () => {
    expect(render({ ...TORRE, lastActivityAt: null })).toContain("No activity yet.");
  });

  // Reaching only an invited Doco doesn't make a person a member who can add
  // Docos or invite people to the workspace; they can still bring an agent.
  it("offers only the agent invite to someone who reaches just some Docos", () => {
    const html = render({ ...TORRE, role: null });
    expect(html).not.toContain("New Doco or source");
    expect(html).not.toContain("Invite person");
    expect(html).toContain("Invite agent");
  });

  // A card with few Docos used to fit the buttons beside the title while a
  // card with many wrapped them below, so cards didn't line up. The buttons
  // always get their own row: title, buttons, last activity.
  it("puts the buttons on their own row, below the title", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render(TORRE);
    const lastActivity = doc.querySelector("time")?.parentElement;
    const rows = Array.from(lastActivity?.parentElement?.children ?? []);
    const rowOf = (selector: string) => rows.findIndex((row) => row.querySelector(selector));
    expect(rows).toHaveLength(3);
    expect(rowOf('ul[aria-label="Docos"]')).toBe(0);
    expect(rowOf('a[href="/workspaces/torre/agent"]')).toBe(1);
    expect(rows[2]).toBe(lastActivity);
  });

  // A source or an agent gone unexpectedly quiet shows right under the Docos,
  // on the Workspaces page and atop the workspace's own page alike.
  it("flags a Doco gone quiet between the Docos and the buttons", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render({ ...TORRE, alerts: [QUIET_SLACK] });
    const alerts = doc.querySelector('ul[aria-label="Alerts"]');
    expect(alerts?.textContent).toContain("torre-slack has received nothing from Slack for");
    expect(alerts?.querySelector('a[href="/torre-slack/integrations/slack"]')?.textContent).toBe(
      "Check the connection",
    );
    const rows = Array.from(alerts?.parentElement?.children ?? []);
    expect(rows[1]).toBe(alerts);
    expect(rows[2]?.querySelector('a[href="/workspaces/torre/agent"]')).not.toBeNull();
  });

  it("shows no alert box when nothing has gone quiet", () => {
    expect(render(TORRE)).not.toContain('aria-label="Alerts"');
  });

  it("leaves the name out on the workspace's own page", () => {
    expect(render(TORRE, false)).not.toContain('href="/workspaces/torre"');
  });
});
