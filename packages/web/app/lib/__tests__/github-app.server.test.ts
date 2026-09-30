import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  buildAppJwt,
  exchangeInstallationCode,
  getInstallationAccount,
  githubAppConfigured,
  listInstallationRepos,
  listRepoIssues,
  listRepoPullRequests,
  listUserInstallationIds,
  mintInstallationToken,
  normalizePem,
  retryAfterMsFromHeaders,
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
    expect(result.items.map((p) => p.number)).toEqual([1, 2]);
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
    expect(result.items).toHaveLength(1);
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

describe("listRepoIssues", () => {
  it("pages every issue, open and closed, from startPage, and says when more remain", async () => {
    const page2 = new Response(
      JSON.stringify([{ number: 7, title: "a", html_url: "u7", state: "open", labels: [] }]),
      { status: 200, headers: { Link: '<https://api.github.com/x?page=3>; rel="next"' } },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(page2);
    const result = await listRepoIssues("ghs_x", "acme", "store", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startPage: 2,
      maxPages: 1,
    });
    expect(result.items.map((i) => i.number)).toEqual([7]);
    expect(result.hasMore).toBe(true);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      "https://api.github.com/repos/acme/store/issues?state=all&per_page=100&page=2",
    );
  });
});

describe("exchangeInstallationCode", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("trades the post-install code for a user token with the App's client credentials", async () => {
    process.env.DOCO_GITHUB_APP_CLIENT_ID = "Iv23.client";
    process.env.DOCO_GITHUB_APP_CLIENT_SECRET = "app-secret";
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "ghu_user" }), { status: 200 }),
    );
    const token = await exchangeInstallationCode("code-1", fetchImpl as unknown as typeof fetch);
    expect(token).toBe("ghu_user");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: "Iv23.client",
      client_secret: "app-secret",
      code: "code-1",
    });
  });

  it("throws when GitHub rejects the code", async () => {
    process.env.DOCO_GITHUB_APP_CLIENT_ID = "Iv23.client";
    process.env.DOCO_GITHUB_APP_CLIENT_SECRET = "app-secret";
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 }),
    );
    await expect(
      exchangeInstallationCode("stale", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("throws when the App's client credentials aren't configured", async () => {
    process.env.DOCO_GITHUB_APP_CLIENT_ID = "";
    process.env.DOCO_GITHUB_APP_CLIENT_SECRET = "";
    await expect(exchangeInstallationCode("code-1", vi.fn() as never)).rejects.toThrow(
      /DOCO_GITHUB_APP_CLIENT_ID/,
    );
  });
});

describe("listUserInstallationIds", () => {
  it("collects the installation ids the user can access across pages", async () => {
    const page1 = new Response(JSON.stringify({ installations: [{ id: 1 }, { id: 2 }] }), {
      status: 200,
      headers: { Link: '<https://api.github.com/user/installations?page=2>; rel="next"' },
    });
    const page2 = new Response(JSON.stringify({ installations: [{ id: 3 }] }), { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const ids = await listUserInstallationIds("ghu_user", fetchImpl as unknown as typeof fetch);
    expect([...ids]).toEqual([1, 2, 3]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=1",
    );
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

describe("retryAfterMsFromHeaders", () => {
  const NOW = 1_000_000;
  it("uses the Retry-After header (seconds) when present", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "30" }), NOW)).toBe(30_000);
  });
  it("falls back to x-ratelimit-reset when the budget is exhausted", () => {
    const resetSec = Math.floor(NOW / 1000) + 45;
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSec),
    });
    expect(retryAfterMsFromHeaders(headers, NOW)).toBe(45_000);
  });
  it("returns null when there is no rate-limit timing to read", () => {
    expect(retryAfterMsFromHeaders(new Headers(), NOW)).toBeNull();
  });
  it("never returns a negative wait (a reset already in the past clamps to 0)", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" });
    expect(retryAfterMsFromHeaders(headers, NOW)).toBe(0);
  });
});

// A backfill walking a 16k-PR org WILL hit GitHub's primary/secondary rate
// limits and the occasional gone/forbidden repo. githubGet must classify those
// so the driver can pause-and-resume (rate limit) vs. skip-and-continue
// (permanent) instead of throwing an opaque Error that wedges the whole import.
describe("GitHub API error classification (surfaced through listRepoPullRequests)", () => {
  const call = (res: Response) =>
    listRepoPullRequests("ghs_x", "acme", "store", {
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });

  it("classifies HTTP 429 as a rate limit carrying the retry delay", async () => {
    const err = (await call(
      new Response("slow down", { status: 429, headers: { "retry-after": "20" } }),
    ).catch((e) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.rateLimited).toBe(true);
    expect(err.permanent).toBe(false);
    expect(err.retryAfterMs).toBe(20_000);
  });

  it("classifies 403 with x-ratelimit-remaining:0 as a rate limit", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 60;
    const err = (await call(
      new Response("API rate limit exceeded", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSec) },
      }),
    ).catch((e) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.rateLimited).toBe(true);
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  it("classifies 404 as permanent — the repo is skipped, never retried forever", async () => {
    const err = (await call(new Response("Not Found", { status: 404 })).catch(
      (e) => e,
    )) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.permanent).toBe(true);
    expect(err.rateLimited).toBe(false);
  });

  it("classifies a bare 403 (no rate-limit signal) as permanent — access revoked", async () => {
    const err = (await call(new Response("Forbidden", { status: 403 })).catch(
      (e) => e,
    )) as GitHubApiError;
    expect(err.permanent).toBe(true);
    expect(err.rateLimited).toBe(false);
  });

  it("classifies 5xx as transient (neither rate-limited nor permanent)", async () => {
    const err = (await call(new Response("Server Error", { status: 500 })).catch(
      (e) => e,
    )) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.rateLimited).toBe(false);
    expect(err.permanent).toBe(false);
  });
});
