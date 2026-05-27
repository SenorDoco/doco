import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ALL_ENTITY_TABLES, DOCO_NEURON_TABLE_SPECS, withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import { ensureEnvLoaded } from "./dotenv.server";

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "commands",
  "im:history",
  "im:write",
  "team:read",
  "users:read",
] as const;

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_CONVERSATIONS_HISTORY_URL = "https://slack.com/api/conversations.history";
const STATE_TTL_MS = 15 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SLACK_DOCO_ANSWER_LIMIT = 5;

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
  overview: boolean;
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

type SlackCountKind =
  | "neurons"
  | "docos"
  | "decisions"
  | "intents"
  | "actions"
  | "logs"
  | "rules"
  | "evals"
  | "references"
  | "ideas"
  | "states"
  | "principals";

interface SlackCountSpec {
  kind: SlackCountKind;
  alias: string;
  table: string;
  singular: string;
}

interface SlackConnectionCounts {
  connection: SlackChannelConnectionSummary;
  docoCount: number;
  docoLabels: string[];
  counts: Record<SlackCountKind, number>;
}

const SLACK_COUNT_SPECS: readonly SlackCountSpec[] = [
  ...DOCO_NEURON_TABLE_SPECS.map((spec) => ({
    kind: (spec.entityType === "reference" ? "references" : `${spec.table}`) as SlackCountKind,
    alias: spec.table,
    table: spec.table,
    singular: spec.entityType === "reference" ? "reference" : spec.entityType,
  })),
  {
    kind: "principals",
    alias: "principals",
    table: "principals",
    singular: "principal",
  },
] as const;

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
  }));
}

export async function buildSlackAppMentionResponse(args: {
  workspaceId: string;
  channelId: string;
  messageText: string;
  recentMessages?: SlackRecentMessage[];
}): Promise<string> {
  const connections = await listSlackChannelConnections({
    workspaceId: args.workspaceId,
    channelId: args.channelId,
  });
  if (connections.length === 0) {
    return "I’m installed here, but I don’t have default Doco permissions yet. Open Doco Integrations to choose them, or use `/doco connect`.";
  }

  const cleanText = cleanSlackMentionText(args.messageText);
  if (detectSlackAccessQuestion(cleanText)) {
    return formatSlackAccessResponse(connections);
  }

  if (isSlackGreeting(cleanText)) {
    return formatSlackDefaultResponse(connections, cleanText);
  }

  const wantsInventory = detectSlackInventoryQuestion(cleanText);
  const countKind = detectSlackCountKind(cleanText);
  if (wantsInventory || countKind) {
    const counts = await Promise.all(
      connections.map((connection) => readSlackConnectionCounts(connection)),
    );
    if (wantsInventory) return formatSlackInventoryResponse(counts);
    if (countKind) return formatSlackCountResponse(counts, countKind);
  }

  const answerQuery = buildSlackDocoAnswerQuery(cleanText, args.recentMessages);
  if (answerQuery) {
    const hits = answerQuery.overview
      ? await readSlackDocoOverviewHits(connections)
      : await readSlackDocoSearchHits(connections, answerQuery.text);
    if (hits.length > 0) {
      return formatSlackDocoAnswerResponse(hits, { overview: answerQuery.overview });
    }
  }

  return formatSlackDefaultResponse(connections, cleanText);
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

export function detectSlackCountKind(text: string): SlackCountKind | null {
  const lower = text.toLowerCase();
  const looksLikeCountQuestion =
    /\b(how many|count|number of|cu[aá]nt[ao]s?)\b/.test(lower) ||
    /\b(nodes?|neurons?|docos?|decisions?|intents?|actions?|logs?|rules?|evals?|evaluations?|references?|ideas?|states?|principals?)\b.*\b(have|exist|are there)\b/.test(
      lower,
    );
  if (!looksLikeCountQuestion) return null;

  if (/\bdocos?\b/.test(lower)) return "docos";
  if (/\bdecisions?\b/.test(lower)) return "decisions";
  if (/\bintents?\b/.test(lower)) return "intents";
  if (/\bactions?\b/.test(lower)) return "actions";
  if (/\blogs?\b/.test(lower)) return "logs";
  if (/\brules?\b/.test(lower)) return "rules";
  if (/\b(evals?|evaluations?)\b/.test(lower)) return "evals";
  if (/\breferences?\b/.test(lower)) return "references";
  if (/\bideas?\b/.test(lower)) return "ideas";
  if (/\bstates?\b/.test(lower)) return "states";
  if (/\bprincipals?\b/.test(lower)) return "principals";
  if (/\b(nodes?|neurons?)\b/.test(lower)) return "neurons";
  return null;
}

export function detectSlackInventoryQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\bwhat\s+docos?\s+(do\s+we|can\s+you)\s+(have|access|see)\b/.test(lower) ||
    /\bwhat\s+(do\s+we|can\s+you)\s+(have|access|see)\s+(in|inside|on)\s+doco\b/.test(lower) ||
    /\bwhat'?s\s+(in|inside)\s+doco\b/.test(lower)
  );
}

export function detectSlackAccessQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\bwho\s+are\s+you\b/.test(lower) ||
    /\bwhat\s+are\s+you\b/.test(lower) ||
    /\bwhat\s+(access|permissions?)\s+(do\s+you\s+have|can\s+you\s+use)\b/.test(lower) ||
    /\bwhat\s+do\s+you\s+have\s+access\s+to\b/.test(lower) ||
    /\bwhat\s+can\s+you\s+access\b/.test(lower) ||
    /\bshow\s+(your\s+)?(access|permissions?)\b/.test(lower)
  );
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
  const recentContext = formatRecentSlackContext(recentMessages);
  const overview = detectSlackDocoOverviewQuestion(text, recentMessages);
  const searchParts = overview
    ? [
        text,
        recentContext,
        "Doco intent decision rule action log reference state explains documents purpose architecture",
      ]
    : [text, recentContext];
  const query = searchParts.filter(Boolean).join(" ").trim();
  return query ? { text: query, overview } : null;
}

export function detectSlackDocoOverviewQuestion(
  text: string,
  recentMessages: SlackRecentMessage[] = [],
): boolean {
  const lower = text.toLowerCase();
  if (
    /\bwhat\s+(do|does)\s+(we\s+)?document\b/.test(lower) ||
    /\bwhat\s+(does|do)\s+(doco|docos?|it|they)\s+(explain|document|contain|cover)\b/.test(lower) ||
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

export function formatSlackAccessResponse(connections: SlackChannelConnectionSummary[]): string {
  const defaultTargets = formatSlackConnectionRoleList(connections);
  const defaultScope = slackDefaultScopeLabel(connections);
  return [
    `I’m Señor Doco, Doco’s Slack assistant. By default in this ${defaultScope}, I can use ${defaultTargets}.`,
    "That shared default applies to everyone here.",
    "People can still link their own Doco account for higher personal access they already hold, but I never get more than their Doco permissions.",
    "Owner-only actions, like creating Docos or changing policies, still require that person to be an owner in Doco.",
  ].join(" ");
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

export async function fetchSlackConversationContext(args: {
  workspaceId: string;
  channelId: string;
  latestTs?: string | null;
  limit?: number;
}): Promise<SlackRecentMessage[]> {
  const token = await getSlackBotToken(args.workspaceId);
  if (!token) return [];
  const url = new URL(SLACK_CONVERSATIONS_HISTORY_URL);
  url.searchParams.set("channel", args.channelId);
  url.searchParams.set("limit", String(args.limit ?? 8));
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

async function readSlackConnectionCounts(
  connection: SlackChannelConnectionSummary,
): Promise<SlackConnectionCounts> {
  const where = connection.targetLevel === "org" ? "d.org_id = $1" : "d.id = $1";
  const countSelects = SLACK_COUNT_SPECS.map(
    (spec) =>
      `(SELECT COUNT(*)::text FROM ${spec.table} WHERE doco_id IN (SELECT id FROM scoped_docos)) AS ${spec.alias}`,
  ).join(",\n              ");
  const result = await withClient((c) =>
    c.query<{ doco_labels?: string[] | null } & Record<string, string | string[] | null>>(
      `WITH scoped_docos AS (
         SELECT d.id
           FROM docos d
          WHERE ${where}
       )
       SELECT (SELECT COUNT(*)::text FROM scoped_docos) AS docos,
              (SELECT COALESCE(
                        array_agg(COALESCE(o.handle, '') || '/' || d.handle ORDER BY o.handle, d.handle),
                        ARRAY[]::text[]
                      )
                 FROM scoped_docos sd
                 JOIN docos d ON d.id = sd.id
                 LEFT JOIN organizations o ON o.id = d.org_id) AS doco_labels,
              ${countSelects}`,
      [connection.targetId],
    ),
  );
  const row = result.rows[0] ?? {};
  const counts = Object.fromEntries(
    SLACK_COUNT_SPECS.map((spec) => [spec.kind, Number(row[spec.alias] ?? 0)]),
  ) as Record<SlackCountKind, number>;
  counts.docos = Number(row.docos ?? 0);
  counts.neurons = SLACK_COUNT_SPECS.reduce((total, spec) => total + counts[spec.kind], 0);
  return {
    connection,
    docoCount: counts.docos,
    docoLabels: Array.isArray(row.doco_labels) ? row.doco_labels : [],
    counts,
  };
}

export function formatSlackInventoryResponse(summaries: SlackConnectionCounts[]): string {
  if (summaries.length === 0) return "I don’t have any default Doco permissions here yet.";
  const lines = summaries.map(formatSlackInventoryLine);
  if (lines.length === 1) return lines[0];
  return ["Here’s what I can access by default:", ...lines.map((line) => `• ${line}`)].join("\n");
}

function formatSlackInventoryLine(summary: SlackConnectionCounts): string {
  const accessLabel = slackConnectionAccessLabelWithRole(summary.connection);
  const docoList = formatSlackDocoLabels(summary.docoLabels);
  const nonzeroCounts = SLACK_COUNT_SPECS.map((spec) => ({
    label: spec.singular,
    value: summary.counts[spec.kind] ?? 0,
  })).filter((entry) => entry.value > 0);
  const contents =
    nonzeroCounts.length > 0
      ? ` It contains ${formatCount(summary.counts.neurons, "neuron")}: ${formatCountList(
          nonzeroCounts,
        )}.`
      : " It does not have any neurons yet.";
  return `${accessLabel}: ${formatCount(summary.docoCount, "Doco")}${docoList}.${contents}`;
}

export function formatSlackCountResponse(
  summaries: SlackConnectionCounts[],
  kind: SlackCountKind,
): string {
  if (summaries.length === 0) return "I don’t have any default Doco permissions here yet.";
  const lines = summaries.map((summary) => formatSlackCountLine(summary, kind));
  if (lines.length === 1) return lines[0];
  return [
    "Here’s what I found using the Slack workspace default:",
    ...lines.map((line) => `• ${line}`),
  ].join("\n");
}

function formatSlackCountLine(summary: SlackConnectionCounts, kind: SlackCountKind): string {
  const label = summary.connection.targetLabel;
  if (kind === "docos") {
    if (summary.connection.targetLevel === "org") {
      return `${label} has ${formatCount(summary.docoCount, "Doco")} available by default.`;
    }
    return `${label} is 1 Doco.`;
  }
  const value = summary.counts[kind] ?? 0;
  const unit = kind === "neurons" ? "neuron" : (countSpecForKind(kind)?.singular ?? kind);
  if (summary.connection.targetLevel === "org") {
    return `${label} has ${formatCount(value, unit)} across ${formatCount(
      summary.docoCount,
      "Doco",
    )}.`;
  }
  return `${label} has ${formatCount(value, unit)}.`;
}

function countSpecForKind(kind: SlackCountKind): SlackCountSpec | null {
  return SLACK_COUNT_SPECS.find((spec) => spec.kind === kind) ?? null;
}

function formatSlackConnectionList(connections: SlackChannelConnectionSummary[]): string {
  const labels = connections.map(slackConnectionAccessLabel);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, 2).join(", ")}, and ${labels.length - 2} more`;
}

function formatSlackConnectionRoleList(connections: SlackChannelConnectionSummary[]): string {
  const labels = connections.map(slackConnectionAccessLabelWithRole);
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
  return `${target} as ${connection.role}`;
}

function slackDefaultScopeLabel(connections: SlackChannelConnectionSummary[]): string {
  return connections.every((connection) => connection.channelId === "*")
    ? "Slack workspace"
    : "Slack channel";
}

function formatSlackDocoLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  const shown = labels.slice(0, 5);
  const suffix = labels.length > shown.length ? `, and ${labels.length - shown.length} more` : "";
  return ` (${shown.join(", ")}${suffix})`;
}

function formatCountList(entries: { label: string; value: number }[]): string {
  const parts = entries.map((entry) => formatCount(entry.value, entry.label));
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function formatCount(value: number, singular: string): string {
  const label = value === 1 ? singular : singular === "Doco" ? "Docos" : `${singular}s`;
  return `${value.toLocaleString()} ${label}`;
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
  return {
    response_type: "ephemeral",
    text: "Open Doco to choose Señor Doco's default permissions for this Slack workspace.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Open Doco to choose Señor Doco's default permissions for this Slack workspace.",
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
