// Production incident diagnostics — the data behind `/admin/agent-debug.json`
// AND the `doco_agent_debug` MCP tool, in ONE place so the browser surface and
// every connected agent read the exact same thing.
//
// Two capabilities exist beyond a raw row dump, because a raw dump alone could
// not answer the question that motivated this module ("Señor Doco said it
// didn't have the file I attached — why?"):
//
//   1. searchConversationsByMessageText — find the thread from a phrase the
//      user remembers (a quote from the chat), so an agent can go from a
//      screenshot to the conversation id without a human looking it up.
//   2. analyzeReplayWindow — replay the REAL trim the turn loop applies
//      (trimHistoryToWindow) and report, per attached file, whether it still
//      falls inside the window fed to the model, or was evicted by the
//      message/token cap, or deleted by the 30-day retention purge. That is the
//      definitive "what happened" for an attachment that went missing.

import { withClient } from "@doco/db";
import {
  type AttachmentRefBlock,
  type ChatMessageRow,
  MAX_REPLAY_APPROX_TOKENS,
  MAX_REPLAY_MESSAGES,
  approximateReplayTokens,
  loadMessages,
  trimHistoryToWindow,
} from "./agent-chat.server";

export interface ReplayAttachmentStatus {
  attachment_id: string;
  filename: string;
  message_id: string;
  /** 0-based position of the message that carries this ref, oldest = 0. */
  message_index: number;
  /** Does this message survive the trim into the window fed to the model? */
  in_replay_window: boolean;
  /** Were the bytes purged by the 30-day retention sweep (or never stored)? */
  expired: boolean;
  /** in_replay_window && !expired — the model actually sees the file iff true. */
  visible_to_model: boolean;
}

export interface ReplayWindowAnalysis {
  total_messages: number;
  total_approx_tokens: number;
  /** First message index kept by the window (rows.length - window length). */
  window_start_index: number;
  window_message_count: number;
  window_approx_tokens: number;
  max_replay_messages: number;
  max_replay_approx_tokens: number;
  attachments: ReplayAttachmentStatus[];
}

function isAttachmentRef(block: unknown): block is AttachmentRefBlock {
  return (
    !!block && typeof block === "object" && (block as { type?: unknown }).type === "attachment_ref"
  );
}

/**
 * Pure: given the full message history of a thread and the set of attachment
 * ids whose bytes are gone (expired/purged), report which attached files the
 * model would still see on the next turn. Mirrors the production send path,
 * which trims history with `trimHistoryToWindow` (last MAX_REPLAY_MESSAGES
 * messages, then capped to ~MAX_REPLAY_APPROX_TOKENS) before hydrating refs.
 */
export function analyzeReplayWindow(
  rows: ChatMessageRow[],
  expiredAttachmentIds: Set<string>,
): ReplayWindowAnalysis {
  const window = trimHistoryToWindow(rows);
  const windowStartIndex = rows.length - window.length;

  const attachments: ReplayAttachmentStatus[] = [];
  rows.forEach((row, index) => {
    for (const block of row.content) {
      if (!isAttachmentRef(block)) continue;
      const inWindow = index >= windowStartIndex;
      const expired = expiredAttachmentIds.has(block.attachment_id);
      attachments.push({
        attachment_id: block.attachment_id,
        filename: block.filename,
        message_id: row.id,
        message_index: index,
        in_replay_window: inWindow,
        expired,
        visible_to_model: inWindow && !expired,
      });
    }
  });

  return {
    total_messages: rows.length,
    total_approx_tokens: approximateReplayTokens(rows),
    window_start_index: windowStartIndex,
    window_message_count: window.length,
    window_approx_tokens: approximateReplayTokens(window),
    max_replay_messages: MAX_REPLAY_MESSAGES,
    max_replay_approx_tokens: MAX_REPLAY_APPROX_TOKENS,
    attachments,
  };
}

export interface ConversationSearchHit {
  conversation_id: string;
  user_id: string;
  title: string | null;
  match_count: number;
  last_match_at: string;
}

// ILIKE metacharacters in a remembered phrase ("100% done", "a_b") should match
// literally, not act as wildcards — escape them so search does what the agent
// means.
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Find conversations whose message content contains `text` (case-insensitive),
 * newest match first. The entry point for "find the thread from this quote".
 */
export async function searchConversationsByMessageText(
  text: string,
  limit = 20,
): Promise<ConversationSearchHit[]> {
  const needle = text.trim();
  if (!needle) return [];
  const capped = Math.max(1, Math.min(100, Math.round(limit)));
  return await withClient(async (c) => {
    const r = await c.query<ConversationSearchHit>(
      `SELECT m.conversation_id,
              c.user_id,
              c.title,
              COUNT(*)::int                AS match_count,
              MAX(m.created_at)::text      AS last_match_at
         FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.content::text ILIKE '%' || $1 || '%' ESCAPE '\\'
        GROUP BY m.conversation_id, c.user_id, c.title
        ORDER BY MAX(m.created_at) DESC
        LIMIT $2`,
      [escapeLike(needle), capped],
    );
    return r.rows;
  });
}

interface TurnRow {
  id: string;
  conversation_id: string;
  user_id: string;
  model: string;
  started_at: string;
  total_ms: number;
  first_text_token_ms: number | null;
  num_anthropic_calls: number;
  num_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string | null;
  error: string | null;
  phases: unknown;
}

interface StuckConv {
  id: string;
  user_id: string;
  active_turn_started_at: string;
  age_seconds: number;
}

interface CaptureErr {
  id: string;
  started_at: string;
  doco_id: string;
  entity_type: string;
  http_method: string;
  status_code: number | null;
  total_ms: number;
  error: string | null;
}

interface OpenAiErr {
  id: string;
  occurred_at: string;
  model: string;
  input_count: number;
  request_ms: number | null;
  error: string | null;
}

interface MessageRowText {
  id: string;
  conversation_id: string;
  role: string;
  content: unknown;
  created_at: string;
}

export interface AgentDebugOptions {
  /** Cap on each top-level row list (turns, stuck, errors). */
  limit?: number;
  /** Tail this conversation's messages and analyze its replay window. */
  conversation?: string | null;
  /** How many of the conversation's most recent messages to return. */
  messages?: number;
  /** Find conversations whose messages contain this phrase. */
  search?: string | null;
}

export interface AgentDebugReport {
  generated_at: string;
  limit: number;
  recent_turns: TurnRow[];
  stuck_conversations: StuckConv[];
  stuck_conversation_messages: MessageRowText[];
  recent_capture_errors: CaptureErr[];
  recent_openai_errors: OpenAiErr[];
  conversation_messages: MessageRowText[];
  conversation_analysis: ReplayWindowAnalysis | null;
  search_results: ConversationSearchHit[];
}

/**
 * Gather the full incident report. Same row dumps the dashboard always had,
 * plus optional conversation tail + replay analysis and message-text search.
 * Callers gate access (superadmin) before invoking; this only reads.
 */
export async function gatherAgentDebug(opts: AgentDebugOptions = {}): Promise<AgentDebugReport> {
  const limit = Number.isFinite(opts.limit)
    ? Math.max(1, Math.min(100, Math.round(opts.limit as number)))
    : 20;
  const targetConv = opts.conversation?.trim() || null;
  const messageLimit = Number.isFinite(opts.messages)
    ? Math.max(1, Math.min(200, Math.round(opts.messages as number)))
    : 30;
  const searchText = opts.search?.trim() || null;

  const base = await withClient(async (c) => {
    const [turns, stuck, captures, openai, stuckMsgs] = await Promise.all([
      c.query<TurnRow>(
        `SELECT id, conversation_id, user_id, model,
                started_at::text AS started_at, total_ms,
                first_text_token_ms, num_anthropic_calls, num_tool_calls,
                input_tokens, output_tokens, stop_reason, error, phases
           FROM agent_turn_metrics
          ORDER BY started_at DESC
          LIMIT $1`,
        [limit],
      ),
      c.query<StuckConv>(
        `SELECT id, user_id,
                active_turn_started_at::text AS active_turn_started_at,
                EXTRACT(EPOCH FROM (now() - active_turn_started_at))::int AS age_seconds
           FROM chat_conversations
          WHERE active_turn_started_at IS NOT NULL
          ORDER BY active_turn_started_at ASC
          LIMIT $1`,
        [limit],
      ),
      c.query<CaptureErr>(
        `SELECT id, started_at::text AS started_at, doco_id, entity_type,
                http_method, status_code, total_ms, error
           FROM capture_timings
          WHERE status_code IS NULL OR status_code >= 400
          ORDER BY started_at DESC
          LIMIT $1`,
        [limit],
      ),
      c.query<OpenAiErr>(
        `SELECT id, occurred_at::text AS occurred_at, model, input_count,
                request_ms, error
           FROM openai_usage_log
          WHERE NOT ok
          ORDER BY occurred_at DESC
          LIMIT $1`,
        [limit],
      ),
      c.query<MessageRowText>(
        `SELECT m.id, m.conversation_id, m.role, m.content,
                m.created_at::text AS created_at
           FROM chat_messages m
          WHERE m.conversation_id IN (
                  SELECT id FROM chat_conversations
                   WHERE active_turn_started_at IS NOT NULL
                )
          ORDER BY m.created_at DESC
          LIMIT 24`,
      ),
    ]);
    let convMessages: MessageRowText[] = [];
    if (targetConv) {
      const r = await c.query<MessageRowText>(
        `SELECT id, conversation_id, role, content,
                created_at::text AS created_at
           FROM chat_messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [targetConv, messageLimit],
      );
      convMessages = r.rows.reverse();
    }
    return {
      recent_turns: turns.rows,
      stuck_conversations: stuck.rows,
      stuck_conversation_messages: stuckMsgs.rows,
      recent_capture_errors: captures.rows,
      recent_openai_errors: openai.rows,
      conversation_messages: convMessages,
    };
  });

  const search_results = searchText
    ? await searchConversationsByMessageText(searchText, limit)
    : [];

  const conversation_analysis = targetConv ? await analyzeConversation(targetConv) : null;

  return {
    generated_at: new Date().toISOString(),
    limit,
    ...base,
    conversation_analysis,
    search_results,
  };
}

// Load a conversation's FULL history (not the truncated tail) and resolve which
// of its attachments still have live bytes, then run the pure replay analysis.
async function analyzeConversation(conversationId: string): Promise<ReplayWindowAnalysis> {
  const rows = await loadMessages(conversationId);
  const refIds = new Set<string>();
  for (const row of rows) {
    for (const block of row.content) {
      if (isAttachmentRef(block)) refIds.add(block.attachment_id);
    }
  }
  const expired = await expiredAttachmentIds(refIds);
  return analyzeReplayWindow(rows, expired);
}

// Of the referenced attachment ids, which are NO LONGER retrievable — either
// purged by the 30-day retention sweep or otherwise absent. (A row whose
// expires_at has passed but hasn't been swept yet is still treated as expired,
// matching the live read path's `expires_at > now()` filter.)
async function expiredAttachmentIds(refIds: Set<string>): Promise<Set<string>> {
  if (refIds.size === 0) return new Set();
  const ids = [...refIds];
  return await withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM chat_attachments
        WHERE id = ANY($1) AND expires_at > now()`,
      [ids],
    );
    const live = new Set(r.rows.map((row) => row.id));
    return new Set(ids.filter((id) => !live.has(id)));
  });
}
