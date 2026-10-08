// @vitest-environment happy-dom
//
// Alexander, 2026-10-08: an invitee's agent asked them to create a token,
// because signing the agent in asked the person to name a token and pick what
// it may reach, with nothing picked. He chose one-click Allow
// (decision_01M4EQPJ6AKETJ1508W254DXVB): the page says what the agent will
// reach, Allow grants it, and Limit access opens the picker.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthAccessApprovalForm } from "../oauth-access-approval-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const TORRE = { id: "workspace_torre", handle: "torre", display_name: "Torre", my_role: "owner" };
const BPMS = { id: "doco_bpms", handle: "torre-bpms", my_role: "owner", workspace_id: TORRE.id };

type Props = Parameters<typeof OAuthAccessApprovalForm>[0];

function render(props: Partial<Props> = {}) {
  return act(async () =>
    root.render(
      <OAuthAccessApprovalForm
        clientName="Claude Code"
        docos={[BPMS] as Props["docos"]}
        workspaces={[TORRE] as Props["workspaces"]}
        requestedRole={null}
        cancelLabel="Cancel"
        cancelDecisionValue="cancel"
        {...props}
      />,
    ),
  );
}

const grants = () =>
  JSON.parse((container.querySelector('input[name="grants"]') as HTMLInputElement).value);
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
const picker = () => container.querySelector('[data-testid="grant-picker"]');

describe("OAuthAccessApprovalForm", () => {
  it("asks for one click: Allow, reaching everything the person can in all their workspaces", async () => {
    await render();

    expect(container.textContent).toContain(
      "Claude Code will be able to read, write and manage everything you can, in all your workspaces, including ones you join later.",
    );
    expect(grants()).toMatchObject([{ level: "actor", role: "owner" }]);
    expect(button("Allow")?.value).toBe("approve");
    expect(button("Cancel")?.value).toBe("cancel");
    expect(container.querySelector('input[name="token_name"]')).toBeNull();
    expect(container.textContent).not.toContain("Token name");
    expect(picker()).toBeNull();
  });

  it("lets someone who owns no workspace allow it too, since it acts as them", async () => {
    await render({ docos: [], workspaces: [] });

    expect(grants()).toMatchObject([{ level: "actor", role: "owner" }]);
    expect(button("Allow")).toBeDefined();
  });

  it("gives a connector bound to one workspace that workspace to read and write", async () => {
    await render({
      workspaces: [{ ...TORRE, display_name: "torre" }] as Props["workspaces"],
      boundWorkspace: { id: TORRE.id, label: "torre", maxRole: "owner" },
    });

    expect(container.textContent).toContain(
      "Claude Code will be able to read and write the torre workspace.",
    );
    expect(grants()).toMatchObject([{ level: "workspace", targetId: TORRE.id, role: "writer" }]);
    expect(container.textContent).not.toContain("all your workspaces");
  });

  it("gives the level a client asked for", async () => {
    await render({ requestedRole: "reader" });

    expect(container.textContent).toContain("Claude Code will be able to read everything you can");
    expect(grants()).toMatchObject([{ level: "actor", role: "reader" }]);
  });

  it("opens the picker, with nothing picked, on Limit access", async () => {
    await render();
    await act(async () => button("Limit access")?.click());

    expect(picker()).not.toBeNull();
    expect(container.textContent).toContain("All your workspaces");
    expect(container.textContent).toContain("Specific workspace(s)");
    expect(container.textContent).toContain("Specific docos");
    expect(grants()).toEqual([]);
    expect(button("Limit access")).toBeUndefined();
    // Allow still submits, so a click on an empty pick says what's missing.
    expect(button("Allow")?.disabled).toBe(false);
  });
});
