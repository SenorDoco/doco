// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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

const QUIET_AGENT: SilenceAlert = {
  id: "alert_agent",
  kind: "agent",
  workspaceHandle: "torre",
  quietSince: "2026-09-18T00:00:00.000Z",
  usual: 12,
  agentName: "Claude Code",
  agentUser: "cy",
  docoHandles: ["torre-decisions"],
};

function render(workspace: WorkspaceSummary, showName?: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(WorkspaceSummaryCard, {
        workspace,
        baseUrl: "https://doco.test",
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
    expect(html).toContain(">Invite agent</button>");
  });

  // No button outshouts the others; the purple goes to the name instead.
  it("draws the three buttons alike", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render(TORRE);
    const classes = ['a[href^="/new-doco"]', 'a[href^="/users"]', "button"].map(
      (selector) => doc.querySelector(selector)?.className,
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
    expect(rowOf("button")).toBe(1);
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
    expect(rows[2]?.querySelector("button")?.textContent).toBe("Invite agent");
  });

  it("flags an agent that stopped reading and writing", () => {
    const doc = new Window().document;
    doc.body.innerHTML = render({ ...TORRE, alerts: [QUIET_AGENT] });
    expect(doc.querySelector('ul[aria-label="Alerts"]')?.textContent).toContain(
      "Claude Code (@cy) hasn't read or written in torre for",
    );
  });

  it("shows no alert box when nothing has gone quiet", () => {
    expect(render(TORRE)).not.toContain('aria-label="Alerts"');
  });

  it("leaves the name out on the workspace's own page", () => {
    expect(render(TORRE, false)).not.toContain('href="/workspaces/torre"');
  });

  // Alexander, 2026-10-06: an invite shows in a dialog, and an agent's copies
  // with "Copy prompt". The message is the one that asks an agent to start
  // using Doco in this workspace. 2026-10-07: connecting Doco to the agent
  // comes first, as in a workspace's setup.
  it("opens a dialog that hands over the prompt for the agent", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(WorkspaceSummaryCard, { workspace: TORRE, baseUrl: "https://doco.test" }),
        ),
      ),
    );
    expect(container.querySelector("dialog")).toBeNull();
    const invite = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Invite agent",
    );
    await act(async () => invite?.click());
    const dialog = container.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("Ask your agent to start using Doco");
    expect(dialog?.querySelector("pre")?.textContent).toContain(
      "in the workspace torre (https://doco.test/workspaces/torre)",
    );
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toContain(
      "Copy prompt",
    );
    act(() => root.unmount());
    container.remove();
  });
});
