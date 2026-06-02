import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserInviteCards } from "../user-invite-cards";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({
      data: null,
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
});
