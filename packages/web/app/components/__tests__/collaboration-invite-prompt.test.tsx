import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollaborationInvitePrompt } from "../collaboration-invite-prompt";

describe("CollaborationInvitePrompt", () => {
  it("styles copy prompt buttons with the primary purple treatment", () => {
    const markup = renderToStaticMarkup(
      createElement(CollaborationInvitePrompt, {
        inviteUrl: "https://doco.test/invite/abc",
        copyButtonTestId: "invite-copy-prompt",
      }),
    );

    const copyButton =
      markup.match(
        /<button type="button" data-testid="invite-copy-prompt" class="([^"]*)">/,
      )?.[1] ?? "";

    expect(copyButton).toContain("bg-primary");
    expect(copyButton).toContain("text-primary-foreground");
  });
});
