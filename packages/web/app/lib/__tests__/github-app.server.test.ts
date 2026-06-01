import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAppJwt,
  getInstallationAccount,
  githubAppConfigured,
  listInstallationRepos,
  listRepoPullRequests,
  mintInstallationToken,
  normalizePem,
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

describe("getInstallationAccount", () => {
  it("fetches the installation account login with an app JWT", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ account: { login: "acme" }, repository_selection: "all" }), {
          status: 200,
        }),
    );
    const res = await getInstallationAccount("42", {
      appId: "1",
      privateKey: PEM,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res).toEqual({ account: "acme", repository_selection: "all" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/42");
    expect(init.method).toBe("GET");
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
    const result = await listRepoPullRequests("ghs_x", "acme", "store", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(result.hasMore).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sets hasMore when maxPages is reached with a next link", async () => {
    const page1 = new Response(
      JSON.stringify([{ number: 1, title: "a", html_url: "u1", state: "open" }]),
      { status: 200, headers: { Link: '<https://api.github.com/x?page=2>; rel="next"' } },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(page1);
    const result = await listRepoPullRequests("ghs_x", "acme", "store", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxPages: 1,
    });
    expect(result.prs).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it("respects startPage by passing it to the GitHub API", async () => {
    const page3 = new Response(
      JSON.stringify([{ number: 3, title: "c", html_url: "u3", state: "open" }]),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(page3);
    await listRepoPullRequests("ghs_x", "acme", "store", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startPage: 3,
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("page=3");
  });
});

describe("listInstallationRepos", () => {
  it("collects repo full names across pages", async () => {
    const page1 = new Response(
      JSON.stringify({ repositories: [{ full_name: "acme/a" }, { full_name: "acme/b" }] }),
      { status: 200, headers: { Link: '<https://api.github.com/x?page=2>; rel="next"' } },
    );
    const page2 = new Response(JSON.stringify({ repositories: [{ full_name: "acme/c" }] }), {
      status: 200,
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const repos = await listInstallationRepos("ghs_x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(repos).toEqual(["acme/a", "acme/b", "acme/c"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the account repo list for all-repository installations", async () => {
    const installationRepos = new Response(JSON.stringify({ repositories: [] }), { status: 200 });
    const accountRepos = new Response(
      JSON.stringify([{ full_name: "Doco-to/doco" }, { full_name: "Doco-to/agents" }]),
      { status: 200 },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(installationRepos)
      .mockResolvedValueOnce(accountRepos);

    const repos = await listInstallationRepos("ghs_x", {
      account: "Doco-to",
      repositorySelection: "all",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(repos).toEqual(["Doco-to/agents", "Doco-to/doco"]);
    const [fallbackUrl] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(fallbackUrl).toBe(
      "https://api.github.com/orgs/Doco-to/repos?type=all&per_page=100&page=1",
    );
  });
});

describe("buildAppJwt tolerates env-mangled private keys", () => {
  const verifies = (jwt: string): boolean => {
    const [h, p, s] = jwt.split(".");
    return createVerify("RSA-SHA256").update(`${h}.${p}`).verify(PUB, b64urlToBuf(s));
  };
  it("newlines collapsed to spaces (single-line)", () => {
    const mangled = PEM.replace(/\n/g, " ");
    expect(verifies(buildAppJwt({ appId: "1", privateKey: mangled, nowSeconds: 1 }))).toBe(true);
  });
  it("backslash-n escaped", () => {
    const mangled = PEM.replace(/\n/g, "\\n");
    expect(verifies(buildAppJwt({ appId: "1", privateKey: mangled, nowSeconds: 1 }))).toBe(true);
  });
  it("wrapped in quotes", () => {
    expect(verifies(buildAppJwt({ appId: "1", privateKey: `"${PEM}"`, nowSeconds: 1 }))).toBe(true);
  });
});

describe("normalizePem", () => {
  it("rebuilds a space-collapsed PEM into newline-delimited form", () => {
    const out = normalizePem(PEM.replace(/\n/g, " "));
    expect(out).toContain("\n");
    expect(out.startsWith("-----BEGIN")).toBe(true);
    expect(out.trimEnd().endsWith("KEY-----")).toBe(true);
  });
});
