import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionPrincipalId, sessionCookie, setSessionCookie } from "../session.server";

const USER = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DAY = 24 * 60 * 60 * 1000;

function requestWith(cookie: string): Request {
  return new Request("https://doco.to/workspaces", { headers: { cookie } });
}

/** The `name=value` pair a Set-Cookie header sets. */
function pairOf(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

beforeEach(() => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie", () => {
  it("signs in the person whose cookie the server set", () => {
    const setCookie = setSessionCookie(USER);
    expect(setCookie).toContain("HttpOnly");
    expect(getSessionPrincipalId(requestWith(pairOf(setCookie)))).toBe(USER);
  });

  it("signs no one in from a cookie holding a bare user id", () => {
    expect(getSessionPrincipalId(requestWith(`doco_session=${USER}`))).toBeNull();
  });

  it("signs no one in from a tampered cookie", () => {
    const token = decodeURIComponent(pairOf(setSessionCookie(USER)).slice("doco_session=".length));
    const [head, , body] = token.split(".");
    const tampered = `${head}.${randomBytes(16).toString("base64url")}.${body}`;
    expect(
      getSessionPrincipalId(requestWith(`doco_session=${encodeURIComponent(tampered)}`)),
    ).toBeNull();
  });

  it("signs no one in from a cookie sealed under another server's key", () => {
    const cookie = pairOf(setSessionCookie(USER));
    vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(getSessionPrincipalId(requestWith(cookie))).toBeNull();
  });

  it("lasts 30 days", () => {
    const cookie = pairOf(setSessionCookie(USER));
    expect(setSessionCookie(USER)).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(getSessionPrincipalId(requestWith(cookie), Date.now() + 29 * DAY)).toBe(USER);
    expect(getSessionPrincipalId(requestWith(cookie), Date.now() + 31 * DAY)).toBeNull();
  });

  it("finds the session among other cookies", () => {
    const cookie = pairOf(setSessionCookie(USER));
    expect(getSessionPrincipalId(requestWith(`theme=dark; ${cookie}; other=1`))).toBe(USER);
  });

  it("lets the server call its own API as a linked person", () => {
    expect(getSessionPrincipalId(requestWith(sessionCookie(USER)))).toBe(USER);
  });
});
