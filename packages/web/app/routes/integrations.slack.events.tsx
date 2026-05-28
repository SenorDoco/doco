import {
  type SlackRecentMessage,
  buildSlackAppMentionResponse,
  fetchSlackConversationContext,
  getSlackBotUserId,
  postSlackMessage,
  verifySlackRequest,
} from "~/lib/slack.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  if (!(await verifySlackRequest(request, rawBody))) {
    return Response.json({ error: "invalid_slack_signature" }, { status: 401 });
  }
  if (isSlackRetryRequest(request)) {
    return Response.json({ ok: true });
  }

  let payload: {
    type?: string;
    challenge?: string;
    team_id?: string;
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

  if (payload.type === "event_callback" && shouldProcessSlackEvent(event)) {
    const teamId = payload.team_id;
    const channelId = event?.channel;
    if (teamId && channelId && !event?.bot_id && !event?.subtype) {
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
      const botUserId = implicitReplyCandidate ? await getSlackBotUserId(teamId) : null;
      if (
        !explicitReply &&
        !shouldTreatSlackMessageAsImplicitReply(event, recentMessages, botUserId)
      ) {
        return Response.json({ ok: true });
      }
      const text = await buildSlackAppMentionResponse({
        workspaceId: teamId,
        channelId,
        chatUserId: event?.user ?? null,
        messageText: event?.text ?? "",
        recentMessages,
        origin: new URL(request.url).origin,
      });
      await postSlackMessage({
        workspaceId: teamId,
        channelId,
        text,
        ...(threadTs ? { threadTs } : {}),
      });
    }
  }

  return Response.json({ ok: true });
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
  if (!slackReplyThreadTs(event)) return false;
  return event.channel_type === "channel" || event.channel_type === "group";
}

export function shouldTreatSlackMessageAsImplicitReply(
  event: SlackEventPayload | undefined,
  recentMessages: SlackRecentMessage[],
  botUserId: string | null,
): boolean {
  if (!event || !shouldInspectSlackImplicitReplyEvent(event)) return false;
  if (!isThreadRootFromSenorDoco(event, recentMessages, botUserId)) return false;
  return looksDirectedAtThreadBot(event?.text ?? "");
}

function isThreadRootFromSenorDoco(
  event: SlackEventPayload,
  recentMessages: SlackRecentMessage[],
  botUserId: string | null,
): boolean {
  const threadTs = slackReplyThreadTs(event);
  const root = recentMessages.find((message) => message.ts === threadTs);
  if (!root) return false;
  return Boolean(botUserId && root.userId === botUserId);
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
    /\b(doco|docos?|neuron|neurons?|decision|intent|action|rule|log|reference|principal|policy)\b/i.test(
      cleanText,
    )
  );
}

export function isSlackRetryRequest(request: Request): boolean {
  return request.headers.has("x-slack-retry-num");
}
