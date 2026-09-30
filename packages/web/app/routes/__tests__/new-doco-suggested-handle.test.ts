// /new-doco pre-fills the Doco handle with a complete, valid suggestion named
// after the chosen workspace and template ("torre-slack", "torre-doco"), never
// a dangling "torre-" the user has to finish. Its template picker shows each
// template with the icon its Docos wear elsewhere.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import NewDoco, { suggestedDocoHandle } from "../new-doco";

vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

describe("suggestedDocoHandle", () => {
  it("names a Doco after its workspace and template", () => {
    expect(suggestedDocoHandle("torre", "slack")).toBe("torre-slack");
    expect(suggestedDocoHandle("torre", "glossary")).toBe("torre-glossary");
  });

  it("calls a blank Doco <workspace>-doco", () => {
    expect(suggestedDocoHandle("torre", "generic")).toBe("torre-doco");
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
      me: { id: "user_alex", username: "alex" },
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

  it("shows each template with its Doco type icon", () => {
    const html = render({ workspaceId: "workspace_torre", templateHandle: "generic" });
    const options = html.split('name="template_handle"').slice(1);
    expect(options).toHaveLength(DOCO_TEMPLATES.length);
    DOCO_TEMPLATES.forEach((template, i) => {
      expect(options[i], template.handle).toContain(`aria-label="${template.label}"`);
    });
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
