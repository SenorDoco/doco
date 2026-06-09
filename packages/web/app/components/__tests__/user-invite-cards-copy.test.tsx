import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserInviteCards } from "../user-invite-cards";

const fetcherState = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({
      data: fetcherState.data,
      state: "idle",
      Form: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement("form", props, children),
    }),
  };
});

vi.mock("~/components/grant-picker", () => ({
  GrantPicker: () => createElement("div", { "data-testid": "grant-picker" }),
}));

describe("UserInviteCards copy", () => {
  beforeEach(() => {
    fetcherState.data = null;
  });

  it("uses digital identity and MCP copy for agent alternatives", () => {
    const markup = renderToStaticMarkup(
      createElement(UserInviteCards, {
        invite: {
          workspaces: [],
          docos: [],
          defaultSelection: { level: "workspace", targetId: "" },
        },
      }),
    );

    expect(markup).toContain("Invite a person or agent with their own digital identity");
    expect(markup).toContain("Adding a traditional AI agent instead?");
    expect(markup).toContain("Connect to Doco&#x27;s MCP");
    expect(markup).not.toContain("Invite a person</h2>");
    expect(markup).not.toContain("Adding an AI agent instead?");
    expect(markup).not.toContain("Invite an agent from the API Tokens page");
  });

  it("notes only that the invite is single-use and expiring, without restating the grant", () => {
    fetcherState.data = {
      intent: "invite",
      ok: true,
      invite_url: "https://doco.to/invite/abc123",
      doco_url: "https://doco.to/acme",
      recipe_url: "https://doco.to/protocol/oauth",
      device_url: "https://doco.to/device",
      invite_expires_at: "2026-06-12T00:00:00.000Z",
      level: "workspace",
      role: "owner",
    };

    const markup = renderToStaticMarkup(
      createElement(UserInviteCards, {
        invite: {
          workspaces: [],
          docos: [],
          defaultSelection: { level: "workspace", targetId: "" },
        },
      }),
    );

    expect(markup).toContain("Single-use, expires in 72 hours.");
    // The grant the link confers is already shown by the grant picker above —
    // don't restate it in the note.
    expect(markup).not.toContain("Grants");
    expect(markup).not.toContain("at the");
  });
});
