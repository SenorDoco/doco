// @vitest-environment happy-dom
//
// Alexander, 2026-10-06: after Generate link, "show the link and the
// instructions to invite them in a dialog so that they don't confuse it with
// something else". A person's invite copies with "Copy invite", an agent's
// with "Copy prompt".
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInviteDialog, PersonInviteDialog } from "../invite-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const dialog = () => container.querySelector("dialog") as HTMLDialogElement;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

describe("PersonInviteDialog", () => {
  const render = (onClose = () => {}) =>
    act(async () =>
      root.render(
        <PersonInviteDialog
          inviteUrl="https://doco.test/invite/abc"
          note="Single-use, expires in 72 hours."
          onClose={onClose}
        />,
      ),
    );

  it("opens as a modal holding the person's invite and Copy invite", async () => {
    await render();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("Send this invite to the person");
    expect(dialog().querySelector("pre")?.textContent).toBe(
      "Let's share knowledge on Doco. Open this URL and accept the invite:\n\nhttps://doco.test/invite/abc",
    );
    expect(dialog().textContent).toContain("Single-use, expires in 72 hours.");
    expect(button("Copy prompt")).toBeUndefined();
    expect(document.activeElement).toBe(button("Copy invite"));
  });

  it("copies the invite and says so", async () => {
    await render();
    await act(async () => button("Copy invite")?.click());
    expect(writeText).toHaveBeenCalledWith(
      "Let's share knowledge on Doco. Open this URL and accept the invite:\n\nhttps://doco.test/invite/abc",
    );
    expect(button("Copied!")).toBeDefined();
  });

  it("closes from its Close button", async () => {
    const onClose = vi.fn();
    await render(onClose);
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalled();
  });
});

// Alexander, 2026-10-07: inviting an agent takes the same two steps as a
// workspace's setup does for an invitee: connect Doco to your agent, with the
// same per-agent guide, then send it the prompt.
describe("AgentInviteDialog", () => {
  const render = () =>
    act(async () =>
      root.render(
        <AgentInviteDialog
          workspaceHandle="torre"
          baseUrl="https://doco.test"
          onClose={() => {}}
        />,
      ),
    );

  it("opens on connecting Doco to the agent, with the per-agent guide", async () => {
    await render();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("Step 1 of 2: Connect Doco to your agent");
    expect(dialog().textContent).toContain("Which agent do you use?");
    expect(dialog().textContent).toContain("Already connected? Go on to step 2.");
    await act(async () => button("Claude Code")?.click());
    expect(dialog().textContent).toContain(
      "claude mcp add --transport http --scope user doco https://doco.test/mcp",
    );
    expect(button("Copy prompt")).toBeUndefined();
  });

  it("goes on to the prompt, which it copies, and back", async () => {
    await render();
    await act(async () => button("Next")?.click());
    expect(dialog().textContent).toContain("Step 2 of 2: Ask your agent to start using Doco");
    expect(dialog().querySelector("pre")?.textContent).toContain(
      "Doco workspace: https://doco.test/workspaces/torre",
    );
    expect(document.activeElement).toBe(button("Copy prompt"));
    await act(async () => button("Copy prompt")?.click());
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Doco workspace: https://doco.test/workspaces/torre"),
    );
    await act(async () => button("Back")?.click());
    expect(dialog().textContent).toContain("Which agent do you use?");
  });
});
