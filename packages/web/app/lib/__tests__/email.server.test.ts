// The one email sender: Resend's HTTPS API when its key is set, and a no-op
// that says why otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailBaseUrl, emailConfigured, sendEmail } from "../email.server";

const EMAIL = { to: "ana@example.com", subject: "Hello", text: "Hi Ana" };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("DOCO_EMAIL_FROM", "");
  vi.stubEnv("DOCO_PUBLIC_HOST", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendEmail", () => {
  it("sends through Resend from Doco's address", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await sendEmail(EMAIL)).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Doco <notifications@doco.to>",
      to: ["ana@example.com"],
      subject: "Hello",
      text: "Hi Ana",
    });
  });

  it("sends from DOCO_EMAIL_FROM when set", async () => {
    vi.stubEnv("DOCO_EMAIL_FROM", "Doco <alerts@doco.to>");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await sendEmail(EMAIL);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).from).toBe("Doco <alerts@doco.to>");
  });

  it("sends nothing without a key, and says so", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(emailConfigured()).toBe(false);
    expect(await sendEmail(EMAIL)).toEqual({
      sent: false,
      error: "Email isn't configured: RESEND_API_KEY is unset.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refusal or an unreachable provider instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("domain not verified", { status: 403 }));
    expect(await sendEmail(EMAIL)).toEqual({
      sent: false,
      error: "Resend refused the email (403): domain not verified",
    });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendEmail(EMAIL)).toEqual({
      sent: false,
      error: "Resend couldn't be reached: socket hang up",
    });
  });
});

describe("emailBaseUrl", () => {
  it("links to the public site", () => {
    expect(emailBaseUrl()).toBe("https://doco.to");
    vi.stubEnv("DOCO_PUBLIC_HOST", "https://staging.doco.to/");
    expect(emailBaseUrl()).toBe("https://staging.doco.to");
  });
});
