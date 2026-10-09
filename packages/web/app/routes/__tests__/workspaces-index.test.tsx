import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));

import WorkspacesPage from "../workspaces._index";

const TORRE = {
  id: "workspace_torre",
  handle: "torre",
  name: "Torre",
  role: "owner" as const,
  docos: [{ id: "doco_bugs", handle: "torre-bugs", template: "bugs" }],
  lastActivityAt: null,
  alerts: [],
};
const PERSONAL = { ...TORRE, id: "workspace_alice", handle: "alice", name: "alice", docos: [] };

function render(workspaces = [TORRE], setup = {}, inAProject = true): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(WorkspacesPage, {
        loaderData: {
          setup,
          workspaces,
          inAProject,
        } as never,
      }),
    ),
  );
}

describe("/workspaces", () => {
  it("lists each workspace with its Doco icons and next steps", () => {
    const html = render();
    expect(html).toContain('href="/workspaces/torre"');
    expect(html).toContain('aria-label="Bug tracker"');
    expect(html).toContain("Invite agent");
    expect(html).toContain('href="/new-workspace"');
    expect(html).not.toContain("Finish setting up");
  });

  it("leads back to the step the person is on in a workspace they haven't set up", () => {
    const html = render([TORRE], {
      workspace_torre: { title: "Connect other sources of knowledge", number: 2, total: 3 },
    });
    expect(html).toContain("Finish setting up: step 2 of 3");
    expect(html).toContain("Connect other sources of knowledge");
  });

  it("says one step is left to someone who joined from an invite", () => {
    const html = render([TORRE], {
      workspace_torre: { title: "Ask your agent to start using Doco", number: 1, total: 1 },
    });
    expect(html).toContain("One step left");
    expect(html).toContain("Ask your agent to start using Doco");
  });

  it("shows someone in no project's workspace how to start one", () => {
    const html = render([PERSONAL], {}, false);
    expect(html).toContain("Start with a workspace");
    expect(html).toContain("Create a workspace");
    expect(render()).not.toContain("Start with a workspace");
  });

  // Signing up creates no workspace (decision_01M4GF757E9T2X902JZKYG0DKG).
  it("shows someone who just signed up, in no workspace, how to start one or open an invite", () => {
    const html = render([], {}, false);
    expect(html).toContain("Start with a workspace");
    expect(html).toContain('href="/new-workspace"');
    expect(html).toContain("Invited to one? Open the invite to join it.");
  });
});
