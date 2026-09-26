import { waitUntil } from "@vercel/functions";
import { mirrorSlackEvent } from "~/lib/slack-mirror.server";
import {
  type SlackBotIdentity,
  type SlackRecentMessage,
  buildSlackAppMentionResponse,
  buildSlackChannelIntroLine,
  fetchSlackConversationContext,
  getSlackBotIdentity,
  markSlackChannelIntroducedIfFirst,
  postSlackMessage,
  removeSlackInstallation,
  verifySlackRequest,
} from "~/lib/slack.server";

// Slack expects an HTTP 200 within ~3s, but answer generation (Doco search +
// a multi-turn LLM loop) routinely runs longer. We ack immediately and finish
// the work in the background via `waitUntil`; `maxDuration` keeps that
// background work from being cut short. (Decision: Slack events ack-then-process.)
//
// The public-channel mirror is the exception: its write is a single idempotent
// upsert, done BEFORE the ack so a failed write answers 500 and Slack redelivers
// the event. It runs on retries too; only the answer is skipped for a retry.
export const config = { maxDuration: 300 };

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  if (!(await verifySlackRequest(request, rawBody))) {
    return Response.json({ error: "invalid_slack_signature" }, { status: 401 });
  }

  let payload: {
    type?: string;
    challenge?: string;
    team_id?: string;
    is_ext_shared_channel?: boolean;
    event?: SlackEventPayload;
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }

  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge ?? "" });
  }

  const event = payload.event;
  const teamId = payload.team_id;
  if (payload.type !== "event_callback" || !event || !teamId) {
    return Response.json({ ok: true });
  }

  // A retry re-delivers an event whose answer is already under way (it was just
  // acked late), so it never starts a second answer.
  if (!isSlackRetryRequest(request) && shouldProcessSlackEvent(event)) {
    const channelId = event.channel;
    if (channelId && !event.bot_id && !event.subtype) {
      // Ack now, answer in the background: Slack's ~3s deadline and the function
      // timeout must not gate answer generation. A slow generation previously
      // either triggered Slack retries (suppressed above) or a
      // FUNCTION_INVOCATION_TIMEOUT, dropping the reply entirely.
      waitUntil(
        respondToSlackEvent({
          teamId,
          channelId,
          event,
          origin: new URL(request.url).origin,
        }).catch((error) => {
          console.error(
            "[slack] event response failed:",
            error instanceof Error ? error.message : error,
          );
        }),
      );
    }
  }

  try {
    if (isSlackUninstallEvent(event)) {
      // Removing the installation cascades to its mirror: uninstalling deletes the copy.
      await removeSlackInstallation(teamId);
    } else {
      await mirrorSlackEvent({
        teamId,
        event: event as Record<string, unknown>,
        isExtSharedChannel: payload.is_ext_shared_channel === true,
      });
    }
  } catch (error) {
    console.error("[slack] mirror write failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "mirror_write_failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

/** The app was uninstalled, or its bot token revoked: the install is dead. */
function isSlackUninstallEvent(event: SlackEventPayload): boolean {
  if (event.type === "app_uninstalled") return true;
  return event.type === "tokens_revoked" && (event.tokens?.bot?.length ?? 0) > 0;
}

async function respondToSlackEvent(args: {
  teamId: string;
  channelId: string;
  event: SlackEventPayload;
  origin: string;
}): Promise<void> {
  const { teamId, channelId, event, origin } = args;
  const explicitReply = shouldReplyToSlackEvent(event);
  const implicitReplyCandidate = shouldInspectSlackImplicitReplyEvent(event);
  const threadTs = slackReplyThreadTs(event);
  const recentMessages = shouldFetchSlackConversationContext(event)
    ? await fetchSlackConversationContext({
        workspaceId: teamId,
        channelId,
        latestTs: event.ts,
        ...(threadTs ? { threadTs } : {}),
      })
    : [];
  const botIdentity = implicitReplyCandidate ? await getSlackBotIdentity(teamId) : null;
  if (
    !explicitReply &&
    !shouldTreatSlackMessageAsImplicitReply(event, recentMessages, botIdentity)
  ) {
    return;
  }
  const text = await buildSlackAppMentionResponse({
    workspaceId: teamId,
    channelId,
    chatUserId: event.user ?? null,
    messageText: event.text ?? "",
    recentMessages,
    origin,
  });
  // The first time Señor Doco speaks in a channel, lead with the Sonnet/MCP
  // intro. Mark-then-post (atomic) so a racing first reply can't double-post
  // the intro; checked here — right before posting — so a turn that decided
  // not to reply doesn't burn the channel's one introduction.
  const introLine = (await markSlackChannelIntroducedIfFirst({ workspaceId: teamId, channelId }))
    ? buildSlackChannelIntroLine(origin)
    : null;
  await postSlackMessage({
    workspaceId: teamId,
    channelId,
    text: introLine ? `${introLine}\n\n${text}` : text,
    ...(threadTs ? { threadTs } : {}),
  });
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

interface SlackEventPayload {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  tokens?: { bot?: string[]; oauth?: string[] };
}

function slackReplyThreadTs(event: SlackEventPayload | undefined): string | null {
  if (!event?.thread_ts || event.thread_ts === event.ts) return null;
  return event.thread_ts;
}

function shouldProcessSlackEvent(event: SlackEventPayload | undefined): boolean {
  return shouldReplyToSlackEvent(event) || shouldInspectSlackImplicitReplyEvent(event);
}

export function shouldReplyToSlackEvent(event: SlackEventPayload | undefined): boolean {
  if (event?.type === "app_mention") return true;
  if (event?.type !== "message") return false;
  return event.channel_type === "im" || event.channel_type === "app_home";
}

export function shouldFetchSlackConversationContext(event: SlackEventPayload | undefined): boolean {
  if (!event) return false;
  if (event.type === "app_mention") return true;
  return (
    event.channel_type === "im" ||
    event.channel_type === "app_home" ||
    shouldInspectSlackImplicitReplyEvent(event)
  );
}

export function shouldInspectSlackImplicitReplyEvent(
  event: SlackEventPayload | undefined,
): boolean {
  if (event?.type !== "message") return false;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return false;
  if (slackReplyThreadTs(event)) return true;
  return Boolean(event.ts && !event.thread_ts && looksDirectedAtThreadBot(event.text ?? ""));
}

export function shouldTreatSlackMessageAsImplicitReply(
  event: SlackEventPayload | undefined,
  recentMessages: SlackRecentMessage[],
  botIdentity: SlackBotIdentity | null,
): boolean {
  if (!event || !shouldInspectSlackImplicitReplyEvent(event)) return false;
  if (!isImplicitReplyToSenorDoco(event, recentMessages, botIdentity)) return false;
  return looksDirectedAtThreadBot(event?.text ?? "");
}

function isImplicitReplyToSenorDoco(
  event: SlackEventPayload,
  recentMessages: SlackRecentMessage[],
  botIdentity: SlackBotIdentity | null,
): boolean {
  if (!hasSlackBotIdentity(botIdentity)) return false;
  const threadTs = slackReplyThreadTs(event);
  if (threadTs) {
    const root = recentMessages.find((message) => message.ts === threadTs);
    return isSenorDocoSlackMessage(root, botIdentity);
  }
  const previous = recentMessages.at(-1);
  if (!previous || !isSenorDocoSlackMessage(previous, botIdentity)) return false;
  return isRecentSlackMessage(event.ts, previous.ts, 10 * 60);
}

// Señor Doco's own prior message must be recognized for an unmentioned reply to
// count. Match on the bot user id OR the bot id: messages posted via
// chat.postMessage carry `user`, but some Slack message shapes carry only
// `bot_id`, and the earlier userId-only check silently dropped those.
function isSenorDocoSlackMessage(
  message: SlackRecentMessage | undefined,
  botIdentity: SlackBotIdentity,
): boolean {
  if (!message) return false;
  if (botIdentity.userId && message.userId === botIdentity.userId) return true;
  if (botIdentity.botId && message.botId === botIdentity.botId) return true;
  return false;
}

function hasSlackBotIdentity(
  botIdentity: SlackBotIdentity | null,
): botIdentity is SlackBotIdentity {
  return Boolean(botIdentity && (botIdentity.userId || botIdentity.botId));
}

function isRecentSlackMessage(
  eventTs: string | undefined,
  previousTs: string | null | undefined,
  maxAgeSeconds: number,
): boolean {
  const eventSeconds = slackTimestampSeconds(eventTs);
  const previousSeconds = slackTimestampSeconds(previousTs);
  if (eventSeconds === null || previousSeconds === null) return true;
  return eventSeconds >= previousSeconds && eventSeconds - previousSeconds <= maxAgeSeconds;
}

function slackTimestampSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksDirectedAtThreadBot(text: string): boolean {
  const cleanText = text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanText) return false;
  const lower = cleanText.toLowerCase();
  if (/^(thanks|thank you|thx|ok|okay|got it|perfect|cool|nice|great)[\s!.,]*$/.test(lower)) {
    return false;
  }
  return (
    /^(yes|yeah|yep|sure|please|no|nope)[\s!.,]*$/i.test(cleanText) ||
    cleanText.includes("?") ||
    /\b(you|your|yours|that|this|it|those|they|them)\b/i.test(cleanText) ||
    /\b(not\s+looking\s+(nice|good)|looks?\s+(bad|ugly|messy)|hard\s+to\s+read|line\s+breaks?)\b/i.test(
      cleanText,
    ) ||
    /\b(add|show|explain|summarize|fix|format|rewrite|create|update|change|invite|link|open|try|tell|answer|continue|include|exclude|remove|again|same|also)\b/i.test(
      cleanText,
    ) ||
    /\b(doco|docos?|node|nodes?|decision|intent|action|rule|log|reference|principal|policy)\b/i.test(
      cleanText,
    )
  );
}

export function isSlackRetryRequest(request: Request): boolean {
  return request.headers.has("x-slack-retry-num");
}
