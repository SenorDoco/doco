// In-page assistant — server side.
//
// One rolling conversation per signed-in Principal. The sidebar reopens
// to the most recently touched thread; "New chat" archives the current
// row and starts fresh. Messages are persisted as Anthropic-shaped
// content blocks so a turn that included tool_use / tool_result blocks
// can be re-fed to the model verbatim on the next turn.
//
// The agent acts on behalf of the signed-in user: tool calls relay
// through the user's session cookie, so the agent's read + write
// surface is exactly the user's. There is no separate principal, no
// OAuth dance — "same level of access as the user" is realized
// literally by reusing the same credential.
//
// Two tools:
//   - doco_api({method, path, body}): fetch a Doco endpoint as the user
//   - navigate({url}): push a URL to the client (SPA navigation, no
//     full reload)
//
// The conversation system prompt is bootstrapped much like the agent-
// bootstrap endpoint feeds external agents — the canonical protocol
// prose + the Doco policies the user can read. Señor Doco follows the
// SAME protocol as any other agent (footer-lines verbatim after every
// write); the only thing he gets that external agents don't is an
// internal API route via the doco_api tool, so his fetches skip the
// HTTP round-trip.

import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  MessageStreamEvent,
  TextBlock,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import { listOrganizationsForUser, withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import {
  SENOR_DOCO_DEFAULT_MAX_TOKENS,
  getSenorDocoModel,
  missingSenorDocoAnthropicMessage,
  streamSenorDocoMessage,
} from "./assistant-runtime.server";
import { canAccessDoco } from "./doco-access.server";
import {
  DOCO_API_TOOL,
  type DocoApiToolResult,
  runDocoApiToolRequest,
} from "./doco-api-tool.server";
import { qualifiedDocoLabel } from "./doco-labels";
import { ensureEnvLoaded } from "./dotenv.server";
import { listAllDocos } from "./host.server";
import { internalFetch } from "./internal-fetch.server";
import { buildSenorDocoCorePrompt } from "./senor-doco-prompt.server";
import type { CurrentPrincipal } from "./session.server";
import { upsertAgentTurn } from "./telemetry.server";

ensureEnvLoaded();

const MAX_TURNS_PER_REPLY = 100;
// Per-Anthropic-call output cap. 2048 was the old Haiku-era setting
// and proved way too tight for Sonnet on multi-tool batches: a single
// "create 8 actions in parallel" reply truncates mid-tool-JSON
// (stop_reason = max_tokens) and silently drops the rest of the work
// because runAssistantTurn only loops on stop_reason === "tool_use".
// 8192 matches Sonnet 4.6's default budget and comfortably covers
// the largest parallel tool batches we issue in one round-trip.
const MAX_TOKENS = SENOR_DOCO_DEFAULT_MAX_TOKENS;
// Rate-limit retry budget for the Anthropic stream call. Single retry
// is enough to ride out a brief minute-bucket spike without bouncing
// to the user; cap the sleep at 30s so a long retry-after doesn't
// freeze the sidebar.
const ANTHROPIC_429_MAX_RETRY_SLEEP_MS = 30_000;

// Attachment policy — kept in one place so the UI notice, the system
// prompt, and the migration's INTERVAL stay in sync. If you change
// ATTACHMENT_RETENTION_DAYS, also update migration 004's INTERVAL.
export const ATTACHMENT_RETENTION_DAYS = 30;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  // XML-shaped formats (.bpmn, .xml). Browsers pick text/xml or
  // application/xml depending on the platform; some pick
  // application/octet-stream for less-known extensions like .bpmn —
  // see normalizeUploadMime below for that fallback.
  "text/xml",
  "application/xml",
]);

/**
 * Some browsers ship .bpmn / .xml uploads as `application/octet-stream`
 * because the extension isn't in their built-in MIME table. We trust
 * the extension for the small allowlist of XML-ish formats we know
 * are safe to read as text; everything else stays as the browser
 * reported it (so an actual binary upload keeps failing the gate).
 */
export function normalizeUploadMime(filename: string, reportedMime: string): string {
  if (reportedMime !== "application/octet-stream" && reportedMime !== "") return reportedMime;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".bpmn") || lower.endsWith(".xml")) return "application/xml";
  return reportedMime;
}
// Stable user-facing line. The sidebar shows this whenever a file is
// staged; the system prompt also instructs the model to repeat it when
// a message arrives with attachments.
export const ATTACHMENT_RETENTION_NOTICE = `Attachments are stored for ${ATTACHMENT_RETENTION_DAYS} days, then deleted.`;

// Anthropic's typed content blocks coming back from the API arrive as
// concrete shapes (no "param" suffix). When we feed them back as part
// of the next message they need to look like message-param blocks.
// In practice the JSON is identical for our two block types so we just
// stash the API shape and treat them as `ContentBlockParam`.
type StoredAssistantBlock = TextBlock | ToolUseBlock;

export interface ChatConversationRow {
  id: string;
  user_id: string;
  archived: boolean;
  title: string | null;
  attached_doco_ids: string[];
  /** Legacy handle storage retained only as a fallback for old rows. */
  attached_doco_handles: string[];
  attached_org_handles: string[];
  created_at: Date;
  updated_at: Date;
  active_turn_started_at: Date | null;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: PersistedContentBlock[];
  created_at: Date;
}

// Persisted blocks are Anthropic `ContentBlockParam`s PLUS one Doco-only
// shape: `attachment_ref`. The ref points at a row in `chat_attachments`;
// at send time it hydrates to an image/document block, and at expiry it
// hydrates to a short text placeholder. The shape is kept narrow so
// front-end code can pattern-match on `type === "attachment_ref"`.
export interface AttachmentRefBlock {
  type: "attachment_ref";
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}
export type PersistedContentBlock = ContentBlockParam | AttachmentRefBlock;

export interface ChatAttachmentMeta {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface ChatStreamContext {
  origin: string;
  cookieHeader: string;
  principal: CurrentPrincipal;
  currentPath: string | null;
  attachmentIds: string[];
  graphReferences: VisibleGraphReferenceGroup[];
  /**
   * Conversation id for the active turn. Lets `runTool` attribute
   * tool calls back to the thread — currently used to back-fill the
   * thread's attached Docos as the agent works (path-scoped
   * doco_api calls → `attachDocoToConversation`).
   */
  conversationId: string;
}

export interface VisibleGraphReference {
  number: number;
  id: string;
  entity_type: string;
  label: string;
  lifecycle: string | null;
  href: string | null;
}

export interface VisibleGraphReferenceGroup {
  source: string;
  references: VisibleGraphReference[];
}

export type ChatStreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; tool_use_id: string; name: string }
  | { kind: "tool_use_input"; tool_use_id: string; input: unknown }
  | { kind: "tool_use_result"; tool_use_id: string; ok: boolean; preview: string }
  | { kind: "navigate"; url: string }
  | { kind: "message_saved"; message_id: string; role: "user" | "assistant" }
  | {
      // Running token totals for THIS turn (not the session). The
      // sidebar shows these next to the in-flight bubble so the user
      // can see what their request is costing in real time.
      kind: "usage_update";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }
  | {
      // Server-side progress heartbeat. Streamed at milestones inside
      // a turn so the user sees activity even before the first text
      // delta arrives — without this, a slow Anthropic TTFT or a
      // long-running tool result looks like the agent froze.
      kind: "status";
      phase:
        | "loading_history"
        | "loading_bootstrap"
        | "calling_anthropic"
        | "anthropic_returned"
        | "rate_limited_retrying"
        | "running_tool"
        | "tool_returned"
        | "settling";
      detail?: string;
    }
  | { kind: "done" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * One conversation per principal, forever. Returns the principal's
 * row if it exists, otherwise mints one. There is no archive / new-
 * chat affordance — the thread is the user's single rolling memory.
 * The `archived` column on the table is legacy from an earlier
 * design; left in place because dropping it would require a migration
 * and the dead column is harmless.
 */
/**
 * Stale-turn cutoff. If `active_turn_started_at` is older than this,
 * the lambda almost certainly crashed before its `finally` cleared
 * the marker (Vercel function timeout, OOM, deploy window replacing
 * the function mid-stream). A real turn never legitimately takes
 * this long — Anthropic + tool round trips for one user message
 * complete in single-digit minutes worst case. Clear on read so the
 * in-flight bubble self-heals on the next snapshot load.
 */
const ACTIVE_TURN_STALE_MS = 5 * 60 * 1000;

const CONV_COLS =
  "id, user_id, archived, title, attached_doco_ids, attached_doco_handles, attached_org_handles, created_at, updated_at, active_turn_started_at";

/**
 * Sweep stale active-turn markers on a conversation row we just
 * loaded. Lambda crashes can leave the marker set; treat anything
 * older than ACTIVE_TURN_STALE_MS as stuck and clear it so the UI
 * doesn't show a forever-replying bubble.
 */
async function clearStaleTurnMarker(row: ChatConversationRow): Promise<void> {
  if (
    !row.active_turn_started_at ||
    Date.now() - row.active_turn_started_at.getTime() <= ACTIVE_TURN_STALE_MS
  ) {
    return;
  }
  await withClient(async (c) => {
    await c.query("UPDATE chat_conversations SET active_turn_started_at = NULL WHERE id = $1", [
      row.id,
    ]);
  });
  row.active_turn_started_at = null;
}

/**
 * Most-recently-touched non-archived conversation for the user, or
 * `null` when they've never chatted. Used as the default thread on
 * page load and as the auto-pick when `POST /messages.json` arrives
 * without an explicit conversation_id.
 */
export async function loadActiveConversation(
  principalId: string,
): Promise<ChatConversationRow | null> {
  return await withClient(async (c) => {
    const r = await c.query<ChatConversationRow>(
      `SELECT ${CONV_COLS}
         FROM chat_conversations
        WHERE user_id = $1 AND archived = false
        ORDER BY updated_at DESC
        LIMIT 1`,
      [principalId],
    );
    const row = r.rows[0];
    if (!row) return null;
    await clearStaleTurnMarker(row);
    return row;
  });
}

/**
 * Load a specific thread by id, scoped to the calling principal so
 * a user can't read someone else's threads by guessing ids.
 */
export async function loadConversationByIdForPrincipal(
  conversationId: string,
  principalId: string,
): Promise<ChatConversationRow | null> {
  return await withClient(async (c) => {
    const r = await c.query<ChatConversationRow>(
      `SELECT ${CONV_COLS}
         FROM chat_conversations
        WHERE id = $1 AND user_id = $2
        LIMIT 1`,
      [conversationId, principalId],
    );
    const row = r.rows[0];
    if (!row) return null;
    await clearStaleTurnMarker(row);
    return row;
  });
}

export async function createConversation(
  principalId: string,
  opts: {
    title?: string | null;
    attachedDocoIds?: string[];
    attachedOrgHandles?: string[];
  } = {},
): Promise<ChatConversationRow> {
  return await withClient(async (c) => {
    const id = `conv_${generateUlid()}`;
    const title = typeof opts.title === "string" && opts.title.trim() ? opts.title.trim() : null;
    const attachedDocoIds = uniqueNonEmptyStrings(opts.attachedDocoIds ?? []);
    const attachedOrgHandles = uniqueNonEmptyStrings(opts.attachedOrgHandles ?? []);
    const r = await c.query<ChatConversationRow>(
      `INSERT INTO chat_conversations
         (id, user_id, title, attached_doco_ids, attached_org_handles)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CONV_COLS}`,
      [id, principalId, title, attachedDocoIds, attachedOrgHandles],
    );
    const row = r.rows[0];
    if (!row) throw new Error("failed to create conversation row");
    return row;
  });
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export interface ConversationListItem {
  id: string;
  title: string | null;
  archived: boolean;
  message_count: number;
  updated_at: string;
  active_turn_started_at: string | null;
  /** Plain-text preview of the latest message; null when the thread is empty. */
  last_message_preview: string | null;
  /** Who sent the latest message — informs the WhatsApp-style "You:" prefix. */
  last_message_role: "user" | "assistant" | null;
  /**
   * Stable Doco ids so the client can decide what to do on row-click
   * without a second snapshot fetch:
   * exactly one attachment between docos + orgs → jump straight to
   * that page; otherwise just open the chat. Handles are included for
   * older clients only and are resolved from ids when possible.
   */
  attached_doco_ids: string[];
  attached_doco_handles: string[];
  attached_org_handles: string[];
}

/**
 * Plain-text preview of a persisted message's first text block. Used
 * for the thread-list row's "last activity" line — image-only or
 * attachment-only messages return null and the UI shows a fallback.
 */
function extractMessagePreview(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        const clean = text.replace(/\s+/g, " ").trim();
        return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
      }
    }
  }
  return null;
}

/**
 * List the user's conversations, newest first. The sidebar list +
 * the API thread-list endpoint both use this. Includes:
 *
 *   - `message_count` — total messages in the thread, so the UI
 *     doesn't need a per-row round-trip
 *   - `last_message_preview` + `last_message_role` — first text
 *     block of the most recent message, for the WhatsApp-style
 *     "title / preview / time" thread row
 *
 * Archived rows excluded by default.
 */
export async function listConversationsForPrincipal(
  principalId: string,
  opts: { includeArchived?: boolean; limit?: number } = {},
): Promise<ConversationListItem[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  return await withClient(async (c) => {
    const r = await c.query<{
      id: string;
      title: string | null;
      archived: boolean;
      updated_at: Date;
      active_turn_started_at: Date | null;
      message_count: string;
      last_message_content: unknown;
      last_message_role: "user" | "assistant" | null;
      attached_doco_ids: string[] | null;
      attached_doco_handles: string[] | null;
      attached_org_handles: string[] | null;
    }>(
      `SELECT c.id, c.title, c.archived, c.updated_at, c.active_turn_started_at,
              c.attached_doco_ids,
              CASE
                WHEN array_length(c.attached_doco_ids, 1) IS NOT NULL THEN
                  ARRAY(
                    SELECT d.handle
                      FROM unnest(c.attached_doco_ids) WITH ORDINALITY AS x(id, ord)
                      JOIN docos d ON d.id = x.id
                     ORDER BY x.ord
                  )
                ELSE c.attached_doco_handles
              END AS attached_doco_handles,
              c.attached_org_handles,
              COALESCE((SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id), 0)::text AS message_count,
              (SELECT m.content
                 FROM chat_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC
                LIMIT 1) AS last_message_content,
              (SELECT m.role
                 FROM chat_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC
                LIMIT 1) AS last_message_role
         FROM chat_conversations c
        WHERE c.user_id = $1
          ${opts.includeArchived ? "" : "AND c.archived = false"}
        ORDER BY c.updated_at DESC
        LIMIT $2`,
      [principalId, limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      archived: row.archived,
      message_count: Number(row.message_count),
      updated_at: row.updated_at.toISOString(),
      active_turn_started_at: row.active_turn_started_at?.toISOString() ?? null,
      last_message_preview: extractMessagePreview(row.last_message_content),
      last_message_role: row.last_message_role,
      attached_doco_ids: row.attached_doco_ids ?? [],
      attached_doco_handles: row.attached_doco_handles ?? [],
      attached_org_handles: row.attached_org_handles ?? [],
    }));
  });
}

export async function patchConversation(
  conversationId: string,
  principalId: string,
  patch: { title?: string | null; archived?: boolean },
): Promise<ChatConversationRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [conversationId, principalId];
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    values.push(patch.title === null ? null : (patch.title ?? "").toString().trim() || null);
    sets.push(`title = $${values.length}`);
  }
  if (typeof patch.archived === "boolean") {
    values.push(patch.archived);
    sets.push(`archived = $${values.length}`);
  }
  if (sets.length === 0) {
    return await loadConversationByIdForPrincipal(conversationId, principalId);
  }
  return await withClient(async (c) => {
    const r = await c.query<ChatConversationRow>(
      `UPDATE chat_conversations
          SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING ${CONV_COLS}`,
      values,
    );
    return r.rows[0] ?? null;
  });
}

function appendUniqueSql(column: string, paramIndex: number): string {
  return `${column} = CASE WHEN $${paramIndex} = ANY(${column}) THEN ${column} ELSE ${column} || ARRAY[$${paramIndex}::text] END`;
}

/**
 * Append a stable Doco id to the thread's `attached_doco_ids` unless
 * it's already there. Idempotent on repeat calls — the conversation
 * accumulates every Doco it has touched. Caller is the doco_api tool
 * dispatcher; this lets the chat sidebar render clickable chips for
 * everywhere the agent has been so the user can jump back to that
 * Doco's perspective view even after a handle rename.
 *
 * Fails silently — attachment is a nice-to-have on top of the tool
 * call; we don't want a transient DB error to break the assistant
 * turn. Most failures are spurious (deadlocks under load) and the
 * next tool call to the same Doco will retry.
 */
export async function attachDocoIdToConversation(
  conversationId: string,
  docoId: string,
): Promise<void> {
  if (!conversationId || !docoId) return;
  try {
    await withClient(async (c) => {
      await c.query(
        `UPDATE chat_conversations
            SET ${appendUniqueSql("attached_doco_ids", 2)}
          WHERE id = $1`,
        [conversationId, docoId],
      );
    });
  } catch {
    // Best-effort — see docblock.
  }
}

/**
 * Resolve a mutable handle at the edge, then store the immutable Doco
 * id. Kept for `doco_api` paths, which still arrive as /<handle>/api.
 */
export async function attachDocoToConversation(
  conversationId: string,
  handle: string,
): Promise<void> {
  if (!conversationId || !handle) return;
  try {
    await withClient(async (c) => {
      const doco = await c.query<{ id: string }>("SELECT id FROM docos WHERE handle = $1", [
        handle,
      ]);
      const docoId = doco.rows[0]?.id;
      if (!docoId) return;
      await c.query(
        `UPDATE chat_conversations
            SET ${appendUniqueSql("attached_doco_ids", 2)}
          WHERE id = $1`,
        [conversationId, docoId],
      );
    });
  } catch {
    // Best-effort — see docblock.
  }
}

/** Same shape as attachDocoToConversation but targets `attached_org_handles`. */
export async function attachOrgToConversation(
  conversationId: string,
  handle: string,
): Promise<void> {
  if (!conversationId || !handle) return;
  try {
    await withClient(async (c) => {
      await c.query(
        `UPDATE chat_conversations
            SET attached_org_handles = attached_org_handles || ARRAY[$2::text]
          WHERE id = $1
            AND NOT ($2 = ANY(attached_org_handles))`,
        [conversationId, handle],
      );
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Owner-scoped mutate for the manual override flow. Accepts arbitrary
 * attach/detach operations against a thread the caller owns. Returns
 * the updated row or null when the conversation doesn't exist for
 * this principal. Each handle is checked against `array_remove` /
 * `array_append (unique)` so repeated requests stay idempotent.
 */
export async function mutateConversationAttachments(
  conversationId: string,
  principalId: string,
  ops: {
    attachDocoId?: string;
    detachDocoId?: string;
    attachDocoHandle?: string;
    detachDocoHandle?: string;
    attachOrg?: string;
    detachOrg?: string;
  },
): Promise<ChatConversationRow | null> {
  return await withClient(async (c) => {
    let attachDocoId = ops.attachDocoId;
    if (!attachDocoId && ops.attachDocoHandle) {
      const r = await c.query<{ id: string }>("SELECT id FROM docos WHERE handle = $1", [
        ops.attachDocoHandle,
      ]);
      attachDocoId = r.rows[0]?.id;
    }
    let detachDocoId = ops.detachDocoId;
    if (!detachDocoId && ops.detachDocoHandle) {
      const r = await c.query<{ id: string }>("SELECT id FROM docos WHERE handle = $1", [
        ops.detachDocoHandle,
      ]);
      detachDocoId = r.rows[0]?.id;
    }

    const updates: string[] = [];
    const values: unknown[] = [conversationId, principalId];
    if (attachDocoId) {
      values.push(attachDocoId);
      updates.push(appendUniqueSql("attached_doco_ids", values.length));
    }
    if (detachDocoId) {
      values.push(detachDocoId);
      updates.push(`attached_doco_ids = array_remove(attached_doco_ids, $${values.length})`);
    }
    if (ops.attachOrg) {
      values.push(ops.attachOrg);
      updates.push(appendUniqueSql("attached_org_handles", values.length));
    }
    if (ops.detachOrg) {
      values.push(ops.detachOrg);
      updates.push(`attached_org_handles = array_remove(attached_org_handles, $${values.length})`);
    }
    if (updates.length === 0) {
      return await loadConversationByIdForPrincipal(conversationId, principalId);
    }
    const r = await c.query<ChatConversationRow>(
      `UPDATE chat_conversations
          SET ${updates.join(", ")}
        WHERE id = $1 AND user_id = $2
        RETURNING ${CONV_COLS}`,
      values,
    );
    return r.rows[0] ?? null;
  });
}

/**
 * Legacy entry point — kept for back-compat with callers that still
 * pass just a principal id. Returns the most-recent thread or mints
 * a fresh one.
 */
export async function loadOrCreateConversation(principalId: string): Promise<ChatConversationRow> {
  const active = await loadActiveConversation(principalId);
  if (active) return active;
  return await createConversation(principalId);
}

/**
 * Mark the conversation as actively composing a reply. Called at the
 * top of runAssistantTurn; the timestamp gives the client a "is this
 * stale?" signal so a crashed/zombied turn doesn't display forever.
 */
async function markActiveTurnStarted(conversationId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE chat_conversations
          SET active_turn_started_at = now(),
              active_turn_events = '[]'::jsonb
        WHERE id = $1`,
      [conversationId],
    );
  });
}

/**
 * Clear the active-turn marker. Called in runAssistantTurn's finally
 * so a normal completion, an error, or even a thrown abort all reset
 * the flag. Keep `active_turn_events` as the most recent turn's
 * replay buffer so a page refresh after completion can still show the
 * Thinking timeline; markActiveTurnStarted resets it for the next turn.
 */
async function markActiveTurnEnded(conversationId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE chat_conversations
          SET active_turn_started_at = NULL
        WHERE id = $1`,
      [conversationId],
    );
  });
}

/**
 * Append events to the active-turn event log. Batched per call so a
 * single turn's worth of SSE deltas doesn't translate to 50 DB
 * writes — runAssistantTurn buffers events locally and calls this on
 * meaningful milestones (status changes, tool boundaries) at most
 * every few hundred ms.
 *
 * The events column is JSONB; we append via `||` which is O(len)
 * but with N < 100 typical events the cost is negligible. If size
 * ever becomes a concern, switch to a side-table.
 */
async function appendActiveTurnEvents(
  conversationId: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    await withClient(async (c) => {
      await c.query(
        `UPDATE chat_conversations
            SET active_turn_events = active_turn_events || $2::jsonb
          WHERE id = $1`,
        [conversationId, JSON.stringify(events)],
      );
    });
  } catch (err) {
    // Best-effort — losing thinking events shouldn't fail the turn.
    console.warn(
      "[agent-chat] appendActiveTurnEvents failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function loadMessages(conversationId: string): Promise<ChatMessageRow[]> {
  return await withClient(async (c) => {
    const r = await c.query<ChatMessageRow>(
      `SELECT id, conversation_id, role, content, created_at
         FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversationId],
    );
    return r.rows;
  });
}

/**
 * Cap conversation history fed to the model. Sidebar threads grow
 * unbounded, so without a cap every turn pays linearly more in input
 * tokens (and TTFT). Strategy:
 *
 *   1. Walk backwards from the latest message, including messages
 *      until we hit MAX_REPLAY_MESSAGES.
 *   2. From that anchor, walk FORWARD to find a clean boundary — the
 *      first user message that isn't a tool_result reply. Anthropic
 *      requires tool_result blocks to follow the assistant message
 *      that produced the matching tool_use; cutting mid-pair would
 *      400 the request.
 *
 * The result is a contiguous slice ending at the latest message,
 * starting at a user-role text message.
 */
export const MAX_REPLAY_MESSAGES = 40;

function isToolResultUserMessage(row: ChatMessageRow): boolean {
  if (row.role !== "user") return false;
  for (const block of row.content) {
    const t = (block as { type?: string }).type;
    if (t !== "tool_result") return false;
  }
  return row.content.length > 0;
}

export function trimHistoryToWindow(
  rows: ChatMessageRow[],
  maxMessages: number = MAX_REPLAY_MESSAGES,
): ChatMessageRow[] {
  if (rows.length <= maxMessages) return rows;
  let start = rows.length - maxMessages;
  // Anthropic requires messages[0] to be role="user" AND not a tool_result-
  // only message (those need a preceding assistant tool_use). Walk forward
  // until we land on a clean conversational user turn.
  while (start < rows.length) {
    const row = rows[start];
    if (row.role === "user" && !isToolResultUserMessage(row)) break;
    start++;
  }
  return rows.slice(start);
}

// Page size for the sidebar's infinite-scroll hydration. Tuned to fill
// the rail without dragging the whole history into the client; older
// pages are fetched on scroll-up.
export const CHAT_MESSAGES_PAGE_SIZE = 30;

/**
 * Cursor-paginated history fetch for the sidebar. Returns the newest
 * `limit` messages whose `created_at` is strictly before the cursor
 * (or the latest `limit` overall when no cursor is given). Result is
 * returned in ASC order so it can be concatenated directly into the
 * displayed message list. `hasMore` indicates whether further older
 * pages exist.
 */
export async function loadMessagesPage(
  conversationId: string,
  opts: { before?: Date | null; limit: number },
): Promise<{ messages: ChatMessageRow[]; hasMore: boolean }> {
  const before = opts.before ?? null;
  return await withClient(async (c) => {
    const r = await c.query<ChatMessageRow>(
      `SELECT id, conversation_id, role, content, created_at
         FROM chat_messages
        WHERE conversation_id = $1
          AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [conversationId, before, opts.limit + 1],
    );
    const hasMore = r.rows.length > opts.limit;
    const slice = hasMore ? r.rows.slice(0, opts.limit) : r.rows;
    return { messages: slice.reverse(), hasMore };
  });
}

/**
 * First-user-message → thread title. Trim the text, collapse
 * whitespace, take the first 6 words capped at 60 chars. Returns
 * `null` when the message has no usable text (e.g. attachment-only),
 * which leaves the column null so the client falls back to "New chat".
 */
function deriveTitleFromUserContent(content: PersistedContentBlock[]): string | null {
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      const clean = text.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      const words = clean.split(" ").slice(0, 6).join(" ");
      return words.length > 60 ? `${words.slice(0, 57)}…` : words;
    }
  }
  return null;
}

async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: PersistedContentBlock[],
): Promise<ChatMessageRow> {
  return await withClient(async (c) => {
    const id = `msg_${generateUlid()}`;
    const r = await c.query<ChatMessageRow>(
      `INSERT INTO chat_messages (id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, conversation_id, role, content, created_at`,
      [id, conversationId, role, JSON.stringify(content)],
    );
    // Bump updated_at on every append. For user messages, also fill
    // in the auto-derived title when the row still has none — that's
    // how "New chat" placeholders turn into something readable in the
    // sidebar. COALESCE keeps any user-set title from being overwritten.
    const derivedTitle = role === "user" ? deriveTitleFromUserContent(content) : null;
    await c.query(
      `UPDATE chat_conversations
          SET updated_at = now(),
              title = COALESCE(title, $2)
        WHERE id = $1`,
      [conversationId, derivedTitle],
    );
    const row = r.rows[0];
    if (!row) throw new Error("failed to append chat message");
    return row;
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Delete rows past their `expires_at`. Called opportunistically at the
 * top of every upload + every message turn — there's no separate cron
 * job. 30-day retention is enforced by the DEFAULT on the column; this
 * is the sweeper that makes it actually happen.
 */
export async function purgeExpiredAttachments(): Promise<number> {
  return await withClient(async (c) => {
    const r = await c.query("DELETE FROM chat_attachments WHERE expires_at < now()");
    return r.rowCount ?? 0;
  });
}

interface ChatAttachmentRow {
  id: string;
  conversation_id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content: Buffer;
  created_at: Date;
  expires_at: Date;
}

export async function saveAttachment(args: {
  conversationId: string;
  principalId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<ChatAttachmentMeta> {
  const mimeType = normalizeUploadMime(args.filename, args.mimeType);
  if (!ATTACHMENT_ALLOWED_MIME.has(mimeType)) {
    throw new Error(`unsupported mime type: ${args.mimeType}`);
  }
  if (args.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `attachment too large (${args.bytes.byteLength} bytes; max ${ATTACHMENT_MAX_BYTES})`,
    );
  }
  await purgeExpiredAttachments();
  return await withClient(async (c) => {
    const id = `att_${generateUlid()}`;
    const r = await c.query<{ created_at: Date; expires_at: Date }>(
      `INSERT INTO chat_attachments
         (id, conversation_id, user_id, filename, mime_type, size_bytes, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING created_at, expires_at`,
      [
        id,
        args.conversationId,
        args.principalId,
        args.filename,
        mimeType,
        args.bytes.byteLength,
        args.bytes,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error("failed to save attachment");
    return {
      id,
      filename: args.filename,
      mime_type: mimeType,
      size_bytes: args.bytes.byteLength,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
    };
  });
}

/**
 * Fetch an attachment row that the caller is authorized to read. Returns
 * null if the row doesn't exist, has expired (the purge will sweep it),
 * or belongs to a different principal — all three collapse to "not
 * found" from the caller's perspective.
 */
export async function loadAttachmentForPrincipal(
  attachmentId: string,
  principalId: string,
): Promise<ChatAttachmentRow | null> {
  return await withClient(async (c) => {
    const r = await c.query<ChatAttachmentRow>(
      `SELECT id, conversation_id, user_id, filename, mime_type, size_bytes,
              content, created_at, expires_at
         FROM chat_attachments
        WHERE id = $1
          AND user_id = $2
          AND expires_at > now()`,
      [attachmentId, principalId],
    );
    return r.rows[0] ?? null;
  });
}

async function loadAttachmentsByIds(
  ids: string[],
  conversationId: string,
): Promise<Map<string, ChatAttachmentRow>> {
  if (ids.length === 0) return new Map();
  return await withClient(async (c) => {
    const r = await c.query<ChatAttachmentRow>(
      `SELECT id, conversation_id, user_id, filename, mime_type, size_bytes,
              content, created_at, expires_at
         FROM chat_attachments
        WHERE id = ANY($1::text[])
          AND conversation_id = $2
          AND expires_at > now()`,
      [ids, conversationId],
    );
    const out = new Map<string, ChatAttachmentRow>();
    for (const row of r.rows) out.set(row.id, row);
    return out;
  });
}

function refToAnthropicBlock(
  ref: AttachmentRefBlock,
  row: ChatAttachmentRow | undefined,
): ContentBlockParam {
  if (!row) {
    return {
      type: "text",
      text: `[attachment "${ref.filename}" was deleted after ${ATTACHMENT_RETENTION_DAYS}-day retention]`,
    };
  }
  const base64 = row.content.toString("base64");
  if (
    row.mime_type === "image/jpeg" ||
    row.mime_type === "image/png" ||
    row.mime_type === "image/gif" ||
    row.mime_type === "image/webp"
  ) {
    const block: ImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: row.mime_type, data: base64 },
    };
    return block;
  }
  if (row.mime_type === "application/pdf") {
    const block: DocumentBlockParam = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title: row.filename,
    };
    return block;
  }
  // text/plain, text/markdown — inline as a plain-text document so the
  // model can quote/read it. Skip base64; PlainTextSource carries the
  // raw string.
  const block: DocumentBlockParam = {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: row.content.toString("utf8") },
    title: row.filename,
  };
  return block;
}

/**
 * Replace every `attachment_ref` block in a persisted message with the
 * concrete Anthropic block the API expects. Unhydratable refs (row
 * expired or missing) become a short text placeholder.
 */
async function hydrateMessageContent(
  content: PersistedContentBlock[],
  conversationId: string,
): Promise<ContentBlockParam[]> {
  const refIds: string[] = [];
  for (const b of content) {
    if ((b as AttachmentRefBlock).type === "attachment_ref") {
      refIds.push((b as AttachmentRefBlock).attachment_id);
    }
  }
  const rows = await loadAttachmentsByIds(refIds, conversationId);
  return content.map((b): ContentBlockParam => {
    if ((b as AttachmentRefBlock).type === "attachment_ref") {
      const ref = b as AttachmentRefBlock;
      return refToAnthropicBlock(ref, rows.get(ref.attachment_id));
    }
    return b as ContentBlockParam;
  });
}

// ---------------------------------------------------------------------------
// System-prompt bootstrap
// ---------------------------------------------------------------------------

interface BootstrapContext {
  docoLines: string[];
  orgLines: string[];
  policySnippets: string[];
}

// Per-principal bootstrap memo. The original implementation paid an
// N+1 cost on every turn: list all host docos → per-doco access check →
// two sequential policies queries per accessible doco. Even ignoring
// any code change, repeated turns from the same user benefit from a
// short-TTL cache. The TTL is intentionally short so a fresh capture
// or new-doco click feels live; longer windows would let the bootstrap
// list lag behind the UI.
interface BootstrapMemoEntry {
  builtAt: number;
  value: BootstrapContext;
}
const BOOTSTRAP_TTL_MS = 10_000;
const bootstrapMemo = new Map<string, BootstrapMemoEntry>();

async function buildBootstrapContext(principalId: string): Promise<BootstrapContext> {
  const cached = bootstrapMemo.get(principalId);
  if (cached && Date.now() - cached.builtAt < BOOTSTRAP_TTL_MS) {
    return cached.value;
  }

  const [allDocos, orgs] = await Promise.all([
    listAllDocos(),
    listOrganizationsForUser(principalId),
  ]);

  // Access checks in parallel: the original code awaited them in a
  // for-loop, serializing N round trips to the DB.
  const accessChecks = await Promise.all(
    allDocos.map(async (d) => {
      const meta = { ownerId: d.ownerId, visibility: d.visibility, docoId: d.docoId };
      const ok = await canAccessDoco(meta, principalId);
      return ok ? d : null;
    }),
  );
  const accessibleDocos = accessChecks.filter((d): d is (typeof allDocos)[number] => d !== null);

  // Listing `id=<doco_id>` next to the handle gives the agent a
  // stable anchor — handles can be renamed at /settings, but the
  // ULID-based id doesn't move. If a fetch under a guessed handle
  // returns 404, the agent now has the canonical list to fall back
  // on instead of hallucinating handles.
  const docoLines: string[] = accessibleDocos.map((d) => {
    const label = qualifiedDocoLabel({ ownerSlug: d.ownerUsername, handle: d.handle });
    return `- ${label} (path=/${d.handle}, id=${d.docoId}, visibility ${d.visibility})`;
  });
  const orgLines: string[] = orgs.map((o) => `- /orgs/${o.handle} (id=${o.id}, ${o.name})`);

  // ONE batched query for every active policy across every accessible
  // Doco, replacing the prior 2*N per-doco queries. Group in-memory.
  const accessibleIds = accessibleDocos.map((d) => d.docoId);
  const policiesByDoco = new Map<string, { guidance: string[]; authoring: string[] }>();
  if (accessibleIds.length > 0) {
    const rows = await withClient(async (c) =>
      c.query<{ doco_id: string; policy: string; kind: "guidance" | "authoring" }>(
        `SELECT doco_id, policy, 'guidance'::text AS kind FROM guidance_policies
          WHERE doco_id = ANY($1::text[]) AND COALESCE(lifecycle,'asserted') = 'asserted'
         UNION ALL
         SELECT doco_id, policy, 'authoring'::text AS kind FROM node_authoring_policies
          WHERE doco_id = ANY($1::text[]) AND COALESCE(lifecycle,'asserted') = 'asserted'
         ORDER BY doco_id, kind, policy`,
        [accessibleIds],
      ),
    );
    for (const r of rows.rows) {
      const bucket = policiesByDoco.get(r.doco_id) ?? { guidance: [], authoring: [] };
      if (r.kind === "guidance") bucket.guidance.push(r.policy);
      else bucket.authoring.push(r.policy);
      policiesByDoco.set(r.doco_id, bucket);
    }
  }

  const policySnippets: string[] = [];
  for (const d of accessibleDocos) {
    const ps = policiesByDoco.get(d.docoId);
    if (!ps || (ps.guidance.length === 0 && ps.authoring.length === 0)) continue;
    const label = qualifiedDocoLabel({ ownerSlug: d.ownerUsername, handle: d.handle });
    const lines = [`Policies for ${label} (path=/${d.handle}):`];
    for (const s of ps.guidance) lines.push(`  - guidance: ${s}`);
    for (const s of ps.authoring) lines.push(`  - rule: ${s}`);
    policySnippets.push(lines.join("\n"));
  }

  const value: BootstrapContext = { docoLines, orgLines, policySnippets };
  bootstrapMemo.set(principalId, { builtAt: Date.now(), value });
  // Opportunistic cleanup: drop expired entries so the Map doesn't grow
  // forever in long-lived processes. Cheap because the Map is small —
  // one entry per active principal.
  if (bootstrapMemo.size > 200) {
    const cutoff = Date.now() - BOOTSTRAP_TTL_MS;
    for (const [k, v] of bootstrapMemo) {
      if (v.builtAt < cutoff) bootstrapMemo.delete(k);
    }
  }
  return value;
}

/**
 * Manual invalidator for callers that mutate the bootstrap inputs
 * (new doco, policies flipped). Optional; without it the TTL still
 * expires within seconds.
 */
export function invalidateBootstrapMemo(principalId?: string): void {
  if (principalId) bootstrapMemo.delete(principalId);
  else bootstrapMemo.clear();
}

/**
 * Build the system prompt as a two-block array so Anthropic can cache
 * the large, stable prefix (identity + endpoint surface + policies)
 * across turns. The dynamic tail (today + current page) goes in the
 * user message instead — that keeps every cache key identical.
 */
function buildSystemBlocks(
  principal: CurrentPrincipal,
  bootstrap: BootstrapContext,
): TextBlockParam[] {
  const docoList = bootstrap.docoLines.length
    ? bootstrap.docoLines.join("\n")
    : "(none yet — the user can create one at /new-doco)";
  const orgList = bootstrap.orgLines.length
    ? bootstrap.orgLines.join("\n")
    : "(no orgs — the user can create one at /new-org)";
  const policySections = bootstrap.policySnippets.length
    ? bootstrap.policySnippets.join("\n\n")
    : "(no policies authored in the visible docos)";

  const text = `${buildSenorDocoCorePrompt({
    surfaceDescription:
      "the in-page assistant embedded as a 320-px left-rail sidebar on every page",
    accessDescription: `You act AS ${principal.username} — the signed-in human reading the page. Every doco_api call is authenticated as them; there is no separate agent identity.`,
    capabilityDescription:
      "read, write, navigate inside Doco — docos, orgs, nodes (Decisions / Intents / Rules / Actions / Logs / Evals / References / States / Ideas / Principals), policies (Guidance + Node-authoring), edges, users, audit history.",
    inScopePrefix: `${principal.username}'s`,
  })}

## Tools

- doco_api({method, path, body?}): HTTP request to the Doco host with the user's session. Path starts with /. Returns {status, ok, body}.
- navigate({url}): SPA-navigate the user's browser. No full reload. Use after captures, when the user asks to be taken somewhere, or when a dedicated page would answer their question better than prose.

## Visible graph references

When the per-turn user header includes "Visible graph node references", the purple numbered circles currently attached to graph nodes map to those listed ids. Treat shorthand commands like "assert 5", "activate 5", "deprecate 20", "deprecated 20", "retire 20", or "open 3" as referring to that numbered node. "assert" and "activate" mean PATCH lifecycle to "asserted"; "deprecate", "deprecated", "archive", and "retire" mean PATCH lifecycle to "retired"; "draft" means "drafting". If the requested number is absent from the visible reference list, ask one brief clarification question instead of guessing.

## Attachments

The composer accepts image (jpeg, png, gif, webp), PDF, and short text/markdown files (up to 10 MB each). The user may attach files to a turn; you'll see them inline in the message as image / document blocks. Use them as evidence when capturing nodes (drop quotes / screenshots into the body) or to answer questions about the content.

Retention: every uploaded file is kept for ${ATTACHMENT_RETENTION_DAYS} days, then deleted. When the current turn arrives with one or more attachments, START your reply with exactly one short reminder line: "${ATTACHMENT_RETENTION_NOTICE}" — then continue normally. Do NOT repeat this on follow-up turns that don't include new attachments.

## Endpoint surface

  GET   /<handle>/status.json                    — freshness + per-type counts
  GET   /<handle>/api/<type>.json                — list every node of the named type in this doco. Response: { ok, type, doco_id, count, items: [{ id, <type>, lifecycle, created_at, updated_at, data }] } — the prose lives in the type-named field (\`decision\` for decisions, \`intent\` for intents, etc.); the first line is the row label. Valid <type>: decisions, intents, actions, rules, logs, evals, references, ideas, states. Use this BEFORE guessing — when the user mentions a count or wants to "remove all X" / "list all X" / "find an X", list first.
  POST  /<handle>/api/<type>.json                — capture; returns { id, footer_lines, duration_ms }
  GET   /<handle>/api/<type>/<id>.json           — single node detail
  PATCH /<handle>/api/<type>/<id>.json           — partial update; PATCH lifecycle = "retired" is the "delete" equivalent
  GET   /<handle>/api/<type>.txt                 — long-form POST/PATCH body spec (only fetch if the inline cheatsheet below isn't enough)
  GET   /<handle>/api/principals.json            — DUAL-purpose endpoint. Response: { ok, principals: [...legacy user alias...], users: [{ id, username, role, type, github_login, email }], principal_nodes: [{ id, name, body_md, lifecycle, data, ... }], user_count, principal_node_count }. Read \`users\` for the doco's OAuth members; read \`principal_nodes\` for the Principal NODES visible as BPMN swim lanes / referenced by Action.actor_id.
  PATCH /<handle>/api/principals/<id>.json       — update a Principal NODE (body_md, reports_to, lifecycle). Same retire-on-lifecycle convention. \`name\` is immutable — to rename, create a new Principal and retire the old one.
  GET   /<handle>/api/policies.json            — list policies (guidance + node-authoring) for this doco
  POST  /<handle>/api/policies.json            — capture a policy; owner role required; body needs "policy_kind": "guidance" | "node_authoring"
  GET   /<handle>/api/invites.json               — pending user invites
  GET   /<handle>/api/audit.json                 — audit log entries
  GET   /<handle>/api/perspectives.json          — saved BPMN perspectives
  GET   /<handle>/api/authoring-contract.json    — agent contract: valid entity types, relation kinds, perspective constraints, and changeset examples
  POST  /<handle>/api/changesets.json            — generic graph-authoring batch: create nodes and add relations in one request; prefer this for BPMN/process/org-tree style structures
  GET   /<handle>/api/settings.json              — doco settings (handle, visibility, goal)
  GET   /<handle>/search.json?q=<query>          — full-text search across this doco's nodes + policies
  GET   /api/v1/docos.json                       — list accessible docos with qualified_handle values like org/doco
  POST  /api/v1/docos.json                       — create a doco; owner role on the target org required
  POST  /api/v1/orgs.json                        — create an org (NO GET — to list the user's orgs, see the "Your orgs" section below)
  GET   /api/v1/agent-bootstrap.json             — re-read policies

### Discovery — "what's in this doco?"

When the user asks about contents of a doco without giving you specific
ids (e.g. "what decisions are here?", "remove all principles", "show me
the active intents", "how many actions does this have?"), DON'T guess
from the page URL — actually GET the list endpoint and answer from the
real data. Examples:

- "remove all principles/principals" → \`GET /<handle>/api/principals.json\`, read \`principal_nodes\`, then PATCH each one's lifecycle to "retired".
- "list intents" / "what intents do I have?" → \`GET /<handle>/api/intents.json\`, read \`items\`.
- "find the X about Y" → \`GET /<handle>/search.json?q=Y\`, scan results.
- "how many decisions?" → \`GET /<handle>/status.json\` (counts only; cheaper than listing).

## Capture body structure

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, policies, and settings. Principals,
invites, and audit have dedicated route behavior; do not infer write
bodies for them from the generic capture pattern.

Principal references in request bodies use principal ids only:
*_principal_id for one principal and *_principal_ids for arrays. Do
not send principal names, *_name fields, or comma-separated strings;
there are no aliases.

Common API-facing fields:
- wanted_by_principal_id: Intent owner; auth fills this from the signed-in principal when omitted.
- actors_principal_ids: Intent actors, always an array like ["principal_01..."].
- stakeholders_principal_ids: Intent stakeholders, always an array.
- actor_principal_id: Action/Log actor; auth fills this when omitted.
- decided_by_principal_id: Decision maker; auth fills this when omitted.
- authored_by_principal_id: Rule/Eval/Policy author; auth fills this when omitted.

Read responses may expose stored graph fields such as wanted_by,
actors, stakeholders, actor_id, and decided_by. created_by is
user/API-key provenance derived from the authenticated session
or token. Never send created_by; when writing via doco_api, use the
API-facing principal-id fields above only for domain actors.

### Inline body cheatsheet (post directly — no spec round trip needed)

Required fields marked *; everything else is optional. lifecycle
defaults to "asserted" except where noted. Auth fills the principal-id
fields when you omit them.

**Migration 022/023 prose-field rename.** Every node type now
stores its full markdown body in a single TYPE-NAMED field — there
is no separate \`summary\` / \`body_md\` / \`title\` / \`name\` /
\`description\` field anymore. The first line of the prose IS the
label shown in lists; the rest is the body. POSTs that send the old
\`summary\` field will fail with \`<type> is required.\` because the
required prose key is now \`intent\` / \`decision\` / \`action\` /
etc., not \`summary\`.

- Decision:  { decision*, question*, chosen*, alternatives?[{name, rejected_because}], intent_ids?[], sequence_to?[], born_from?, decided_by_principal_id?, lifecycle?, deprecated?, outcome?("succeeded"|"failed"), superseded_by? }
- Intent:    { intent*, wanted_by_principal_id?, actors_principal_ids?[], stakeholders_principal_ids?[], lifecycle?, deprecated?, outcome? }
- Action:    { action*, verb*, intent_ids?[], decision_ids?[], preceded_by?[], sequence_to?[], gated_by?[], inputs?, outputs?, actor_principal_id?, lifecycle?(default "retired"), outcome?(default "succeeded") }
- Log:       { log*, verb*, happened_at*(ISO8601), outputs*(non-empty obj), template_id?, intent_ids?[], decision_ids?[], preceded_by?[], inputs?, actor_principal_id?, lifecycle?(default "retired"), outcome?(default "succeeded") }
- Rule:      { rule*, predicate*, intent_ids?[], enforced_by?("runtime"|"review"|"manual"), severity?("hard"|"soft"), born_from?, authored_by_principal_id? }
- Eval:      { eval*, criterion*({kind:"exact"|"shape"|"llm-judge", spec}), kind?("unit"|"integration"|"eval"|"process"|"doc-consistency"), expected_status?("pass"|"fail"), target_ref?, intent_ids?[], authored_by_principal_id? }
- Reference: { reference*, ref_type*("file"|"url"|"ticket"|"commit"|"document"|"other"), locator*, content_hash?, intent_ids?[] }
- State:     { state*, kind*("initial"|"intermediate"|"terminal"), invariants?[], preceded_by?[], sequence_to?[] }
- Idea:      { idea*, promoted_to?, rejection_reason?, lifecycle?(default "drafting") }
- Policy (Guidance, owner-only): POST /<handle>/api/policies.json with policy_kind*("guidance"), policy*(one-line rule), body_md?, authored_by_principal_id?. (\`policy\` was renamed from \`summary\` by migration 038; old clients sending \`summary\` will fail.)
- Policy (Node-authoring, owner-only): same endpoint with policy_kind*("node_authoring"), policy*(one-line rule), evaluation_kind*("deterministic"|"probabilistic"), then either predicate*(deterministic AuthoringPredicate object) or spec*(probabilistic prose), and optional fires_when_node_lifecycle?[], on_violation?("block"|"warn"|"log", default "block").

The TYPE-NAMED field carries multi-line markdown; the first line is
the row label that shows up in lists and BPMN swim lanes. Example:

  POST /<handle>/api/intents.json
  { "intent": "Talent seeker pays to activate Torre Reach\\n\\nThe buyer can complete the purchase without support intervention…",
    "wanted_by_principal_id": "principal_01..." }

More examples (minimal — first line of the type-named field is the label):
{ "intent": "Checkout can be completed without support.\\n\\nBackground: support tickets averaged 3/week before this work.", "wanted_by_principal_id": "principal_01..." }   ← Intent
{ "action": "Implement principal-id capture fields.\\n\\nReplaced the username-based path…", "verb": "implement", "outputs": { "commit": "abc123" } }                          ← Action
{ "decision": "Use ULIDs for all entity ids.", "question": "What identifier scheme should every entity use?", "chosen": "ULID — time-sortable, URL-safe, no collisions in practice." } ← Decision

Only call GET /<handle>/api/<type>.txt when you need detail beyond
this cheatsheet (long-form error semantics, deep PATCH field list,
or a type not enumerated above). Routine captures POST directly.

## After every write — paste footer_lines verbatim, then navigate

Every POST / PATCH / DELETE on a Doco endpoint returns a \`footer_lines: string[]\` in the response body. Paste every entry **verbatim**, one per line, as plain text in your reply — same canonical protocol every other agent on Doco follows. The lines already carry the entity name, an emoji marker, a markdown link to the new node, and a parenthetical authoring-policy pass summary with timing; they are the canonical user-visible record of what happened. Don't paraphrase them, don't summarize them, don't drop the link, don't add your own "Decision captured — see graph." line on top — the footer line is the line.

Then navigate to the page that visibly proves the change:

| Action | Navigate to |
|---|---|
| Captured a new node | /<handle>/<type>/<id>?dialog=skip — focus the graph/list on the node without opening the detail dialog |
| Added/changed a edge (patched a ref field on a node) | /<handle>/<type>/<from-id>?dialog=skip — focus the source node's graph neighborhood without opening the detail dialog |
| Browsing edges in general | /<handle>/edges (list) or /<handle>/edges/<edge-key> (detail with two-node graph) |
| Created a new doco / org | /<new-handle> |
| User asked "show me X" | the page that lists or details X |

Never paste the URL on a separate line — the footer-line's link covers it, and the navigate already moved them there. If the response also returns \`warnings[]\`, those are model-facing hints, not user-facing; do not paste them.

## Adding a edge

Edges in Doco are derived from reference fields on nodes (D-017, fields-as-edges). For one-off edits, PATCH the owning field on the node. For structured work where the relation matters to rendering (BPMN, org charts, dependency maps), prefer POST /<handle>/api/changesets.json so creation and relation happen together and the response returns integrity/frontier feedback.

Changeset example for BPMN-style ordered flow:

  POST /<handle>/api/changesets.json
  {
    "validate_against": "bpmn",
    "operations": [
      {
        "op": "append",
        "relation_kind": "sequence_flow",
        "after": "decision_01...",
        "label": "Yes",
        "entity_type": "action",
        "alias": "charge_card",
        "body": {
          "action": "SuD charges the authorized card",
          "verb": "charge",
          "actor_principal_id": "principal_01...",
          "lifecycle": "drafting"
        }
      }
    ]
  }

Common relation kinds: sequence_flow → sequence_to (source -> target, edge labels allowed) · preceded_by → preceded_by (stored on later node) · serves → intent_ids · enacts → decision_ids · gated_by → gated_by · tests → target_ref · born_from → born_from · superseded_by → superseded_by · reports_to → reports_to · implemented_by → implemented_by (any node → code-artifact References; e.g. Decision/ADR shipped by these PRs, BPMN Action implemented at these code locations). There is no POST /<handle>/api/edges.json — use changesets or patch reference fields; the indexer materializes the edge synchronously.

When sibling relations must become valid together, use \`op: "relate_many"\` in the same changeset. This is especially important for exhaustive gateways, tree siblings, and other structures where adding the first edge alone would be temporarily invalid.

## Speed rules

1. Tool first, words second. When the user gives a direct command ("add a decision about X", "take me to Y"), START with the tool call. No preamble, no restating, no clarifying questions you can avoid.
2. One tool round-trip per user-visible step. Don't list before capturing if the user already gave you the content.
3. Keep replies under 2 short lines unless the user asked for explanation.
4. Don't await confirmation between capture and navigate — chain them.

## Other working principles

- Be terse. The sidebar is narrow.
- Read before you write only when you genuinely don't know enough to write a good node. Otherwise, write.
- Deduplicate. Before a new node, scan for one already covering the territory; patch beats create.
- Honor the policies below — they govern your captures.

## Your docos and orgs — canonical

The two lists below are computed server-side at the start of each turn from the same access-control checks ${principal.username} sees in the UI. They are COMPLETE and AUTHORITATIVE — every doco / org the user can read or write is here. When asked "how many docos do I have?" or "what's my org?", answer from these lists directly. Never hedge with "if there are others not visible…" — there aren't. Don't probe with HTTP GETs to discover docos/orgs; there is no listing endpoint for those.

Doco labels in these lists are qualified as org/doco (for example, torre/bpms) to avoid ambiguity. Use the \`path=/...\` value when calling doco_api routes, because Doco's public route namespace is still the global doco handle.

### Your docos

${docoList}

### Your orgs

${orgList}

## Policies — canonical

The section below lists every ACTIVE guidance + node-authoring policy for every doco the user can access, fetched server-side at the start of each turn. It is COMPLETE — same SQL the /policies page reads. When asked about a doco's policies or rules, answer from this list directly. Never say "I may have incomplete information" or offer to fetch the live version — this IS the live version. (Inactive / archived policies are excluded by design; flag that only if the user specifically asks about non-active ones.)

${policySections}`;

  return [
    {
      type: "text",
      text,
      // Mark the entire system block as ephemerally cacheable. Anthropic
      // keys on byte-identical prefixes, so subsequent turns within ~5 min
      // hit the cache and skip re-processing this ~2-4 KB prompt.
      cache_control: { type: "ephemeral" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  DOCO_API_TOOL,
  {
    name: "navigate",
    description:
      "Push the user's browser to a Doco URL. Causes a client-side navigation (no page reload, no sidebar reset). Use when the user asks to be taken somewhere, or when the destination page would be the natural place to continue the conversation.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Relative path starting with /, e.g. '/myhandle/decisions'.",
        },
      },
      required: ["url"],
    },
  },
];

/**
 * Pull a recommended retry-delay (in ms) from an Anthropic 429 error.
 * Anthropic sets `retry-after` (seconds) and the more specific
 * `anthropic-ratelimit-*-reset` (ISO timestamp) headers; we try both
 * and fall back to a 5s nudge if neither is present. Capped so a
 * pathological `retry-after` doesn't freeze the sidebar.
 */
function parseAnthropicRetryAfterMs(err: unknown): number {
  const headers = (err as { headers?: unknown }).headers;
  const ra = getHeaderValue(headers, "retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) {
      return Math.min(n * 1000, ANTHROPIC_429_MAX_RETRY_SLEEP_MS);
    }
  }
  for (const key of [
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-requests-reset",
  ]) {
    const v = getHeaderValue(headers, key);
    if (!v) continue;
    const ms = Date.parse(v) - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      return Math.min(ms, ANTHROPIC_429_MAX_RETRY_SLEEP_MS);
    }
  }
  return 5_000;
}

/**
 * Translate an Anthropic SDK error into a sentence the user can act
 * on. Raw error bodies (giant JSON dumps with type / request_id /
 * message) read like noise in the chat bubble; this surfaces the
 * actionable bit only.
 */
function friendlyAnthropicError(err: unknown): string {
  const status = (err as { status?: number }).status;
  const inner = (err as { error?: { error?: { message?: string; type?: string } } }).error?.error;
  if (status === 429) {
    const detail = inner?.message ? ` (${inner.message.split(".")[0]})` : "";
    return `Señor Doco hit Anthropic's per-minute rate limit and one auto-retry didn't clear it. Try again in a minute.${detail}`;
  }
  if (status === 401 || status === 403) {
    return `Señor Doco's Anthropic credentials aren't accepted (HTTP ${status}).${inner?.message ? ` ${inner.message}` : ""}`;
  }
  if (typeof status === "number" && status >= 500) {
    return `Anthropic is having a problem on their end (HTTP ${status}). Try again shortly.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Anthropic stream error: ${msg}`;
}

const ANTHROPIC_TELEMETRY_HEADERS = [
  "request-id",
  "retry-after",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-limit",
  "anthropic-ratelimit-output-tokens-remaining",
  "anthropic-ratelimit-output-tokens-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "cf-ray",
] as const;

function getHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  const exact = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (typeof exact === "string") return exact;
  const found = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof found?.[1] === "string" ? found[1] : null;
}

function pickAnthropicHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ANTHROPIC_TELEMETRY_HEADERS) {
    const value = getHeaderValue(headers, name);
    if (value) out[name] = value;
  }
  return out;
}

function summarizeAnthropicError(err: unknown, waitMs?: number): Record<string, unknown> {
  const shaped = err as {
    status?: number;
    requestID?: string;
    request_id?: string;
    headers?: unknown;
    name?: string;
    error?: { error?: { type?: string; message?: string } };
  };
  const summary: Record<string, unknown> = {
    status: shaped.status ?? null,
    name: shaped.name ?? (err instanceof Error ? err.name : null),
    request_id:
      shaped.requestID ?? shaped.request_id ?? getHeaderValue(shaped.headers, "request-id"),
    headers: pickAnthropicHeaders(shaped.headers),
  };
  if (waitMs !== undefined) summary.retry_wait_ms = waitMs;
  const inner = shaped.error?.error;
  if (inner?.type) summary.error_type = inner.type;
  if (inner?.message) summary.message = inner.message.slice(0, 500);
  return summary;
}

function usageSnapshot(usage: Usage | null | undefined): Record<string, number> | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as unknown as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    const value = raw[key];
    if (typeof value === "number") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

type ToolResult = DocoApiToolResult & { navigateUrl?: string };

async function runTool(block: ToolUseBlock, ctx: ChatStreamContext): Promise<ToolResult> {
  if (block.name === "navigate") {
    const input = block.input as { url?: unknown };
    const url = typeof input?.url === "string" ? input.url : "";
    if (!url.startsWith("/")) {
      return {
        result: {
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: navigate url must start with "/" (got: ${JSON.stringify(url)})`,
          is_error: true,
        },
        preview: `navigate(${JSON.stringify(url)}) — refused (must start with /)`,
        ok: false,
      };
    }
    return {
      result: {
        type: "tool_result",
        tool_use_id: block.id,
        content: `navigated to ${url}`,
      },
      navigateUrl: url,
      preview: `navigate → ${url}`,
      ok: true,
    };
  }
  if (block.name === "doco_api") {
    const input = block.input as { method?: unknown; path?: unknown; body?: unknown };
    const path = typeof input?.path === "string" ? input.path : "";
    // Auto-attach: when the agent hits a per-Doco URL, remember that
    // Doco against the active conversation by stable id so the sidebar
    // can render a clickable chip that survives handle renames.
    // Best-effort — failures are swallowed by the helper and never
    // break the tool call.
    const perDocoById = /^\/by-id\/([^/]+)\/api\//.exec(path);
    if (perDocoById) {
      void attachDocoIdToConversation(ctx.conversationId, perDocoById[1]);
    } else {
      const perDoco = /^\/([^/]+)\/api\//.exec(path);
      const handle = perDoco?.[1];
      // Skip the platform-level API root — `/api/v1/...` matches the
      // shape above with "api" as the would-be handle. Reserved
      // prefixes never collide with real Doco handles by URL policy.
      if (handle && handle !== "api") {
        void attachDocoToConversation(ctx.conversationId, handle);
      }
    }
    return runDocoApiToolRequest({
      toolUseId: block.id,
      input: block.input,
      execute: async ({ method, path, body }) => {
        const url = new URL(path, ctx.origin).toString();
        // Try the in-process router first. Calls the SAME loader/action
        // module HTTP would reach — no logic duplication — but skips the
        // socket / parse round-trip. Returns null when no registered route
        // matches; we then fall back to a real fetch so unmapped routes
        // (HTML pages, dynamic plugins, etc.) keep working.
        let res = await internalFetch({
          method,
          path,
          origin: ctx.origin,
          cookieHeader: ctx.cookieHeader,
          body,
          userAgent: "Doco-In-Page-Assistant/1",
        });
        if (!res) {
          const init: RequestInit = {
            method,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Cookie: ctx.cookieHeader,
              "User-Agent": "Doco-In-Page-Assistant/1",
            },
          };
          if (method !== "GET" && method !== "DELETE" && body !== undefined) {
            init.body = typeof body === "string" ? body : JSON.stringify(body);
          }
          res = await fetch(url, init);
        }
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON — pass through as text
        }
        return {
          status: res.status,
          ok: res.ok,
          body: parsed,
        };
      },
    });
  }
  return {
    result: {
      type: "tool_result",
      tool_use_id: block.id,
      content: `unknown tool: ${block.name}`,
      is_error: true,
    },
    preview: `unknown tool: ${block.name}`,
    ok: false,
  };
}

// ---------------------------------------------------------------------------
// Streaming turn
// ---------------------------------------------------------------------------

/**
 * Walk the message list looking for assistant turns with `tool_use`
 * blocks that lack matching `tool_result` blocks in the immediately
 * following user message — and backfill synthetic results so the
 * Anthropic API contract holds. Happens when a prior lambda was
 * SIGKILL'd after persisting the assistant message but before
 * persisting the tool-result user message.
 *
 * Without this, every subsequent turn on that conversation 400s
 * ("`tool_use` ids were found without `tool_result` blocks").
 * Placeholder results are marked `is_error: true` so the model can
 * tell the run was interrupted.
 */
function stitchMissingToolResults(messages: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const toolUseIds: string[] = [];
    for (const b of m.content) {
      if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
        const id = (b as { id?: string }).id;
        if (typeof id === "string") toolUseIds.push(id);
      }
    }
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    const nextContent: ContentBlockParam[] =
      next && next.role === "user" && Array.isArray(next.content)
        ? (next.content.slice() as ContentBlockParam[])
        : [];
    const presentIds = new Set<string>();
    for (const b of nextContent) {
      if (b && typeof b === "object" && (b as { type?: string }).type === "tool_result") {
        const id = (b as { tool_use_id?: string }).tool_use_id;
        if (typeof id === "string") presentIds.add(id);
      }
    }
    const missing = toolUseIds.filter((id) => !presentIds.has(id));
    if (missing.length === 0) continue;
    const synthetic: ContentBlockParam[] = missing.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "(turn was interrupted before the result was recorded)",
      is_error: true,
    }));
    if (next && next.role === "user") {
      // Augment the existing tool-result message with the missing ids.
      out[out.length - 1] = m;
      messages[i + 1] = { role: "user", content: [...synthetic, ...nextContent] };
    } else {
      // No follow-up user message at all → inject a fresh one before
      // whatever comes next.
      out.push({ role: "user", content: synthetic });
    }
  }
  return out;
}

async function rowsToHistory(rows: ChatMessageRow[]): Promise<MessageParam[]> {
  const raw: MessageParam[] = [];
  for (const r of rows) {
    const content = await hydrateMessageContent(r.content, r.conversation_id);
    raw.push({ role: r.role, content });
  }
  const out = stitchMissingToolResults(raw);
  // Cross-turn prompt caching. Anthropic re-uses cached prefixes when
  // a subsequent request starts byte-identically; the breakpoint lives
  // on the LAST content block of whatever message we mark. By tagging
  // the final block of the last persisted message, every later turn
  // re-uses the entire prior history without re-spending input tokens
  // against the per-minute rate limit. (Up to 4 breakpoints allowed;
  // the system block already uses one — this adds the second.)
  const last = out[out.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const tail = last.content[last.content.length - 1] as unknown as Record<string, unknown>;
    if (
      tail &&
      typeof tail === "object" &&
      typeof tail.type === "string" &&
      (tail.type === "text" ||
        tail.type === "tool_use" ||
        tail.type === "tool_result" ||
        tail.type === "image" ||
        tail.type === "document")
    ) {
      tail.cache_control = { type: "ephemeral" };
    }
  }
  return out;
}

function formatVisibleGraphReferences(groups: VisibleGraphReferenceGroup[]): string {
  const lines: string[] = [];
  for (const group of groups) {
    for (const reference of group.references) {
      const href = reference.href ? ` ${reference.href}` : "";
      const lifecycle = reference.lifecycle ? ` lifecycle=${reference.lifecycle}` : "";
      lines.push(
        `${reference.number}. ${reference.entity_type} ${reference.id}${lifecycle}${href} — ${reference.label}`,
      );
    }
  }
  if (lines.length === 0) return "";
  return [
    "Visible graph node references (numbers match the purple circles on the graph):",
    ...lines,
  ].join("\n");
}

/**
 * Public entry point. Wraps the actual streamer so every yielded
 * event is also pushed onto the conversation's `active_turn_events`
 * column — that lets a freshly-loaded page replay the Thinking column
 * for everything that happened in the current or most recent turn,
 * instead of staring at "no thinking yet" after a refresh.
 *
 * Events flush to the DB every 500 ms (whatever's in the buffer at
 * that tick), plus a final flush on milestone events so the lag
 * between "Señor Doco just called a tool" and "the column shows it"
 * is bounded. Best-effort: a failed write logs and continues; never
 * fails the turn itself.
 */
export async function* runAssistantTurn(args: {
  conversation: ChatConversationRow;
  userText: string;
  ctx: ChatStreamContext;
}): AsyncGenerator<ChatStreamEvent> {
  const turnStartMs = Date.now();
  const buffer: Array<Record<string, unknown>> = [];
  const pendingFlushes = new Set<Promise<void>>();
  const flushBuffer = (): Promise<void> => {
    if (buffer.length === 0) return Promise.resolve();
    const batch = buffer.splice(0, buffer.length);
    // Periodic and milestone callers may fire-and-forget; the final
    // cleanup awaits pending flushes so refresh has the completed log.
    const flush = appendActiveTurnEvents(args.conversation.id, batch);
    pendingFlushes.add(flush);
    flush.finally(() => pendingFlushes.delete(flush));
    return flush;
  };
  const flushTimer = setInterval(() => {
    void flushBuffer();
  }, 500);
  // Milestone kinds: flush immediately so the user sees status
  // changes the moment the lambda emits them, not 0-500ms later.
  const MILESTONE_KINDS = new Set([
    "status",
    "tool_use_start",
    "tool_use_result",
    "navigate",
    "error",
    "done",
    "message_saved",
  ]);
  try {
    for await (const event of streamAssistantTurn(args)) {
      buffer.push({ at_ms: Date.now() - turnStartMs, ...event });
      if (MILESTONE_KINDS.has(event.kind)) void flushBuffer();
      yield event;
    }
  } finally {
    clearInterval(flushTimer);
    // Preserve the final tail as part of the last-turn replay buffer.
    // markActiveTurnEnded now clears only the active marker; the next
    // turn's markActiveTurnStarted resets the event buffer.
    await flushBuffer();
    if (pendingFlushes.size > 0) {
      await Promise.allSettled(pendingFlushes);
    }
  }
}

async function* streamAssistantTurn(args: {
  conversation: ChatConversationRow;
  userText: string;
  ctx: ChatStreamContext;
}): AsyncGenerator<ChatStreamEvent> {
  const missingAnthropic = missingSenorDocoAnthropicMessage("the in-page assistant");
  if (missingAnthropic) {
    yield {
      kind: "error",
      message: missingAnthropic,
    };
    return;
  }

  const model = getSenorDocoModel();
  const turnStart = performance.now();
  // Stable id so the same row can be progressively filled in via
  // upsertAgentTurn — survives Vercel SIGKILL because every milestone
  // writes synchronously.
  const turnId = `atm_${generateUlid()}`;

  // Per-turn metrics. Filled in as we go; written eagerly on every
  // boundary so a SIGKILL'd lambda still leaves a row behind.
  let bootstrapMs = 0;
  let historyLoadMs = 0;
  let firstTextTokenMs: number | null = null;
  let numAnthropicCalls = 0;
  let numToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let historyMessageCount = 0;
  let stopReason: string | null = null;
  let turnError: string | null = null;
  const anthropicCallStats: Array<Record<string, unknown>> = [];
  const toolCallStats: Array<Record<string, unknown>> = [];

  const buildMetricsRow = () => ({
    conversation_id: args.conversation.id,
    user_id: args.conversation.user_id,
    model,
    total_ms: Math.round(performance.now() - turnStart),
    bootstrap_ms: Math.round(bootstrapMs),
    history_load_ms: Math.round(historyLoadMs),
    first_text_token_ms:
      firstTextTokenMs === null ? null : Math.round(firstTextTokenMs - turnStart),
    num_anthropic_calls: numAnthropicCalls,
    num_tool_calls: numToolCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    history_message_count: historyMessageCount,
    attachment_count: args.ctx.attachmentIds.length,
    stop_reason: stopReason,
    error: turnError,
    phases: {
      anthropic_calls: anthropicCallStats,
      tool_calls: toolCallStats,
    },
  });

  // Synchronous checkpoint write. Called at every milestone so a
  // mid-turn lambda kill still leaves a row with the last known state
  // (which Anthropic call hung, how many tokens it had consumed). The
  // await costs ~5-15ms per checkpoint — acceptable insurance.
  const checkpointMetrics = async () => {
    await upsertAgentTurn(turnId, buildMetricsRow());
  };
  // Final write — still eager (not waitUntil) so we hold the
  // AsyncGenerator open until the row is persisted. Better than
  // fire-and-forget; the response is already streamed by this point
  // so latency here doesn't affect the user.
  const flushMetrics = async () => {
    await upsertAgentTurn(turnId, buildMetricsRow());
  };

  // PERSIST THE USER'S MESSAGE FIRST. Before purgeExpiredAttachments,
  // before markActiveTurnStarted, before history loading — any of which
  // can hang for tens of seconds and leave the lambda vulnerable to a
  // timeout-kill. Past incident: user typed "?", hit Send, lambda died
  // during the load phase, and the user's "?" was never persisted →
  // their message disappeared on refresh. The agent doesn't see the
  // persisted row, it sees the in-memory `userContent` later, so saving
  // it now is purely a durability win.
  const attachmentRows = await loadAttachmentsByIds(args.ctx.attachmentIds, args.conversation.id);
  const turnAttachmentBlocks: ContentBlockParam[] = [];
  const turnAttachmentRefs: AttachmentRefBlock[] = [];
  for (const id of args.ctx.attachmentIds) {
    const row = attachmentRows.get(id);
    if (!row) continue;
    turnAttachmentBlocks.push(
      refToAnthropicBlock(
        {
          type: "attachment_ref",
          attachment_id: id,
          filename: row.filename,
          mime_type: row.mime_type,
          size_bytes: row.size_bytes,
        },
        row,
      ),
    );
    turnAttachmentRefs.push({
      type: "attachment_ref",
      attachment_id: id,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
    });
  }
  // Per-turn dynamic context lives in the user message so the system
  // prompt stays byte-identical across turns (cache-friendly).
  const todayIso = new Date().toISOString().slice(0, 10);
  const pageLine = args.ctx.currentPath ? `Page: ${args.ctx.currentPath}` : "Page: (unknown)";
  const attachmentLine =
    turnAttachmentRefs.length > 0
      ? `\nAttachments this turn: ${turnAttachmentRefs.length}. Begin your reply with: "${ATTACHMENT_RETENTION_NOTICE}"`
      : "";
  const graphReferenceText = formatVisibleGraphReferences(args.ctx.graphReferences);
  const turnHeader = `[Today ${todayIso}. ${pageLine}.${attachmentLine}]\n\n${
    graphReferenceText ? `${graphReferenceText}\n\n` : ""
  }`;
  const userContent: ContentBlockParam[] = [
    { type: "text", text: `${turnHeader}${args.userText}` },
    ...turnAttachmentBlocks,
  ];
  // Persist user's words + attachment refs (NOT the bytes — the bytes
  // live in chat_attachments and hydrate on replay). The dynamic
  // header is metadata for the model, not part of human history.
  const persistedUserContent: PersistedContentBlock[] = [
    { type: "text", text: args.userText },
    ...turnAttachmentRefs,
  ];
  const userRow = await appendMessage(args.conversation.id, "user", persistedUserContent);
  yield { kind: "message_saved", message_id: userRow.id, role: "user" };

  // Opportunistic cleanup at the top of every turn so retention is
  // enforced even without a separate cron.
  await purgeExpiredAttachments();
  // Server-side "is Señor Doco mid-reply?" marker so a freshly-loaded
  // page can show the placeholder bubble for a turn its tab didn't
  // initiate. Cleared in the finally below — covers normal
  // completion, errors, and aborts.
  await markActiveTurnStarted(args.conversation.id);
  // Eager metrics insert with the "in_flight" sentinel. Establishes
  // the row before any long anthropic call runs so a SIGKILL leaves
  // forensic evidence (vs. the prior flush-in-finally pattern which
  // lost the row when the function timed out).
  turnError = "(in_flight)";
  await checkpointMetrics();
  turnError = null;

  // First user-facing event in the stream. Without this, the
  // sidebar's thinking column shows "0 events / waiting for first
  // event…" until Anthropic produces its first content block —
  // which can take several seconds and look frozen.
  yield { kind: "status", phase: "loading_history" };

  const histStart = performance.now();
  const allHistory = await loadMessages(args.conversation.id);
  const history = trimHistoryToWindow(allHistory);
  // History now includes the user message we just persisted; drop
  // the trailing user row so we don't double-add the same content
  // when we push the `userContent` (with dynamic header) below.
  if (history.length > 0 && history[history.length - 1].id === userRow.id) {
    history.pop();
  }
  const messages: MessageParam[] = await rowsToHistory(history);
  historyLoadMs = performance.now() - histStart;
  historyMessageCount = history.length;

  try {
    messages.push({ role: "user", content: userContent });

    const bootstrapStart = performance.now();
    yield { kind: "status", phase: "loading_bootstrap" };
    const bootstrap = await buildBootstrapContext(args.ctx.principal.id);
    bootstrapMs = performance.now() - bootstrapStart;
    const systemBlocks = buildSystemBlocks(args.ctx.principal, bootstrap);

    for (let turn = 0; turn < MAX_TURNS_PER_REPLY; turn++) {
      const callStart = performance.now();
      let ttfbMs: number | null = null;
      let streamConstructedMs: number | null = null;
      let streamConnectedMs: number | null = null;
      let firstStreamEventMs: number | null = null;
      let firstStreamEventType: MessageStreamEvent["type"] | null = null;
      let messageStartMs: number | null = null;
      let messageStartUsage: Record<string, number> | null = null;
      let responseRequestId: string | null | undefined;
      let responseHeaders: Record<string, string> = {};
      let streamConnectError: Record<string, unknown> | null = null;
      let responseTelemetryPromise: Promise<void> | null = null;
      // One retry per turn iteration when we hit a 429. Stream
      // creation AND per-chunk reads can both throw the rate-limit
      // error, so the flag is checked in the catch below.
      let retriedThisTurn = false;
      numAnthropicCalls++;
      yield {
        kind: "status",
        phase: "calling_anthropic",
        detail: `call ${numAnthropicCalls}`,
      };
      let stream: MessageStream;
      try {
        stream = streamSenorDocoMessage({
          model,
          max_tokens: MAX_TOKENS,
          system: systemBlocks,
          tools: TOOLS,
          messages,
        });
        streamConstructedMs = performance.now() - callStart;
        responseTelemetryPromise = stream
          .withResponse()
          .then(({ response, request_id }) => {
            streamConnectedMs = performance.now() - callStart;
            responseRequestId = request_id;
            responseHeaders = pickAnthropicHeaders(response.headers);
          })
          .catch((err) => {
            streamConnectError = summarizeAnthropicError(err);
          });
      } catch (err) {
        // Rare — most 429s surface from the async iteration below.
        if ((err as { status?: number }).status === 429 && !retriedThisTurn) {
          retriedThisTurn = true;
          const waitMs = parseAnthropicRetryAfterMs(err);
          anthropicCallStats.push({
            turn,
            elapsed_ms: Math.round(performance.now() - callStart),
            ttfb_ms: null,
            stream_constructed_ms:
              streamConstructedMs === null ? null : Math.round(streamConstructedMs),
            stop_reason: "rate_limited_retry",
            retry_wait_ms: waitMs,
            error: summarizeAnthropicError(err, waitMs),
          });
          await checkpointMetrics();
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          turn--;
          continue;
        }
        const friendly = friendlyAnthropicError(err);
        turnError = `anthropic stream: ${friendly}`;
        yield { kind: "error", message: friendly };
        return;
      }

      const collectedBlocks: StoredAssistantBlock[] = [];
      let activeToolUse: { id: string; name: string; partialJson: string } | null = null;

      try {
        for await (const event of stream) {
          if (firstStreamEventMs === null) {
            firstStreamEventMs = performance.now() - callStart;
            firstStreamEventType = event.type;
          }
          if (event.type === "message_start" && messageStartMs === null) {
            messageStartMs = performance.now() - callStart;
            messageStartUsage = usageSnapshot(event.message.usage);
          }
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              activeToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                partialJson: "",
              };
              if (ttfbMs === null) ttfbMs = performance.now() - callStart;
              if (firstTextTokenMs === null) firstTextTokenMs = performance.now();
              yield {
                kind: "tool_use_start",
                tool_use_id: event.content_block.id,
                name: event.content_block.name,
              };
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              if (ttfbMs === null) ttfbMs = performance.now() - callStart;
              if (firstTextTokenMs === null) firstTextTokenMs = performance.now();
              yield { kind: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && activeToolUse) {
              activeToolUse.partialJson += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            activeToolUse = null;
          }
        }
      } catch (err) {
        if ((err as { status?: number }).status === 429 && !retriedThisTurn) {
          retriedThisTurn = true;
          const waitMs = parseAnthropicRetryAfterMs(err);
          if (responseTelemetryPromise) await responseTelemetryPromise;
          anthropicCallStats.push({
            turn,
            elapsed_ms: Math.round(performance.now() - callStart),
            ttfb_ms: ttfbMs === null ? null : Math.round(ttfbMs),
            stream_constructed_ms:
              streamConstructedMs === null ? null : Math.round(streamConstructedMs),
            stream_connected_ms: streamConnectedMs === null ? null : Math.round(streamConnectedMs),
            first_stream_event_ms:
              firstStreamEventMs === null ? null : Math.round(firstStreamEventMs),
            first_stream_event_type: firstStreamEventType,
            message_start_ms: messageStartMs === null ? null : Math.round(messageStartMs),
            message_start_usage: messageStartUsage,
            request_id: responseRequestId ?? null,
            response_headers: responseHeaders,
            stop_reason: "rate_limited_retry",
            retry_wait_ms: waitMs,
            error: summarizeAnthropicError(err, waitMs),
          });
          await checkpointMetrics();
          yield {
            kind: "status",
            phase: "rate_limited_retrying",
            detail: `retry in ${Math.round(waitMs / 1000)}s`,
          };
          // Tell the user we're holding rather than going silent for a
          // potentially-long sleep.
          yield {
            kind: "text_delta",
            text: `\n_(Anthropic rate-limited; retrying in ${Math.round(waitMs / 1000)}s…)_\n`,
          };
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          turn--;
          continue;
        }
        const friendly = friendlyAnthropicError(err);
        turnError = `anthropic stream: ${friendly}`;
        yield { kind: "error", message: friendly };
        return;
      }

      const finalMessage = await stream.finalMessage();
      if (responseTelemetryPromise) await responseTelemetryPromise;
      yield {
        kind: "status",
        phase: "anthropic_returned",
        detail: `stop=${finalMessage.stop_reason ?? "unknown"}`,
      };
      stopReason = finalMessage.stop_reason ?? stopReason;
      const usage = finalMessage.usage;
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      // Tell the client the running totals for this turn so the
      // sidebar can show "1,234 in · 56 out" while the user waits.
      yield {
        kind: "usage_update",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
      };
      anthropicCallStats.push({
        turn,
        elapsed_ms: Math.round(performance.now() - callStart),
        ttfb_ms: ttfbMs === null ? null : Math.round(ttfbMs),
        stream_constructed_ms:
          streamConstructedMs === null ? null : Math.round(streamConstructedMs),
        stream_connected_ms: streamConnectedMs === null ? null : Math.round(streamConnectedMs),
        first_stream_event_ms: firstStreamEventMs === null ? null : Math.round(firstStreamEventMs),
        first_stream_event_type: firstStreamEventType,
        message_start_ms: messageStartMs === null ? null : Math.round(messageStartMs),
        message_start_usage: messageStartUsage,
        request_id: responseRequestId ?? null,
        response_headers: responseHeaders,
        stream_connect_error: streamConnectError,
        message_id: finalMessage.id,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
        stop_reason: finalMessage.stop_reason ?? null,
      });
      // Checkpoint after each Anthropic call so a kill on the NEXT
      // call still leaves a row pointing at the last completed one.
      turnError = "(in_flight)";
      await checkpointMetrics();
      turnError = null;
      for (const block of finalMessage.content) {
        if (block.type === "text" || block.type === "tool_use") {
          collectedBlocks.push(block);
        }
      }

      // Emit assembled input for each tool_use block (so the UI can show
      // what the model is about to do before we run the tool).
      for (const block of collectedBlocks) {
        if (block.type === "tool_use") {
          yield { kind: "tool_use_input", tool_use_id: block.id, input: block.input };
        }
      }

      messages.push({ role: "assistant", content: collectedBlocks as ContentBlockParam[] });

      if (finalMessage.stop_reason !== "tool_use") {
        // max_tokens means the model was cut off mid-output (could be
        // mid-text or mid-tool-JSON). Without a visible signal the
        // user thinks the agent just stopped early. Surface a short
        // note so they know to ask me to continue.
        const persistedAssistantBlocks = collectedBlocks as ContentBlockParam[];
        if (finalMessage.stop_reason === "max_tokens") {
          const note = `\n\n_(hit the per-call output cap mid-reply — ask me to continue and I'll pick up where I left off)_`;
          yield {
            kind: "text_delta",
            text: note,
          };
          persistedAssistantBlocks.push({ type: "text", text: note });
        }
        // Save assistant turn (text-only) and finish.
        const saved = await appendMessage(
          args.conversation.id,
          "assistant",
          persistedAssistantBlocks,
        );
        yield { kind: "message_saved", message_id: saved.id, role: "assistant" };
        yield { kind: "done" };
        return;
      }

      // Tool use turn — run each tool, append a single user-role message
      // containing all the tool_result blocks (Anthropic API contract).
      const toolUseBlocks = collectedBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const toolResults: ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        yield { kind: "status", phase: "running_tool", detail: block.name };
        const toolStart = performance.now();
        const tr = await runTool(block, args.ctx);
        const toolElapsed = Math.round(performance.now() - toolStart);
        yield {
          kind: "status",
          phase: "tool_returned",
          detail: `${block.name} ${tr.ok ? "ok" : "err"} ${toolElapsed}ms`,
        };
        numToolCalls++;
        toolCallStats.push({
          name: block.name,
          ok: tr.ok,
          elapsed_ms: toolElapsed,
          preview: tr.preview,
        });
        yield {
          kind: "tool_use_result",
          tool_use_id: block.id,
          ok: tr.ok,
          preview: tr.preview,
        };
        if (tr.navigateUrl) {
          yield { kind: "navigate", url: tr.navigateUrl };
        }
        toolResults.push(tr.result);
      }

      // Persist the assistant turn AND the tool-result user message so
      // the next reload reproduces the same context.
      const assistantSaved = await appendMessage(
        args.conversation.id,
        "assistant",
        collectedBlocks as ContentBlockParam[],
      );
      yield { kind: "message_saved", message_id: assistantSaved.id, role: "assistant" };

      const toolResultContent: ContentBlockParam[] = toolResults;
      const toolMsgSaved = await appendMessage(args.conversation.id, "user", toolResultContent);
      messages.push({ role: "user", content: toolResultContent });
      yield { kind: "message_saved", message_id: toolMsgSaved.id, role: "user" };
    }

    turnError = `hit MAX_TURNS_PER_REPLY=${MAX_TURNS_PER_REPLY}`;
    const limitMessage = `I hit the per-turn work limit (${MAX_TURNS_PER_REPLY} Anthropic calls) while continuing this job, so I paused instead of risking a tool-call loop. The work so far is saved; send "continue" and I'll pick up from the latest tool results.`;
    yield { kind: "text_delta", text: limitMessage };
    const saved = await appendMessage(args.conversation.id, "assistant", [
      { type: "text", text: limitMessage },
    ]);
    yield { kind: "message_saved", message_id: saved.id, role: "assistant" };
    yield { kind: "done" };
  } finally {
    // Final synchronous flush so a turn that completed normally (or
    // errored cleanly) overwrites the "in_flight" sentinel with the
    // real outcome. Swallow errors so a DB hiccup at the end of a
    // turn doesn't surface as a turn-level failure.
    try {
      await flushMetrics();
    } catch (err) {
      console.warn(
        "[agent-chat] final flushMetrics failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await markActiveTurnEnded(args.conversation.id);
    } catch (err) {
      console.warn(
        "[agent-chat] failed to clear active_turn_started_at:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public read API for the loader
// ---------------------------------------------------------------------------

/**
 * Resolved Doco attachment. The handle is the global route handle;
 * label is the human-facing org/doco name used where ambiguity matters.
 * `id` is kept for stable links/correlation.
 */
export interface DocoAttachmentInfo {
  id?: string;
  handle: string;
  label?: string;
}

export interface OrgAttachmentInfo {
  handle: string;
  name: string | null;
}

export interface ConversationSnapshot {
  conversation_id: string;
  /** User-visible thread name. Null until the first user message is sent. */
  title: string | null;
  archived: boolean;
  /** Docos the agent has touched in this thread. Auto-populated by `doco_api`. */
  attached_docos: DocoAttachmentInfo[];
  /** Orgs the agent has touched in this thread. Reserved; not yet populated. */
  attached_orgs: OrgAttachmentInfo[];
  messages: {
    id: string;
    role: "user" | "assistant";
    content: PersistedContentBlock[];
    created_at: string;
  }[];
  has_more: boolean;
  /**
   * ISO timestamp of when the active turn started, or null when the
   * conversation is idle. Lets a freshly-loaded page show the
   * "Señor Doco is replying…" placeholder for a turn that was started
   * by a now-closed tab. Clients should treat values older than a few
   * minutes as stale (the server might have crashed before clearing).
   */
  active_turn_started_at: string | null;
  /**
   * Replay buffer of thinking events for the current or most recent
   * turn. Each entry is the SSE event the agent yielded, with an
   * `at_ms` offset from turn start. New turns reset the buffer; idle
   * conversations keep the last completed turn so refresh preserves
   * the Thinking column.
   */
  active_turn_events: Array<Record<string, unknown>>;
}

async function resolveDocoAttachments(
  ids: string[],
  legacyHandles: string[] = [],
): Promise<DocoAttachmentInfo[]> {
  const docoIds = uniqueNonEmptyStrings(ids);
  if (docoIds.length === 0 && legacyHandles.length === 0) return [];
  return await withClient(async (c) => {
    if (docoIds.length > 0) {
      const r = await c.query<{ id: string; handle: string; owner_slug: string }>(
        `SELECT d.id, d.handle, COALESCE(o.handle, co.github_login, '') AS owner_slug
           FROM docos d
           LEFT JOIN organizations o ON o.id = d.owner_id
           LEFT JOIN users co ON co.id = d.owner_id
          WHERE d.id = ANY($1::text[])`,
        [docoIds],
      );
      const byId = new Map(r.rows.map((row) => [row.id, row]));
      return docoIds.map((id) => {
        const row = byId.get(id);
        return row
          ? {
              id: row.id,
              handle: row.handle,
              label: qualifiedDocoLabel({ ownerSlug: row.owner_slug, handle: row.handle }),
            }
          : { id, handle: id };
      });
    }
    const handles = uniqueNonEmptyStrings(legacyHandles);
    const r = await c.query<{ id: string; handle: string; owner_slug: string }>(
      `SELECT d.id, d.handle, COALESCE(o.handle, co.github_login, '') AS owner_slug
         FROM docos d
         LEFT JOIN organizations o ON o.id = d.owner_id
         LEFT JOIN users co ON co.id = d.owner_id
        WHERE d.handle = ANY($1::text[])`,
      [handles],
    );
    const byHandle = new Map(r.rows.map((row) => [row.handle, row]));
    return handles.flatMap((handle) => {
      const row = byHandle.get(handle);
      return row
        ? [
            {
              id: row.id,
              handle: row.handle,
              label: qualifiedDocoLabel({ ownerSlug: row.owner_slug, handle: row.handle }),
            },
          ]
        : [];
    });
  });
}

async function resolveOrgAttachments(handles: string[]): Promise<OrgAttachmentInfo[]> {
  if (handles.length === 0) return [];
  return await withClient(async (c) => {
    const r = await c.query<{ handle: string; name: string | null }>(
      "SELECT handle, name FROM organizations WHERE handle = ANY($1::text[])",
      [handles],
    );
    const byHandle = new Map(r.rows.map((row) => [row.handle, row.name]));
    return handles.map((h) => ({ handle: h, name: byHandle.get(h) ?? null }));
  });
}

/**
 * Load a snapshot for a specific thread or the user's active thread.
 *
 * - `conversationId` omitted: most-recent non-archived thread, or a
 *   fresh empty one when the user has never chatted. This matches the
 *   pre-multi-thread behavior and is what the sidebar uses on first
 *   open.
 * - `conversationId` provided: that thread, scoped to the calling
 *   principal. Returns `null` when the id doesn't exist or belongs
 *   to a different user — callers should 404 in that case.
 */
export async function loadSnapshotForPrincipal(
  principalId: string,
  opts: { before?: Date | null; conversationId?: string | null } = {},
): Promise<ConversationSnapshot | null> {
  let conv: ChatConversationRow | null;
  if (opts.conversationId) {
    conv = await loadConversationByIdForPrincipal(opts.conversationId, principalId);
    if (!conv) return null;
  } else {
    conv = await loadOrCreateConversation(principalId);
  }
  const [{ messages: rows, hasMore }, events, attachedDocos, attachedOrgs] = await Promise.all([
    loadMessagesPage(conv.id, {
      before: opts.before ?? null,
      limit: CHAT_MESSAGES_PAGE_SIZE,
    }),
    loadActiveTurnEvents(conv.id),
    resolveDocoAttachments(conv.attached_doco_ids ?? [], conv.attached_doco_handles ?? []),
    resolveOrgAttachments(conv.attached_org_handles ?? []),
  ]);
  return {
    conversation_id: conv.id,
    title: conv.title,
    archived: conv.archived,
    attached_docos: attachedDocos,
    attached_orgs: attachedOrgs,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at.toISOString(),
    })),
    has_more: hasMore,
    active_turn_started_at: conv.active_turn_started_at?.toISOString() ?? null,
    active_turn_events: events,
  };
}

async function loadActiveTurnEvents(
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  return await withClient(async (c) => {
    const r = await c.query<{ events: Array<Record<string, unknown>> | null }>(
      "SELECT active_turn_events AS events FROM chat_conversations WHERE id = $1",
      [conversationId],
    );
    const events = r.rows[0]?.events;
    return Array.isArray(events) ? events : [];
  });
}
