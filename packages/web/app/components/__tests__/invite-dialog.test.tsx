// @vitest-environment happy-dom
//
// Alexander, 2026-10-06: after Generate link, "show the link and the
// instructions to invite them in a dialog so that they don't confuse it with
// something else". A person's invite copies with "Copy invite", an agent's
// with "Copy prompt".
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteDialog, PersonInviteDialog } from "../invite-dialog";

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

describe("InviteDialog", () => {
  it("opens as a modal holding only the message and a copy button named for the recipient", async () => {
    await act(async () =>
      root.render(
        <InviteDialog
          title="Send this prompt to your agent"
          message="Start using Doco"
          copyLabel="Copy prompt"
          onClose={() => {}}
        />,
      ),
    );
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("Send this prompt to your agent");
    expect(dialog().querySelector("pre")?.textContent).toBe("Start using Doco");
    expect(button("Copy prompt")).toBeDefined();
    expect(document.activeElement).toBe(button("Copy prompt"));
  });

  it("copies the message and says so", async () => {
    await act(async () =>
      root.render(
        <InviteDialog
          title="t"
          message="Start using Doco"
          copyLabel="Copy prompt"
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => button("Copy prompt")?.click());
    expect(writeText).toHaveBeenCalledWith("Start using Doco");
    expect(button("Copied!")).toBeDefined();
  });

  it("closes from its Close button", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(<InviteDialog title="t" message="m" copyLabel="Copy prompt" onClose={onClose} />),
    );
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PersonInviteDialog", () => {
  it("hands over the person's invite with Copy invite", async () => {
    await act(async () =>
      root.render(
        <PersonInviteDialog
          inviteUrl="https://doco.test/invite/abc"
          note="Single-use, expires in 72 hours."
          onClose={() => {}}
        />,
      ),
    );
    expect(dialog().querySelector("pre")?.textContent).toBe(
      "Let's share knowledge on Doco. Open this URL and accept the invite:\n\nhttps://doco.test/invite/abc",
    );
    expect(dialog().textContent).toContain("Single-use, expires in 72 hours.");
    expect(button("Copy invite")).toBeDefined();
    expect(button("Copy prompt")).toBeUndefined();
  });
});
