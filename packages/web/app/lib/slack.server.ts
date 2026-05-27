import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import { ensureEnvLoaded } from "./dotenv.server";

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "commands",
  "groups:read",
  "im:write",
  "team:read",
  "users:read",
] as const;

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const STATE_TTL_MS = 15 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface SlackConfig {
  appId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  configured: boolean;
}

export interface SlackOAuthState {
  installerId: string;
  nonce: string;
  issuedAt: number;
}

export interface SlackInstallationSummary {
  workspaceId: string;
  workspaceName: string;
  botUserId: string | null;
  installedAt: string;
}

export interface SlackChannelConnectionSummary {
  channelId: string;
  channelName: string;
  targetLevel: "org" | "doco";
  targetId: string;
  targetLabel: string;
  role: string;
}

export interface SlackCommandPayload {
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  text?: string;
}

interface SlackOAuthAccessResponse {
  ok: boolean;
  error?: string;
  app_id?: string;
  authed_user?: { id?: string };
  team?: { id?: string; name?: string };
  enterprise?: { id?: string; name?: string };
  is_enterprise_install?: boolean;
  access_token?: string;
  scope?: string;
  token_type?: string;
  bot_user_id?: string;
}

interface SlackInstallationInput {
  response: SlackOAuthAccessResponse;
  installedByCollaboratorId: string | null;
}

interface SlackConnectionInput {
  workspaceId: string;
  channelId: string;
  channelName: string;
  targetLevel: "org" | "doco";
  targetId: string;
  role: string;
  createdByCollaboratorId: string;
}

export function getSlackConfig(): SlackConfig {
  ensureEnvLoaded();
  const appId = cleanEnv("SLACK_APP_ID");
  const clientId = cleanEnv("SLACK_CLIENT_ID");
  const clientSecret = cleanEnv("SLACK_CLIENT_SECRET");
  const signingSecret = cleanEnv("SLACK_SIGNING_SECRET");
  return {
    appId,
    clientId,
    clientSecret,
    signingSecret,
    configured: Boolean(clientId && clientSecret && signingSecret),
  };
}

export function slackRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/integrations/slack/callback`;
}

export function buildSlackInstallUrl(request: Request, installerId: string): string | null {
  const config = getSlackConfig();
  if (!config.configured || !config.clientId || !config.signingSecret) return null;
  const state = signSlackState(
    {
      installerId,
      nonce: randomBytes(16).toString("base64url"),
      issuedAt: Date.now(),
    },
    config.signingSecret,
  );
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackRedirectUri(request));
  url.searchParams.set("state", state);
  return url.toString();
}

export function signSlackState(state: SlackOAuthState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = hmacHex(secret, payload);
  return `${payload}.${signature}`;
}

export function verifySlackState(
  value: string,
  secret: string,
  nowMs = Date.now(),
): SlackOAuthState {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new Error("Invalid Slack OAuth state.");
  const expected = hmacHex(secret, payload);
  if (!timingSafeStringEqual(signature, expected)) {
    throw new Error("Invalid Slack OAuth state signature.");
  }
  let parsed: SlackOAuthState;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SlackOAuthState;
  } catch {
    throw new Error("Invalid Slack OAuth state payload.");
  }
  if (!parsed.installerId || !parsed.nonce || typeof parsed.issuedAt !== "number") {
    throw new Error("Invalid Slack OAuth state payload.");
  }
  if (nowMs - parsed.issuedAt > STATE_TTL_MS || parsed.issuedAt - nowMs > 60_000) {
    throw new Error("Expired Slack OAuth state.");
  }
  return parsed;
}

export async function exchangeSlackOAuthCode(
  request: Request,
  code: string,
): Promise<SlackOAuthAccessResponse> {
  const config = getSlackConfig();
  if (!config.configured || !config.clientId || !config.clientSecret) {
    throw new Error("Slack is not configured.");
  }
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("redirect_uri", slackRedirectUri(request));
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString(
    "base64",
  );
  const response = await fetch(SLACK_OAUTH_ACCESS_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = (await response.json()) as SlackOAuthAccessResponse;
  if (!response.ok || !json.ok) {
    throw new Error(json.error ? `Slack OAuth failed: ${json.error}` : "Slack OAuth failed.");
  }
  return json;
}

export async function upsertSlackInstallation(input: SlackInstallationInput): Promise<void> {
  const teamId = input.response.team?.id?.trim();
  if (!teamId) throw new Error("Slack OAuth response did not include a team id.");
  const workspaceName = input.response.team?.name?.trim() ?? "";
  const scopes = splitSlackScopes(input.response.scope);
  const data = {
    app_id: input.response.app_id ?? null,
    enterprise: input.response.enterprise ?? null,
    is_enterprise_install: input.response.is_enterprise_install ?? false,
    token_type: input.response.token_type ?? null,
  };
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_installations
         (id, provider, workspace_id, workspace_name, bot_user_id, bot_access_token,
          bot_scope, installed_by_chat_user_id, installed_by_collaborator_id, data, created_at, updated_at)
       VALUES ($1, 'slack', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
       ON CONFLICT (provider, workspace_id)
       DO UPDATE SET
         workspace_name = EXCLUDED.workspace_name,
         bot_user_id = EXCLUDED.bot_user_id,
         bot_access_token = EXCLUDED.bot_access_token,
         bot_scope = EXCLUDED.bot_scope,
         installed_by_chat_user_id = EXCLUDED.installed_by_chat_user_id,
         installed_by_collaborator_id = EXCLUDED.installed_by_collaborator_id,
         data = EXCLUDED.data,
         updated_at = now()`,
      [
        `gci_${generateUlid()}`,
        teamId,
        workspaceName,
        input.response.bot_user_id ?? null,
        input.response.access_token ?? null,
        scopes,
        input.response.authed_user?.id ?? null,
        input.installedByCollaboratorId,
        JSON.stringify(data),
      ],
    ),
  );
}

export async function listSlackInstallations(): Promise<SlackInstallationSummary[]> {
  const result = await withClient((c) =>
    c.query<{
      workspace_id: string;
      workspace_name: string;
      bot_user_id: string | null;
      created_at: Date | string;
    }>(
      `SELECT workspace_id, workspace_name, bot_user_id, created_at
         FROM group_chat_installations
        WHERE provider = 'slack'
        ORDER BY workspace_name, workspace_id`,
    ),
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name || row.workspace_id,
    botUserId: row.bot_user_id,
    installedAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export async function saveSlackChannelConnection(input: SlackConnectionInput): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_channel_connections
         (id, provider, workspace_id, channel_id, channel_name, target_level, target_id,
          role, created_by_collaborator_id, data, created_at, updated_at)
       VALUES ($1, 'slack', $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, now(), now())
       ON CONFLICT (provider, workspace_id, channel_id, target_level, target_id)
       DO UPDATE SET
         channel_name = EXCLUDED.channel_name,
         role = EXCLUDED.role,
         created_by_collaborator_id = EXCLUDED.created_by_collaborator_id,
         updated_at = now()`,
      [
        `gcc_${generateUlid()}`,
        input.workspaceId,
        input.channelId,
        input.channelName,
        input.targetLevel,
        input.targetId,
        input.role,
        input.createdByCollaboratorId,
      ],
    ),
  );
}

export async function listSlackChannelConnections(args: {
  workspaceId: string;
  channelId: string;
}): Promise<SlackChannelConnectionSummary[]> {
  const result = await withClient((c) =>
    c.query<{
      channel_id: string;
      channel_name: string;
      target_level: "org" | "doco";
      target_id: string;
      role: string;
      target_label: string | null;
      doco_handle: string | null;
      org_handle: string | null;
    }>(
      `SELECT gcc.channel_id,
              gcc.channel_name,
              gcc.target_level,
              gcc.target_id,
              gcc.role,
              CASE
                WHEN gcc.target_level = 'org' THEN o.handle
                ELSE COALESCE(dorg.handle, '') || '/' || d.handle
              END AS target_label,
              d.handle AS doco_handle,
              COALESCE(dorg.handle, '') AS org_handle
         FROM group_chat_channel_connections gcc
         LEFT JOIN organizations o
           ON gcc.target_level = 'org' AND o.id = gcc.target_id
         LEFT JOIN docos d
           ON gcc.target_level = 'doco' AND d.id = gcc.target_id
         LEFT JOIN organizations dorg
           ON d.org_id = dorg.id
        WHERE gcc.provider = 'slack'
          AND gcc.workspace_id = $1
          AND gcc.channel_id = $2
        ORDER BY target_label, gcc.role`,
      [args.workspaceId, args.channelId],
    ),
  );
  return result.rows.map((row) => ({
    channelId: row.channel_id,
    channelName: row.channel_name,
    targetLevel: row.target_level,
    targetId: row.target_id,
    targetLabel: row.target_label ?? row.target_id,
    role: row.role,
  }));
}

export async function getSlackBotToken(workspaceId: string): Promise<string | null> {
  const result = await withClient((c) =>
    c.query<{ bot_access_token: string | null }>(
      `SELECT bot_access_token
         FROM group_chat_installations
        WHERE provider = 'slack' AND workspace_id = $1`,
      [workspaceId],
    ),
  );
  return result.rows[0]?.bot_access_token ?? null;
}

export function verifySlackRequestSignature(args: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  if (!args.timestamp || !args.signature) return false;
  const timestampSeconds = Number(args.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const base = `v0:${args.timestamp}:${args.rawBody}`;
  const expected = `v0=${hmacHex(args.signingSecret, base)}`;
  return timingSafeStringEqual(args.signature, expected);
}

export async function verifySlackRequest(request: Request, rawBody: string): Promise<boolean> {
  const config = getSlackConfig();
  if (!config.signingSecret) return false;
  return verifySlackRequestSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    signingSecret: config.signingSecret,
  });
}

export function parseSlackCommandPayload(rawBody: string): SlackCommandPayload {
  const form = new URLSearchParams(rawBody);
  return {
    team_id: form.get("team_id") ?? "",
    team_domain: form.get("team_domain") ?? undefined,
    channel_id: form.get("channel_id") ?? "",
    channel_name: form.get("channel_name") ?? undefined,
    user_id: form.get("user_id") ?? "",
    user_name: form.get("user_name") ?? undefined,
    text: form.get("text") ?? undefined,
  };
}

export function slackConnectUrl(request: Request, payload: SlackCommandPayload): string {
  const url = new URL("/integrations", request.url);
  url.searchParams.set("provider", "slack");
  url.searchParams.set("team_id", payload.team_id);
  if (payload.team_domain) url.searchParams.set("team_name", payload.team_domain);
  url.searchParams.set("channel_id", payload.channel_id);
  if (payload.channel_name) url.searchParams.set("channel_name", payload.channel_name);
  return url.toString();
}

export function buildSlackConnectCommandResponse(request: Request, payload: SlackCommandPayload) {
  const connectUrl = slackConnectUrl(request, payload);
  const channel = payload.channel_name ? `#${payload.channel_name}` : "this channel";
  return {
    response_type: "ephemeral",
    text: `Connect Señor Doco to ${channel} in Doco.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Connect Señor Doco to *${channel}* by choosing the Doco and channel-default role in Doco.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Doco" },
            url: connectUrl,
            action_id: "open_doco_channel_connection",
          },
        ],
      },
    ],
  };
}

export async function postSlackMessage(args: {
  workspaceId: string;
  channelId: string;
  text: string;
}): Promise<void> {
  const token = await getSlackBotToken(args.workspaceId);
  if (!token) return;
  await fetch(SLACK_CHAT_POST_MESSAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channelId,
      text: args.text,
    }),
  }).catch(() => undefined);
}

function cleanEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function splitSlackScopes(scope: string | undefined): string[] {
  return (scope ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
