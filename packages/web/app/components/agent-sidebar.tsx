// AgentSidebar — 320px fixed left rail, persistent across SPA navigation.
//
// Mounted from app/root.tsx so its React state outlives the <Outlet/>
// swaps that happen on client-side route changes. Loads the current
// rolling conversation on mount, streams new turns via SSE, and
// re-uses React Router's useNavigate() to follow `navigate` tool
// events from the agent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,.md";

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
}

// "In-flight" assistant message being assembled from a stream.
interface InFlightMessage {
  content: AnyBlock[];
  toolResults: Map<string, ContentBlockToolResult>;
}

const COLLAPSE_KEY = "senor-doco:collapsed";
const UNREAD_KEY = "senor-doco:unread";

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
  // Lazy initializers so SSR doesn't touch localStorage; the first
  // client render hydrates from the stored value.
  const [collapsed, setCollapsed] = useState<boolean>(() => readBoolFlag(COLLAPSE_KEY));
  const [unread, setUnread] = useState<boolean>(() => readBoolFlag(UNREAD_KEY));
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);
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

  // After the first hydration completes, jump straight to the bottom so
  // the user sees the most recent turn. Runs once, after `messages` has
  // been populated by `reload()` (the empty-deps variant fired before
  // the fetch resolved and scrolled an empty list).
  useEffect(() => {
    if (!bootstrapped) return;
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bootstrapped]);

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

  const send = useCallback(async () => {
    const text = inputText.trim();
    const attachmentIds = staged.map((a) => a.id);
    const graphReferenceGroups: GraphReferenceGroup[] = readGraphReferenceGroups();
    if ((!text && attachmentIds.length === 0) || busy) return;
    setInputText("");
    const sentAttachments = staged;
    setStaged([]);
    setUploadError(null);
    setBusy(true);

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
          } else if (event.kind === "tool_use_start") {
            localContent.push({
              type: "tool_use",
              id: event.tool_use_id,
              name: event.name,
              input: {},
            });
            bumpInFlight();
          } else if (event.kind === "tool_use_input") {
            const b = localContent.find(
              (x) => x.type === "tool_use" && (x as ContentBlockToolUse).id === event.tool_use_id,
            ) as ContentBlockToolUse | undefined;
            if (b) {
              b.input = event.input;
              bumpInFlight();
            }
          } else if (event.kind === "tool_use_result") {
            localResults.set(event.tool_use_id, {
              type: "tool_result",
              tool_use_id: event.tool_use_id,
              content: event.preview,
              is_error: !event.ok,
            });
            bumpInFlight();
          } else if (event.kind === "navigate") {
            navigate(event.url);
          } else if (event.kind === "error") {
            localContent.push({ type: "text", text: `[error] ${event.message}` });
            bumpInFlight();
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
    }
  }, [inputText, busy, staged, location.pathname, location.search, navigate]);

  const allMessages = useMemo<RenderableMessage[]>(() => {
    const out: RenderableMessage[] = messages.map((m) => ({ kind: "saved", message: m }));
    if (inFlight) {
      out.push({ kind: "inflight", message: inFlight });
    }
    return out;
  }, [messages, inFlight]);
  const agentActive = busy || inFlight !== null;

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

  if (collapsed) {
    return (
      <CollapsedRail
        label="Señor Doco"
        side="left"
        unread={unread}
        active={agentActive}
        onExpand={() => setCollapsedPersistent(false)}
      />
    );
  }

  return (
    <aside
      className="neu-panel flex h-full w-[320px] shrink-0 flex-col border-r border-border bg-card"
      aria-busy={agentActive}
      aria-label={agentActive ? "Señor Doco, working" : "Señor Doco"}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <DocoMark height={20} variant="mark" active={agentActive} decorative />
          <div className="truncate text-xs font-semibold">Señor Doco</div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsedPersistent(true)}
          className="neu-button rounded p-0.5 text-muted-foreground hover:bg-input hover:text-foreground"
          aria-label="Collapse Señor Doco"
          title="Collapse"
        >
          <CollapseIcon side="left" />
        </button>
      </div>

      <div
        ref={messageListRef}
        onScroll={onMessagesScroll}
        className="flex-1 overflow-y-auto px-3 py-3 text-xs leading-relaxed"
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
            Ask me anything about your Docos — I can search, capture decisions, create new Docos or
            orgs, invite collaborators, and take you to any page.
          </div>
        ) : null}
        {allMessages.map((rm) => (
          <MessageBlock key={rm.kind === "saved" ? rm.message.id : "inflight"} rm={rm} />
        ))}
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
      <DocoMark height={18} variant="mark" active={active} decorative />
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

function MessageBlock({ rm }: { rm: RenderableMessage }) {
  if (rm.kind === "saved") {
    const m = rm.message;
    // A "user" role message that contains only tool_result blocks is
    // bookkeeping in the Anthropic contract — render its results inline
    // with the previous assistant turn (right-aligned + accent bubble)
    // instead of as a fresh "You: …" bubble.
    if (m.role === "user" && m.content.every((b) => b.type === "tool_result")) {
      return (
        <div className="mb-2 flex justify-end">
          <div className="neu-bubble max-w-[90%] space-y-1 rounded-lg bg-primary/10 px-2 py-1.5">
            {m.content.map((b) =>
              b.type === "tool_result" ? <ToolResultRow key={blockKey(b)} result={b} /> : null,
            )}
          </div>
        </div>
      );
    }
    return <SavedMessage message={m} />;
  }
  return <InFlightMessageView msg={rm.message} />;
}

function SavedMessage({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant";
  return (
    <div className={cn("mb-3 flex flex-col", isAssistant ? "items-end" : "items-start")}>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {isAssistant ? "Señor Doco" : "You"}
      </div>
      <div
        className={cn(
          "neu-bubble max-w-[90%] space-y-1.5 rounded-lg px-2.5 py-1.5",
          isAssistant ? "bg-primary/10" : "neu-inset bg-input/60",
        )}
      >
        {message.content.map((b) => (
          <BlockView key={blockKey(b)} block={b} />
        ))}
      </div>
    </div>
  );
}

function InFlightMessageView({ msg }: { msg: InFlightMessage }) {
  return (
    <div className="mb-3 flex flex-col items-end">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Señor Doco
      </div>
      <div className="neu-bubble max-w-[90%] space-y-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5">
        {msg.content.map((b) => {
          if (b.type === "tool_use") {
            const result = msg.toolResults.get(b.id);
            return (
              <div key={blockKey(b)} className="space-y-1">
                <BlockView block={b} />
                {result ? <ToolResultRow result={result} /> : null}
              </div>
            );
          }
          return <BlockView key={blockKey(b)} block={b} />;
        })}
        {msg.content.length === 0 ? (
          <div className="text-muted-foreground">
            <span className="inline-block animate-pulse">…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: AnyBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
  }
  if (block.type === "tool_use") {
    return (
      <div className="neu-inset rounded-md bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
        <div className="break-all font-semibold text-foreground">{toolLabel(block.name, block.input)}</div>
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

function ToolResultRow({ result }: { result: ContentBlockToolResult }) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-all rounded-md px-2 py-1 font-mono text-[10px]",
        result.is_error
          ? "bg-destructive/10 text-destructive"
          : "neu-inset bg-background text-muted-foreground",
      )}
    >
      → {result.content}
    </div>
  );
}

function toolLabel(name: string, input: unknown): string {
  if (name === "navigate" && input && typeof input === "object") {
    const url = (input as { url?: unknown }).url;
    return `navigate(${typeof url === "string" ? url : ""})`;
  }
  if (name === "doco_api" && input && typeof input === "object") {
    const method = (input as { method?: unknown }).method;
    const path = (input as { path?: unknown }).path;
    return `${typeof method === "string" ? method : "?"} ${typeof path === "string" ? path : ""}`;
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
              className="neu-inset flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px]"
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
      <div className="mt-1.5 border-t border-border/70 pt-1.5 text-[10px] leading-snug text-muted-foreground">
        Señor Doco runs on Claude Haiku 4.5 inside Doco. Want to collaborate with your own agent?{" "}
        <Link
          to="/collaborators/invite"
          className="font-semibold text-foreground hover:text-primary"
        >
          Invite them
        </Link>
        .
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
  | { kind: "done" }
  | { kind: "error"; message: string };
