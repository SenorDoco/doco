import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAppJwt,
  githubAppConfigured,
  listRepoPullRequests,
  mintInstallationToken,
} from "../github-app.server";

// A throwaway RSA keypair for signing/verifying test JWTs (pkcs1, like GitHub's).
const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = kp.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUB = kp.publicKey.export({ type: "spki", format: "pem" }).toString();

function b64urlToBuf(seg: string): Buffer {
  return Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(b64urlToBuf(seg).toString("utf8"));
}

describe("buildAppJwt", () => {
  it("builds a verifiable RS256 JWT with the expected claims", () => {
    const now = 1_700_000_000;
    const jwt = buildAppJwt({ appId: "123456", privateKey: PEM, nowSeconds: now });
    const [h, p, s] = jwt.split(".");
    expect(decodeSegment(h)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const payload = decodeSegment(p) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBeLessThanOrEqual(now);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const verified = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(PUB, b64urlToBuf(s));
    expect(verified).toBe(true);
  });

  it("accepts a PEM whose newlines are backslash-escaped (env-var style)", () => {
    const escaped = PEM.replace(/\n/g, "\\n");
    const jwt = buildAppJwt({ appId: "1", privateKey: escaped, nowSeconds: 1 });
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("githubAppConfigured", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("true when app id + private key are present", () => {
    process.env.DOCO_GITHUB_APP_ID = "1";
    process.env.DOCO_GITHUB_APP_PRIVATE_KEY = "k";
    expect(githubAppConfigured()).toBe(true);
  });
  it("false when either is missing", () => {
    process.env.DOCO_GITHUB_APP_ID = "1";
    process.env.DOCO_GITHUB_APP_PRIVATE_KEY = "";
    expect(githubAppConfigured()).toBe(false);
  });
});

describe("mintInstallationToken", () => {
  it("POSTs to the installation access_tokens endpoint with the app JWT", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghs_abc", expires_at: "2026-01-01T00:00:00Z" }), {
          status: 201,
        }),
    );
    const res = await mintInstallationToken("42", {
      appId: "1",
      privateKey: PEM,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.token).toBe("ghs_abc");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer .+\..+\..+$/);
  });
});

describe("listRepoPullRequests", () => {
  it("follows pagination until there is no rel=next link", async () => {
    const page1 = new Response(
      JSON.stringify([{ number: 1, title: "a", html_url: "u1", state: "open" }]),
      { status: 200, headers: { Link: '<https://api.github.com/x?page=2>; rel="next"' } },
    );
    const page2 = new Response(
      JSON.stringify([{ number: 2, title: "b", html_url: "u2", state: "closed" }]),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const prs = await listRepoPullRequests("ghs_x", "acme", "store", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
