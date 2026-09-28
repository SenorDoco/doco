// Notion's REST API, as the mirror uses it (schema.sql → "Notion mirror").
//
// One fetch wrapper speaks the current API version, surfaces Notion's error
// codes as NotionApiError, and turns a 429 into a pause the sync honors
// (Notion's Retry-After, in seconds). The OAuth token exchange and refresh sit
// beside it, as does the webhook signature check. Every call takes an
// injectable fetch, so tests run without Notion.
import { createHmac, timingSafeEqual } from "node:crypto";

export const NOTION_API_VERSION = "2026-03-11";
const NOTION_API = "https://api.notion.com/v1";

export type Json = Record<string, unknown>;

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Set on a rate limit: how long Notion asked to wait. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Notion ${code} (HTTP ${status}): ${message}`);
  }
}

export interface NotionConfig {
  clientId: string;
  clientSecret: string;
  /** The verification token of the webhook subscription (see api.notion.webhook). */
  webhookSecret: string;
  configured: boolean;
}

export function getNotionConfig(): NotionConfig {
  const clientId = process.env.DOCO_NOTION_CLIENT_ID ?? "";
  const clientSecret = process.env.DOCO_NOTION_CLIENT_SECRET ?? "";
  return {
    clientId,
    clientSecret,
    webhookSecret: process.env.DOCO_NOTION_WEBHOOK_SECRET ?? "",
    configured: Boolean(clientId && clientSecret),
  };
}

/** One Notion API call. Throws `NotionApiError`, with Notion's Retry-After on
 *  a rate limit. */
export async function callNotion<T extends Json>(
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Json,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new NotionApiError(
      429,
      "rate_limited",
      "Rate limited.",
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    throw new NotionApiError(
      res.status,
      typeof json.code === "string" ? json.code : `http_${res.status}`,
      typeof json.message === "string" ? json.message : `HTTP ${res.status}`,
    );
  }
  return json as T;
}

// ── OAuth ─────────────────────────────────────────────────────────────────

export interface NotionTokenResponse {
  access_token: string;
  refresh_token: string | null;
  bot_id: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  /** `{ type: "user", user: {…} }` for a person's authorization. */
  owner: Json;
}

/** The authorization page Notion shows, with its page picker. `state` is the
 *  signed value the callback verifies (lib/notion-mirror-setup.server.ts). */
export function notionAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  return `${NOTION_API}/oauth/authorize?${params.toString()}`;
}

async function oauthToken(body: Json, fetchImpl: typeof fetch): Promise<NotionTokenResponse> {
  const { clientId, clientSecret } = getNotionConfig();
  if (!clientId || !clientSecret) {
    throw new Error("DOCO_NOTION_CLIENT_ID / DOCO_NOTION_CLIENT_SECRET are not configured.");
  }
  const res = await fetchImpl(`${NOTION_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || typeof json.access_token !== "string") {
    const code = json.error ?? json.code;
    const message = json.error_description ?? json.message;
    throw new NotionApiError(
      res.status,
      typeof code === "string" ? code : `http_${res.status}`,
      typeof message === "string" ? message : `HTTP ${res.status}`,
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : null,
    bot_id: String(json.bot_id ?? ""),
    workspace_id: String(json.workspace_id ?? ""),
    workspace_name: typeof json.workspace_name === "string" ? json.workspace_name : null,
    workspace_icon: typeof json.workspace_icon === "string" ? json.workspace_icon : null,
    owner: json.owner && typeof json.owner === "object" ? (json.owner as Json) : {},
  };
}

/** Trade the `code` Notion hands back after authorization for the token pair. */
export function exchangeNotionCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionTokenResponse> {
  return oauthToken(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    fetchImpl,
  );
}

/** A fresh token pair. Notion says to store every pair it returns. */
export function refreshNotionToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionTokenResponse> {
  return oauthToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

// ── Webhooks ──────────────────────────────────────────────────────────────

/**
 * Notion signs every delivery: `X-Notion-Signature: sha256=<HMAC-SHA256 of
 * the raw body, keyed with the subscription's verification token>`. Constant
 * time; false on any missing input so the route answers 401. Pure.
 */
export function verifyNotionSignature(args: {
  rawBody: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!args.signature || !args.secret) return false;
  const expected = `sha256=${createHmac("sha256", args.secret).update(args.rawBody).digest("hex")}`;
  const a = Buffer.from(args.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── The calls the mirror makes ────────────────────────────────────────────

export interface NotionList<T = Json> extends Json {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  /** `incomplete` when Notion capped the listing. */
  request_status?: { type: string; reason?: string };
}

const PAGE_SIZE = 100;

/** Every page and data source shared with the connection, most recently
 *  edited first, a hundred at a time. */
export function searchNotion(
  token: string,
  cursor: string | null,
  fetchImpl?: typeof fetch,
): Promise<NotionList> {
  return callNotion<NotionList>(
    token,
    "POST",
    "/search",
    {
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: PAGE_SIZE,
      ...(cursor ? { start_cursor: cursor } : {}),
    },
    fetchImpl,
  );
}

export function getNotionPage(token: string, pageId: string, fetchImpl?: typeof fetch) {
  return callNotion<Json>(token, "GET", `/pages/${pageId}`, undefined, fetchImpl);
}

export interface NotionPageMarkdown extends Json {
  markdown?: string;
  truncated?: boolean;
  unknown_block_ids?: string[];
}

/** The page as Notion's enhanced Markdown; `truncated` past about 20,000
 *  blocks, with the missing subtrees' ids in `unknown_block_ids`. The same
 *  call on a block id returns that subtree. */
export function getNotionPageMarkdown(token: string, id: string, fetchImpl?: typeof fetch) {
  return callNotion<NotionPageMarkdown>(
    token,
    "GET",
    `/pages/${id}/markdown`,
    undefined,
    fetchImpl,
  );
}

export function getNotionDataSource(token: string, id: string, fetchImpl?: typeof fetch) {
  return callNotion<Json>(token, "GET", `/data_sources/${id}`, undefined, fetchImpl);
}

/** A data source's rows (pages), a hundred at a time. */
export function queryNotionDataSource(
  token: string,
  id: string,
  cursor: string | null,
  fetchImpl?: typeof fetch,
): Promise<NotionList> {
  return callNotion<NotionList>(
    token,
    "POST",
    `/data_sources/${id}/query`,
    { page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) },
    fetchImpl,
  );
}

/** The workspace's members and bots (not guests), a hundred at a time. Needs
 *  the user-information capability. */
export function listNotionUsers(
  token: string,
  cursor: string | null,
  fetchImpl?: typeof fetch,
): Promise<NotionList> {
  const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (cursor) query.set("start_cursor", cursor);
  return callNotion<NotionList>(token, "GET", `/users?${query.toString()}`, undefined, fetchImpl);
}
