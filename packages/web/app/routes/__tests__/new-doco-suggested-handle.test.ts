// /new-doco pre-fills the Doco handle with a complete, valid suggestion named
// after the chosen workspace and template ("torre-slack", "torre-doco"), never
// a dangling "torre-" the user has to finish.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import NewDoco, { suggestedDocoHandle } from "../new-doco";

describe("suggestedDocoHandle", () => {
  it("names a Doco after its workspace and template", () => {
    expect(suggestedDocoHandle("torre", "slack")).toBe("torre-slack");
    expect(suggestedDocoHandle("torre", "glossary")).toBe("torre-glossary");
  });

  it("calls a blank Doco <workspace>-doco", () => {
    expect(suggestedDocoHandle("torre", "generic")).toBe("torre-doco");
    expect(suggestedDocoHandle("torre", "")).toBe("torre-doco");
  });

  it("suggests nothing until a workspace is chosen", () => {
    expect(suggestedDocoHandle("", "slack")).toBe("");
  });

  it("stays a valid handle for a long workspace handle", () => {
    const handle = suggestedDocoHandle(`${"a".repeat(55)}-b`, "architectural-decisions");
    expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    expect(handle).not.toMatch(/[-_]$/);
  });
});

describe("/new-doco form", () => {
  function render(prefill: { workspaceId: string; templateHandle: string; name?: string }) {
    const loaderData = {
      workspaces: [{ id: "workspace_torre", handle: "torre" }],
      prefill: {
        newWorkspaceHandle: "",
        name: "",
        visibility: "private" as const,
        goal: "",
        ...prefill,
      },
    } as unknown as Parameters<typeof NewDoco>[0]["loaderData"];
    const Stub = createRoutesStub([
      { path: "/", Component: () => createElement(NewDoco, { loaderData }) },
    ]);
    return renderToStaticMarkup(createElement(Stub));
  }

  it("pre-fills the handle from the workspace and template", () => {
    const html = render({ workspaceId: "workspace_torre", templateHandle: "slack" });
    expect(html).toMatch(/name="name"[^>]*value="torre-slack"/);
  });

  it("keeps a handle the user typed", () => {
    const html = render({
      workspaceId: "workspace_torre",
      templateHandle: "slack",
      name: "sister-unit-slack",
    });
    expect(html).toMatch(/name="name"[^>]*value="sister-unit-slack"/);
  });
});
