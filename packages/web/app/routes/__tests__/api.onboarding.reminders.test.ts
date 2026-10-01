import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueReminders: vi.fn(),
  emailConfigured: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("~/lib/email.server", async (importOriginal) => ({
  emailBaseUrl: (await importOriginal<typeof import("~/lib/email.server")>()).emailBaseUrl,
  emailConfigured: mocks.emailConfigured,
  sendEmail: mocks.sendEmail,
}));
vi.mock("~/lib/onboarding.server", () => ({ claimDueReminders: mocks.claimDueReminders }));

import { loader } from "../api.onboarding.reminders";

function call(headers: Record<string, string> = {}) {
  return loader({
    request: new Request("https://doco.test/api/onboarding/reminders", { headers }),
  });
}

const CRON = { authorization: "Bearer cron-secret" };

function due(steps: Array<{ step: string; done: boolean }>, email: string | null) {
  return {
    progress: {
      workspaceId: "workspace_acme",
      workspaceHandle: "acme",
      userId: "user_alice",
      joinedAs: steps.length === 1 ? "invitee" : "creator",
      startedAt: "2026-10-01T00:00:00.000Z",
      steps,
    },
    email,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("DOCO_PUBLIC_HOST", "");
  mocks.emailConfigured.mockReturnValue(true);
  mocks.sendEmail.mockResolvedValue({ sent: true });
  mocks.claimDueReminders.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/onboarding/reminders", () => {
  it("only answers Vercel Cron's bearer", async () => {
    expect((await call()).status).toBe(403);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(403);
    expect(mocks.claimDueReminders).not.toHaveBeenCalled();
  });

  it("claims nothing until email is set up, so those reminders still go out once it is", async () => {
    mocks.emailConfigured.mockReturnValue(false);
    const res = await call(CRON);
    expect(await res.json()).toEqual({ ok: true, skipped: "no_email" });
    expect(mocks.claimDueReminders).not.toHaveBeenCalled();
  });

  it("emails each person the steps they have left, linking to the workspace", async () => {
    mocks.claimDueReminders.mockResolvedValue([
      due(
        [
          { step: "github", done: true },
          { step: "sources", done: false },
          { step: "agent", done: false },
        ],
        "alice@example.com",
      ),
    ]);
    const res = await call(CRON);
    expect(await res.json()).toEqual({ ok: true, due: 1, sent: 1 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.to).toBe("alice@example.com");
    expect(email.subject).toBe("Finish setting up acme on Doco");
    expect(email.text).toContain("https://doco.to/workspaces/acme");
  });

  it("sends the message for the agent right away when that's all that's left", async () => {
    mocks.claimDueReminders.mockResolvedValue([
      due([{ step: "agent", done: false }], "bob@example.com"),
    ]);
    await call(CRON);
    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.subject).toBe("Ask your agent to start using Doco in acme");
    expect(email.text).toContain("in the workspace acme");
    expect(email.text).toContain("Doco workspace: https://doco.to/workspaces/acme");
  });

  it("skips a person without an email address", async () => {
    mocks.claimDueReminders.mockResolvedValue([due([{ step: "agent", done: false }], null)]);
    const res = await call(CRON);
    expect(await res.json()).toEqual({ ok: true, due: 1, sent: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("links to the public site, not the deployment the cron ran on", async () => {
    vi.stubEnv("DOCO_PUBLIC_HOST", "https://staging.doco.to");
    mocks.claimDueReminders.mockResolvedValue([
      due([{ step: "agent", done: false }], "bob@example.com"),
    ]);
    await call(CRON);
    expect(mocks.sendEmail.mock.calls[0][0].text).toContain(
      "Doco workspace: https://staging.doco.to/workspaces/acme",
    );
  });
});
