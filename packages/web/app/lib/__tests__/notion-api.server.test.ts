import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTION_API_VERSION,
  NotionApiError,
  callNotion,
  exchangeNotionCode,
  listNotionUsers,
  notionAuthorizeUrl,
  refreshNotionToken,
  searchNotion,
  verifyNotionSignature,
} from "../notion-api.server";

type Recorded = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

beforeEach(() => {
  vi.stubEnv("DOCO_NOTION_CLIENT_ID", "client");
  vi.stubEnv("DOCO_NOTION_CLIENT_SECRET", "secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("callNotion", () => {
  it("sends the bearer token and the API version, and JSON for a body", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ object: "list", results: [] }));

    await searchNotion("ntn_token", "cursor1", fetchImpl);

    expect(calls[0].url).toBe("https://api.notion.com/v1/search");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer ntn_token",
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
      start_cursor: "cursor1",
    });
  });

  it("surfaces Notion's rate limit with its Retry-After", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("", { status: 429, headers: { "Retry-After": "12" } }),
    );

    const error = await callNotion("t", "GET", "/pages/p1", undefined, fetchImpl).catch((e) => e);

    expect(error).toBeInstanceOf(NotionApiError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 12_000 });
  });

  it("surfaces Notion's error code and message", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        { object: "error", status: 404, code: "object_not_found", message: "Could not find page." },
        { status: 404 },
      ),
    );

    const error = await callNotion("t", "GET", "/pages/p1", undefined, fetchImpl).catch((e) => e);

    expect(error).toMatchObject({ status: 404, code: "object_not_found" });
    expect((error as Error).message).toContain("Could not find page.");
  });

  it("pages the users listing through the query string", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ results: [] }));

    await listNotionUsers("t", "next", fetchImpl);

    expect(calls[0].url).toBe("https://api.notion.com/v1/users?page_size=100&start_cursor=next");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });
});

describe("OAuth", () => {
  it("builds the authorization URL Notion's page picker opens from", () => {
    const url = new URL(
      notionAuthorizeUrl({
        clientId: "client",
        redirectUri: "https://doco.to/integrations/notion/callback",
        state: "signed",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      response_type: "code",
      owner: "user",
      redirect_uri: "https://doco.to/integrations/notion/callback",
      state: "signed",
    });
  });

  it("exchanges the code with HTTP Basic client credentials", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        access_token: "ntn_a",
        refresh_token: "ntn_r",
        bot_id: "bot1",
        workspace_id: "ws1",
        workspace_name: "Acme",
        workspace_icon: null,
        owner: { type: "user", user: { id: "u1", name: "Tania" } },
      }),
    );

    const tokens = await exchangeNotionCode("code1", "https://doco.to/cb", fetchImpl);

    expect(calls[0].url).toBe("https://api.notion.com/v1/oauth/token");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client:secret").toString("base64")}`,
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_type: "authorization_code",
      code: "code1",
      redirect_uri: "https://doco.to/cb",
    });
    expect(tokens).toEqual({
      access_token: "ntn_a",
      refresh_token: "ntn_r",
      bot_id: "bot1",
      workspace_id: "ws1",
      workspace_name: "Acme",
      workspace_icon: null,
      owner: { type: "user", user: { id: "u1", name: "Tania" } },
    });
  });

  it("refreshes with the refresh token, and reports a refused refresh", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }),
    );

    const error = await refreshNotionToken("ntn_r", fetchImpl).catch((e) => e);

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "ntn_r",
    });
    expect(error).toMatchObject({ status: 400, code: "invalid_grant" });
  });

  it("refuses to run without client credentials, before any request", async () => {
    vi.stubEnv("DOCO_NOTION_CLIENT_ID", "");
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    await expect(exchangeNotionCode("c", "https://doco.to/cb", fetchImpl)).rejects.toThrow(
      /DOCO_NOTION_CLIENT_ID/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("verifyNotionSignature", () => {
  const rawBody = JSON.stringify({ type: "page.created" });
  const secret = "secret_token";
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts Notion's signature and rejects everything else", () => {
    expect(verifyNotionSignature({ rawBody, signature, secret })).toBe(true);
    expect(verifyNotionSignature({ rawBody, signature: `${signature}0`, secret })).toBe(false);
    expect(verifyNotionSignature({ rawBody, signature, secret: "other" })).toBe(false);
    expect(verifyNotionSignature({ rawBody, signature: null, secret })).toBe(false);
    expect(verifyNotionSignature({ rawBody, signature, secret: "" })).toBe(false);
  });
});
