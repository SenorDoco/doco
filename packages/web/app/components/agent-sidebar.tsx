// AgentSidebar — 320px fixed left rail, persistent across SPA navigation.
//
// Mounted from app/root.tsx so its React state outlives the <Outlet/>
// swaps that happen on client-side route changes. Loads the current
// rolling conversation on mount, streams new turns via SSE, and
// re-uses React Router's useNavigate() to follow `navigate` tool
// events from the agent.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { cn } from "~/lib/cn";
import { type GraphReferenceGroup, readGraphReferenceGroups } from "~/lib/graph-references";
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

interface ConversationSnapshot {
  conversation_id: string;
  messages: ChatMessage[];
  has_more: boolean;
  /**
   * ISO timestamp the server set when the current turn started; null
   * when idle. Lets a freshly-loaded page show the in-flight bubble
   * for a turn its tab didn't initiate.
   */
  active_turn_started_at: string | null;
}

/** Per-request token totals streamed from the server. Reset to null
 *  whenever Señor Doco settles (no in-flight + no remote in-flight). */
interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

// If the server's `active_turn_started_at` is older than this, treat
// it as stale (lambda probably crashed before clearing the marker)
// and ignore it rather than showing a never-ending placeholder.
const ACTIVE_TURN_STALE_MS = 5 * 60 * 1000;

// "In-flight" assistant message being assembled from a stream.
interface InFlightMessage {
  content: AnyBlock[];
  toolResults: Map<string, ContentBlockToolResult>;
}

const COLLAPSE_KEY = "senor-doco:collapsed";
const UNREAD_KEY = "senor-doco:unread";
const SHOW_THINKING_KEY = "senor-doco:show-thinking";

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
  // Another tab on this origin is currently streaming a reply. Used
  // to show a "Señor Doco is replying…" placeholder bubble in tabs
  // that didn't initiate the send.
  const [remoteInflight, setRemoteInflight] = useState(false);
  // Per-request token usage for the in-flight turn. Updated as the
  // server streams usage_update events; cleared on settle. Shown next
  // to the in-flight bubble so the user sees what THIS request is
  // costing in real time (not the session-wide total).
  const [turnUsage, setTurnUsage] = useState<TurnUsage | null>(null);
  // Queued send. When the user hits Send while Señor Doco is
  // mid-reply, the typed text + staged attachments land here and
  // auto-fire once the current turn settles. Lets the user keep
  // typing without losing the message; respects the Anthropic
  // user→assistant→user alternation by not racing a second turn.
  const [queuedSend, setQueuedSend] = useState<{
    text: string;
    staged: StagedAttachment[];
  } | null>(null);
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
  // expanded (320), and Show-Thinking expanded (640).
  const railWidth = collapsed ? RAIL_COLLAPSED : showThinking ? RAIL_THINKING : RAIL_DEFAULT;
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
  // Tracks the earliest loaded message so concurrent state reads (the
  // scroll handler closes over stale `messages`) always page from the
  // true top of the loaded window.
  const earliestRef = useRef<ChatMessage | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/agent-chat/conversation.json", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ConversationSnapshot;
      setMessages(data.messages);
      setHasMore(data.has_more);
      earliestRef.current = data.messages[0] ?? null;
      setLoadError(null);
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
  }, []);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

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
      const url = `/api/v1/agent-chat/conversation.json?before=${encodeURIComponent(earliest.created_at)}`;
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
  }, []);

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
      if (busy && !override) {
        setQueuedSend({ text, staged: sentAttachments });
        setInputText("");
        setStaged([]);
        return;
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
      setInFlight({ content: localContent, toolResults: localResults });

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
      setMessages((prev) => [...prev, localUser]);

      const controller = new AbortController();
      abortRef.current = controller;

      const bumpInFlight = () =>
        setInFlight({
          content: [...localContent],
          toolResults: new Map(localResults),
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
          }),
          signal: controller.signal,
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
            } else if (event.kind === "navigate") {
              navigate(event.url);
              appendThinking({ kind: "navigate", url: event.url });
            } else if (event.kind === "message_saved") {
              // Server just persisted a user or assistant message. Tell
              // other tabs so they re-fetch the canonical snapshot and
              // see the message in real time.
              broadcastSync({ kind: "changed" });
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
            id: `local_${Date.now() + 1}`,
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
      }
    },
    [
      inputText,
      busy,
      staged,
      location.pathname,
      location.search,
      navigate,
      broadcastSync,
      appendThinking,
    ],
  );

  // Queue-drain: when Señor Doco settles AND a message is queued
  // from a busy-send, auto-fire it. Passing the message as an
  // `override` bypasses the re-queue check inside `send`.
  useEffect(() => {
    if (busy || !queuedSend) return;
    const q = queuedSend;
    setQueuedSend(null);
    void send(q);
  }, [busy, queuedSend, send]);

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
        message: { content: [], toolResults: new Map() },
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

  // Authorization / sign-in flows render in a single-tab focus mode —
  // the Señor Doco chat is force-minimized so it doesn't distract from
  // the consent decision (`/device`, `/oauth/authorize`, `/invite/<code>`)
  // or the OAuth round-trip pages (`/auth/*`). The user can still
  // expand the rail manually, but the default + every navigation back
  // to an auth page snaps it back to collapsed.
  const isAuthPage =
    location.pathname === "/device" ||
    location.pathname.startsWith("/oauth/authorize") ||
    location.pathname.startsWith("/invite/") ||
    location.pathname === "/sign-in" ||
    location.pathname === "/sign-out" ||
    location.pathname.startsWith("/auth/");

  // Single-element render: the aside is always present so its
  // width transition runs for BOTH the show-thinking expansion AND
  // the chevron-click collapse. Content swaps based on `collapsedDisplay`,
  // and `overflow-hidden` keeps the inner content from spilling while
  // the width animates.
  const collapsedDisplay = collapsed || isAuthPage;

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
          className="group relative flex h-full w-full shrink-0 cursor-pointer flex-col items-center gap-2 py-3 hover:bg-input"
        >
          <CollapseIcon side="right" />
          <div
            className="select-none text-[11px] font-semibold uppercase tracking-wider text-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Señor Doco
          </div>
          {unread ? (
            <span
              aria-label="unread"
              className="h-2 w-2 rounded-full bg-primary"
              style={{ boxShadow: "0 0 0 2px var(--color-card)" }}
            />
          ) : null}
        </button>
      ) : (
        <>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-xs font-semibold">Señor Doco</div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Show-thinking toggle. Sits left of the collapse chevron;
              pressed when on (neu-pressed), raised when off
              (neu-button) — same depth treatment as the rest of the
              platform's buttons. */}
          <button
            type="button"
            onClick={toggleShowThinking}
            aria-pressed={showThinking}
            aria-label={showThinking ? "Hide thinking column" : "Show thinking column"}
            title={showThinking ? "Hide thinking column" : "Show thinking column"}
            className={cn(
              "rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide",
              showThinking
                ? "neu-pressed bg-input text-foreground"
                : "neu-button text-muted-foreground hover:bg-input hover:text-foreground",
            )}
          >
            {showThinking ? "Hide thinking" : "Show thinking"}
          </button>
          <button
            type="button"
            onClick={() => setCollapsedPersistent(true)}
            className="neu-button rounded-md border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-input hover:text-foreground"
            aria-label="Collapse Señor Doco"
            title="Collapse"
          >
            <CollapseIcon side="left" />
          </button>
        </div>
      </div>

      {/* Persistent "what this is" line, sitting right under the title so
          new collaborators immediately know what Señor Doco is and how to
          mint a token for their own agent. */}
      <div className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
        Señor Doco runs on Claude Haiku 4.5 inside Doco. Want to collaborate with your own agent?{" "}
        <Link to="/api-keys" className="font-semibold text-foreground hover:text-primary">
          Invite it
        </Link>
        .
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={messageListRef}
          onScroll={onMessagesScroll}
          className={cn(
            "min-h-0 overflow-y-auto px-3 py-3 text-xs leading-relaxed",
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
              Ask me anything about your Docos — I can search, capture decisions, create new Docos
              or orgs, invite collaborators, and take you to any page.
            </div>
          ) : null}
          {allMessages.map((rm) => (
            <MessageBlock
              key={rm.kind === "saved" ? rm.message.id : "inflight"}
              rm={rm}
              usage={rm.kind === "inflight" ? turnUsage : null}
            />
          ))}
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
        busy={busy}
        username={me.username}
        staged={staged}
        uploading={uploading}
        uploadError={uploadError}
        onUploadFiles={uploadFiles}
        onRemoveStaged={removeStaged}
      />
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
      <CollapseIcon side={isLeft ? "right" : "left"} />
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

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function MessageBlock({ rm, usage }: { rm: RenderableMessage; usage: TurnUsage | null }) {
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
    return <SavedMessage message={m} />;
  }
  return <InFlightMessageView msg={rm.message} usage={usage} />;
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

function SavedMessage({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant";
  const visible = visibleChatBlocks(message.content);
  // Whole message was tool-call noise → skip the bubble. Detailed
  // tool activity is still in the Thinking column.
  if (visible.length === 0) return null;
  return (
    <div className={cn("mb-3 flex flex-col", isAssistant ? "items-end" : "items-start")}>
      <div
        className={cn(
          "neu-bubble max-w-[90%] space-y-1.5 rounded-lg px-2.5 py-1.5",
          isAssistant ? "bg-primary/10" : "neu-surface bg-card",
        )}
      >
        {visible.map((b) => (
          <BlockView key={blockKey(b)} block={b} />
        ))}
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
}: {
  msg: InFlightMessage;
  usage: TurnUsage | null;
}) {
  // tool_use / tool_result chips live in the Thinking column; the
  // main chat only sees text + attachments.
  const visible = visibleChatBlocks(msg.content);
  // Pre-text "thinking" state: no bubble, no pulsing dots, no label —
  // just the doco mark at 2× normal size. Persists until the model
  // emits the first text delta of the turn.
  if (visible.length === 0) {
    return (
      <div className="mb-3 flex justify-end pr-1">
        <DocoMark height={28} variant="mark" active decorative />
      </div>
    );
  }
  // Once text streams in, render the bubble normally AND keep the
  // animated doco mark below it. The animation only disappears when
  // the turn fully settles and the in-flight view unmounts — so
  // mid-stream pauses (e.g. between tool round trips on a multi-
  // call turn) still show the thinking cue.
  return (
    <div className="mb-3 flex flex-col items-end">
      <div className="neu-bubble max-w-[90%] space-y-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5">
        {visible.map((b) => (
          <BlockView key={blockKey(b)} block={b} />
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <DocoMark height={14} variant="mark" active decorative />
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
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card/50">
      <div className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Thinking {active ? <span className="ml-1 animate-pulse">●</span> : null}
        <span className="ml-2 font-mono normal-case">{events.length} events</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-[11px] font-mono leading-snug">
        {events.length === 0 ? (
          <div className="px-1 py-2 text-muted-foreground">
            {active
              ? "(waiting for first event…)"
              : "(no thinking yet — send a message to see what Señor Doco does)"}
          </div>
        ) : (
          events.map((ev) => <ThinkingRow key={ev.id} ev={ev} />)
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

function BlockView({ block }: { block: AnyBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
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
  const canSend = !busy && (value.trim().length > 0 || staged.length > 0);
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
        disabled={busy}
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
            disabled={busy || uploading}
            className="neu-button rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-input/60 hover:text-foreground disabled:opacity-50"
            aria-label="Attach a file"
          >
            {uploading ? "Uploading…" : "📎 Attach"}
          </button>
          <div className="text-[10px] text-muted-foreground">⏎ to send · ⇧⏎ for newline</div>
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="neu-button rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
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
