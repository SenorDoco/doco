// AgentSidebar — 320px fixed left rail, persistent across SPA navigation.
//
// Mounted from app/root.tsx so its React state outlives the <Outlet/>
// swaps that happen on client-side route changes. Loads the current
// rolling conversation on mount, streams new turns via SSE, and
// re-uses React Router's useNavigate() to follow `navigate` tool
// events from the agent.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { cn } from "~/lib/cn";
import { type GraphReferenceGroup, readGraphReferenceGroups } from "~/lib/graph-references";
import {
  CREATED_DOCO_CHAT_ID_SEARCH_PARAM,
  readCreatedDocoChatIdSearchParams,
} from "~/lib/post-create-doco-route";
import type { CurrentPrincipal } from "~/lib/session.server";

interface ContentBlockText {
  type: "text";
  text: string;
}
interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
interface ContentBlockAttachmentRef {
  type: "attachment_ref";
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}
type AnyBlock =
  | ContentBlockText
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockAttachmentRef;

interface StagedAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface QueuedSend {
  text: string;
  staged: StagedAttachment[];
}

interface UploadAcceptedMeta {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

const ATTACHMENT_RETENTION_NOTICE = "Attachments are stored for 30 days, then deleted.";
const ATTACHMENT_ACCEPT =
  // The trailing extension hints (.md, .bpmn, .xml) cover formats
  // browsers don't have a built-in MIME type for. The server
  // normalizes octet-stream uploads with these extensions to
  // application/xml so the upload survives the MIME allowlist.
  "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/xml,application/xml,.md,.bpmn,.xml";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: AnyBlock[];
  created_at: string;
}

interface DocoAttachmentInfo {
  id?: string;
  handle: string;
  label?: string;
}

interface OrgAttachmentInfo {
  handle: string;
  name: string | null;
}

interface ConversationSnapshot {
  conversation_id: string;
  /** User-visible thread name. Null until the first user message lands. */
  title: string | null;
  archived: boolean;
  attached_docos: DocoAttachmentInfo[];
  attached_orgs: OrgAttachmentInfo[];
  messages: ChatMessage[];
  has_more: boolean;
  /**
   * ISO timestamp the server set when the current turn started; null
   * when idle. Lets a freshly-loaded page show the in-flight bubble
   * for a turn its tab didn't initiate.
   */
  active_turn_started_at: string | null;
  /**
   * Replay buffer for the in-flight turn's thinking events. Each
   * entry is the SSE event the server yielded plus an `at_ms` offset.
   * Empty when no turn is active or no events have been persisted
   * yet. Lets a fresh tab hydrate the Thinking column for a turn
   * already in progress.
   */
  active_turn_events?: Array<Record<string, unknown>>;
}

/** Row in the thread-list. Matches the server's ConversationListItem. */
interface ConversationListItem {
  id: string;
  title: string | null;
  archived: boolean;
  message_count: number;
  updated_at: string;
  active_turn_started_at: string | null;
  last_message_preview: string | null;
  last_message_role: "user" | "assistant" | null;
  attached_doco_ids: string[];
  /** Legacy/display fallback; navigation uses attached_doco_ids. */
  attached_doco_handles: string[];
  attached_org_handles: string[];
}

/** Per-request token totals streamed from the server. Reset to null
 *  whenever Señor Doco settles (no in-flight + no remote in-flight). */
interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

type ConversationStatusKind = "working" | "question" | "complete" | "attention" | "idle";

interface ConversationStatus {
  kind: ConversationStatusKind;
  label: string;
}

// If the server's `active_turn_started_at` is older than this, treat
// it as stale (lambda probably crashed before clearing the marker)
// and ignore it rather than showing a never-ending placeholder.
const ACTIVE_TURN_STALE_MS = 5 * 60 * 1000;

// "In-flight" assistant message being assembled from a stream.
interface InFlightMessage {
  content: AnyBlock[];
  toolResults: Map<string, ContentBlockToolResult>;
  created_at: string;
}

const COLLAPSE_KEY = "senor-doco:collapsed";
const UNREAD_KEY = "senor-doco:unread";
const SHOW_THINKING_KEY = "senor-doco:show-thinking";
const THINKING_BOTTOM_STICKY_THRESHOLD_PX = 24;
// Pending-send recovery key. send() stashes the user's text here
// synchronously before the fetch. If the tab dies before the SSE
// confirms persistence, a mount-time effect replays it.
const PENDING_SEND_KEY = "senor-doco:pending-send";
const PENDING_SEND_MAX_AGE_MS = 60_000;
// Last opened thread id. Persisted so a refresh keeps the user in the
// same thread instead of bouncing back to "most-recent".
const ACTIVE_CONV_KEY = "senor-doco:active-conversation";
// Per-thread last-seen message_count. Used to drive the unread badge —
// when the list endpoint reports message_count > last-seen we know new
// messages landed since the user last viewed that thread. Best-effort:
// localStorage is per-browser, and there's no server-side tracking,
// so the badge clears the next time the user opens the thread.
const LAST_SEEN_PREFIX = "senor-doco:last-seen:";

// Sidebar widths. Collapsed → 32px rail. Default expanded → 320px
// (chat only). When the user toggles "Show thinking" in the header,
// the Thinking panel doubles the sidebar to 640px.
const RAIL_COLLAPSED = "32px";
const RAIL_DEFAULT = "320px";
const RAIL_THINKING = "640px";

/** One chronological entry in the per-turn thinking log. Populated as
 *  SSE events arrive; cleared at the start of every new send. */
type ThinkingEvent =
  | { id: string; at_ms: number; kind: "tool_start"; tool_id: string; name: string }
  | { id: string; at_ms: number; kind: "tool_input"; tool_id: string; input: unknown }
  | {
      id: string;
      at_ms: number;
      kind: "tool_result";
      tool_id: string;
      preview: string;
      ok: boolean;
    }
  | { id: string; at_ms: number; kind: "text"; text: string }
  | {
      id: string;
      at_ms: number;
      kind: "usage";
      input_tokens: number;
      output_tokens: number;
    }
  | { id: string; at_ms: number; kind: "navigate"; url: string }
  | { id: string; at_ms: number; kind: "error"; message: string }
  | { id: string; at_ms: number; kind: "status"; phase: string; detail?: string };
// Broadcast channel name shared across tabs in the same browser
// origin. Same session → same conversation, so any change in one tab
// pings the others to reload.
const SYNC_CHANNEL = "doco:senor-doco-sync";

type SyncMessage = { kind: "changed" } | { kind: "remote-inflight"; busy: boolean };

/**
 * Convert a server-persisted thinking event (the raw SSE event +
 * `at_ms`) into the ThinkingEvent shape the panel renders. Returns
 * null for events the panel doesn't display (e.g. `message_saved`,
 * `done`, `tool_use_input` is already covered by `tool_input`).
 */
function storedEventToThinkingEvent(raw: Record<string, unknown>): ThinkingEvent | null {
  const at_ms = typeof raw.at_ms === "number" ? raw.at_ms : 0;
  const id = `t_${at_ms}_${(raw.kind as string | undefined) ?? "x"}_${Math.random().toString(36).slice(2, 7)}`;
  switch (raw.kind) {
    case "text_delta":
      return typeof raw.text === "string" ? { id, at_ms, kind: "text", text: raw.text } : null;
    case "tool_use_start":
      return typeof raw.tool_use_id === "string" && typeof raw.name === "string"
        ? { id, at_ms, kind: "tool_start", tool_id: raw.tool_use_id, name: raw.name }
        : null;
    case "tool_use_input":
      return typeof raw.tool_use_id === "string"
        ? { id, at_ms, kind: "tool_input", tool_id: raw.tool_use_id, input: raw.input ?? null }
        : null;
    case "tool_use_result":
      return typeof raw.tool_use_id === "string"
        ? {
            id,
            at_ms,
            kind: "tool_result",
            tool_id: raw.tool_use_id,
            preview: typeof raw.preview === "string" ? raw.preview : "",
            ok: raw.ok === true,
          }
        : null;
    case "navigate":
      return typeof raw.url === "string" ? { id, at_ms, kind: "navigate", url: raw.url } : null;
    case "error":
      return typeof raw.message === "string"
        ? { id, at_ms, kind: "error", message: raw.message }
        : null;
    case "usage_update":
      return typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number"
        ? {
            id,
            at_ms,
            kind: "usage",
            input_tokens: raw.input_tokens,
            output_tokens: raw.output_tokens,
          }
        : null;
    case "status":
      return typeof raw.phase === "string"
        ? {
            id,
            at_ms,
            kind: "status",
            phase: raw.phase,
            ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
          }
        : null;
    default:
      return null;
  }
}

function readBoolFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeBoolFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // localStorage blocked (private mode, etc.) — silently degrade
  }
}
function readStringFlag(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStringFlag(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // localStorage blocked (private mode, etc.) — silently degrade
  }
}

function readCreatedDocoChatIdFromLocationSearch(search: string): string | null {
  return readCreatedDocoChatIdSearchParams(new URLSearchParams(search));
}

function readInitialConversationId(): string | null {
  if (typeof window === "undefined") return readStringFlag(ACTIVE_CONV_KEY);
  return (
    readCreatedDocoChatIdFromLocationSearch(window.location.search) ??
    readStringFlag(ACTIVE_CONV_KEY)
  );
}

function removeCreatedDocoChatIdFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CREATED_DOCO_CHAT_ID_SEARCH_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/**
 * Display name for a thread. Server returns null until the first user
 * message is sent (and even then, attachment-only messages leave it
 * null), so the client always has a fallback.
 */
function displayThreadTitle(title: string | null | undefined): string {
  return title?.trim() ? title : "New chat";
}

function readLastSeen(convId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_PREFIX + convId);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(convId: string, count: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SEEN_PREFIX + convId, String(count));
  } catch {
    // localStorage blocked — silently degrade
  }
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Map a plural API segment to the kind slug used in the policies
// edit URL (`/<handle>/policies/<kind>/<id>/edit`). Returns null
// when the plural isn't a policy.
function pluralToPolicyKindSlug(plural: string): string | null {
  if (plural === "guidance_policies") return "guidance";
  if (plural === "neuron_authoring_policies") return "neuron-authoring";
  return null;
}

// Resolve the URL kind slug from a doco_api POST body for the shared
// `/<handle>/api/policies.json` create endpoint. The body's
// `policy_kind` field is either "guidance" or "neuron_authoring";
// translate to the slug the policy edit route expects.
function bodyToPolicyKindSlug(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const k = (body as { policy_kind?: unknown }).policy_kind;
  if (k === "guidance") return "guidance";
  if (k === "neuron_authoring") return "neuron-authoring";
  return null;
}

type PendingCreate =
  | { kind: "neuron"; handle: string; entityType: string }
  | { kind: "policy"; handle: string; policyKindSlug: string };

// Below this viewport width, the neuron detail dialog overlays the
// whole content area and there's no room for both the chat and the
// dialog to coexist comfortably. When the agent drives the focus
// (vs. an explicit user click), we still center the graph on the
// neuron but suppress the dialog by appending `?dialog=skip`. The
// route loader reads the param and leaves `selectedNeuron` null.
const AUTO_FOCUS_DIALOG_MIN_WIDTH = 1280;

function withDialogSkipIfCramped(target: string): string {
  if (typeof window === "undefined") return target;
  if (window.innerWidth >= AUTO_FOCUS_DIALOG_MIN_WIDTH) return target;
  return target.includes("?") ? `${target}&dialog=skip` : `${target}?dialog=skip`;
}

export function AgentSidebar({ me }: { me: CurrentPrincipal }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inFlight, setInFlight] = useState<InFlightMessage | null>(null);
  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  // Multi-thread state. `conversationId` is the active thread (null
  // until the snapshot first responds, then sticky across refreshes
  // via localStorage). `conversationTitle` mirrors what the server has
  // — null = "New chat" placeholder. `view` toggles the sidebar
  // between the chat column and the thread list. `conversations` is
  // the dropdown contents; loaded on demand when the user opens the
  // list and refreshed when threads change.
  const [conversationId, setConversationId] = useState<string | null>(() =>
    readInitialConversationId(),
  );
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  // Resolved {handle, name} for the Docos/Orgs the agent has touched
  // in this thread. Rendered as clickable chips below the thread
  // title in chat view. Populated from the snapshot endpoint each
  // reload; the server-side auto-attach happens in runTool.
  const [attachedDocos, setAttachedDocos] = useState<DocoAttachmentInfo[]>([]);
  const [attachedOrgs, setAttachedOrgs] = useState<OrgAttachmentInfo[]>([]);
  // WhatsApp-style default — when nothing's open, the user lands on
  // the thread list. Picking a thread switches into chat view; the
  // back button in the chat header returns here.
  //
  // If the sticky `ACTIVE_CONV_KEY` is already in localStorage (the
  // user was last in a thread), default to chat view so navigation
  // or remounts don't bounce them back to the list. The list is the
  // "nothing open" fallback, not the home page.
  const [view, setView] = useState<"chat" | "list">(() =>
    readInitialConversationId() ? "chat" : "list",
  );
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  // Free-text filter applied to the thread list (title + last-message
  // preview, case-insensitive). Lives in component state, not URL or
  // localStorage — closing/reopening the sidebar resets it.
  const [searchQuery, setSearchQuery] = useState("");
  // Inline rename state — keyed by conversation id. When non-null,
  // the row in the list shows an input instead of the title.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  // Another tab on this origin is currently streaming a reply. Used
  // to show a "Señor Doco is replying…" placeholder bubble in tabs
  // that didn't initiate the send.
  const [remoteInflight, setRemoteInflight] = useState(false);
  // Per-request token usage for the in-flight turn. Updated as the
  // server streams usage_update events; cleared on settle. Shown next
  // to the in-flight bubble so the user sees what THIS request is
  // costing in real time (not the session-wide total).
  const [turnUsage, setTurnUsage] = useState<TurnUsage | null>(null);
  // Queued sends. When the user hits Send while Señor Doco is
  // mid-reply, the typed text + staged attachments land here and
  // auto-fire one at a time as turns settle. Lets the user keep
  // typing without losing messages; respects the Anthropic
  // user→assistant→user alternation by not racing a second turn.
  const [queuedSends, setQueuedSends] = useState<QueuedSend[]>([]);
  // Lazy initializers so SSR doesn't touch localStorage; the first
  // client render hydrates from the stored value.
  const [collapsed, setCollapsed] = useState<boolean>(() => readBoolFlag(COLLAPSE_KEY));
  const [unread, setUnread] = useState<boolean>(() => readBoolFlag(UNREAD_KEY));
  // Show Thinking toggle: when on, the sidebar widens from 320 to
  // 640px and a "Thinking" column appears next to the chat showing
  // the real-time event log of the current/last turn.
  const [showThinking, setShowThinking] = useState<boolean>(() => readBoolFlag(SHOW_THINKING_KEY));
  // Per-turn chronological log of every SSE event. Reset at the
  // start of each send; retained between turns so the user can
  // review the last completed turn without re-running it.
  const [thinkingEvents, setThinkingEvents] = useState<ThinkingEvent[]>([]);
  // Wall-clock anchor for at_ms timestamps on thinkingEvents — set
  // when a turn starts; reads as `performance.now() - turnStartRef`.
  const turnStartRef = useRef<number>(0);
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);
  // Publish the rail's current width as a CSS variable so floating
  // overlays (the neuron-detail dialog, etc.) can avoid covering it on
  // small screens. Three widths now: collapsed (32), default
  // expanded (320), and Show-Thinking expanded (640). Thinking is a
  // chat-only feature so the rail narrows back to 320 whenever the
  // user is in the list view, even if the toggle is on; flipping
  // back to a chat restores the wider rail without the user having
  // to toggle anything.
  const thinkingActive = showThinking && view === "chat";
  const railWidth = collapsed ? RAIL_COLLAPSED : thinkingActive ? RAIL_THINKING : RAIL_DEFAULT;
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--senor-doco-rail-width", railWidth);
  }, [railWidth]);

  const toggleShowThinking = useCallback(() => {
    setShowThinking((prev) => {
      const next = !prev;
      writeBoolFlag(SHOW_THINKING_KEY, next);
      return next;
    });
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setCollapsedPersistent = useCallback((next: boolean) => {
    setCollapsed(next);
    writeBoolFlag(COLLAPSE_KEY, next);
    if (!next) {
      // Expanding clears unread.
      setUnread(false);
      writeBoolFlag(UNREAD_KEY, false);
    }
  }, []);
  const markUnread = useCallback(() => {
    setUnread(true);
    writeBoolFlag(UNREAD_KEY, true);
  }, []);
  // Cross-tab sync — BroadcastChannel posts a message to every other
  // tab on this origin (the sender doesn't receive its own posts).
  // Same browser session → same conversation, so any change in one tab
  // pings the others to re-fetch.
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const broadcastSync = useCallback((msg: SyncMessage) => {
    const ch = syncChannelRef.current;
    if (!ch) return;
    try {
      ch.postMessage(msg);
    } catch {
      // BroadcastChannel can throw if the page is unloading — safe to ignore.
    }
  }, []);
  // `conversationId === null` normally means "load the most recent
  // thread". When the user archives the active thread, though, it means
  // "nothing is open"; skip exactly one default bootstrap so archiving
  // doesn't immediately open the next row in the list.
  const skipNextDefaultBootstrapRef = useRef(false);
  // Tracks the earliest loaded message so concurrent state reads (the
  // scroll handler closes over stale `messages`) always page from the
  // true top of the loaded window.
  const earliestRef = useRef<ChatMessage | null>(null);

  // Mirror of `inputText.trim().length > 0`, kept in a ref so callbacks
  // that read it don't have to depend on (and re-bind every keystroke
  // on) the `inputText` state. Used by `maybeFollowToolToNeuron` to
  // skip auto-focus while the user has unsent text in the composer.
  const composerHasTextRef = useRef(false);
  useEffect(() => {
    composerHasTextRef.current = inputText.trim().length > 0;
  }, [inputText]);

  const reload = useCallback(async () => {
    if (!conversationId && skipNextDefaultBootstrapRef.current) {
      skipNextDefaultBootstrapRef.current = false;
      setBootstrapped(true);
      setLoadError(null);
      setRemoteInflight(false);
      setThinkingEvents([]);
      return;
    }
    try {
      const url = conversationId
        ? `/api/v1/agent-chat/conversation.json?id=${encodeURIComponent(conversationId)}`
        : "/api/v1/agent-chat/conversation.json";
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.status === 404 && conversationId) {
        // The stored thread id no longer exists (archived elsewhere,
        // or a different user signed in on the same device). Drop
        // the stored id and re-bootstrap with the active thread.
        setConversationId(null);
        writeStringFlag(ACTIVE_CONV_KEY, null);
        setMessages([]);
        setLoadError(null);
        return;
      }
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ConversationSnapshot;
      // Sticky thread id: snapshot fetched with no `?id=` lands the
      // user in their most-recent thread; pin that id so subsequent
      // reloads (cross-tab sync, polling) stay on the same one even
      // if another tab opens a newer thread.
      if (data.conversation_id !== conversationId) {
        setConversationId(data.conversation_id);
        writeStringFlag(ACTIVE_CONV_KEY, data.conversation_id);
      }
      setConversationTitle(data.title);
      setAttachedDocos(Array.isArray(data.attached_docos) ? data.attached_docos : []);
      setAttachedOrgs(Array.isArray(data.attached_orgs) ? data.attached_orgs : []);
      // Merge — don't overwrite. Two classes of message can sit
      // outside the snapshot's window:
      //
      //   1. OLDER pages the user pulled in via `loadOlder` (scroll
      //      up). Naive setMessages(data.messages) wiped these on
      //      every poll → older messages flickered out.
      //   2. NEWER local-only messages (id prefixed `local_`) that
      //      the optimistic-send path appended but the server hasn't
      //      persisted yet. Naive setMessages also wiped these →
      //      you'd hit Send, the composer would clear, and your
      //      bubble would vanish for ~1.5s until reload re-ran.
      //
      // Preserve both ends; only the middle (snapshot window) is
      // authoritative on reload.
      setMessages((prev) => {
        const fresh = data.messages;
        if (fresh.length === 0) return prev;
        const freshIds = new Set(fresh.map((m) => m.id));
        const freshLocalTwinKeys = new Set(fresh.map(messageLocalTwinKey));
        const freshOldest = fresh[0].created_at;
        const freshNewest = fresh[fresh.length - 1].created_at;
        const olderRetained: typeof prev = [];
        const newerRetained: typeof prev = [];
        for (const m of prev) {
          if (freshIds.has(m.id)) continue;
          if (m.id.startsWith("local_") && freshLocalTwinKeys.has(messageLocalTwinKey(m))) {
            continue;
          }
          if (m.created_at < freshOldest) olderRetained.push(m);
          else if (m.created_at > freshNewest) newerRetained.push(m);
          // Else: in the snapshot window but missing from fresh →
          // server doesn't think it exists, drop it (covers
          // local-only optimistic messages whose server-persisted
          // twin has now arrived in `fresh` under a different id but
          // with a created_at inside the window — the snapshot's
          // version of truth wins for that timeframe).
        }
        return [...olderRetained, ...fresh, ...newerRetained];
      });
      // `hasMore` reflects whether the SERVER has older pages beyond
      // what's currently loaded. The snapshot's `has_more` only
      // describes its own window, so trust it AND preserve any older-
      // page knowledge.
      setHasMore((prev) => prev || data.has_more);
      // earliestRef anchors the next `loadOlder` cursor. Use the
      // earliest message we now hold (either retained or fresh).
      const earliest = data.messages[0] ?? null;
      if (
        earliest &&
        (!earliestRef.current || earliest.created_at < earliestRef.current.created_at)
      ) {
        earliestRef.current = earliest;
      }
      setLoadError(null);
      // Replay the server-persisted thinking events so a freshly
      // loaded tab fills the Thinking column with the current or most
      // recent turn, instead of losing the timeline on refresh. Only
      // set when the local tab isn't already streaming — its own
      // client-side events are richer than the server log.
      if (!busy && Array.isArray(data.active_turn_events)) {
        const hydrated = data.active_turn_events
          .map((raw) => storedEventToThinkingEvent(raw))
          .filter((ev): ev is ThinkingEvent => ev !== null);
        setThinkingEvents(hydrated);
      }
      // Server-side in-flight marker: a freshly-loaded page (e.g.
      // after refresh) should show the "Señor Doco is replying…"
      // placeholder if a turn is actually running on the server.
      // Stale markers (lambda crashed before clearing) are filtered
      // out by the freshness check.
      if (data.active_turn_started_at) {
        const startedMs = Date.parse(data.active_turn_started_at);
        if (Number.isFinite(startedMs) && Date.now() - startedMs < ACTIVE_TURN_STALE_MS) {
          setRemoteInflight(true);
        } else {
          setRemoteInflight(false);
        }
      } else {
        // Turn has settled server-side — clear the placeholder. This
        // is what closes the loop after the resume-poll detects
        // completion.
        setRemoteInflight(false);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootstrapped(true);
    }
  }, [busy, conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Abort any in-flight send when the sidebar unmounts. This used
  // to live as the cleanup on the `[reload]` effect — but `reload`'s
  // identity changes whenever `busy` flips, and `send()` stashes
  // its AbortController in `abortRef.current` BEFORE React commits
  // the busy→true render. The cleanup fires synchronously after
  // commit and aborted the live send's controller, so the user saw
  // their message disappear, no in-flight bubble, and "Señor Doco
  // is silently working" while keepalive: true let the server
  // finish anyway. Splitting the abort into a mount-only effect
  // keeps the unmount-cleanup intent without nuking active sends.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const loadConversationsList = useCallback(async () => {
    setConversationsLoading(true);
    setConversationsError(null);
    try {
      const res = await fetch("/api/v1/agent-chat/conversations.json", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setConversationsError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { conversations: ConversationListItem[] };
      setConversations(Array.isArray(data.conversations) ? data.conversations : []);
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : String(err));
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
    const createdChatId = readCreatedDocoChatIdFromLocationSearch(location.search);
    if (!createdChatId) return;

    setCollapsed(false);
    writeBoolFlag(COLLAPSE_KEY, false);
    setUnread(false);
    writeBoolFlag(UNREAD_KEY, false);
    setView("chat");
    setRenamingId(null);

    if (createdChatId !== conversationId) {
      abortRef.current?.abort();
      setBusy(false);
      setInFlight(null);
      setQueuedSends([]);
      setTurnUsage(null);
      setRemoteInflight(false);
      setThinkingEvents([]);
      setMessages([]);
      setAttachedDocos([]);
      setAttachedOrgs([]);
      setHasMore(false);
      earliestRef.current = null;
      setConversationId(createdChatId);
      writeStringFlag(ACTIVE_CONV_KEY, createdChatId);
    } else {
      writeStringFlag(ACTIVE_CONV_KEY, createdChatId);
    }

    void loadConversationsList();
    navigate(
      `${location.pathname}${removeCreatedDocoChatIdFromSearch(location.search)}${location.hash}`,
      {
        replace: true,
      },
    );
  }, [
    conversationId,
    loadConversationsList,
    location.hash,
    location.pathname,
    location.search,
    navigate,
  ]);

  const openThreadList = useCallback(() => {
    setView("list");
    setSearchQuery("");
    void loadConversationsList();
  }, [loadConversationsList]);

  // Initial list fetch + refetch on conversation change. The list is
  // the default view so we always want it populated on mount; we also
  // refetch when the active thread changes so its updated_at / last
  // message preview reflect the latest send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The stable loader must refetch when the active conversation changes.
  useEffect(() => {
    void loadConversationsList();
  }, [loadConversationsList, conversationId]);

  // Switch to a different thread. Wipes the in-memory message list +
  // thinking events; the next reload() picks up the new thread's
  // snapshot. Idempotent on no-op (same id) so the dropdown can be
  // dismissed cheaply.
  const switchThread = useCallback(
    (id: string) => {
      // Single-attachment shortcut. The user said: "If there is only
      // one, opening a thread should send the visitor to that page."
      // Look the thread up in our cached list and, if it has exactly
      // one attached entity (across docos + orgs), navigate directly
      // there instead of opening the chat column. The chat column
      // stays one click away — the thread title in the chat header
      // still toggles back to it, and the back arrow returns to the
      // thread list.
      const conv = conversations.find((c) => c.id === id);
      if (conv) {
        const docos = conv.attached_doco_ids ?? [];
        const orgs = conv.attached_org_handles ?? [];
        if (docos.length + orgs.length === 1) {
          const targetUrl =
            docos.length === 1 ? `/by-id/${encodeURIComponent(docos[0])}` : `/orgs/${orgs[0]}`;
          // Still mark this thread active so subsequent sends land
          // here; if the user's already on the URL we skip navigate.
          if (id !== conversationId) {
            abortRef.current?.abort();
            setBusy(false);
            setInFlight(null);
            setQueuedSends([]);
            setTurnUsage(null);
            setRemoteInflight(false);
            setThinkingEvents([]);
            setMessages([]);
            setHasMore(false);
            earliestRef.current = null;
            setConversationId(id);
            writeStringFlag(ACTIVE_CONV_KEY, id);
          }
          setView("chat");
          setRenamingId(null);
          if (location.pathname !== targetUrl) navigate(targetUrl);
          return;
        }
      }
      if (id === conversationId) {
        setView("chat");
        return;
      }
      // Cancel any in-flight stream on the old thread. The server-side
      // turn keeps going (keepalive: true on the fetch) so we won't
      // lose the reply; the user just won't see it in this column
      // until they switch back.
      abortRef.current?.abort();
      setBusy(false);
      setInFlight(null);
      setQueuedSends([]);
      setTurnUsage(null);
      setRemoteInflight(false);
      setThinkingEvents([]);
      setMessages([]);
      setAttachedDocos([]);
      setAttachedOrgs([]);
      setHasMore(false);
      earliestRef.current = null;
      setConversationId(id);
      writeStringFlag(ACTIVE_CONV_KEY, id);
      setView("chat");
      setRenamingId(null);
    },
    [conversationId, conversations, location.pathname, navigate],
  );

  const newThread = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/agent-chat/conversations.json", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setConversationsError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { conversation: ConversationListItem };
      if (data.conversation?.id) {
        switchThread(data.conversation.id);
      }
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : String(err));
    }
  }, [switchThread]);

  const renameThread = useCallback(
    async (id: string, nextTitle: string) => {
      const trimmed = nextTitle.trim().slice(0, 120);
      try {
        const res = await fetch(`/api/v1/agent-chat/conversation/${encodeURIComponent(id)}.json`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed || null }),
        });
        if (!res.ok) {
          setConversationsError(`HTTP ${res.status}`);
          return;
        }
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: trimmed || null } : c)),
        );
        if (id === conversationId) setConversationTitle(trimmed || null);
      } catch (err) {
        setConversationsError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId],
  );

  // Mutate the active thread's attachment lists via the PATCH route.
  // Optimistic update — apply the change locally, then issue the
  // request. On error we re-fetch the snapshot so the chips agree
  // with the server again.
  const attachAttachment = useCallback(
    async (kind: "doco" | "org", attachment: AvailableDoco | AvailableOrg) => {
      if (!conversationId || !attachment.handle) return;
      if (kind === "doco") {
        const optimistic = attachment as AvailableDoco;
        setAttachedDocos((prev) =>
          prev.some(
            (d) =>
              (optimistic.id ? d.id === optimistic.id : false) || d.handle === optimistic.handle,
          )
            ? prev
            : [
                ...prev,
                {
                  id: optimistic.id,
                  handle: optimistic.handle,
                  label: optimistic.qualified_handle ?? optimistic.handle,
                },
              ],
        );
      } else {
        const optimistic = attachment as AvailableOrg;
        setAttachedOrgs((prev) =>
          prev.some((o) => o.handle === attachment.handle) ? prev : [...prev, optimistic],
        );
      }
      try {
        const body =
          kind === "doco"
            ? "id" in attachment
              ? { attach_doco_id: attachment.id }
              : { attach_doco: attachment.handle }
            : { attach_org: attachment.handle };
        const res = await fetch(
          `/api/v1/agent-chat/conversation/${encodeURIComponent(conversationId)}.json`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Reload the snapshot so the chip picks up the resolved name.
        void reload();
        void loadConversationsList();
      } catch {
        // Snap state back to whatever the server says.
        void reload();
      }
    },
    [conversationId, reload, loadConversationsList],
  );

  const detachAttachment = useCallback(
    async (kind: "doco" | "org", attachment: DocoAttachmentInfo | OrgAttachmentInfo) => {
      if (!conversationId || !attachment.handle) return;
      if (kind === "doco") {
        const docoAttachment = attachment as DocoAttachmentInfo;
        setAttachedDocos((prev) =>
          prev.filter((d) =>
            docoAttachment.id ? d.id !== docoAttachment.id : d.handle !== docoAttachment.handle,
          ),
        );
      } else {
        setAttachedOrgs((prev) => prev.filter((o) => o.handle !== attachment.handle));
      }
      try {
        const body = (() => {
          if (kind === "doco") {
            const docoAttachment = attachment as DocoAttachmentInfo;
            return docoAttachment.id
              ? { detach_doco_id: docoAttachment.id }
              : { detach_doco: docoAttachment.handle };
          }
          return { detach_org: attachment.handle };
        })();
        const res = await fetch(
          `/api/v1/agent-chat/conversation/${encodeURIComponent(conversationId)}.json`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        void loadConversationsList();
      } catch {
        void reload();
      }
    },
    [conversationId, reload, loadConversationsList],
  );

  const archiveThread = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/v1/agent-chat/conversation/${encodeURIComponent(id)}.json`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        });
        if (!res.ok) {
          setConversationsError(`HTTP ${res.status}`);
          return;
        }
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (id === conversationId) {
          // We just archived the active thread. Drop the pin and leave
          // the user in the thread list with nothing open; the next
          // explicit selection or "New chat" creates the next active id.
          skipNextDefaultBootstrapRef.current = true;
          abortRef.current?.abort();
          setBusy(false);
          setInFlight(null);
          setQueuedSends([]);
          setTurnUsage(null);
          setRemoteInflight(false);
          setThinkingEvents([]);
          setConversationId(null);
          setConversationTitle(null);
          setAttachedDocos([]);
          setAttachedOrgs([]);
          setHasMore(false);
          earliestRef.current = null;
          writeStringFlag(ACTIVE_CONV_KEY, null);
          setMessages([]);
          setView("list");
        }
      } catch (err) {
        setConversationsError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId],
  );

  // Resume-after-refresh: when the snapshot says a turn is in flight
  // server-side but this tab isn't the one running the stream (no
  // local `busy`), poll the snapshot every 1.5s so the UI catches the
  // turn's eventual completion (or its message landing) without the
  // user having to manually reload. Stops as soon as the server
  // clears `active_turn_started_at` or the local tab takes over the
  // stream. Capped at the stale-turn cutoff so a permanently-stuck
  // marker doesn't poll forever (the stale-row cleanup will null it
  // out on the next poll anyway).
  useEffect(() => {
    if (!remoteInflight || busy) return;
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - startedAt > ACTIVE_TURN_STALE_MS) {
        window.clearInterval(id);
        return;
      }
      void reload();
    }, 1500);
    return () => window.clearInterval(id);
  }, [remoteInflight, busy, reload]);

  // Subscribe to cross-tab sync messages. SSR-guarded — BroadcastChannel
  // doesn't exist on the server, and older browsers without it just
  // skip the feature (the sidebar continues to work, just without
  // cross-tab updates).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(SYNC_CHANNEL);
    syncChannelRef.current = ch;
    ch.onmessage = (event) => {
      const msg = event.data as SyncMessage | undefined;
      if (!msg) return;
      if (msg.kind === "changed") {
        // Another tab saved / received a message. Re-fetch the
        // canonical conversation snapshot so this tab catches up.
        void reload();
        // Re-fetch implies the remote stream landed; clear any
        // lingering "Señor Doco is replying somewhere else" indicator.
        setRemoteInflight(false);
        // If this tab is collapsed, surface the new content via the
        // unread dot.
        if (collapsedRef.current) markUnread();
      } else if (msg.kind === "remote-inflight") {
        // Only show the placeholder when THIS tab isn't already
        // streaming locally; otherwise the local in-flight bubble
        // covers it.
        setRemoteInflight(msg.busy);
      }
    };
    return () => {
      ch.close();
      syncChannelRef.current = null;
    };
  }, [reload, markUnread]);

  // After the first hydration completes, jump straight to the bottom so
  // the user sees the most recent turn. Runs once, after `messages` has
  // been populated by `reload()` (the empty-deps variant fired before
  // the fetch resolved and scrolled an empty list).
  useEffect(() => {
    if (!bootstrapped) return;
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bootstrapped]);

  // Every time the sidebar transitions from collapsed → expanded the
  // chat column re-mounts and the user expects to land on the most
  // recent message instantly, not scrolled to the top of the loaded
  // window. useLayoutEffect runs after the chat column mounts but
  // before the browser paints, so the jump-to-bottom is invisible.
  useLayoutEffect(() => {
    if (collapsed) return;
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [collapsed]);

  const newestMessageId = messages[messages.length - 1]?.id ?? null;
  const autoScrollTrigger =
    newestMessageId || inFlight
      ? `${newestMessageId ?? "none"}:${inFlight?.content.length ?? 0}:${inFlight?.toolResults.size ?? 0}`
      : null;

  // Auto-scroll on new content.
  useEffect(() => {
    if (!autoScrollTrigger) return;
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScrollTrigger]);

  const loadOlder = useCallback(async () => {
    const earliest = earliestRef.current;
    if (!earliest) return;
    const el = messageListRef.current;
    if (!el) return;
    setLoadingOlder(true);
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;
    try {
      const params = new URLSearchParams({ before: earliest.created_at });
      if (conversationId) params.set("id", conversationId);
      const url = `/api/v1/agent-chat/conversation.json?${params.toString()}`;
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ConversationSnapshot;
      if (data.messages.length === 0) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.has_more);
      earliestRef.current = data.messages[0] ?? earliestRef.current;
      // Wait for the DOM to absorb the prepended rows, then restore the
      // viewport so the user stays anchored on the same message rather
      // than getting flung to the top by the height change.
      requestAnimationFrame(() => {
        const el2 = messageListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevScrollHeight;
        el2.scrollTop = prevScrollTop + delta;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId]);

  const onMessagesScroll = useCallback(() => {
    if (!hasMore || loadingOlder) return;
    const el = messageListRef.current;
    if (!el) return;
    if (el.scrollTop < 80) void loadOlder();
  }, [hasMore, loadingOlder, loadOlder]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const res = await fetch("/api/v1/agent-chat/attachments.json", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!res.ok) {
        setUploadError(`upload failed (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        accepted: UploadAcceptedMeta[];
        rejected: Array<{ filename: string; reason: string }>;
      };
      if (data.rejected.length > 0) {
        setUploadError(data.rejected.map((r) => `${r.filename}: ${r.reason}`).join("; "));
      }
      if (data.accepted.length > 0) {
        setStaged((prev) => [
          ...prev,
          ...data.accepted.map((a) => ({
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
          })),
        ]);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const removeStaged = useCallback((id: string) => {
    setStaged((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Append helper for the thinking event log. The id is monotonic
  // within the React closure for stable list keys; at_ms is relative
  // to turn start so the panel can render elapsed-time markers.
  const appendThinking = useCallback(
    (
      ev:
        | Omit<Extract<ThinkingEvent, { kind: "tool_start" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "tool_input" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "tool_result" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "text" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "usage" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "navigate" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "error" }>, "id" | "at_ms">
        | Omit<Extract<ThinkingEvent, { kind: "status" }>, "id" | "at_ms">,
    ) => {
      const at_ms = Math.round(performance.now() - turnStartRef.current);
      const id = `t_${at_ms}_${Math.random().toString(36).slice(2, 7)}`;
      setThinkingEvents((prev) => [...prev, { ...ev, id, at_ms } as ThinkingEvent]);
    },
    [],
  );

  // Auto-focus: when the agent makes a doco_api tool call targeting
  // a specific neuron (path matches /<handle>/api/<plural-type>/<id>.{json,txt}),
  // pull the user into that neuron's perspective view so they can
  // see what Señor Doco is doing in real time. No-op when the user
  // is already at the target URL — React Router would treat the
  // navigate as a no-op anyway, but skipping avoids touching history.
  //
  // Original guard checked `document.activeElement.tagName ===
  // "TEXTAREA"` to "skip mid-keystroke", but that fires for the much
  // more common case: the user just hit Send and is passively
  // waiting (their composer still has focus). The real intent was
  // "don't yank them while they have unsent text to type", so guard
  // on the composer's *content* instead — handed in via a ref so the
  // callback doesn't re-bind on every keystroke.
  //
  // Policies aren't neurons, but the agent edits them the same way:
  // PATCH /<handle>/api/{guidance,neuron_authoring}_policies/<id>.json.
  // They get a different target URL — the policy edit page —
  // instead of a perspective view.
  const maybeFollowToolToNeuron = useCallback(
    (toolName: string, input: unknown) => {
      if (toolName !== "doco_api") return;
      if (!input || typeof input !== "object") return;
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string" || !path.startsWith("/")) return;
      // /<handle>/api/<plural-type>/<id>.<ext>
      const m = /^\/([^/]+)\/api\/([^/]+)\/([^/.]+)\.(?:json|txt)$/.exec(path);
      if (!m) return;
      const [, handle, plural, id] = m;
      const policyKind = pluralToPolicyKindSlug(plural);
      let target: string;
      if (policyKind) {
        target = `/${handle}/policies/${policyKind}/${id}/edit`;
      } else {
        // Plurals are uniformly the entity-type + "s" across all
        // neuron tables shipped today (decisions, intents, actions,
        // logs, rules, evals, references, ideas, states, principals).
        const entityType = plural.replace(/s$/, "");
        if (entityType === "polic") return; // policies isn't a neuron
        target = `/${handle}/${entityType}/${id}`;
      }
      const currentPath = location.pathname;
      if (currentPath === target) return;
      // Don't interrupt active composition — but only when there's
      // actually something half-written. Empty composer = user is
      // waiting; navigate.
      if (composerHasTextRef.current) return;
      navigate(withDialogSkipIfCramped(target));
    },
    [navigate, location.pathname],
  );

  // POST-to-create flow doesn't have the id in the request path
  // (the path is /<handle>/api/<plural>.json — the id is generated
  // server-side and returned in the response body). So track which
  // in-flight tool_use_ids are creates, then on tool_use_result pull
  // the id out of the preview and navigate.
  //
  // Two shapes:
  //   - "neuron" creates go to /<handle>/<entity-type>/<id>
  //   - "policy" creates go to /<handle>/policies/<kind-slug>/<id>/edit.
  //     The plural endpoint is /<handle>/api/policies.json for both
  //     guidance and neuron-authoring policies; the kind is in the
  //     request body's `policy_kind` field, which we capture at
  //     note-create time.
  const pendingCreatesRef = useRef<Map<string, PendingCreate>>(new Map());

  const maybeNoteCreate = useCallback((toolUseId: string, toolName: string, input: unknown) => {
    if (toolName !== "doco_api") return;
    if (!input || typeof input !== "object") return;
    const inp = input as { path?: unknown; method?: unknown; body?: unknown };
    if (typeof inp.path !== "string") return;
    const method = typeof inp.method === "string" ? inp.method.toUpperCase() : "GET";
    if (method !== "POST") return;
    // /<handle>/api/<plural>.<ext> — no id segment.
    const m = /^\/([^/]+)\/api\/([^/]+)\.(?:json|txt)$/.exec(inp.path);
    if (!m) return;
    const [, handle, plural] = m;
    if (plural === "policies") {
      // Policy create — kind comes from the request body, not the path.
      const policyKindSlug = bodyToPolicyKindSlug(inp.body);
      if (!policyKindSlug) return;
      pendingCreatesRef.current.set(toolUseId, {
        kind: "policy",
        handle,
        policyKindSlug,
      });
      return;
    }
    const entityType = plural.replace(/s$/, "");
    if (entityType === "polic") return;
    pendingCreatesRef.current.set(toolUseId, { kind: "neuron", handle, entityType });
  }, []);

  const maybeFollowCreateResult = useCallback(
    (toolUseId: string, ok: boolean, preview: string) => {
      const pending = pendingCreatesRef.current.get(toolUseId);
      if (!pending) return;
      pendingCreatesRef.current.delete(toolUseId);
      if (!ok) return;
      // Response shape varies (capture endpoints return { id, … },
      // create endpoints return { id, handle, … }, etc.) but every
      // one of them includes a top-level `id`. Try JSON parse first;
      // fall back to a regex when the preview is truncated past the
      // closing brace.
      let id: string | null = null;
      try {
        const parsed = JSON.parse(preview);
        if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
          id = parsed.id;
        }
      } catch {
        const m = /"id"\s*:\s*"([^"]+)"/.exec(preview);
        if (m) id = m[1];
      }
      if (!id) return;
      const target =
        pending.kind === "policy"
          ? `/${pending.handle}/policies/${pending.policyKindSlug}/${id}/edit`
          : `/${pending.handle}/${pending.entityType}/${id}`;
      if (location.pathname === target) return;
      if (composerHasTextRef.current) return;
      navigate(withDialogSkipIfCramped(target));
    },
    [navigate, location.pathname],
  );

  const send = useCallback(
    async (override?: { text: string; staged: StagedAttachment[] }) => {
      const text = (override?.text ?? inputText).trim();
      const sentAttachments = override?.staged ?? staged;
      const attachmentIds = sentAttachments.map((a) => a.id);
      const graphReferenceGroups: GraphReferenceGroup[] = readGraphReferenceGroups();
      if (!text && attachmentIds.length === 0) return;
      // While Señor Doco is mid-reply, the Anthropic API can't accept
      // another user message in the same conversation (the wire
      // protocol requires user→assistant→user alternation, and the
      // server-side runAssistantTurn mutates the message list as it
      // goes). Rather than dropping the user's submit on the floor,
      // stash it; the queue-drain effect auto-fires it once the
      // current turn settles. `override` is set by that drain — we
      // skip the re-queue path so the auto-fire doesn't loop.
      if ((busy || remoteInflight) && !override) {
        setQueuedSends((prev) => [...prev, { text, staged: sentAttachments }]);
        setInputText("");
        setStaged([]);
        return;
      }
      // Crash-safe pending-send. Write to localStorage SYNCHRONOUSLY
      // before any await. If the tab dies (reload, network drop)
      // before the SSE response confirms persistence, the recovery
      // effect below replays this on next mount. Successful sends
      // get this key cleared by the `message_saved` SSE event. Merely
      // queued messages skip this until they become the active send.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            PENDING_SEND_KEY,
            JSON.stringify({ text, queued_at: Date.now() }),
          );
        } catch {
          // localStorage may be blocked; lose the recovery guard but
          // not the send itself.
        }
      }
      if (!override) {
        setInputText("");
        setStaged([]);
      }
      setUploadError(null);
      setBusy(true);
      // Reset the thinking log so the panel reflects only the current
      // turn. The last turn's events have already been retained long
      // enough for the user to review them after settle.
      turnStartRef.current = performance.now();
      setThinkingEvents([]);
      // Tell other tabs that Señor Doco is busy — they'll show a
      // "replying somewhere else" placeholder until our stream ends.
      broadcastSync({ kind: "remote-inflight", busy: true });

      // Local accumulator — sole source of truth for what to commit at end
      // of stream. React state lags async updates, so we can't read it from
      // inside `finally`. We mirror every update into this object AND into
      // React state, then commit `local*` once `done` fires.
      const localContent: AnyBlock[] = [];
      const localResults = new Map<string, ContentBlockToolResult>();
      const assistantStartedAt = new Date().toISOString();
      setInFlight({
        content: localContent,
        toolResults: localResults,
        created_at: assistantStartedAt,
      });

      const localUserBlocks: AnyBlock[] = [];
      if (text) localUserBlocks.push({ type: "text", text });
      for (const a of sentAttachments) {
        localUserBlocks.push({
          type: "attachment_ref",
          attachment_id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
        });
      }
      const localUser: ChatMessage = {
        id: `local_${Date.now()}`,
        role: "user",
        content: localUserBlocks,
        created_at: new Date().toISOString(),
      };
      let optimisticUserMessageId = localUser.id;
      let persistedUserMessageId: string | null = null;
      let persistedAssistantMessageId: string | null = null;
      setMessages((prev) => [...prev, localUser]);
      // Optimistically backfill the thread title from the first user
      // message so the header flips from "New chat" → "Hello…" the
      // instant the user hits Send. The server runs the same
      // derivation, so the next reload() agrees with what we just
      // showed. Don't clobber an existing title (rename survives).
      if (!conversationTitle && text) {
        const derived = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
        const display = derived.length > 60 ? `${derived.slice(0, 57)}…` : derived;
        setConversationTitle(display);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const bumpInFlight = () =>
        setInFlight({
          content: [...localContent],
          toolResults: new Map(localResults),
          created_at: assistantStartedAt,
        });

      try {
        const res = await fetch("/api/v1/agent-chat/messages.json", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            current_path: location.pathname + location.search,
            attachment_ids: attachmentIds,
            graph_references: graphReferenceGroups,
            ...(conversationId ? { conversation_id: conversationId } : {}),
          }),
          signal: controller.signal,
          // keepalive: the request must survive a tab close / hard
          // refresh fired BEFORE the network round-trip completes.
          // Without this the user sees their optimistic bubble for
          // a millisecond, hits Cmd+R, and the POST never leaves the
          // network stack — which means the user's message never
          // reaches `runAssistantTurn` and the localStorage replay
          // path is the only recovery. With keepalive the request
          // continues server-side independently of the tab; the
          // user message gets persisted via PR #277's
          // persist-first flow even if the page unloads mid-stream.
          // Body size limit (~64KB) is way above the size of a
          // realistic user message + current_path + attachment_ids.
          keepalive: true,
        });
        if (!res.ok || !res.body) {
          const errBody = await res.text().catch(() => "");
          localContent.push({
            type: "text",
            text: `[error] HTTP ${res.status}: ${errBody || "(no body)"}`,
          });
          bumpInFlight();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        streamLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Parse SSE frames: separated by \n\n, each frame is `data: <json>`.
          for (;;) {
            const nlIdx = buf.indexOf("\n\n");
            if (nlIdx < 0) break;
            const frame = buf.slice(0, nlIdx);
            buf = buf.slice(nlIdx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const json = line.slice(6);
            let event: StreamEvent;
            try {
              event = JSON.parse(json) as StreamEvent;
            } catch {
              continue;
            }
            if (event.kind === "text_delta") {
              const last = localContent[localContent.length - 1];
              if (last && last.type === "text") {
                last.text += event.text;
              } else {
                localContent.push({ type: "text", text: event.text });
              }
              bumpInFlight();
              appendThinking({ kind: "text", text: event.text });
            } else if (event.kind === "tool_use_start") {
              localContent.push({
                type: "tool_use",
                id: event.tool_use_id,
                name: event.name,
                input: {},
              });
              bumpInFlight();
              appendThinking({
                kind: "tool_start",
                tool_id: event.tool_use_id,
                name: event.name,
              });
            } else if (event.kind === "tool_use_input") {
              const b = localContent.find(
                (x) => x.type === "tool_use" && (x as ContentBlockToolUse).id === event.tool_use_id,
              ) as ContentBlockToolUse | undefined;
              if (b) {
                b.input = event.input;
                bumpInFlight();
                // Auto-focus: when the agent reads/updates a specific
                // neuron via doco_api, take the user to that neuron's
                // perspective view so they can watch what's happening.
                // Skipped silently if the user is already there.
                maybeFollowToolToNeuron(b.name, event.input);
                // Record creates here so the matching tool_use_result
                // (which carries the server-generated id) can navigate.
                maybeNoteCreate(event.tool_use_id, b.name, event.input);
              }
              appendThinking({
                kind: "tool_input",
                tool_id: event.tool_use_id,
                input: event.input,
              });
            } else if (event.kind === "tool_use_result") {
              localResults.set(event.tool_use_id, {
                type: "tool_result",
                tool_use_id: event.tool_use_id,
                content: event.preview,
                is_error: !event.ok,
              });
              bumpInFlight();
              appendThinking({
                kind: "tool_result",
                tool_id: event.tool_use_id,
                preview: event.preview,
                ok: event.ok,
              });
              // Create flow: navigate to the freshly-minted neuron.
              maybeFollowCreateResult(event.tool_use_id, event.ok, event.preview);
            } else if (event.kind === "navigate") {
              navigate(event.url);
              appendThinking({ kind: "navigate", url: event.url });
            } else if (event.kind === "message_saved") {
              // Server just persisted a user or assistant message. Tell
              // other tabs so they re-fetch the canonical snapshot and
              // see the message in real time.
              broadcastSync({ kind: "changed" });
              // User-message persisted server-side — drop the
              // pending-send recovery record so we don't replay it.
              if (event.role === "user") {
                if (!persistedUserMessageId) {
                  persistedUserMessageId = event.message_id;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === optimisticUserMessageId ? { ...m, id: event.message_id } : m,
                    ),
                  );
                  optimisticUserMessageId = event.message_id;
                }
                if (typeof window !== "undefined") {
                  try {
                    window.localStorage.removeItem(PENDING_SEND_KEY);
                  } catch {}
                }
              } else {
                persistedAssistantMessageId = event.message_id;
              }
            } else if (event.kind === "error") {
              localContent.push({ type: "text", text: `[error] ${event.message}` });
              bumpInFlight();
              appendThinking({ kind: "error", message: event.message });
            } else if (event.kind === "status") {
              appendThinking({ kind: "status", phase: event.phase, detail: event.detail });
            } else if (event.kind === "usage_update") {
              setTurnUsage({
                input_tokens: event.input_tokens,
                output_tokens: event.output_tokens,
                cache_read_tokens: event.cache_read_tokens,
                cache_creation_tokens: event.cache_creation_tokens,
              });
              appendThinking({
                kind: "usage",
                input_tokens: event.input_tokens,
                output_tokens: event.output_tokens,
              });
            } else if (event.kind === "done") {
              break streamLoop;
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          const msg = err instanceof Error ? err.message : String(err);
          localContent.push({ type: "text", text: `[error] ${msg}` });
          bumpInFlight();
        }
      } finally {
        abortRef.current = null;
        // Commit the in-flight content as saved messages. Canonical history
        // (with server-assigned ids and timestamps) gets re-hydrated on the
        // next mount via the conversation endpoint — we don't block here on
        // a reload round-trip.
        const committed: ChatMessage[] = [];
        if (localContent.length > 0) {
          committed.push({
            id: persistedAssistantMessageId ?? `local_${Date.now() + 1}`,
            role: "assistant",
            content: localContent.slice(),
            created_at: new Date().toISOString(),
          });
        }
        if (localResults.size > 0) {
          committed.push({
            id: `local_${Date.now() + 2}`,
            role: "user",
            content: Array.from(localResults.values()),
            created_at: new Date().toISOString(),
          });
        }
        if (committed.length > 0) {
          setMessages((prev) => [...prev, ...committed]);
        }
        setInFlight(null);
        setBusy(false);
        // Per-request token counter is only meaningful while the
        // request is in flight; clear it once the turn settles.
        setTurnUsage(null);
        // Settled — tell other tabs to re-fetch the final state (covers
        // the late-arriving assistant message) and that Señor Doco is
        // no longer mid-reply.
        broadcastSync({ kind: "remote-inflight", busy: false });
        broadcastSync({ kind: "changed" });
        // Refresh the thread list so the active thread's preview /
        // updated_at reflect the assistant's reply when the user
        // navigates back to the list.
        void loadConversationsList();
      }
    },
    [
      inputText,
      busy,
      remoteInflight,
      staged,
      location.pathname,
      location.search,
      navigate,
      broadcastSync,
      appendThinking,
      conversationId,
      conversationTitle,
      loadConversationsList,
      maybeFollowToolToNeuron,
      maybeNoteCreate,
      maybeFollowCreateResult,
    ],
  );

  // Pending-send recovery. send() writes the user's text to
  // localStorage synchronously before its fetch; if the tab died
  // before the SSE confirmed persistence, this effect finds the
  // stale entry on mount and re-fires the send. Cleared either by
  // the `message_saved` event in the SSE handler (success path) or
  // by this effect detecting that the text is already in `messages`
  // (someone else persisted it, e.g. another tab).
  //
  // IMPORTANT: this `useEffect` MUST be declared AFTER `send` —
  // referencing `send` in a hook above its `useCallback` triggers
  // a TDZ ReferenceError at render time, which crashes SSR. PR #278
  // shipped that bug and took prod down for ~12 min.
  useEffect(() => {
    if (!bootstrapped || busy || remoteInflight || typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(PENDING_SEND_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: { text?: unknown; queued_at?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    if (!parsed || typeof parsed.text !== "string" || !parsed.text) {
      try {
        window.localStorage.removeItem(PENDING_SEND_KEY);
      } catch {}
      return;
    }
    const queuedAt = typeof parsed.queued_at === "number" ? parsed.queued_at : 0;
    if (!queuedAt || Date.now() - queuedAt > PENDING_SEND_MAX_AGE_MS) {
      try {
        window.localStorage.removeItem(PENDING_SEND_KEY);
      } catch {}
      return;
    }
    const text = parsed.text;
    const alreadyThere = messages.some(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text === text),
    );
    if (alreadyThere) {
      try {
        window.localStorage.removeItem(PENDING_SEND_KEY);
      } catch {}
      return;
    }
    // Clear before replaying so a re-send failure doesn't loop the
    // recovery. send() will re-write the key with a fresh queued_at.
    try {
      window.localStorage.removeItem(PENDING_SEND_KEY);
    } catch {}
    void send({ text, staged: [] });
  }, [bootstrapped, busy, remoteInflight, messages, send]);

  // Queue-drain: when Señor Doco settles AND messages are queued
  // from busy-sends, auto-fire the oldest one. Passing the message as
  // an `override` bypasses the re-queue check inside `send`.
  useEffect(() => {
    if (busy || remoteInflight || queuedSends.length === 0) return;
    const q = queuedSends[0];
    if (!q) return;
    setQueuedSends(queuedSends.slice(1));
    void send(q);
  }, [busy, remoteInflight, queuedSends, send]);

  // Per-thread unread counter derived from the list-endpoint's
  // message_count vs. a per-thread last-seen value in localStorage.
  // Falls back to 0 when the user has never seen the thread (we
  // initialize last-seen on first sight, so genuinely unread state
  // only appears for activity that happened while the user was
  // looking elsewhere). Recomputed whenever the list refreshes.
  const unreadByThread = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conversations) {
      const seen = readLastSeen(c.id);
      const unread = Math.max(0, c.message_count - seen);
      map.set(c.id, unread);
    }
    return map;
  }, [conversations]);

  // Total unread across every thread that ISN'T the one currently
  // open. Shown next to the back arrow in the chat header so the
  // user knows whether anything else needs attention.
  const totalUnreadOthers = useMemo(() => {
    let total = 0;
    for (const c of conversations) {
      if (c.id === conversationId) continue;
      total += unreadByThread.get(c.id) ?? 0;
    }
    return total;
  }, [conversations, conversationId, unreadByThread]);

  // Total unread across every thread, including the active one.
  // Drives the collapsed rail's badge — when the sidebar is closed
  // we have no notion of "active thread," so the count covers
  // everything the user might want to come back for.
  const totalUnreadAll = useMemo(() => {
    let total = 0;
    for (const c of conversations) {
      total += unreadByThread.get(c.id) ?? 0;
    }
    return total;
  }, [conversations, unreadByThread]);

  // When the user is viewing a thread (chat view), keep its
  // last-seen count pinned to its current message_count so the
  // unread badge stays at 0 for the active thread.
  useEffect(() => {
    if (view !== "chat" || !conversationId) return;
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    writeLastSeen(conv.id, conv.message_count);
  }, [view, conversationId, conversations]);

  // Initialize last-seen for any thread the user has never visited
  // so existing threads (created before this UX shipped) don't all
  // show fake unread counts on first list open.
  useEffect(() => {
    for (const c of conversations) {
      if (typeof window === "undefined") return;
      const raw = window.localStorage.getItem(LAST_SEEN_PREFIX + c.id);
      if (raw === null) writeLastSeen(c.id, c.message_count);
    }
  }, [conversations]);

  const allMessages = useMemo<RenderableMessage[]>(() => {
    const out: RenderableMessage[] = messages.map((m) => ({ kind: "saved", message: m }));
    if (inFlight) {
      out.push({ kind: "inflight", message: inFlight });
    } else if (remoteInflight) {
      // Another tab is mid-reply. Show an empty in-flight bubble so
      // this tab tells the user something's happening; the content
      // arrives via the `changed` broadcast once the remote stream
      // settles and we re-fetch.
      out.push({
        kind: "inflight",
        message: {
          content: [],
          toolResults: new Map(),
          created_at: new Date().toISOString(),
        },
      });
    }
    return out;
  }, [messages, inFlight, remoteInflight]);
  const agentActive = busy || inFlight !== null || remoteInflight;

  // While collapsed, any new content from the server (a fresh message
  // saved, or an in-flight stream still landing) flips the unread flag.
  const assistantSavedCount = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages],
  );
  const prevAssistantCountRef = useRef(assistantSavedCount);
  useEffect(() => {
    if (assistantSavedCount > prevAssistantCountRef.current && collapsedRef.current) {
      markUnread();
    }
    prevAssistantCountRef.current = assistantSavedCount;
  }, [assistantSavedCount, markUnread]);
  useEffect(() => {
    if (inFlight && (inFlight.content.length > 0 || inFlight.toolResults.size > 0)) {
      if (collapsedRef.current) markUnread();
    }
  }, [inFlight, markUnread]);

  const conversationStatus = useMemo<ConversationStatus>(() => {
    if (loadError || uploadError) {
      return { kind: "attention", label: "Needs attention" };
    }
    if (agentActive) {
      return { kind: "working", label: "Señor Doco is working" };
    }
    const latest = latestVisibleChatMessage(messages);
    if (!latest) {
      return { kind: "idle", label: "Ready" };
    }
    if (latest.role === "assistant") {
      return assistantMessageAsksQuestion(latest)
        ? { kind: "question", label: "Waiting for your answer" }
        : { kind: "complete", label: "Complete" };
    }
    return { kind: "idle", label: "Ready" };
  }, [agentActive, loadError, messages, uploadError]);

  // Sign-in / sign-out / OAuth callbacks always force-collapse: no
  // session yet (or being torn down), and Señor Doco would be empty
  // chrome. /device + /oauth/authorize used to be in this list too,
  // but those are consent pages for an *already signed-in* user — they
  // should be able to keep using Señor Doco there. Same for the invite
  // accept page; if they're signed in, the rail behaves normally.
  const isAuthPage =
    location.pathname === "/sign-in" ||
    location.pathname === "/sign-out" ||
    location.pathname.startsWith("/auth/");

  // Single-element render: the aside is always present so its
  // width transition runs for BOTH the show-thinking expansion AND
  // the panel-button collapse. Content swaps based on `collapsedDisplay`,
  // and `overflow-hidden` keeps the inner content from spilling while
  // the width animates.
  const collapsedDisplay = collapsed || isAuthPage;
  const statusAnchorIndex = lastVisibleMessageIndex(allMessages);

  return (
    <aside
      className="neu-panel flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-card"
      style={{ width: railWidth, transition: "width 180ms ease-out" }}
      aria-busy={agentActive}
      aria-label={agentActive ? "Señor Doco, working" : "Señor Doco"}
    >
      {collapsedDisplay ? (
        <button
          type="button"
          onClick={() => setCollapsedPersistent(false)}
          aria-busy={agentActive}
          aria-label={agentActive ? "Expand Señor Doco (working)" : "Expand Señor Doco"}
          className="group relative flex h-full w-full shrink-0 cursor-pointer flex-col items-center justify-start gap-2 py-3 hover:bg-input"
        >
          <PanelToggleIcon side="left" open />
          <div
            className="select-none text-[12px] font-semibold text-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Señor Doco
          </div>
          {totalUnreadAll > 0 ? (
            <span
              aria-label={`${totalUnreadAll} unread message${totalUnreadAll === 1 ? "" : "s"}`}
              className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground"
              style={{ boxShadow: "0 0 0 2px var(--color-card)" }}
            >
              {totalUnreadAll > 99 ? "99+" : totalUnreadAll}
            </span>
          ) : unread ? (
            <span
              aria-label="unread"
              className="h-2 w-2 rounded-full bg-primary"
              style={{ boxShadow: "0 0 0 2px var(--color-card)" }}
            />
          ) : null}
        </button>
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Header — always visible. Single row: title on the left,
          Thinking + collapse controls on the right. */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
              <div className="select-none truncate text-sm font-semibold text-foreground">
                Señor Doco
              </div>
              <div className="flex items-center gap-1.5">
                {view === "chat" ? (
                  <button
                    type="button"
                    onClick={toggleShowThinking}
                    aria-pressed={showThinking}
                    aria-label={showThinking ? "Hide thinking column" : "Show thinking column"}
                    title={showThinking ? "Hide thinking column" : "Show thinking column"}
                    className={cn(
                      "rounded-md border border-border px-2 py-0.5 text-[11px]",
                      showThinking
                        ? "neu-pressed bg-input text-foreground"
                        : "neu-button text-muted-foreground hover:bg-input hover:text-foreground",
                    )}
                  >
                    {showThinking ? "Hide thinking" : "Show thinking"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setCollapsedPersistent(true)}
                  aria-label="Collapse Señor Doco"
                  title="Collapse"
                  className="neu-button inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-input hover:text-foreground"
                >
                  <PanelToggleIcon side="left" open={false} />
                </button>
              </div>
            </div>

            {view === "list" ? (
              <ThreadListView
                conversations={conversations}
                loading={conversationsLoading}
                error={conversationsError}
                activeId={conversationId}
                renamingId={renamingId}
                renameDraft={renameDraft}
                searchQuery={searchQuery}
                unreadByThread={unreadByThread}
                onSearchChange={setSearchQuery}
                onSelect={switchThread}
                onNew={() => void newThread()}
                onStartRename={(id, current) => {
                  setRenamingId(id);
                  setRenameDraft(current ?? "");
                }}
                onCancelRename={() => setRenamingId(null)}
                onCommitRename={(id) => {
                  const next = renameDraft;
                  setRenamingId(null);
                  void renameThread(id, next);
                }}
                onRenameDraftChange={setRenameDraft}
                onArchive={(id) => void archiveThread(id)}
              />
            ) : (
              <>
                {/* Chat header — back arrow + total-unread badge + thread
              name. WhatsApp-style: tapping the back arrow returns to
              the thread list. */}
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-2.5 pt-1.5">
                  <button
                    type="button"
                    onClick={openThreadList}
                    aria-label={
                      totalUnreadOthers > 0
                        ? `Back to threads (${totalUnreadOthers} unread in other threads)`
                        : "Back to threads"
                    }
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-foreground hover:bg-input"
                  >
                    <CollapseIcon side="left" />
                    {totalUnreadOthers > 0 ? (
                      <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                        {totalUnreadOthers}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {renamingId === conversationId && conversationId ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: Inline rename should focus immediately when the user starts renaming.
                        autoFocus
                        type="text"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const next = renameDraft;
                            setRenamingId(null);
                            void renameThread(conversationId, next);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => {
                          const next = renameDraft;
                          setRenamingId(null);
                          void renameThread(conversationId, next);
                        }}
                        maxLength={120}
                        className="min-w-0 flex-1 rounded-md border border-border bg-input/40 px-1.5 py-0.5 text-xs font-semibold text-foreground outline-none focus:bg-input"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          if (!conversationId) return;
                          setRenameDraft(conversationTitle ?? "");
                          setRenamingId(conversationId);
                        }}
                        title={
                          conversationId
                            ? `${displayThreadTitle(conversationTitle)} — click to rename`
                            : displayThreadTitle(conversationTitle)
                        }
                        disabled={!conversationId}
                        className={cn(
                          "min-w-0 truncate rounded-md px-1 py-0.5 text-left text-xs font-semibold hover:bg-input/60 disabled:cursor-default disabled:hover:bg-transparent",
                          conversationTitle ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {displayThreadTitle(conversationTitle)}
                      </button>
                    )}
                    <AttachmentsRow
                      docos={attachedDocos}
                      orgs={attachedOrgs}
                      onDetachDoco={(doco) => void detachAttachment("doco", doco)}
                      onDetachOrg={(org) => void detachAttachment("org", org)}
                      onAttachDoco={(doco) => void attachAttachment("doco", doco)}
                      onAttachOrg={(org) => void attachAttachment("org", org)}
                      conversationId={conversationId}
                    />
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div
                    ref={messageListRef}
                    onScroll={onMessagesScroll}
                    className={cn(
                      "flex min-h-0 flex-col overflow-y-auto px-3 py-3 text-xs leading-relaxed",
                      showThinking ? "w-[320px] shrink-0 border-r border-border" : "flex-1",
                    )}
                  >
                    {loadError ? (
                      <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                        Couldn't load chat history: {loadError}
                      </div>
                    ) : null}
                    {hasMore ? (
                      <div className="mb-2 text-center text-[10px] text-muted-foreground">
                        {loadingOlder ? "Loading older messages…" : "Scroll up for older messages"}
                      </div>
                    ) : null}
                    {allMessages.length === 0 && !loadError && bootstrapped ? (
                      <div className="text-[11px] text-muted-foreground">
                        Ask me anything about your Docos — I can search, capture decisions, create
                        new Docos or orgs, invite collaborators, and take you to any page.
                      </div>
                    ) : null}
                    {allMessages.map((rm, index) => (
                      <MessageBlock
                        key={rm.kind === "saved" ? rm.message.id : "inflight"}
                        rm={rm}
                        usage={rm.kind === "inflight" ? turnUsage : null}
                        compactAfter={index === statusAnchorIndex}
                      />
                    ))}
                    <ConversationStatusIcon status={conversationStatus} />
                  </div>
                  {showThinking ? (
                    <ThinkingPanel
                      events={thinkingEvents}
                      active={busy || inFlight !== null || remoteInflight}
                    />
                  ) : null}
                </div>

                <Composer
                  value={inputText}
                  onChange={setInputText}
                  onSend={send}
                  busy={busy || remoteInflight}
                  username={me.username}
                  staged={staged}
                  queuedCount={queuedSends.length}
                  uploading={uploading}
                  uploadError={uploadError}
                  onUploadFiles={uploadFiles}
                  onRemoveStaged={removeStaged}
                />
              </>
            )}

            {/* Footer pinned at the bottom — explains what Señor Doco is
          and how a collaborator can mint their own agent token. Out
          of the user's way during conversation but always reachable. */}
            <div className="shrink-0 border-t border-border/70 px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
              Señor Doco runs on Claude Haiku 4.5 inside Doco. Want to collaborate with your own
              agent?{" "}
              <Link to="/api-keys" className="font-semibold text-foreground hover:text-primary">
                Invite it
              </Link>
              .
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * Thin (32 px) vertical rail rendered when a collapsible sidebar is in
 * its collapsed state. Shows the side's label written vertically + an
 * optional unread dot. Click anywhere on the rail expands it.
 *
 * Exported so other pages (e.g. the per-Doco home's right column) can
 * reuse the same chrome.
 */
export function CollapsedRail({
  label,
  side,
  unread,
  active,
  onExpand,
}: {
  label: string;
  side: "left" | "right";
  unread?: boolean;
  active?: boolean;
  onExpand: () => void;
}) {
  const isLeft = side === "left";
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-busy={active}
      aria-label={active ? `Expand ${label} (working)` : `Expand ${label}`}
      className={cn(
        "neu-panel group relative flex h-full w-[32px] shrink-0 cursor-pointer flex-col items-center gap-2 bg-card py-3 hover:bg-input",
        isLeft ? "border-r border-border" : "border-l border-border",
      )}
    >
      <PanelToggleIcon side={side} open />
      <div
        className="select-none text-[11px] font-semibold uppercase tracking-wider text-foreground"
        style={{
          writingMode: "vertical-rl",
          transform: isLeft ? "rotate(180deg)" : undefined,
        }}
      >
        {label}
      </div>
      {unread ? (
        <span
          aria-label="unread"
          className="h-2 w-2 rounded-full bg-primary"
          style={{ boxShadow: "0 0 0 2px var(--color-card)" }}
        />
      ) : null}
    </button>
  );
}

function CollapseIcon({ side }: { side: "left" | "right" }) {
  // A small chevron pointing in the collapse direction.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {side === "left" ? <polyline points="10 4 5 8 10 12" /> : <polyline points="6 4 11 8 6 12" />}
    </svg>
  );
}

function PanelToggleIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  const isLeftPanel = side === "left";
  const separatorX = isLeftPanel ? 7 : 17;
  const points = isLeftPanel === open ? "13 8 17 12 13 16" : "15 8 11 12 15 16";

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <line x1={separatorX} y1="4" x2={separatorX} y2="20" />
      <polygon points={points} fill="currentColor" stroke="none" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

interface AttachmentsRowProps {
  docos: DocoAttachmentInfo[];
  orgs: OrgAttachmentInfo[];
  conversationId: string | null;
  onAttachDoco: (doco: AvailableDoco) => void;
  onAttachOrg: (org: AvailableOrg) => void;
  onDetachDoco: (doco: DocoAttachmentInfo) => void;
  onDetachOrg: (org: OrgAttachmentInfo) => void;
}

interface AvailableDoco {
  id: string;
  handle: string;
  qualified_handle?: string;
}

interface AvailableOrg {
  handle: string;
  name: string | null;
}

interface AvailableLists {
  docos: AvailableDoco[];
  orgs: AvailableOrg[];
}

function AttachmentsRow({
  docos,
  orgs,
  conversationId,
  onAttachDoco,
  onAttachOrg,
  onDetachDoco,
  onDetachOrg,
}: AttachmentsRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [available, setAvailable] = useState<AvailableLists | null>(null);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (e.target instanceof Node && pickerRef.current.contains(e.target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  // Lazy-load the user's accessible Docos / Orgs the first time the
  // picker opens. Cheap query — listAccessibleDocoIdsForPrincipal +
  // a single docos join — but no point pulling it on every chat
  // bootstrap.
  useEffect(() => {
    if (!pickerOpen || available !== null) return;
    setLoadingAvailable(true);
    void Promise.all([
      fetch("/api/v1/docos.json", { credentials: "same-origin" }).then((r) =>
        r.ok ? r.json() : { docos: [] },
      ),
      fetch("/api/v1/orgs.json", { credentials: "same-origin" }).then((r) =>
        r.ok ? r.json() : { orgs: [] },
      ),
    ])
      .then(([d, o]) => {
        setAvailable({
          docos: Array.isArray(d.docos) ? d.docos : [],
          orgs: Array.isArray(o.orgs) ? o.orgs : [],
        });
      })
      .catch(() => setAvailable({ docos: [], orgs: [] }))
      .finally(() => setLoadingAvailable(false));
  }, [pickerOpen, available]);

  const attachedDocoIdSet = new Set(docos.map((d) => d.id).filter(Boolean));
  const attachedDocoHandleSet = new Set(docos.map((d) => d.handle));
  const attachedOrgSet = new Set(orgs.map((o) => o.handle));
  const docosToOffer = (available?.docos ?? []).filter(
    (d) => !attachedDocoIdSet.has(d.id) && !attachedDocoHandleSet.has(d.handle),
  );
  const orgsToOffer = (available?.orgs ?? []).filter((o) => !attachedOrgSet.has(o.handle));

  if (docos.length + orgs.length === 0 && !conversationId) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" ref={pickerRef}>
      {docos.map((d) => (
        <span
          key={`doco-${d.id ?? d.handle}`}
          className="neu-button inline-flex h-5 items-center rounded-full border border-border pl-2 pr-0.5 text-[10px] leading-none text-muted-foreground"
          title={d.label ?? d.handle}
        >
          <Link
            to={d.id ? `/by-id/${encodeURIComponent(d.id)}` : `/${d.handle}`}
            className="inline-flex h-full items-center leading-none hover:text-foreground"
          >
            {d.label ?? d.handle}
          </Link>
          <button
            type="button"
            onClick={() => onDetachDoco(d)}
            aria-label={`Remove ${d.label ?? d.handle}`}
            className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full leading-none text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          >
            ×
          </button>
        </span>
      ))}
      {orgs.map((o) => (
        <span
          key={`org-${o.handle}`}
          className="neu-button inline-flex h-5 items-center rounded-full border border-border pl-2 pr-0.5 text-[10px] leading-none text-muted-foreground"
          title={o.name ?? o.handle}
        >
          <Link
            to={`/orgs/${o.handle}`}
            className="inline-flex h-full items-center leading-none hover:text-foreground"
          >
            @{o.name ?? o.handle}
          </Link>
          <button
            type="button"
            onClick={() => onDetachOrg(o)}
            aria-label={`Remove ${o.name ?? o.handle}`}
            className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full leading-none text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          >
            ×
          </button>
        </span>
      ))}
      <div className="relative inline-flex items-center">
        <button
          type="button"
          onClick={() => setPickerOpen((p) => !p)}
          aria-label="Attach a Doco or Org"
          aria-expanded={pickerOpen}
          className="neu-button inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-[10px] leading-none text-muted-foreground hover:text-foreground"
        >
          +
        </button>
        {pickerOpen ? (
          <div
            role="menu"
            className="neu-panel absolute left-0 top-full z-20 mt-1 max-h-72 min-w-[180px] overflow-y-auto rounded-md border border-border bg-card py-1 text-xs shadow"
          >
            {loadingAvailable ? (
              <div className="px-3 py-1 text-[11px] text-muted-foreground">Loading…</div>
            ) : null}
            {!loadingAvailable && docosToOffer.length === 0 && orgsToOffer.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-muted-foreground">
                Nothing else to attach.
              </div>
            ) : null}
            {docosToOffer.length > 0 ? (
              <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Docos
              </div>
            ) : null}
            {docosToOffer.map((d) => (
              <button
                key={`d-${d.handle}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPickerOpen(false);
                  onAttachDoco(d);
                }}
                className="block w-full truncate px-3 py-1 text-left hover:bg-input"
              >
                {d.qualified_handle ?? d.handle}
              </button>
            ))}
            {orgsToOffer.length > 0 ? (
              <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Orgs
              </div>
            ) : null}
            {orgsToOffer.map((o) => (
              <button
                key={`o-${o.handle}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPickerOpen(false);
                  onAttachOrg(o);
                }}
                className="block w-full truncate px-3 py-1 text-left hover:bg-input"
              >
                @{o.name ?? o.handle}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ThreadListViewProps {
  conversations: ConversationListItem[];
  loading: boolean;
  error: string | null;
  activeId: string | null;
  renamingId: string | null;
  renameDraft: string;
  searchQuery: string;
  unreadByThread: Map<string, number>;
  onSearchChange: (next: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onStartRename: (id: string, current: string | null) => void;
  onCancelRename: () => void;
  onCommitRename: (id: string) => void;
  onRenameDraftChange: (next: string) => void;
  onArchive: (id: string) => void;
}

function ThreadListView({
  conversations,
  loading,
  error,
  activeId,
  renamingId,
  renameDraft,
  searchQuery,
  unreadByThread,
  onSearchChange,
  onSelect,
  onNew,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRenameDraftChange,
  onArchive,
}: ThreadListViewProps) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) => {
        const title = (c.title ?? "").toLowerCase();
        const preview = (c.last_message_preview ?? "").toLowerCase();
        return title.includes(q) || preview.includes(q);
      })
    : conversations;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <div className="text-xs font-semibold text-foreground">Chats</div>
        <button
          type="button"
          onClick={onNew}
          className="neu-button rounded-md border border-primary bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New chat
        </button>
      </div>
      <div className="shrink-0 px-3 py-1.5">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search"
          aria-label="Search threads"
          className="w-full rounded-md border border-border bg-input/60 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            Couldn't load threads: {error}
          </div>
        ) : null}
        {loading && conversations.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">Loading threads…</div>
        ) : null}
        {!loading && conversations.length === 0 && !error ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            No threads yet — hit “+ New chat” to start one.
          </div>
        ) : null}
        {!loading && conversations.length > 0 && filtered.length === 0 && q ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            No threads match “{searchQuery}”.
          </div>
        ) : null}
        <ul>
          {filtered.map((c) => (
            <ThreadRow
              key={c.id}
              conv={c}
              isActive={c.id === activeId}
              isRenaming={c.id === renamingId}
              renameDraft={renameDraft}
              unread={unreadByThread.get(c.id) ?? 0}
              onSelect={() => onSelect(c.id)}
              onStartRename={() => onStartRename(c.id, c.title)}
              onCancelRename={onCancelRename}
              onCommitRename={() => onCommitRename(c.id)}
              onRenameDraftChange={onRenameDraftChange}
              onArchive={() => onArchive(c.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface ThreadRowProps {
  conv: ConversationListItem;
  isActive: boolean;
  isRenaming: boolean;
  renameDraft: string;
  unread: number;
  onSelect: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onRenameDraftChange: (next: string) => void;
  onArchive: () => void;
}

function ThreadRow({
  conv,
  isActive,
  isRenaming,
  renameDraft,
  unread,
  onSelect,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRenameDraftChange,
  onArchive,
}: ThreadRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Dismiss the per-row menu when the user clicks anywhere else on
  // the page. Without this the menu stays open after the user picks
  // an option, since we close it inside the callback.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  // Auto-focus + select the input when entering rename mode.
  useEffect(() => {
    if (!isRenaming) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [isRenaming]);

  // WhatsApp-style "last message" line. Prefix with "You: " when
  // the most recent message came from the user, so it's easy to tell
  // at-a-glance whether the agent has replied. Falls back to a
  // synthesized placeholder for image-only / attachment-only threads.
  const previewLine = conv.last_message_preview
    ? conv.last_message_role === "user"
      ? `You: ${conv.last_message_preview}`
      : conv.last_message_preview
    : conv.message_count === 0
      ? "No messages yet"
      : "Attachment";
  return (
    <li
      className={cn(
        "group relative flex items-stretch border-b border-border/40",
        // No fill on the row itself — the active thread is denoted
        // only by the primary-colored accent strip on the left edge.
        // Hover keeps a subtle tint so rows still feel clickable.
        isActive ? "" : "hover:bg-input/40",
      )}
    >
      {isActive ? <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" /> : null}
      {isRenaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-3 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
            onBlur={onCommitRename}
            maxLength={120}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs text-foreground"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onSelect}
            className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-xs font-semibold",
                  conv.title ? "text-foreground" : "text-muted-foreground",
                  unread > 0 ? "font-bold" : "",
                )}
              >
                {displayThreadTitle(conv.title)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatRelativeTime(conv.updated_at)}
              </span>
            </span>
            <span className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-[11px]",
                  unread > 0 ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {previewLine}
              </span>
              {unread > 0 ? (
                <span
                  aria-label={`${unread} unread`}
                  className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground"
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
            </span>
          </button>
          <div ref={menuRef} className="relative flex items-center pr-1.5">
            <button
              type="button"
              onClick={() => setMenuOpen((p) => !p)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Thread actions"
              className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-input hover:text-foreground group-hover:opacity-100 aria-expanded:opacity-100"
            >
              <DotsIcon />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="neu-panel absolute right-0 top-full z-10 mt-1 min-w-[120px] rounded-md border border-border bg-card py-1 text-xs shadow"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onStartRename();
                  }}
                  className="block w-full px-3 py-1 text-left hover:bg-input"
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                  className="block w-full px-3 py-1 text-left text-destructive hover:bg-destructive/10"
                >
                  Archive
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type RenderableMessage =
  | { kind: "saved"; message: ChatMessage }
  | { kind: "inflight"; message: InFlightMessage };

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function blockKey(block: AnyBlock): string {
  if (block.type === "tool_use") return `tool-use-${block.id}`;
  if (block.type === "tool_result") return `tool-result-${block.tool_use_id}`;
  if (block.type === "attachment_ref") return `attachment-${block.attachment_id}`;
  return `text-${hashText(block.text)}`;
}

function blockLocalTwinKey(block: AnyBlock): string {
  if (block.type === "attachment_ref") {
    return `attachment:${block.attachment_id}:${block.filename}:${block.size_bytes}`;
  }
  if (block.type === "text") return `text:${block.text}`;
  if (block.type === "tool_result") return `tool-result:${block.tool_use_id}:${block.content}`;
  return `tool-use:${block.id}`;
}

function messageLocalTwinKey(message: ChatMessage): string {
  return `${message.role}:${visibleChatBlocks(message.content).map(blockLocalTwinKey).join("|")}`;
}

function latestVisibleChatMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (visibleChatBlocks(message.content).length > 0) return message;
  }
  return null;
}

function visibleMessageText(message: ChatMessage): string {
  return visibleChatBlocks(message.content)
    .filter((block): block is ContentBlockText => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function assistantMessageAsksQuestion(message: ChatMessage): boolean {
  const text = visibleMessageText(message);
  if (!text) return false;
  const visibleText = text
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, (url) => url.replace(/[?？]/g, ""));
  return /[?？]/.test(visibleText);
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatMessageTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function MessageTime({ createdAt }: { createdAt: string }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(formatMessageTime(createdAt));
  }, [createdAt]);
  return (
    <time
      dateTime={createdAt}
      className="mb-1 min-w-[2.5rem] shrink-0 select-none text-center font-mono text-[10px] leading-none text-muted-foreground/70"
    >
      {label}
    </time>
  );
}

function lastVisibleMessageIndex(messages: readonly RenderableMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rm = messages[i];
    if (!rm) continue;
    if (rm.kind === "saved") {
      const message = rm.message;
      if (message.role === "user" && message.content.every((b) => b.type === "tool_result")) {
        continue;
      }
      if (visibleChatBlocks(message.content).length > 0) return i;
    } else if (visibleChatBlocks(rm.message.content).length > 0) {
      return i;
    }
  }
  return -1;
}

function MessageBlock({
  rm,
  usage,
  compactAfter,
}: {
  rm: RenderableMessage;
  usage: TurnUsage | null;
  compactAfter: boolean;
}) {
  if (rm.kind === "saved") {
    const m = rm.message;
    // Tool-result-only user messages are Anthropic-contract bookkeeping
    // (the user-role wrapper for tool_result blocks). Hide from the
    // main chat entirely — the canonical user-visible record is the
    // next assistant turn's pasted footer-line; detailed result rows
    // live in the Thinking column.
    if (m.role === "user" && m.content.every((b) => b.type === "tool_result")) {
      return null;
    }
    return <SavedMessage message={m} compactAfter={compactAfter} />;
  }
  return <InFlightMessageView msg={rm.message} usage={usage} compactAfter={compactAfter} />;
}

function ConversationStatusIcon({ status }: { status: ConversationStatus }) {
  const baseClass =
    "inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-[15px] font-semibold leading-none shadow-sm";
  const symbol =
    status.kind === "question"
      ? "?"
      : status.kind === "complete"
        ? "✓"
        : status.kind === "attention"
          ? "!"
          : "•";
  const toneClass =
    status.kind === "question"
      ? "text-primary"
      : status.kind === "complete"
        ? "text-emerald-600"
        : status.kind === "attention"
          ? "text-destructive"
          : "text-muted-foreground";

  return (
    <output
      className="flex justify-end pb-3 pr-1 pt-1"
      aria-label={status.label}
      aria-live="polite"
    >
      {status.kind === "working" ? (
        <DocoMark height={28} variant="mark" active ariaLabel={status.label} />
      ) : (
        <span className={cn(baseClass, toneClass)} title={status.label}>
          {symbol}
        </span>
      )}
    </output>
  );
}

/**
 * Filter block list for the main chat. Tool-use chips are
 * intermediate "agent is calling X" affordances that belong in the
 * Thinking column, not the user-facing message stream. Text +
 * attachments stay.
 */
function visibleChatBlocks(blocks: readonly AnyBlock[]): AnyBlock[] {
  return blocks.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");
}

function SavedMessage({
  message,
  compactAfter,
}: {
  message: ChatMessage;
  compactAfter: boolean;
}) {
  const isAssistant = message.role === "assistant";
  const visible = visibleChatBlocks(message.content);
  // Whole message was tool-call noise → skip the bubble. Detailed
  // tool activity is still in the Thinking column.
  if (visible.length === 0) return null;
  return (
    <div
      className={cn(
        compactAfter ? "mb-1" : "mb-3",
        "flex flex-col",
        isAssistant ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn("flex w-full items-end gap-2", isAssistant ? "justify-end" : "justify-start")}
      >
        {isAssistant ? <MessageTime createdAt={message.created_at} /> : null}
        <div
          className={cn(
            "neu-bubble max-w-[82%] space-y-1.5 rounded-lg px-2.5 py-1.5",
            isAssistant ? "bg-primary/10" : "neu-surface bg-card",
          )}
        >
          {visible.map((b) => (
            <BlockView key={blockKey(b)} block={b} />
          ))}
        </div>
        {!isAssistant ? <MessageTime createdAt={message.created_at} /> : null}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {isAssistant ? "Señor Doco" : "You"}
      </div>
    </div>
  );
}

function InFlightMessageView({
  msg,
  usage,
  compactAfter,
}: {
  msg: InFlightMessage;
  usage: TurnUsage | null;
  compactAfter: boolean;
}) {
  // tool_use / tool_result chips live in the Thinking column; the
  // main chat only sees text + attachments.
  const visible = visibleChatBlocks(msg.content);
  // Pre-text "thinking" state: the shared status icon below the
  // current message stack carries the only working animation.
  if (visible.length === 0) {
    return null;
  }
  // Once text streams in, render the bubble normally. The single
  // animated working mark lives in ConversationStatusIcon immediately
  // below this message's metadata row.
  return (
    <div className={cn(compactAfter ? "mb-1" : "mb-3", "flex flex-col items-end")}>
      <div className="flex w-full items-end justify-end gap-2">
        <MessageTime createdAt={msg.created_at} />
        <div className="neu-bubble max-w-[82%] space-y-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5">
          {visible.map((b) => (
            <BlockView key={blockKey(b)} block={b} />
          ))}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Señor Doco
        {usage ? (
          <span
            className="font-mono normal-case tracking-normal"
            title={`Tokens for this turn — input ${usage.input_tokens}, output ${usage.output_tokens}, cache read ${usage.cache_read_tokens}, cache create ${usage.cache_creation_tokens}`}
          >
            · {formatTokenCount(usage.input_tokens)} in · {formatTokenCount(usage.output_tokens)}{" "}
            out
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ThinkingPanel({ events, active }: { events: ThinkingEvent[]; active: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  // `performance.now()` at the moment the last event arrived. Drives
  // the "waiting +Xs" tail line below — anchoring on event arrival
  // (instead of plumbing the turn start in) means the indicator
  // resets cleanly each time a new event lands, even when the turn
  // straddles a sidebar remount.
  const [lastArrivalRT, setLastArrivalRT] = useState<number | null>(null);
  useEffect(() => {
    setLastArrivalRT(events.length > 0 ? performance.now() : null);
  }, [events.length]);

  // Force a re-render every 200ms while we're still waiting on the
  // agent, so the seconds count visibly. Cleared when the turn ends
  // or no events have arrived (the placeholder copy covers that case
  // already, no need to also tick).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!active || lastArrivalRT == null) return;
    const id = setInterval(() => forceTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [active, lastArrivalRT]);

  const idleSec = active && lastArrivalRT != null ? (performance.now() - lastArrivalRT) / 1000 : 0;
  const showWaitingLine = active && idleSec >= 1;

  const updatePinnedToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom <= THINKING_BOTTOM_STICKY_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (events.length === 0) {
      pinnedToBottomRef.current = true;
    }
    if (!pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card/50">
      <div className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Thinking <span className="ml-2 font-mono normal-case">{events.length} events</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={updatePinnedToBottom}
        className="min-h-0 flex-1 overflow-y-auto py-2 pl-2 pr-5 text-[11px] font-mono leading-snug [scrollbar-gutter:stable]"
      >
        {events.length === 0 ? (
          <div className="px-1 py-2 text-muted-foreground">
            {active
              ? "(waiting for first event…)"
              : "(no thinking yet — send a message to see what Señor Doco does)"}
          </div>
        ) : (
          <>
            {events.map((ev) => (
              <ThinkingRow key={ev.id} ev={ev} />
            ))}
            {showWaitingLine ? (
              <div className="mt-1 italic text-muted-foreground">
                waiting +{idleSec.toFixed(1)}s
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ThinkingRow({ ev }: { ev: ThinkingEvent }) {
  const elapsed = `+${(ev.at_ms / 1000).toFixed(1)}s`;
  if (ev.kind === "text") {
    return (
      <div className="mb-1">
        <span className="text-muted-foreground">{elapsed} text </span>
        <span className="whitespace-pre-wrap break-words">{ev.text}</span>
      </div>
    );
  }
  if (ev.kind === "tool_start") {
    return (
      <div className="mb-1">
        <span className="text-muted-foreground">{elapsed} tool </span>
        <span className="font-semibold">{ev.name}</span>
        <span className="text-muted-foreground"> ({ev.tool_id.slice(-6)})</span>
      </div>
    );
  }
  if (ev.kind === "tool_input") {
    const json = JSON.stringify(ev.input);
    return (
      <div className="mb-1 break-all">
        <span className="text-muted-foreground">{elapsed} input </span>
        <span>{json.length > 200 ? `${json.slice(0, 200)}…` : json}</span>
      </div>
    );
  }
  if (ev.kind === "tool_result") {
    return (
      <div className={cn("mb-1 break-all", ev.ok ? "" : "text-destructive")}>
        <span className="text-muted-foreground">{elapsed} result </span>
        <span>{ev.preview}</span>
      </div>
    );
  }
  if (ev.kind === "navigate") {
    return (
      <div className="mb-1 text-primary">
        <span className="text-muted-foreground">{elapsed} navigate </span>
        <span>{ev.url}</span>
      </div>
    );
  }
  if (ev.kind === "usage") {
    return (
      <div className="mb-1 text-muted-foreground">
        {elapsed} usage in={ev.input_tokens} out={ev.output_tokens}
      </div>
    );
  }
  if (ev.kind === "error") {
    return (
      <div className="mb-1 text-destructive">
        <span className="text-muted-foreground">{elapsed} error </span>
        <span>{ev.message}</span>
      </div>
    );
  }
  if (ev.kind === "status") {
    return (
      <div className="mb-1 text-muted-foreground">
        {elapsed} {ev.phase}
        {ev.detail ? ` (${ev.detail})` : ""}
      </div>
    );
  }
  return null;
}

// Render text blocks with inline `[label](url)` markdown links
// elevated to anchors. The chat surface is otherwise plain text — no
// full markdown — but footer lines emitted by capture endpoints carry
// a markdown link to the affected entity (e.g.
// `[🔮 Doco] 👤 Principal added: [juanfer](http://host/handle/principal/...)`).
// Without this the user sees the brackets-and-parens literal instead
// of a clickable jump.
//
// Same-origin URLs are routed through React Router's Link so the chat
// state survives the navigation; foreign URLs fall back to a plain
// anchor opened in a new tab.
function renderInlineLinks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, label, url] = m;
    let toProp: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const u = new URL(url, window.location.origin);
        if (u.origin === window.location.origin) {
          toProp = u.pathname + u.search + u.hash;
        }
      } catch {
        // Malformed URL — fall through to plain anchor.
      }
    }
    if (toProp) {
      out.push(
        <Link key={key++} to={toProp} className="underline hover:text-primary">
          {label}
        </Link>,
      );
    } else {
      out.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-primary"
        >
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BlockView({ block }: { block: AnyBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap break-words">{renderInlineLinks(block.text)}</div>;
  }
  if (block.type === "tool_use") {
    return (
      <div className="neu-surface rounded-md bg-card px-2 py-1 font-mono text-[10px] text-muted-foreground">
        <div className="break-all font-semibold text-foreground">
          {toolLabel(block.name, block.input)}
        </div>
      </div>
    );
  }
  if (block.type === "tool_result") {
    return <ToolResultRow result={block} />;
  }
  if (block.type === "attachment_ref") {
    return <AttachmentBlockView block={block} />;
  }
  return null;
}

function AttachmentBlockView({ block }: { block: ContentBlockAttachmentRef }) {
  const isImage = block.mime_type.startsWith("image/");
  const href = `/api/v1/agent-chat/attachments/${encodeURIComponent(block.attachment_id)}`;
  if (isImage) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="neu-surface block overflow-hidden rounded-md border border-border bg-background"
      >
        <img
          src={href}
          alt={block.filename}
          className="block max-h-48 w-full object-cover"
          loading="lazy"
        />
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          {block.filename} · {formatBytes(block.size_bytes)}
        </div>
      </a>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="neu-button flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground hover:bg-input/40"
    >
      <span className="font-mono text-muted-foreground">📎</span>
      <span className="truncate">{block.filename}</span>
      <span className="ml-auto text-muted-foreground">{formatBytes(block.size_bytes)}</span>
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compress a tool-result body into a one-line, human-readable summary.
 *
 * The model sees the full `{status, ok, body, warnings[].pending_spec}`
 * envelope so it can iterate against the validator. The user does not
 * need any of that — they need "did it work, and if not, why." Picks
 * the most informative one-liner from the envelope:
 *
 *   - 2xx success → "✓ added <Type>: <label>" if the response has a
 *     `footer_lines` entry (every successful capture sets one), else
 *     "✓ HTTP <status>".
 *   - 4xx / 5xx → "✗ <error.message>" — drops warnings, pending_spec,
 *     policy_id, and other model-facing context.
 *   - Non-JSON or unrecognized shape → truncated raw text (the prior
 *     behaviour, capped to one line).
 */
function summarizeToolResult(content: unknown, isError: boolean | undefined): string {
  if (typeof content !== "string") {
    return isError ? `✗ ${String(content).slice(0, 200)}` : `→ ${String(content).slice(0, 200)}`;
  }
  // Plain navigate/text results — already short, render as-is.
  if (!content.startsWith("{") && !content.startsWith("[")) {
    return content.slice(0, 200);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.slice(0, 200);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    const status = typeof p.status === "number" ? p.status : null;
    const ok = p.ok === true;
    const body = p.body;
    if (ok && body && typeof body === "object" && !Array.isArray(body)) {
      // Don't extract footer_lines here. Señor Doco follows the same
      // Doco agent-protocol as every other agent: he pastes the
      // footer-line verbatim in his next text response. The chip just
      // confirms the round-trip succeeded — pulling the same footer
      // text into the chip would show the user the same line twice.
      const duration = (body as Record<string, unknown>).duration_ms;
      if (typeof duration === "number") {
        return `✓ ${status ?? 200} (${(duration / 1000).toFixed(1)}s)`;
      }
      return `✓ ${status ?? 200}`;
    }
    if (!ok && body && typeof body === "object" && !Array.isArray(body)) {
      const errMsg = (body as Record<string, unknown>).error;
      if (typeof errMsg === "string") {
        // Trim the long "— pending LLM judge" / "<spec text>" tails the
        // validator appends for the model's benefit; the lead sentence
        // already names the policy.
        const trimmed = errMsg.split(" — ")[0] ?? errMsg;
        return `✗ ${status ?? "?"}: ${trimmed.slice(0, 240)}`;
      }
    }
    return isError ? `✗ ${status ?? "?"}` : `✓ ${status ?? 200}`;
  }
  return content.slice(0, 200);
}

function ToolResultRow({ result }: { result: ContentBlockToolResult }) {
  const summary = summarizeToolResult(result.content, result.is_error);
  return (
    <details
      className={cn(
        "neu-surface group rounded-md px-2 py-1 font-mono text-[10px]",
        result.is_error ? "bg-destructive/10 text-destructive" : "bg-card text-muted-foreground",
      )}
    >
      <summary className="cursor-pointer list-none truncate">{summary}</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all opacity-70">
        {typeof result.content === "string" ? result.content : JSON.stringify(result.content)}
      </pre>
    </details>
  );
}

/**
 * Type-named prose field per neuron type (post-migration 023). The
 * server stores the prose under this field name; the agent's POST
 * bodies use the same key. Lets the chip label show the actual
 * intent of a capture instead of just the URL.
 */
const NEURON_PROSE_FIELD: Record<string, string> = {
  decisions: "decision",
  intents: "intent",
  ideas: "idea",
  actions: "action",
  references: "reference",
  rules: "rule",
  logs: "log",
  evals: "eval",
  states: "state",
  principals: "principal",
};

/**
 * First-line preview of a possibly-multiline prose field. The first
 * line of every neuron's prose is the headline (the Decision summary,
 * the Intent statement, etc.) — perfect for a one-line chip.
 */
function firstLine(s: unknown, cap = 60): string {
  if (typeof s !== "string") return "";
  const head = s.split(/\r?\n/)[0]?.trim() ?? "";
  return head.length > cap ? `${head.slice(0, cap - 1)}…` : head;
}

function toolLabel(name: string, input: unknown): string {
  if (name === "navigate" && input && typeof input === "object") {
    const url = (input as { url?: unknown }).url;
    return `→ ${typeof url === "string" ? url : ""}`;
  }
  if (name === "doco_api" && input && typeof input === "object") {
    const i = input as { method?: unknown; path?: unknown; body?: unknown };
    const method = typeof i.method === "string" ? i.method.toUpperCase() : "GET";
    const path = typeof i.path === "string" ? i.path : "";
    // Parse "/<handle>/api/<type>(/<id>)?.json" so the chip can show
    // what the agent is actually doing instead of a raw URL.
    const m = path.match(/\/api\/([a-z_-]+)(?:\/([^/.]+))?\.(?:json|txt)$/);
    if (m) {
      const type = m[1] ?? "";
      const id = m[2] ?? "";
      const body = i.body as Record<string, unknown> | undefined;
      const proseField = NEURON_PROSE_FIELD[type];
      const label = proseField && body ? firstLine(body[proseField], 60) : "";
      const typeLabel = type.replace(/_/g, " ");
      if (method === "POST" && label) return `Adding ${typeLabel.replace(/s$/, "")}: ${label}`;
      if (method === "POST") return `Adding ${typeLabel.replace(/s$/, "")}`;
      if (method === "PATCH" && id) return `Updating ${typeLabel.replace(/s$/, "")}`;
      if (method === "DELETE" && id) return `Deleting ${typeLabel.replace(/s$/, "")}`;
      if (method === "GET" && id) return `Reading ${typeLabel.replace(/s$/, "")}`;
      if (method === "GET") return `Listing ${typeLabel}`;
    }
    return `${method} ${path}`;
  }
  return name;
}

function Composer({
  value,
  onChange,
  onSend,
  busy,
  username,
  staged,
  queuedCount,
  uploading,
  uploadError,
  onUploadFiles,
  onRemoveStaged,
}: {
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  busy: boolean;
  username: string;
  staged: StagedAttachment[];
  queuedCount: number;
  uploading: boolean;
  uploadError: string | null;
  onUploadFiles: (files: File[]) => void;
  onRemoveStaged: (id: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  });
  const canSend = value.trim().length > 0 || staged.length > 0;
  const queuedLabel = queuedCount === 0 ? null : `${queuedCount} queued`;
  return (
    <div
      className={cn(
        "shrink-0 border-t border-border bg-card px-3 py-2",
        dragOver && "ring-2 ring-primary/40",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) onUploadFiles(files);
      }}
    >
      {staged.length > 0 ? (
        <div className="mb-1.5 space-y-1">
          {staged.map((a) => (
            <div
              key={a.id}
              className="neu-surface flex items-center gap-1.5 rounded-md bg-card px-2 py-1 text-[10px]"
            >
              <span className="font-mono text-muted-foreground">📎</span>
              <span className="truncate">{a.filename}</span>
              <span className="ml-auto text-muted-foreground">{formatBytes(a.size_bytes)}</span>
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() => onRemoveStaged(a.id)}
                className="neu-button rounded px-1 text-muted-foreground hover:bg-input/60 hover:text-foreground"
              >
                ×
              </button>
            </div>
          ))}
          <div className="text-[10px] text-muted-foreground">{ATTACHMENT_RETENTION_NOTICE}</div>
        </div>
      ) : null}
      {uploadError ? (
        <div className="mb-1 rounded-md bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {uploadError}
        </div>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Ask Señor Doco as ${username}…`}
        rows={2}
        className="min-h-[44px] w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:border-primary focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onUploadFiles(files);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />
      <div className="mt-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="neu-button rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-input/60 hover:text-foreground disabled:opacity-50"
            aria-label="Attach a file"
          >
            {uploading ? "Uploading…" : "📎 Attach"}
          </button>
          <div className="text-[10px] text-muted-foreground">
            {queuedLabel ?? "⏎ to send · ⇧⏎ for newline"}
          </div>
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="neu-button rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream event shapes (mirrors ChatStreamEvent in agent-chat.server.ts)
// ---------------------------------------------------------------------------

type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; tool_use_id: string; name: string }
  | { kind: "tool_use_input"; tool_use_id: string; input: unknown }
  | { kind: "tool_use_result"; tool_use_id: string; ok: boolean; preview: string }
  | { kind: "navigate"; url: string }
  | { kind: "message_saved"; message_id: string; role: "user" | "assistant" }
  | {
      kind: "status";
      phase: string;
      detail?: string;
    }
  | {
      kind: "usage_update";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }
  | { kind: "done" }
  | { kind: "error"; message: string };
