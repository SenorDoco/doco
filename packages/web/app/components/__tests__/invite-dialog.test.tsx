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

// Alexander, 2026-10-07: inviting an agent takes the one step a workspace's
// setup gives an invitee: send it the prompt. Doco supports only Claude Code,
// Codex and Gemini CLI for now, which add Doco to themselves, so connecting
// the agent is no longer a step of its own.
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

  it("opens on the prompt for the agent, which it copies", async () => {
    await render();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("Ask your agent to start using Doco");
    expect(dialog().textContent).toContain(
      "send it to Claude Code, Codex or Gemini CLI in your project",
    );
    expect(dialog().textContent).not.toContain("Step 1 of 2");
    expect(dialog().textContent).not.toContain("Which agent do you use?");
    expect(dialog().querySelector("pre")?.textContent).toContain(
      "in the workspace torre (https://doco.test/workspaces/torre)",
    );
    expect(document.activeElement).toBe(button("Copy prompt"));
    await act(async () => button("Copy prompt")?.click());
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("in the workspace torre (https://doco.test/workspaces/torre)"),
    );
    expect(button("Next")).toBeUndefined();
  });
});
