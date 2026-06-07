import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The route module imports server-only helpers (host.server pulls in
// @doco/db) at the top level. Stub them so importing the component for a
// static render doesn't drag in Postgres/session machinery.
vi.mock("~/lib/host.server", () => ({
  loadHostConfig: async () => ({ id: "host_test", name: "torrenegra", visibility: "public" }),
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: async () => null,
}));

import Home from "../_index";

function render(): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Home)));
}

beforeAll(() => {
  // VersionPill reads these vite-injected build-time globals during render;
  // vitest doesn't define them, so stub them to avoid a ReferenceError.
  vi.stubGlobal("__DOCO_VERSION__", "0.0.0-test");
  vi.stubGlobal("__DOCO_RELEASE_AT__", "2026-01-01T00:00:00.000Z");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Home (anonymous landing)", () => {
  it("offers the create-workspace CTA and drops the removed join-wizard link", () => {
    const html = render();
    expect(html).toContain('href="/new-workspace"');
    expect(html).toContain("Create a new workspace");
    // The "Join a workspace" wizard is gone — joining is invite- or MCP-based.
    expect(html).not.toContain('href="/onboarding/join"');
    expect(html).not.toContain("Join a workspace");
  });

  it("uses the shared-memory line as the hero headline", () => {
    const html = render();
    // Promoted from the kicker to the <h1>, in normal case (no uppercase).
    expect(html).toContain(">Shared memory for AI and teams</h1>");
  });

  it("showcases unique functionality: a typed knowledge graph", () => {
    const html = render();
    // Typed nodes — decisions and rules are the canonical examples.
    expect(html).toContain("Decisions");
    expect(html).toContain("Rules");
  });

  it("keeps the agent-native angle discoverable via /llms.txt", () => {
    const html = render();
    expect(html).toContain("/llms.txt");
  });
});
