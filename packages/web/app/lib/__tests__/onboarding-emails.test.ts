// A new workspace's creator gets a welcome email that links to it, and 15
// minutes later a reminder while a step is open. When asking the agent is the
// next step, the reminder carries the message for the agent right away.
import { describe, expect, it } from "vitest";
import { agentInstructionsForWorkspace } from "../agent-instructions";
import { reminderEmail, welcomeEmail } from "../onboarding-emails";

const base = { baseUrl: "https://doco.test", workspaceHandle: "acme" };

describe("welcomeEmail", () => {
  const email = welcomeEmail(base);

  it("welcomes the creator to the new workspace and links to it", () => {
    expect(email.subject).toBe("Welcome to acme on Doco");
    expect(email.text).toContain("Your workspace acme is ready.");
    expect(email.text).toContain("https://doco.test/workspaces/acme");
    expect(email.html).toContain('href="https://doco.test/workspaces/acme"');
  });

  it("names the four steps that set it up", () => {
    expect(email.text).toContain(
      "Four steps set it up: connect GitHub, connect other sources of knowledge, connect Doco to your agent, and ask your agent to start using Doco.",
    );
  });
});

describe("reminderEmail", () => {
  it("invites the creator to finish the four simple steps, marking the done ones", () => {
    const email = reminderEmail({
      ...base,
      steps: [
        { step: "github", done: true },
        { step: "sources", done: false },
        { step: "mcp", done: false },
        { step: "agent", done: false },
      ],
    });
    expect(email.subject).toBe("Finish setting up acme on Doco");
    expect(email.text).toContain("acme is four simple steps from");
    expect(email.text).toContain(
      "1. Connect GitHub (done)\n2. Connect other sources of knowledge\n3. Connect Doco to your agent\n4. Ask your agent to start using Doco\n",
    );
    expect(email.text).toContain("https://doco.test/workspaces/acme");
    expect(email.text).not.toContain("doco:begin");
  });

  it("hands over the agent's message when asking the agent is the next step", () => {
    const email = reminderEmail({
      ...base,
      steps: [
        { step: "github", done: true },
        { step: "sources", done: true },
        { step: "mcp", done: true },
        { step: "agent", done: false },
      ],
    });
    expect(email.subject).toBe("Ask your agent to start using Doco in acme");
    expect(email.text).toContain("and turn on the Doco hook.");
    expect(email.text).toContain(agentInstructionsForWorkspace("https://doco.test", "acme"));
  });

  it("sends someone who joined from an invite to connect their agent first", () => {
    const email = reminderEmail({
      ...base,
      steps: [
        { step: "mcp", done: false },
        { step: "agent", done: false },
      ],
    });
    expect(email.text).toContain("acme is two simple steps from");
    expect(email.text).toContain("1. Connect Doco to your agent\n");
    expect(email.text).not.toContain("doco:begin");
  });

  it("hands over the agent's message, escaped, once their agent is connected", () => {
    const email = reminderEmail({
      ...base,
      steps: [
        { step: "mcp", done: true },
        { step: "agent", done: false },
      ],
    });
    expect(email.text).toContain(agentInstructionsForWorkspace("https://doco.test", "acme"));
    // In HTML the message is escaped and keeps its line breaks.
    expect(email.html).toContain("&lt;!-- doco:begin v");
    expect(email.html).toContain("white-space:pre-wrap");
  });
});
