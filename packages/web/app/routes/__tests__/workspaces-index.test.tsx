import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));

import WorkspacesPage from "../workspaces._index";

const ALL_DONE = { workspace: true, agent: true, sources: true };
const TORRE = {
  id: "workspace_torre",
  handle: "torre",
  name: "Torre",
  role: "owner" as const,
  docos: [{ id: "doco_bugs", handle: "torre-bugs", template: "bugs" }],
  lastActivityAt: null,
};

function render(onboarding = ALL_DONE, workspaces = [TORRE]): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(WorkspacesPage, {
        loaderData: {
          me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
          onboarding,
          workspaces,
        } as never,
      }),
    ),
  );
}

describe("/workspaces", () => {
  it("walks a new person through the three onboarding steps", () => {
    const html = render({ workspace: false, agent: false, sources: false });
    expect(html).toContain("Get started");
    expect(html).toContain("Connect your agent");
    expect(html).toContain("Connect sources of knowledge");
  });

  it("drops the onboarding card once every step is done", () => {
    expect(render()).not.toContain("Get started");
  });

  it("lists each workspace with its Doco icons and next steps", () => {
    const html = render();
    expect(html).toContain('href="/workspaces/torre"');
    expect(html).toContain('aria-label="Bug tracker"');
    expect(html).toContain("Invite agent");
    expect(html).toContain('href="/new-workspace"');
  });

  it("says so when the person reaches no workspace", () => {
    expect(render(ALL_DONE, [])).toContain("No workspaces yet.");
  });
});
