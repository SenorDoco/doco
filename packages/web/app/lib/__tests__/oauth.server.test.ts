import { describe, expect, it } from "vitest";

import { type OAuthConfig, startOAuth } from "../oauth.server";

function testConfig(): OAuthConfig {
  return {
    clientId: "test-client-id",
    clientSecret: "test-secret",
    redirectUri: "https://doco.to/auth/github/callback",
    stateKey: Buffer.from("test-state-key", "utf8"),
  };
}

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
