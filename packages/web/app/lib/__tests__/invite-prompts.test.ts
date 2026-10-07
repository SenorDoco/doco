import { describe, expect, it } from "vitest";
import { buildHumanInvitePrompt } from "../invite-prompts";

describe("buildHumanInvitePrompt", () => {
  // Alexander, 2026-10-06: "You're invited to collaborate on a doco. Open this
  // URL in your browser, sign in, and click Accept:" => "Let's share knowledge
  // on Doco. Open this URL and accept the invite:"
  it("asks the person to share knowledge on Doco and accept the invite", () => {
    expect(buildHumanInvitePrompt("https://doco.test/invite/abc")).toBe(
      "Let's share knowledge on Doco. Open this URL and accept the invite:\n\nhttps://doco.test/invite/abc",
    );
  });
});
