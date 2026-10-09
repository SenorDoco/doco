import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type OAuthConfig, startOAuth, verifyOAuthState } from "../oauth.server";

function testConfig(): OAuthConfig {
  return {
    clientId: "test-client-id",
    clientSecret: "test-secret",
    redirectUri: "https://doco.to/auth/github/callback",
  };
}

beforeEach(() => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("startOAuth", () => {
  it("forces GitHub's account picker so a sign-out can't be silently undone", () => {
    const { url } = startOAuth(testConfig());
    const params = new URL(url).searchParams;
    // Without prompt=select_account, a still-active GitHub session silently
    // re-authorizes the moment the user clicks "Continue with GitHub" — so
    // signing out of Doco feels broken (you're bounced straight back in).
    expect(params.get("prompt")).toBe("select_account");
  });

  it("targets GitHub's authorize endpoint with the registered client + redirect", () => {
    const { url } = startOAuth(testConfig());
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://doco.to/auth/github/callback");
  });

  it("pins the authorize state to a cookie for CSRF protection", () => {
    const { url, setCookie } = startOAuth(testConfig());
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(setCookie).toContain(`doco_oauth_state=${encodeURIComponent(state ?? "")}`);
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("verifyOAuthState", () => {
  function started(): { state: string; cookie: string } {
    const { url, setCookie } = startOAuth(testConfig());
    return {
      state: new URL(url).searchParams.get("state") ?? "",
      cookie: setCookie.split(";")[0] ?? "",
    };
  }

  it("accepts the state this browser was sent off with", () => {
    const { state, cookie } = started();
    expect(verifyOAuthState(state, cookie)).toBe("valid");
  });

  it("rejects a state another browser was sent off with", () => {
    const { cookie } = started();
    expect(verifyOAuthState(started().state, cookie)).toBe("mismatch");
    expect(verifyOAuthState(started().state, null)).toBe("missing_cookie");
  });

  it("rejects a state the server didn't issue, even when the cookie matches it", () => {
    // Signed the way states used to be, under the default key in the public
    // source.
    const payload = `${randomBytes(16).toString("hex")}.${Math.floor(Date.now() / 1000)}`;
    const sig = createHmac("sha256", "doco-dev-default-state-key").update(payload).digest("hex");
    const forged = `${payload}.${sig}`;
    expect(verifyOAuthState(forged, `doco_oauth_state=${encodeURIComponent(forged)}`)).toBe(
      "invalid",
    );
  });

  it("rejects a state older than ten minutes", () => {
    vi.useFakeTimers();
    const { state, cookie } = started();
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(verifyOAuthState(state, cookie)).toBe("invalid");
  });
});
