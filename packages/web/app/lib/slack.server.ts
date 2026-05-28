import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { EntityRecord } from "@doco/db";
import {
  ALL_ENTITY_TABLES,
  DOCO_NEURON_TABLE_SPECS,
  getCollaboratorById,
  getEntity,
  listDocoUsers,
  listEntitiesByDoco,
  withClient,
} from "@doco/db";
import { generateUlid } from "@doco/shared";
import {
  createSenorDocoMessage,
  missingSenorDocoAnthropicMessage,
} from "./assistant-runtime.server";
import { type AuditOp, readAuditEvents } from "./audit-log.server";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "./doco-access.server";
import {
  DOCO_API_TOOL,
  type DocoApiToolEnvelope,
  type DocoApiToolRequest,
  type DocoApiToolResult,
  runDocoApiToolRequest,
} from "./doco-api-tool.server";
import { ensureEnvLoaded } from "./dotenv.server";
import {
  contractForAttachedPerspectives,
  relationKindList,
} from "./graph-authoring-contract.server";
import { internalFetch } from "./internal-fetch.server";
import { listAvailablePerspectives, listPerspectivesForDoco } from "./perspectives.server";
import { buildSenorDocoCorePrompt } from "./senor-doco-prompt.server";

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "commands",
  "groups:history",
  "im:history",
  "im:write",
  "mpim:history",
  "team:read",
  "users:read",
] as const;

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_CONVERSATIONS_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_CONVERSATIONS_REPLIES_URL = "https://slack.com/api/conversations.replies";
const STATE_TTL_MS = 15 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SLACK_DOCO_ANSWER_LIMIT = 8;
const SLACK_LLM_MAX_TOKENS = 600;
const SLACK_LLM_MAX_TOOL_TURNS = 6;

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

export interface SlackPersonalAuthorizationState {
  workspaceId: string;
  chatUserId: string;
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
  source?: "shared_default" | "personal";
  collaboratorId?: string;
  collaboratorUsername?: string;
}

export interface SlackRecentMessage {
  text: string;
  ts: string | null;
  userId: string | null;
  botId: string | null;
}

export interface SlackDocoAnswerHit {
  entityId: string;
  docoLabel: string;
  neuronType: string;
  summary: string | null;
  body: string | null;
  rank: number;
}

export interface SlackDocoAnswerQuery {
  text: string;
  questionText: string;
  repairText: string | null;
  overview: boolean;
  repair: boolean;
}

export interface SlackLlmAnswerInput {
  questionText: string;
  repairText?: string | null;
  recentMessages: SlackRecentMessage[];
  connections: SlackChannelConnectionSummary[];
  hits: SlackDocoAnswerHit[];
  overview: boolean;
  repair: boolean;
  personalAuthorizationCommand?: string | null;
  personalActors?: SlackLinkedCollaborator[];
  origin?: string | null;
}

export interface SlackLinkedCollaborator {
  collaboratorId: string;
  username: string;
}

export interface SlackLlmAnswerDeps {
  createMessage?: typeof createSenorDocoMessage;
  runTool?: (block: ToolUseBlock, input: SlackLlmAnswerInput) => Promise<DocoApiToolResult>;
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

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  warning?: string;
}

interface SlackConversationHistoryResponse extends SlackApiResponse {
  messages?: SlackConversationHistoryMessage[];
}

interface SlackConversationHistoryMessage {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
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

interface SlackConnectionGrantInput {
  targetLevel: "org" | "doco";
  targetId: string;
  role: string;
}

interface SlackAccessibleDoco {
  id: string;
  handle: string;
  orgId: string;
  orgHandle: string;
  qualifiedHandle: string;
  role: string;
}

const SLACK_ROLE_RANK: Record<string, number> = {
  reader: 1,
  author: 2,
  approver: 3,
  owner: 4,
};

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

export function buildSlackPersonalAuthorizationUrl(
  request: Request,
  args: { workspaceId: string; chatUserId: string },
): string | null {
  const config = getSlackConfig();
  if (!config.signingSecret || !args.workspaceId || !args.chatUserId) return null;
  const state = signSlackPersonalAuthorizationState(
    {
      workspaceId: args.workspaceId,
      chatUserId: args.chatUserId,
      nonce: randomBytes(16).toString("base64url"),
      issuedAt: Date.now(),
    },
    config.signingSecret,
  );
  const url = new URL("/integrations/slack/link", request.url);
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

export function signSlackPersonalAuthorizationState(
  state: SlackPersonalAuthorizationState,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = hmacHex(secret, payload);
  return `${payload}.${signature}`;
}

export function verifySlackPersonalAuthorizationState(
  value: string,
  secret: string,
  nowMs = Date.now(),
): SlackPersonalAuthorizationState {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new Error("Invalid Slack personal authorization state.");
  const expected = hmacHex(secret, payload);
  if (!timingSafeStringEqual(signature, expected)) {
    throw new Error("Invalid Slack personal authorization state signature.");
  }
  let parsed: SlackPersonalAuthorizationState;
  try {
    parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as SlackPersonalAuthorizationState;
  } catch {
    throw new Error("Invalid Slack personal authorization state payload.");
  }
  if (
    !parsed.workspaceId ||
    !parsed.chatUserId ||
    !parsed.nonce ||
    typeof parsed.issuedAt !== "number"
  ) {
    throw new Error("Invalid Slack personal authorization state payload.");
  }
  if (nowMs - parsed.issuedAt > STATE_TTL_MS || parsed.issuedAt - nowMs > 60_000) {
    throw new Error("Expired Slack personal authorization state.");
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

export async function replaceSlackChannelConnections(input: {
  workspaceId: string;
  channelId: string;
  channelName: string;
  grants: SlackConnectionGrantInput[];
  createdByCollaboratorId: string;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(
        `DELETE FROM group_chat_channel_connections
        WHERE provider = 'slack'
          AND workspace_id = $1
          AND channel_id = $2`,
        [input.workspaceId, input.channelId],
      );
      for (const grant of input.grants) {
        await c.query(
          `INSERT INTO group_chat_channel_connections
           (id, provider, workspace_id, channel_id, channel_name, target_level, target_id,
            role, created_by_collaborator_id, data, created_at, updated_at)
         VALUES ($1, 'slack', $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, now(), now())`,
          [
            `gcc_${generateUlid()}`,
            input.workspaceId,
            input.channelId,
            input.channelName,
            grant.targetLevel,
            grant.targetId,
            grant.role,
            input.createdByCollaboratorId,
          ],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
}

export async function upsertSlackUserLink(input: {
  workspaceId: string;
  chatUserId: string;
  collaboratorId: string;
}): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO group_chat_user_links
         (id, provider, workspace_id, chat_user_id, collaborator_id, data, created_at, updated_at)
       VALUES ($1, 'slack', $2, $3, $4, '{}'::jsonb, now(), now())
       ON CONFLICT (provider, workspace_id, chat_user_id, collaborator_id)
       DO UPDATE SET updated_at = now()`,
      [`gcul_${generateUlid()}`, input.workspaceId, input.chatUserId, input.collaboratorId],
    ),
  );
}

async function listSlackLinkedCollaborators(args: {
  workspaceId: string;
  chatUserId?: string | null;
}): Promise<SlackLinkedCollaborator[]> {
  if (!args.chatUserId) return [];
  const result = await withClient((c) =>
    c.query<{
      collaborator_id: string;
      github_login: string | null;
      data: Record<string, unknown> | null;
    }>(
      `SELECT gcul.collaborator_id,
              c.github_login,
              c.data
         FROM group_chat_user_links gcul
         JOIN collaborators c ON c.id = gcul.collaborator_id
        WHERE gcul.provider = 'slack'
          AND gcul.workspace_id = $1
          AND gcul.chat_user_id = $2
        ORDER BY gcul.updated_at DESC`,
      [args.workspaceId, args.chatUserId],
    ),
  );
  return result.rows.map((row) => {
    const named = row.data?.name ?? row.data?.display_name;
    return {
      collaboratorId: row.collaborator_id,
      username:
        typeof named === "string" && named.trim()
          ? named.trim()
          : (row.github_login ?? row.collaborator_id),
    };
  });
}

async function listSlackPersonalConnections(args: {
  workspaceId: string;
  chatUserId?: string | null;
}): Promise<{
  actors: SlackLinkedCollaborator[];
  connections: SlackChannelConnectionSummary[];
}> {
  const actors = await listSlackLinkedCollaborators(args);
  if (actors.length === 0) return { actors, connections: [] };

  const groups = await Promise.all(
    actors.map(async (actor) => {
      const docoIds = await listAccessibleDocoIdsForPrincipal(actor.collaboratorId);
      if (docoIds.length === 0) return [];
      const result = await withClient((c) =>
        c.query<{
          id: string;
          handle: string;
          owner_id: string;
          org_handle: string | null;
        }>(
          `SELECT d.id,
                  d.handle,
                  d.owner_id,
                  o.handle AS org_handle
             FROM docos d
             LEFT JOIN organizations o ON o.id = d.org_id
            WHERE d.id = ANY($1::text[])
            ORDER BY COALESCE(o.handle, ''), d.handle`,
          [docoIds],
        ),
      );
      const connections = await Promise.all(
        result.rows.map(async (row): Promise<SlackChannelConnectionSummary | null> => {
          const role = await getDocoLevelRole(
            { ownerId: row.owner_id, docoId: row.id },
            actor.collaboratorId,
          );
          if (!role) return null;
          const targetLabel = row.org_handle ? `${row.org_handle}/${row.handle}` : row.handle;
          return {
            channelId: "*",
            channelName: "personal",
            targetLevel: "doco",
            targetId: row.id,
            targetLabel,
            role,
            source: "personal",
            collaboratorId: actor.collaboratorId,
            collaboratorUsername: actor.username,
          };
        }),
      );
      return connections.filter((entry) => entry !== null);
    }),
  );

  return {
    actors,
    connections: mergeSlackConnections(groups.flat()),
  };
}

function mergeSlackConnections(
  connections: SlackChannelConnectionSummary[],
): SlackChannelConnectionSummary[] {
  const byTarget = new Map<string, SlackChannelConnectionSummary>();
  for (const connection of connections) {
    const key = `${connection.targetLevel}:${connection.targetId}`;
    const existing = byTarget.get(key);
    if (!existing || slackConnectionSortRank(connection) > slackConnectionSortRank(existing)) {
      byTarget.set(key, connection);
    }
  }
  return [...byTarget.values()].sort((a, b) => {
    const sourceDelta = slackConnectionSourceRank(b) - slackConnectionSourceRank(a);
    if (sourceDelta !== 0) return sourceDelta;
    return a.targetLabel.localeCompare(b.targetLabel);
  });
}

function slackConnectionSortRank(connection: SlackChannelConnectionSummary): number {
  return slackRoleRank(connection.role) * 10 + slackConnectionSourceRank(connection);
}

function slackConnectionSourceRank(connection: SlackChannelConnectionSummary): number {
  return connection.source === "personal" ? 2 : 1;
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
          AND gcc.channel_id IN ($2, '*')
        ORDER BY CASE WHEN gcc.channel_id = $2 THEN 0 ELSE 1 END, target_label, gcc.role`,
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
    source: "shared_default",
  }));
}

export async function buildSlackAppMentionResponse(args: {
  workspaceId: string;
  channelId: string;
  chatUserId?: string | null;
  messageText: string;
  recentMessages?: SlackRecentMessage[];
  personalAuthorizationCommand?: string | null;
  origin?: string | null;
  answerGenerator?: (input: SlackLlmAnswerInput) => Promise<string | null>;
}): Promise<string> {
  const [sharedConnections, personalAccess] = await Promise.all([
    listSlackChannelConnections({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
    }),
    listSlackPersonalConnections({
      workspaceId: args.workspaceId,
      chatUserId: args.chatUserId,
    }),
  ]);
  const connections = mergeSlackConnections([...sharedConnections, ...personalAccess.connections]);
  if (connections.length === 0) {
    return "I’m installed here, but I don’t have default or personal Doco permissions yet. Open Doco Integrations to choose workspace defaults, or use `/doco connect`.";
  }
  const fallbackConnections = sharedConnections.length > 0 ? sharedConnections : connections;

  const contextConnections = connections;
  const cleanText = cleanSlackMentionText(args.messageText);

  const answerQuery = buildSlackDocoAnswerQuery(cleanText, args.recentMessages);
  if (answerQuery) {
    const searchHits = await readSlackDocoSearchHits(contextConnections, answerQuery.text);
    const overviewHits =
      answerQuery.overview || searchHits.length === 0
        ? await readSlackDocoOverviewHits(contextConnections)
        : [];
    const hits = sortSlackDocoAnswerHits([...searchHits, ...overviewHits]).slice(
      0,
      SLACK_DOCO_ANSWER_LIMIT,
    );
    const llmAnswer = await (args.answerGenerator ?? generateSlackDocoLlmAnswer)({
      questionText: answerQuery.questionText,
      repairText: answerQuery.repairText,
      recentMessages: args.recentMessages ?? [],
      connections: contextConnections,
      hits,
      overview: answerQuery.overview,
      repair: answerQuery.repair,
      personalAuthorizationCommand: args.personalAuthorizationCommand ?? "/doco connect",
      personalActors: personalAccess.actors,
      origin: args.origin,
    });
    if (llmAnswer) return llmAnswer;
    if (hits.length > 0) {
      return formatSlackDocoAnswerResponse(hits, { overview: answerQuery.overview });
    }
    return "I couldn’t find matching Doco entries in the available Slack permissions.";
  }

  const llmAnswer = await (args.answerGenerator ?? generateSlackDocoLlmAnswer)({
    questionText: cleanText || args.messageText,
    recentMessages: args.recentMessages ?? [],
    connections: contextConnections,
    hits: [],
    overview: false,
    repair: false,
    personalAuthorizationCommand: args.personalAuthorizationCommand ?? "/doco connect",
    personalActors: personalAccess.actors,
    origin: args.origin,
  });
  if (llmAnswer) return llmAnswer;
  return formatSlackDefaultResponse(fallbackConnections, cleanText);
}

export function cleanSlackMentionText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isSlackGreeting(text: string): boolean {
  return /^(hi|hello|hey|hola|buenas|yo|sup)[\s!.,?]*$/i.test(text);
}

export function buildSlackDocoAnswerQuery(
  cleanText: string,
  recentMessages: SlackRecentMessage[] = [],
): SlackDocoAnswerQuery | null {
  const text = cleanText.trim();
  if (!text || isSlackGreeting(text)) return null;
  const repair = detectSlackRepairMessage(text);
  const repairedQuestion = repair ? latestHumanSlackQuestion(recentMessages) : null;
  const questionText = repairedQuestion ?? text;
  const recentContext = formatRecentSlackContext(recentMessages);
  const overview = detectSlackDocoOverviewQuestion(questionText, recentMessages) || repair;
  const searchParts = overview
    ? [
        questionText,
        repair ? text : "",
        recentContext,
        "Doco intent decision rule action log reference state explains documents purpose architecture",
      ]
    : [questionText, recentContext];
  const query = searchParts.filter(Boolean).join(" ").trim();
  return query
    ? {
        text: query,
        questionText,
        repairText: repair ? text : null,
        overview,
        repair,
      }
    : null;
}

export function detectSlackDocoOverviewQuestion(
  text: string,
  recentMessages: SlackRecentMessage[] = [],
): boolean {
  const lower = text.toLowerCase();
  if (
    /\bwhat\s+(do|does)\s+(we\s+)?document\b/.test(lower) ||
    /\bwhat\s+(does|do)\s+(doco|docos?|it|they)\s+(explain|document|contain|cover)\b/.test(lower) ||
    /\bwhat\s+do\s+the\s+docos?\s+we\s+have\s+(explain|document|contain|cover)\b/.test(lower) ||
    /\bwhat\s+do\s+they\s+explain\b/.test(lower) ||
    /\bwhat\s+does\s+that\s+explain\b/.test(lower) ||
    /\bsummarize\s+(it|that|those|the\s+docos?)\b/.test(lower)
  ) {
    return true;
  }
  if (!/\b(they|those|that|it)\b/.test(lower)) return false;
  return recentMessages.some((message) =>
    /\b(doco|docos|neurons?|decisions?|rules?|actions?|logs?|references?)\b/i.test(message.text),
  );
}

export function detectSlackRepairMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\byou\s+(didn'?t|did not|haven'?t|have not)\s+(answer|respond)\b/.test(lower) ||
    /\bthat\s+(didn'?t|did not)\s+answer\b/.test(lower) ||
    /\bnot\s+what\s+i\s+asked\b/.test(lower) ||
    /\banswer\s+my\s+(question|previous\s+question)\b/.test(lower) ||
    isSlackLineBreakRepair(lower) ||
    /\b(format\s+(it\s+)?as\s+(bullets?|a\s+list)|make\s+(it\s+)?(readable|scannable))\b/.test(
      lower,
    ) ||
    /\b(not\s+looking\s+(nice|good)|looks?\s+(bad|ugly|messy)|hard\s+to\s+read|format(?:ting)?\s+(is\s+)?(bad|broken|messy))\b/.test(
      lower,
    )
  );
}

function isSlackLineBreakRepair(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(add|use|insert|put)\s+(some\s+)?line\s+breaks?\b/.test(lower) ||
    /\b(line\s+breaks?|break\s+(it\s+)?into\s+lines?|split\s+(it\s+)?into\s+lines?)\b/.test(lower)
  );
}

export function formatSlackDefaultResponse(
  connections: SlackChannelConnectionSummary[],
  cleanText: string,
): string {
  const defaultTargets = formatSlackConnectionList(connections);
  if (isSlackGreeting(cleanText)) {
    return `Hola. By default, I can answer questions accessing ${defaultTargets}. Try “what docos do we have?” or tell me what to doco.`;
  }

  return `I’m here. By default, I can answer questions accessing ${defaultTargets}. Try “what docos do we have?” for a quick check.`;
}

export function formatSlackDocoAnswerResponse(
  hits: SlackDocoAnswerHit[],
  options: { overview?: boolean } = {},
): string {
  const uniqueHits = uniqueSlackDocoAnswerHits(hits).slice(0, SLACK_DOCO_ANSWER_LIMIT);
  if (uniqueHits.length === 0) {
    return "I couldn’t find matching Doco entries in the default Slack permissions.";
  }
  const intro = options.overview
    ? "Here’s what the accessible Docos explain:"
    : "Here’s what I found in the accessible Docos:";
  return [
    intro,
    ...uniqueHits.map(
      (hit) =>
        `• ${capitalize(hit.neuronType)} in ${hit.docoLabel}: ${formatSlackDocoHitText(hit)}`,
    ),
  ].join("\n");
}

export async function generateSlackDocoLlmAnswer(
  input: SlackLlmAnswerInput,
  deps: SlackLlmAnswerDeps = {},
): Promise<string | null> {
  ensureEnvLoaded();
  if (!deps.createMessage && missingSenorDocoAnthropicMessage("Señor Doco for Slack")) {
    return null;
  }
  const createMessage = deps.createMessage ?? createSenorDocoMessage;
  const runTool = deps.runTool ?? runSlackDocoApiTool;
  try {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: buildSlackLlmUserPrompt(input),
      },
    ];
    let lastMessage: Message | null = null;
    const footerLines: string[] = [];
    for (let turn = 0; turn < SLACK_LLM_MAX_TOOL_TURNS; turn++) {
      const message = await createMessage({
        max_tokens: SLACK_LLM_MAX_TOKENS,
        temperature: 0.2,
        system: slackLlmSystemPrompt(),
        tools: [DOCO_API_TOOL],
        messages,
      });
      lastMessage = message;
      const assistantContent = message.content.filter(
        (block) => block.type === "text" || block.type === "tool_use",
      ) as ContentBlockParam[];
      messages.push({ role: "assistant", content: assistantContent });
      if (message.stop_reason !== "tool_use") {
        return cleanSlackLlmAnswer(slackMessageText(message), {
          footerLines,
          repairText: input.repairText,
        });
      }
      const toolUseBlocks = assistantContent.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) break;
      const toolResults = await Promise.all(toolUseBlocks.map((block) => runTool(block, input)));
      footerLines.push(...extractSlackDocoFooterLines(toolResults));
      messages.push({
        role: "user",
        content: toolResults.map((toolResult) => toolResult.result),
      });
    }
    return lastMessage
      ? cleanSlackLlmAnswer(slackMessageText(lastMessage), {
          footerLines,
          repairText: input.repairText,
        })
      : null;
  } catch (error) {
    console.error(
      "[slack] Doco LLM answer failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function buildSlackLlmUserPrompt(input: SlackLlmAnswerInput): string {
  return [
    `Current Slack message: ${input.questionText}`,
    ...(input.repairText ? [`Repair requested: ${input.repairText}`] : []),
    `Question type: ${input.repair ? "repair/follow-up" : input.overview ? "overview" : "question"}`,
    "",
    "Doco access available in this Slack request:",
    ...input.connections.map((connection) => `- ${slackConnectionAccessLabelWithRole(connection)}`),
    "",
    "Personal Doco authorization for this Slack user:",
    ...formatSlackPersonalAuthorizationLines(input.personalActors),
    "",
    "Recent Slack context, oldest to newest:",
    ...formatSlackLlmRecentMessages(input.recentMessages),
    "",
    "Doco context excerpts:",
    ...input.hits.map(formatSlackLlmHit),
    "",
    `Personal authorization command: ${input.personalAuthorizationCommand ?? "/doco connect"}`,
    "",
    "Use doco_api when you need exact counts, lists, item detail, or a second look beyond these excerpts. Use API results as the source of truth.",
    "",
    "Answer the current message. If it is a repair/follow-up, answer the prior unanswered question from the Slack context.",
  ].join("\n");
}

function formatSlackPersonalAuthorizationLines(
  personalActors: SlackLinkedCollaborator[] | null | undefined,
): string[] {
  if (!personalActors || personalActors.length === 0) {
    return [
      "- not linked; POST/PATCH/DELETE doco_api calls require the user to run /doco connect first.",
    ];
  }
  return personalActors.map(
    (actor) =>
      `- linked as ${actor.username}; POST/PATCH/DELETE doco_api calls run as this collaborator and are capped by their actual Doco role.`,
  );
}

function slackMessageText(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

export async function fetchSlackConversationContext(args: {
  workspaceId: string;
  channelId: string;
  latestTs?: string | null;
  threadTs?: string | null;
  limit?: number;
}): Promise<SlackRecentMessage[]> {
  const token = await getSlackBotToken(args.workspaceId);
  if (!token) return [];
  const url = new URL(
    args.threadTs ? SLACK_CONVERSATIONS_REPLIES_URL : SLACK_CONVERSATIONS_HISTORY_URL,
  );
  url.searchParams.set("channel", args.channelId);
  url.searchParams.set("limit", String(args.limit ?? 8));
  if (args.threadTs) {
    url.searchParams.set("ts", args.threadTs);
  }
  if (args.latestTs) {
    url.searchParams.set("latest", args.latestTs);
    url.searchParams.set("inclusive", "false");
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => null)) as SlackConversationHistoryResponse | null;
  if (!response.ok || body?.ok === false) return [];
  return (body?.messages ?? [])
    .filter((message) => typeof message.text === "string" && message.text.trim().length > 0)
    .map((message) => ({
      text: cleanSlackMentionText(message.text ?? ""),
      ts: message.ts ?? null,
      userId: message.user ?? null,
      botId: message.bot_id ?? null,
    }))
    .reverse();
}

export async function runSlackDocoApiTool(
  block: ToolUseBlock,
  input: SlackLlmAnswerInput,
): Promise<DocoApiToolResult> {
  return runDocoApiToolRequest({
    toolUseId: block.id,
    input: block.input,
    execute: (request) => executeSlackDocoApiRequest(input, request),
  });
}

async function executeSlackDocoApiRequest(
  input: SlackLlmAnswerInput,
  request: DocoApiToolRequest,
): Promise<DocoApiToolEnvelope> {
  if (request.method !== "GET") {
    return executeSlackPersonalDocoApiWrite(input, request);
  }

  const url = new URL(request.path, "https://slack.doco.local");
  if (url.pathname === "/api/v1/docos.json") {
    const docos = await listSlackAccessibleDocos(input.connections);
    return slackToolEnvelope(200, {
      docos: docos.map((doco) => ({
        id: doco.id,
        handle: doco.handle,
        org_id: doco.orgId,
        org_handle: doco.orgHandle,
        qualified_handle: doco.qualifiedHandle,
        slack_default_role: doco.role,
      })),
    });
  }

  const parsed = parseSlackPerDocoPath(url.pathname);
  if (!parsed) {
    return slackToolEnvelope(404, {
      error: `Unsupported Slack doco_api path. Supported reads: ${slackSupportedApiPathSummary()}.`,
    });
  }

  const doco = await resolveSlackAccessibleDoco(input.connections, parsed.docoHandle);
  if (!doco) {
    return slackToolEnvelope(404, {
      error: `Doco is not available through this Slack workspace default: ${parsed.docoHandle}`,
    });
  }

  const [head, ...tail] = parsed.routeSegments;
  if (head === "status.json" && tail.length === 0) {
    return slackToolEnvelope(200, await readSlackDocoApiStatus(doco));
  }
  if (head === "search.json" && tail.length === 0) {
    const q = (url.searchParams.get("q") ?? "").trim();
    return slackToolEnvelope(200, await readSlackDocoApiSearch(doco, q));
  }
  if (head !== "api" || tail.length === 0) {
    return slackToolEnvelope(404, { error: `Unsupported Doco API path: ${url.pathname}` });
  }

  const [typePart, idPart] = tail;
  const type = typePart?.replace(/\.json$/i, "") ?? "";
  const id = idPart?.replace(/\.json$/i, "");
  if (tail.length === 1 && typePart?.endsWith(".json")) {
    return slackToolEnvelope(200, await readSlackDocoApiCollection(doco, type, url.searchParams));
  }
  if (tail.length === 2 && idPart?.endsWith(".json")) {
    return slackToolEnvelope(200, await readSlackDocoApiDetail(doco, type, id));
  }
  return slackToolEnvelope(404, { error: `Unsupported Doco API path: ${url.pathname}` });
}

async function executeSlackPersonalDocoApiWrite(
  input: SlackLlmAnswerInput,
  request: DocoApiToolRequest,
): Promise<DocoApiToolEnvelope> {
  const actors = input.personalActors ?? [];
  if (actors.length === 0) {
    return slackToolEnvelope(403, {
      error:
        "Slack doco_api cannot write with the shared workspace default alone. Ask this Slack user to run /doco connect and authorize their own Doco account for Slack if they already have the needed Doco access, then retry the request as that user. Never claim you can exceed the access that user already holds in Doco.",
      needs_personal_doco_authorization: true,
      personal_authorization_command: input.personalAuthorizationCommand ?? "/doco connect",
    });
  }

  let lastDenied: DocoApiToolEnvelope | null = null;
  for (const actor of actors) {
    const envelope = await executeSlackDocoApiAsCollaborator(input, request, actor);
    if (envelope.status !== 401 && envelope.status !== 403) return envelope;
    lastDenied = envelope;
  }
  return (
    lastDenied ??
    slackToolEnvelope(403, {
      error:
        "Your Doco account is linked to Slack, but it did not grant enough access for this write.",
      needs_more_doco_access: true,
    })
  );
}

async function executeSlackDocoApiAsCollaborator(
  input: SlackLlmAnswerInput,
  request: DocoApiToolRequest,
  actor: SlackLinkedCollaborator,
): Promise<DocoApiToolEnvelope> {
  const origin = input.origin || "https://doco.to";
  const response = await internalFetch({
    method: request.method,
    path: request.path,
    origin,
    cookieHeader: `doco_session=${encodeURIComponent(actor.collaboratorId)}`,
    body: request.body,
    userAgent: "Doco-Slack-Assistant/1",
  });
  if (!response) {
    return slackToolEnvelope(404, {
      error: `Unsupported Slack write path: ${request.path}`,
      supported_write_paths: [
        "/api/v1/docos.json",
        "/<handle>/api/<type>.json",
        "/<handle>/api/<type>/<id>.json",
        "/<handle>/api/principals.json",
        "/<handle>/api/principals/<id>.json",
        "/<handle>/api/policies.json",
        "/<handle>/api/changesets.json",
      ],
    });
  }

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep non-JSON route output visible to the model.
  }
  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
  };
}

async function listSlackAccessibleDocos(
  connections: SlackChannelConnectionSummary[],
): Promise<SlackAccessibleDoco[]> {
  const groups = await Promise.all(connections.map(listSlackConnectionAccessibleDocos));
  return dedupeSlackAccessibleDocos(groups.flat()).sort((a, b) =>
    a.qualifiedHandle.localeCompare(b.qualifiedHandle),
  );
}

async function listSlackConnectionAccessibleDocos(
  connection: SlackChannelConnectionSummary,
): Promise<SlackAccessibleDoco[]> {
  const where = connection.targetLevel === "org" ? "d.org_id = $1" : "d.id = $1";
  const result = await withClient((c) =>
    c.query<{ id: string; handle: string; org_id: string; org_handle: string }>(
      `SELECT d.id, d.handle, d.org_id, o.handle AS org_handle
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE ${where}
        ORDER BY o.handle ASC, d.handle ASC`,
      [connection.targetId],
    ),
  );
  return result.rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    orgId: row.org_id,
    orgHandle: row.org_handle,
    qualifiedHandle: `${row.org_handle}/${row.handle}`,
    role: connection.role,
  }));
}

function dedupeSlackAccessibleDocos(docos: SlackAccessibleDoco[]): SlackAccessibleDoco[] {
  const byId = new Map<string, SlackAccessibleDoco>();
  for (const doco of docos) {
    const existing = byId.get(doco.id);
    if (!existing || slackRoleRank(doco.role) > slackRoleRank(existing.role)) {
      byId.set(doco.id, doco);
    }
  }
  return [...byId.values()];
}

async function resolveSlackAccessibleDoco(
  connections: SlackChannelConnectionSummary[],
  routeHandle: string,
): Promise<SlackAccessibleDoco | null> {
  const normalized = routeHandle.trim().toLowerCase();
  const docos = await listSlackAccessibleDocos(connections);
  return (
    docos.find(
      (doco) =>
        doco.handle.toLowerCase() === normalized ||
        doco.qualifiedHandle.toLowerCase() === normalized,
    ) ?? null
  );
}

function parseSlackPerDocoPath(
  pathname: string,
): { docoHandle: string; routeSegments: string[] } | null {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) return null;
  const routeIndex = isSlackDocoRouteStart(segments[1])
    ? 1
    : segments.length >= 3 && isSlackDocoRouteStart(segments[2])
      ? 2
      : -1;
  if (routeIndex < 1) return null;
  return {
    docoHandle: segments.slice(0, routeIndex).join("/"),
    routeSegments: segments.slice(routeIndex),
  };
}

function isSlackDocoRouteStart(segment: string): boolean {
  return segment === "status.json" || segment === "search.json" || segment === "api";
}

async function readSlackDocoApiStatus(doco: SlackAccessibleDoco): Promise<Record<string, unknown>> {
  const typeMap = [
    ...DOCO_NEURON_TABLE_SPECS.map((spec) => ({
      table: spec.table,
      plural: spec.entityType === "reference" ? "references" : `${spec.table}`,
      group: "note" as const,
    })),
    { table: "guidance_policies", plural: "guidance_policies", group: "policy" as const },
    {
      table: "neuron_authoring_policies",
      plural: "neuron_authoring_policies",
      group: "policy" as const,
    },
  ];
  const counts: {
    notes: Record<string, number>;
    notes_total: number;
    policies: Record<string, number>;
    policies_total: number;
    principals: number;
  } = { notes: {}, notes_total: 0, policies: {}, policies_total: 0, principals: 0 };
  let latest: string | null = null;
  await withClient(async (c) => {
    for (const spec of typeMap) {
      const result = await c.query<{ n: string; c: string | null }>(
        `SELECT COUNT(*)::text AS n, MAX(created_at)::text AS c FROM ${spec.table} WHERE doco_id = $1`,
        [doco.id],
      );
      const n = Number(result.rows[0]?.n ?? 0);
      if (spec.group === "note") {
        counts.notes[spec.plural] = n;
        counts.notes_total += n;
      } else {
        counts.policies[spec.plural] = n;
        counts.policies_total += n;
      }
      const ts = result.rows[0]?.c ?? null;
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
    const principals = await c.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM principals WHERE doco_id = $1",
      [doco.id],
    );
    counts.principals = Number(principals.rows[0]?.n ?? 0);
  });
  return {
    status: "ok",
    doco_id: doco.id,
    doco_handle: doco.handle,
    qualified_handle: doco.qualifiedHandle,
    slack_access_role: doco.role,
    slack_default_role: doco.role,
    last_updated_at: latest,
    counts,
  };
}

async function readSlackDocoApiSearch(
  doco: SlackAccessibleDoco,
  q: string,
): Promise<Record<string, unknown>> {
  if (!q) {
    return {
      query: "",
      count: 0,
      hits: [],
    };
  }
  const hits = await readSlackConnectionSearchHits(slackDocoConnection(doco), q);
  return {
    query: q,
    count: hits.length,
    hits: hits.map((hit) => ({
      id: hit.entityId,
      entity_type: hit.neuronType,
      doco_label: hit.docoLabel,
      name: hit.summary,
      summary: hit.body ?? hit.summary,
      rank: hit.rank,
    })),
  };
}

async function readSlackDocoApiCollection(
  doco: SlackAccessibleDoco,
  type: string,
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  if (type === "principals") return readSlackDocoApiPrincipals(doco);
  if (type === "policies") return readSlackDocoApiPolicies(doco);
  if (type === "settings") return readSlackDocoApiSettings(doco);
  if (type === "audit") return readSlackDocoApiAudit(doco, searchParams);
  if (type === "perspectives") return readSlackDocoApiPerspectives(doco);
  if (type === "authoring-contract") return readSlackDocoApiAuthoringContract(doco);
  const entityType = slackApiEntityType(type);
  if (!entityType) {
    return {
      error: `Unknown or unsupported Slack read endpoint: /api/${type}.json`,
      supported_types: slackSupportedApiTypes(),
    };
  }
  const rows = await listEntitiesByDoco(entityType, doco.id);
  return {
    ok: true,
    type,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    count: rows.length,
    items: rows.map(slackEntityRecordToApiItem),
  };
}

async function readSlackDocoApiDetail(
  doco: SlackAccessibleDoco,
  type: string,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  if (!id) return { error: "Entity id is required." };
  const entityType = slackApiEntityType(type);
  if (!entityType && type !== "principals") {
    return {
      error: `Unknown or unsupported Slack read endpoint: /api/${type}/${id}.json`,
      supported_types: slackSupportedApiTypes(),
    };
  }
  const row = await getEntity(entityType ?? "principal", id);
  if (!row || row.doco_id !== doco.id) {
    return { error: `Entity not found in ${doco.qualifiedHandle}: ${id}` };
  }
  return {
    ok: true,
    type,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    item: slackEntityRecordToApiItem(row),
  };
}

async function readSlackDocoApiPrincipals(
  doco: SlackAccessibleDoco,
): Promise<Record<string, unknown>> {
  const [docoUsers, neuronRows] = await Promise.all([
    listDocoUsers(doco.id),
    listEntitiesByDoco("principal", doco.id),
  ]);
  const collaborators = (
    await Promise.all(
      docoUsers.map(async (user) => {
        const collaborator = await getCollaboratorById(user.collaborator_id);
        return collaborator
          ? {
              id: collaborator.id,
              username: slackCollaboratorDisplayName(collaborator),
              type: collaborator.kind,
              role: user.role,
              github_login: collaborator.github_login,
              email: collaborator.email,
            }
          : null;
      }),
    )
  ).filter((entry) => entry !== null);
  return {
    ok: true,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    principals: collaborators,
    collaborators,
    principal_neurons: neuronRows.map(slackEntityRecordToApiItem),
    collaborator_count: collaborators.length,
    principal_neuron_count: neuronRows.length,
  };
}

async function readSlackDocoApiPolicies(
  doco: SlackAccessibleDoco,
): Promise<Record<string, unknown>> {
  const result = await withClient((c) =>
    Promise.all([
      c.query<{
        id: string;
        policy: string;
        lifecycle: string | null;
        body_md: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        `SELECT id, policy, lifecycle, body_md, created_at::text AS created_at, updated_at::text AS updated_at
           FROM guidance_policies
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [doco.id],
      ),
      c.query<{
        id: string;
        policy: string;
        lifecycle: string | null;
        body_md: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        `SELECT id, policy, lifecycle, body_md, created_at::text AS created_at, updated_at::text AS updated_at
           FROM neuron_authoring_policies
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [doco.id],
      ),
    ]),
  );
  const [guidance, neuronAuthoring] = result;
  const items = [
    ...guidance.rows.map((row) => ({ ...row, policy_kind: "guidance" as const })),
    ...neuronAuthoring.rows.map((row) => ({ ...row, policy_kind: "neuron_authoring" as const })),
  ];
  return {
    doco_id: doco.id,
    doco_handle: doco.handle,
    qualified_handle: doco.qualifiedHandle,
    count: items.length,
    guidance_count: guidance.rows.length,
    neuron_authoring_count: neuronAuthoring.rows.length,
    items,
  };
}

async function readSlackDocoApiSettings(
  doco: SlackAccessibleDoco,
): Promise<Record<string, unknown>> {
  const result = await withClient((c) =>
    c.query<{
      visibility: string | null;
      goal: string | null;
      created_at: string | null;
      updated_at: string | null;
    }>(
      `SELECT visibility, data->>'goal' AS goal, created_at::text AS created_at, updated_at::text AS updated_at
         FROM docos
        WHERE id = $1`,
      [doco.id],
    ),
  );
  const row = result.rows[0] ?? {};
  return {
    ok: true,
    id: doco.id,
    handle: doco.handle,
    org_id: doco.orgId,
    org_handle: doco.orgHandle,
    qualified_handle: doco.qualifiedHandle,
    visibility: row.visibility ?? null,
    goal: row.goal ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const SLACK_AUDIT_OPS: ReadonlySet<AuditOp> = new Set([
  "entity.create",
  "entity.update",
  "entity.delete",
  "lifecycle.transition",
  "synapse.add",
]);

async function readSlackDocoApiAudit(
  doco: SlackAccessibleDoco,
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> {
  const opParam = searchParams.get("op");
  let op: AuditOp[] | undefined;
  if (opParam) {
    const parts = opParam
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const invalid = parts.filter((part) => !SLACK_AUDIT_OPS.has(part as AuditOp));
    if (invalid.length > 0) {
      return {
        error: `Invalid op value(s): ${invalid.join(", ")}. Allowed: ${[...SLACK_AUDIT_OPS].join(
          ", ",
        )}.`,
      };
    }
    op = parts as AuditOp[];
  }

  const limitRaw = searchParams.get("limit");
  let limit = 200;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { error: "limit must be a positive integer." };
    }
    limit = Math.min(parsed, 1000);
  }

  const events = await readAuditEvents(
    "",
    {
      entity_id: searchParams.get("entity_id") ?? undefined,
      entity_type: searchParams.get("entity_type") ?? undefined,
      by: searchParams.get("by") ?? undefined,
      since: searchParams.get("since") ?? undefined,
      before: searchParams.get("before") ?? undefined,
      until: searchParams.get("until") ?? undefined,
      op,
      limit,
    },
    doco.id,
  );

  return {
    ok: true,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    count: events.length,
    events,
  };
}

async function readSlackDocoApiPerspectives(
  doco: SlackAccessibleDoco,
): Promise<Record<string, unknown>> {
  const [attached, available] = await Promise.all([
    listPerspectivesForDoco(doco.id),
    listAvailablePerspectives(),
  ]);
  return {
    ok: true,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    attached,
    available,
    can_admin: slackRoleRank(doco.role) >= slackRoleRank("approver"),
  };
}

async function readSlackDocoApiAuthoringContract(
  doco: SlackAccessibleDoco,
): Promise<Record<string, unknown>> {
  const attached = await listPerspectivesForDoco(doco.id);
  const canAuthor = slackRoleRank(doco.role) >= slackRoleRank("author");
  return {
    ok: true,
    doco_id: doco.id,
    qualified_handle: doco.qualifiedHandle,
    entity_types: DOCO_NEURON_TABLE_SPECS.map((spec) => ({
      entity_type: spec.entityType,
      collection: spec.table,
      capture_endpoint: `/${doco.handle}/api/${spec.table}.json`,
    })),
    relation_kinds: relationKindList(),
    perspective_contracts: contractForAttachedPerspectives(attached),
    changeset_endpoint: `/${doco.handle}/api/changesets.json`,
    slack_write_capability: canAuthor
      ? "This Slack user appears to have author-or-higher personal access for this Doco. POST/PATCH/DELETE doco_api calls will still be checked against that linked collaborator's real Doco role."
      : "Slack exposes this contract for planning. POST/PATCH/DELETE doco_api calls require the Slack user to run /doco connect and have the needed Doco role.",
  };
}

function slackEntityRecordToApiItem(row: EntityRecord): Record<string, unknown> {
  return {
    id: row.id,
    summary: row.summary ?? row.type_named_value ?? row.name ?? null,
    lifecycle: row.lifecycle ?? null,
    created_at: row.created_at ?? null,
    created_by: row.created_by ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
    data: row.data,
    body_md: row.body_md ?? null,
  };
}

function slackApiEntityType(type: string): string | null {
  const normalized = type.toLowerCase();
  for (const spec of DOCO_NEURON_TABLE_SPECS) {
    const plural = spec.entityType === "reference" ? "references" : spec.table;
    if (normalized === plural) return spec.entityType;
  }
  return null;
}

function slackSupportedApiTypes(): string[] {
  return [
    ...DOCO_NEURON_TABLE_SPECS.map((spec) =>
      spec.entityType === "reference" ? "references" : spec.table,
    ),
    "principals",
    "policies",
    "settings",
    "audit",
    "perspectives",
    "authoring-contract",
  ];
}

function slackSupportedApiPathSummary(): string {
  return [
    "/api/v1/docos.json",
    "/<handle>/status.json",
    "/<handle>/search.json?q=...",
    "/<handle>/api/<type>.json",
    "/<handle>/api/<type>/<id>.json",
    "/<handle>/api/principals.json",
    "/<handle>/api/policies.json",
    "/<handle>/api/settings.json",
    "/<handle>/api/audit.json",
    "/<handle>/api/perspectives.json",
    "/<handle>/api/authoring-contract.json",
  ].join(", ");
}

function slackDocoConnection(doco: SlackAccessibleDoco): SlackChannelConnectionSummary {
  return {
    channelId: "*",
    channelName: "workspace",
    targetLevel: "doco",
    targetId: doco.id,
    targetLabel: doco.qualifiedHandle,
    role: doco.role,
  };
}

function slackToolEnvelope(status: number, body: unknown): DocoApiToolEnvelope {
  return {
    status,
    ok: status >= 200 && status < 300 && !(body && typeof body === "object" && "error" in body),
    body,
  };
}

function slackRoleRank(role: string): number {
  return SLACK_ROLE_RANK[role] ?? 0;
}

function slackCollaboratorDisplayName(
  collaborator: Awaited<ReturnType<typeof getCollaboratorById>>,
): string {
  if (!collaborator) return "";
  const named = collaborator.data.name ?? collaborator.data.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return collaborator.github_login ?? collaborator.id;
}

function formatSlackConnectionList(connections: SlackChannelConnectionSummary[]): string {
  const labels = connections.map(slackConnectionAccessLabel);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, 2).join(", ")}, and ${labels.length - 2} more`;
}

function slackConnectionAccessLabel(connection: SlackChannelConnectionSummary): string {
  return connection.targetLevel === "org"
    ? `all ${connection.targetLabel}'s docos`
    : connection.targetLabel;
}

function slackConnectionAccessLabelWithRole(connection: SlackChannelConnectionSummary): string {
  const target = slackConnectionAccessLabel(connection);
  const source =
    connection.source === "personal"
      ? ` via ${connection.collaboratorUsername ?? "the linked Slack user"}'s Doco account`
      : " via shared default";
  return `${target} as ${connection.role}${source}`;
}

async function readSlackDocoSearchHits(
  connections: SlackChannelConnectionSummary[],
  queryText: string,
): Promise<SlackDocoAnswerHit[]> {
  const groups = await Promise.all(
    connections.map((connection) => readSlackConnectionSearchHits(connection, queryText)),
  );
  return sortSlackDocoAnswerHits(groups.flat()).slice(0, SLACK_DOCO_ANSWER_LIMIT);
}

async function readSlackConnectionSearchHits(
  connection: SlackChannelConnectionSummary,
  queryText: string,
): Promise<SlackDocoAnswerHit[]> {
  const where = connection.targetLevel === "org" ? "d.org_id = $1" : "d.id = $1";
  const result = await withClient((c) =>
    c.query<{
      entity_id: string;
      doco_label: string;
      neuron_type: string;
      summary: string | null;
      body: string | null;
      rank: string | number;
    }>(
      `WITH scoped_docos AS (
         SELECT d.id, COALESCE(o.handle, '') || '/' || d.handle AS doco_label
           FROM docos d
           LEFT JOIN organizations o ON o.id = d.org_id
          WHERE ${where}
       ),
       query AS (
         SELECT websearch_to_tsquery('english', $2) AS q
       )
       SELECT f.entity_id,
              sd.doco_label,
              f.neuron_type,
              f.summary,
              f.body,
              ts_rank_cd(f.search_tsv, query.q) AS rank
         FROM entity_fts_neurons f
         JOIN scoped_docos sd ON sd.id = f.doco_id
         CROSS JOIN query
        WHERE f.search_tsv @@ query.q
        ORDER BY rank DESC, f.entity_id
        LIMIT $3`,
      [connection.targetId, queryText, SLACK_DOCO_ANSWER_LIMIT],
    ),
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    docoLabel: row.doco_label,
    neuronType: row.neuron_type,
    summary: row.summary,
    body: row.body,
    rank: Number(row.rank ?? 0),
  }));
}

async function readSlackDocoOverviewHits(
  connections: SlackChannelConnectionSummary[],
): Promise<SlackDocoAnswerHit[]> {
  const groups = await Promise.all(
    connections.map((connection) => readSlackConnectionOverviewHits(connection)),
  );
  return sortSlackDocoAnswerHits(groups.flat()).slice(0, SLACK_DOCO_ANSWER_LIMIT);
}

async function readSlackConnectionOverviewHits(
  connection: SlackChannelConnectionSummary,
): Promise<SlackDocoAnswerHit[]> {
  const where = connection.targetLevel === "org" ? "d.org_id = $1" : "d.id = $1";
  const result = await withClient((c) =>
    c.query<{
      entity_id: string;
      doco_label: string;
      neuron_type: string;
      summary: string | null;
      body: string | null;
      priority: string | number;
      created_at: string | null;
    }>(
      `WITH scoped_docos AS (
         SELECT d.id, COALESCE(o.handle, '') || '/' || d.handle AS doco_label
           FROM docos d
           LEFT JOIN organizations o ON o.id = d.org_id
          WHERE ${where}
       ),
       all_neurons AS (
         ${slackOverviewUnionSql()}
       )
       SELECT n.entity_id,
              sd.doco_label,
              n.neuron_type,
              n.summary,
              n.body,
              CASE n.neuron_type
                WHEN 'intent' THEN 5
                WHEN 'decision' THEN 4
                WHEN 'rule' THEN 3
                WHEN 'state' THEN 2
                ELSE 1
              END AS priority,
              n.created_at::text AS created_at
         FROM all_neurons n
         JOIN scoped_docos sd ON sd.id = n.doco_id
        WHERE NULLIF(trim(COALESCE(n.summary, '')), '') IS NOT NULL
        ORDER BY priority DESC, n.created_at DESC NULLS LAST, n.entity_id
        LIMIT $2`,
      [connection.targetId, SLACK_DOCO_ANSWER_LIMIT],
    ),
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    docoLabel: row.doco_label,
    neuronType: row.neuron_type,
    summary: row.summary,
    body: row.body,
    rank: Number(row.priority ?? 0),
  }));
}

function latestHumanSlackQuestion(recentMessages: SlackRecentMessage[]): string | null {
  for (const message of [...recentMessages].reverse()) {
    const text = cleanSlackMentionText(message.text);
    if (!text || message.botId || isSlackGreeting(text)) continue;
    return text;
  }
  return null;
}

function slackOverviewUnionSql(): string {
  return DOCO_NEURON_TABLE_SPECS.map((spec) => {
    const tnCol = ALL_ENTITY_TABLES[spec.entityType]?.typeNamedColumn ?? "summary";
    return `SELECT id AS entity_id,
                   doco_id,
                   ${sqlString(spec.entityType)} AS neuron_type,
                   split_part(${tnCol}, E'\\n', 1) AS summary,
                   ${tnCol} AS body,
                   created_at
              FROM ${spec.table}`;
  }).join("\nUNION ALL\n");
}

function formatRecentSlackContext(recentMessages: SlackRecentMessage[]): string {
  const cleaned = recentMessages
    .map((message) => cleanSlackMentionText(message.text))
    .filter((text) => text && !isSlackGreeting(text))
    .slice(-4);
  return cleaned.join(" ");
}

export function slackLlmSystemPrompt(): string {
  return [
    buildSenorDocoCorePrompt({
      surfaceDescription: "the Slack assistant for group chats and direct messages",
      accessDescription:
        "You answer from Slack using the workspace default Doco access, the current Slack user's linked personal Doco access when present, and any Slack context explicitly provided to you. Do not imply you have the signed-in website user's browser session.",
      capabilityDescription:
        "answer questions about Doco using doco_api reads, and perform Doco writes through doco_api only when the current Slack user has linked their Doco account and the normal Doco API authorizes that collaborator.",
      inScopePrefix: "the Slack-accessible",
      surfaceLimits: [
        "Slack can use doco_api for reads authorized by shared workspace defaults and linked personal Doco access. It cannot use the signed-in website user's browser session.",
        "Slack can use POST/PATCH/DELETE doco_api calls only through the linked Slack user's personal Doco account. The Doco API enforces that collaborator's actual role on every write.",
        "Slack cannot navigate the website, inspect the visible graph, or read file attachments from the Doco sidebar.",
        "When a Slack user asks you to create, patch, retire, invite, change policies, or perform any action beyond the current Slack default permissions, ask that user to run /doco connect and authorize their own Doco account for Slack if they already have the needed Doco access. Do not send them to the Doco website as the next step unless they explicitly ask for non-Slack alternatives; make the missing Slack authorization the next step.",
        "After personal Doco authorization exists, write actions run as that linked collaborator with audit attribution, and never above the role they already hold in Doco. If a doco_api write returns footer_lines, paste every footer_lines entry verbatim.",
        "Do not claim access beyond the listed Doco access. People may link personal Doco access later, but you only know the access included in this prompt.",
      ],
    }),
    "Available Slack doco_api reads: GET /api/v1/docos.json; GET /<handle>/status.json; GET /<handle>/search.json?q=...; GET /<handle>/api/<type>.json; GET /<handle>/api/<type>/<id>.json; GET /<handle>/api/principals.json; GET /<handle>/api/policies.json; GET /<handle>/api/settings.json; GET /<handle>/api/audit.json (supports limit, before, since, until, entity_type, op, by); GET /<handle>/api/perspectives.json; GET /<handle>/api/authoring-contract.json. Valid <type>: decisions, intents, actions, logs, rules, evals, references, ideas, states. Keep qualified org/doco labels in prose, but use the route handle from /api/v1/docos.json for API paths.",
    "Available Slack doco_api writes when this Slack user has linked personal Doco access: POST /api/v1/docos.json; POST /<handle>/api/<type>.json; PATCH /<handle>/api/<type>/<id>.json; POST /<handle>/api/principals.json; PATCH /<handle>/api/principals/<id>.json; POST /<handle>/api/policies.json; POST /<handle>/api/changesets.json.",
    "Answer with a concise, natural Slack message using doco_api results, provided Doco excerpts, and Slack context.",
    "Do not return the generic setup or access prompt. Do not merely list raw excerpts unless the user asks for a list.",
    "If a requested action is blocked by Slack default permissions, say you need the user's personal Doco authorization for Slack and ask them to run /doco connect if they have the required Doco role. Do not mention going to the website as a workaround. Be explicit about the required kind of role when you can infer it: owner for creating Docos or changing policies, author for adding neurons, approver for approval actions.",
    "If the user is already personally linked, try the appropriate doco_api write instead of saying authorization has not come through. If the write returns 401/403, explain the missing Doco role or scope from the tool result.",
    "After any successful POST/PATCH/DELETE, paste every returned footer_lines entry verbatim. Do not paraphrase or drop those lines.",
    "If the user says you did not answer, answer the most recent substantive unanswered user question in the Slack context.",
    "If the user asks for line breaks, bullets, better formatting, or complains that a prior answer is ugly, messy, hard to read, or not looking nice, treat it as a formatting repair: reformat the most recent relevant Señor Doco answer from Slack context instead of repeating the same shape.",
    "For line-break repair requests, preserve the content but split it into short Slack-friendly lines or bullets. Do not return the same single wrapped paragraph with extra words.",
    "Slack uses proportional fonts. For org charts, trees, reporting lines, and nested hierarchies, prefer short grouped bullets such as 'Manager — role' followed by indented report bullets. Do not mix bold Markdown with ASCII tree glyphs. If the user explicitly asks for a tree diagram, put the entire diagram in a fenced code block with plain text only.",
    "For questions like what the docos explain, synthesize the main themes and cite the doco labels naturally.",
    "If the excerpts are insufficient, say exactly what is missing.",
    "Keep the answer under 900 characters unless the user asks for detail.",
  ].join(" ");
}

function formatSlackLlmRecentMessages(recentMessages: SlackRecentMessage[]): string[] {
  const lines = recentMessages
    .map((message) => {
      const text = cleanSlackAnswerText(cleanSlackMentionText(message.text));
      if (!text) return null;
      const speaker = message.botId ? "Señor Doco" : "User";
      return `- ${speaker}: ${truncateSlackAnswerText(text, 500)}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(-8);
  return lines.length > 0 ? lines : ["- None"];
}

function formatSlackLlmHit(hit: SlackDocoAnswerHit, index: number): string {
  const summary = cleanSlackAnswerText(hit.summary ?? "");
  const body = cleanSlackAnswerText(hit.body ?? "");
  const bodyText =
    body && body !== summary ? `\n  Detail: ${truncateSlackAnswerText(body, 900)}` : "";
  return `[${index + 1}] ${capitalize(hit.neuronType)} in ${hit.docoLabel}: ${summary || "No summary."}${bodyText}`;
}

function cleanSlackLlmAnswer(
  text: string,
  options: { footerLines?: string[]; repairText?: string | null } = {},
): string | null {
  const cleaned = cleanSlackLlmOutputText(text)
    .replace(/^["“]|["”]$/g, "")
    .trim();
  if (!cleaned && (!options.footerLines || options.footerLines.length === 0)) return null;
  const formatted = options.repairText
    ? formatSlackLineBreakRepairOutput(cleaned, options.repairText)
    : cleaned;
  return truncateSlackAnswerText(prependSlackDocoFooterLines(formatted, options.footerLines), 1800);
}

function cleanSlackLlmOutputText(text: string): string {
  return text
    .replace(/`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) =>
      formatSlackLink(url, label),
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSlackDocoFooterLines(toolResults: DocoApiToolResult[]): string[] {
  const lines: string[] = [];
  for (const toolResult of toolResults) {
    const content = toolResult.result.content;
    if (typeof content !== "string") continue;
    try {
      const parsed = JSON.parse(content) as DocoApiToolEnvelope;
      lines.push(...collectDocoFooterLines(parsed.body));
    } catch {
      // Ignore non-JSON or truncated tool output; the LLM still sees the raw result.
    }
  }
  return lines;
}

function collectDocoFooterLines(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectDocoFooterLines);

  const record = value as Record<string, unknown>;
  const directLines = Array.isArray(record.footer_lines)
    ? record.footer_lines.filter((line): line is string => typeof line === "string")
    : [];
  return [
    ...directLines,
    ...Object.entries(record)
      .filter(([key]) => key !== "footer_lines")
      .flatMap(([, child]) => collectDocoFooterLines(child)),
  ];
}

function prependSlackDocoFooterLines(
  text: string,
  footerLines: string[] | null | undefined,
): string {
  const formattedFooterLines = uniqueStrings(
    (footerLines ?? []).map(formatSlackDocoFooterLine).filter(Boolean),
  );
  if (formattedFooterLines.length === 0) return text;

  const nonFooterText = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("[🔮 Doco]"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [formattedFooterLines.join("\n"), nonFooterText].filter(Boolean).join("\n\n");
}

function formatSlackDocoFooterLine(line: string): string {
  return line.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => formatSlackLink(url, label),
  );
}

function formatSlackLink(url: string, label: string): string {
  const cleanUrl = url.trim();
  const cleanLabel = label.replace(/[<>|]/g, "").trim();
  return `<${cleanUrl}|${cleanLabel || cleanUrl}>`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function formatSlackLineBreakRepairOutput(text: string, repairText: string): string {
  if (!isSlackLineBreakRepair(repairText)) return text;
  return text
    .replace(/([:.])\s+[-•]\s+/g, "$1\n- ")
    .replace(/\s+[-•]\s+(\d+\s+[A-Za-z])/g, "\n- $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sortSlackDocoAnswerHits(hits: SlackDocoAnswerHit[]): SlackDocoAnswerHit[] {
  return uniqueSlackDocoAnswerHits(hits).sort((a, b) => {
    const byRank = b.rank - a.rank;
    if (byRank !== 0) return byRank;
    return a.entityId.localeCompare(b.entityId);
  });
}

function uniqueSlackDocoAnswerHits(hits: SlackDocoAnswerHit[]): SlackDocoAnswerHit[] {
  const seen = new Set<string>();
  const unique: SlackDocoAnswerHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.entityId)) continue;
    seen.add(hit.entityId);
    unique.push(hit);
  }
  return unique;
}

function formatSlackDocoHitText(hit: SlackDocoAnswerHit): string {
  const text = cleanSlackAnswerText(hit.summary || firstParagraph(hit.body) || "No summary yet.");
  return truncateSlackAnswerText(text, 220);
}

function firstParagraph(text: string | null): string {
  return (
    (text ?? "")
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? ""
  );
}

function cleanSlackAnswerText(text: string): string {
  return text
    .replace(/`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSlackAnswerText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function capitalize(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

export async function getSlackBotUserId(workspaceId: string): Promise<string | null> {
  const result = await withClient((c) =>
    c.query<{ bot_user_id: string | null }>(
      `SELECT bot_user_id
         FROM group_chat_installations
        WHERE provider = 'slack' AND workspace_id = $1`,
      [workspaceId],
    ),
  );
  return result.rows[0]?.bot_user_id ?? null;
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
  const url = new URL("/integrations/slack/setup", request.url);
  url.searchParams.set("team_id", payload.team_id);
  if (payload.team_domain) url.searchParams.set("team_name", payload.team_domain);
  return url.toString();
}

export function buildSlackConnectCommandResponse(request: Request, payload: SlackCommandPayload) {
  const connectUrl = slackConnectUrl(request, payload);
  const personalAuthorizationUrl = payload.user_id
    ? buildSlackPersonalAuthorizationUrl(request, {
        workspaceId: payload.team_id,
        chatUserId: payload.user_id,
      })
    : null;
  const elements = [
    personalAuthorizationUrl
      ? {
          type: "button",
          text: { type: "plain_text", text: "Authorize my Doco account" },
          url: personalAuthorizationUrl,
          action_id: "authorize_doco_account_for_slack",
        }
      : null,
    {
      type: "button",
      text: { type: "plain_text", text: "Manage workspace defaults" },
      url: connectUrl,
      action_id: "open_doco_channel_connection",
    },
  ].filter(Boolean);
  return {
    response_type: "ephemeral",
    text: "Connect your Doco account to Slack, or manage Señor Doco's shared workspace defaults.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your Doco account to Slack for personal access, or manage Señor Doco's shared workspace defaults.",
        },
      },
      {
        type: "actions",
        elements,
      },
    ],
  };
}

export async function postSlackMessage(args: {
  workspaceId: string;
  channelId: string;
  text: string;
  threadTs?: string | null;
}): Promise<void> {
  const token = await getSlackBotToken(args.workspaceId);
  if (!token) {
    throw new Error(`Slack bot token is missing for workspace ${args.workspaceId}.`);
  }
  const response = await fetch(SLACK_CHAT_POST_MESSAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channelId,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as SlackApiResponse | null;
  if (!response.ok || body?.ok === false) {
    const reason = body?.error ? `: ${body.error}` : "";
    throw new Error(`Slack chat.postMessage failed${reason}.`);
  }
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
