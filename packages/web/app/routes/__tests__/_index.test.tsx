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
  it("preserves both primary CTAs (create + join) with their destinations", () => {
    const html = render();
    expect(html).toContain('href="/new-doco"');
    expect(html).toContain('href="/onboarding/join"');
    expect(html).toContain("Create a new doco");
    expect(html).toContain("Join an existing doco");
  });

  it("leads with the shared-memory positioning and keeps the tagline", () => {
    const html = render();
    expect(html).toContain("Shared memory for AI and teams");
    expect(html).toContain("Keep people, agents, and work aligned");
  });

  it("frames the core benefit as capturing the why, not just the what", () => {
    const html = render();
    // The git-remembers-what / Doco-remembers-why contrast is the thesis.
    expect(html).toMatch(/\bwhy\b/i);
    expect(html).toMatch(/\bgit\b/i);
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
