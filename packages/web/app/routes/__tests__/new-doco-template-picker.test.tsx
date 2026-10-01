// @vitest-environment happy-dom
//
// The /new-doco template picker: every template with its Doco type icon, in
// the order of DOCO_TEMPLATES (Generic first, the rest A to Z), none chosen
// up front. Choosing one collapses the picker to that template, and its X
// brings every option back.
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCO_TEMPLATES, findDocoTemplateMeta } from "~/lib/doco-templates-meta";
import NewDoco from "../new-doco";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

function App({ templateHandle }: { templateHandle: string }) {
  const loaderData = {
    me: { id: "user_alex", username: "alex" },
    workspaces: [{ id: "workspace_torre", handle: "torre" }],
    prefill: {
      templateHandle,
      workspaceId: "workspace_torre",
      newWorkspaceHandle: "",
      name: "",
      visibility: "private" as const,
      goal: "",
    },
  } as unknown as Parameters<typeof NewDoco>[0]["loaderData"];
  const Stub = createRoutesStub([
    { path: "/", Component: () => createElement(NewDoco, { loaderData }) },
  ]);
  return createElement(Stub);
}

async function mount(templateHandle: string): Promise<HTMLElement> {
  const app = createElement(App, { templateHandle });
  const container = document.createElement("div");
  container.innerHTML = renderToString(app);
  document.body.appendChild(container);
  await act(async () => {
    hydrateRoot(container, app);
  });
  return container;
}

function radios(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[name="template_handle"]')].filter(
    (input) => input.type === "radio",
  );
}

function chosenTemplate(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLInputElement>('input[type="hidden"][name="template_handle"]')
    ?.value;
}

function goal(container: HTMLElement): string {
  return container.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')?.value ?? "";
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("/new-doco template picker", () => {
  it("offers every template, in order, with its icon and none chosen", async () => {
    const container = await mount("");
    const options = radios(container);
    expect(options.map((radio) => radio.value)).toEqual(DOCO_TEMPLATES.map((t) => t.handle));
    expect(options.filter((radio) => radio.checked)).toEqual([]);
    expect(options.every((radio) => radio.required)).toBe(true);
    for (const radio of options) {
      const label = findDocoTemplateMeta(radio.value)?.label;
      expect(radio.closest("label")?.querySelector(`svg[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(chosenTemplate(container)).toBeUndefined();
  });

  it("collapses to a template chosen up front, with an X to choose again", async () => {
    const container = await mount("slack");
    expect(radios(container)).toEqual([]);
    expect(chosenTemplate(container)).toBe("slack");
    expect(container.textContent).toContain("Slack workspace");
    expect(container.textContent).not.toContain("Glossary");
    expect(container.querySelector('button[aria-label="Remove Slack workspace"]')).not.toBeNull();
  });

  it("collapses when a template is chosen, and the X shows every option again", async () => {
    const container = await mount("");
    const glossary = radios(container).find((radio) => radio.value === "glossary");
    await act(async () => {
      glossary?.click();
    });

    expect(radios(container)).toEqual([]);
    expect(chosenTemplate(container)).toBe("glossary");
    expect(goal(container)).toBe(findDocoTemplateMeta("glossary")?.description);

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Glossary"]',
    );
    await act(async () => {
      remove?.click();
    });

    expect(radios(container)).toHaveLength(DOCO_TEMPLATES.length);
    expect(radios(container).filter((radio) => radio.checked)).toEqual([]);
    expect(chosenTemplate(container)).toBeUndefined();
    expect(goal(container)).toBe("");
  });
});
