// AgentSidebar — 320px fixed left rail, persistent across SPA navigation.
//
// Mounted from app/root.tsx so its React state outlives the <Outlet/>
// swaps that happen on client-side route changes. Loads the current
// rolling conversation on mount, streams new turns via SSE, and
// re-uses React Router's useNavigate() to follow `navigate` tool
// events from the agent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "~/lib/cn";
import type { CurrentPrincipal } from "~/lib/session";

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
type AnyBlock = ContentBlockText | ContentBlockToolUse | ContentBlockToolResult;

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: AnyBlock[];
  created_at: string;
}

interface ConversationSnapshot {
  conversation_id: string;
  messages: ChatMessage[];
}

// "In-flight" assistant message being assembled from a stream.
interface InFlightMessage {
  content: AnyBlock[];
  toolResults: Map<string, ContentBlockToolResult>;
}

export function AgentSidebar({ me }: { me: CurrentPrincipal }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inFlight, setInFlight] = useState<InFlightMessage | null>(null);
  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [inFlight]);

  const send = useCallback(async () => {
    const text = inputText.trim();
    if (!text || busy) return;
    setInputText("");
    setBusy(true);

    // Local accumulator — sole source of truth for what to commit at end
    // of stream. React state lags async updates, so we can't read it from
    // inside `finally`. We mirror every update into this object AND into
    // React state, then commit `local*` once `done` fires.
    const localContent: AnyBlock[] = [];
    const localResults = new Map<string, ContentBlockToolResult>();
    setInFlight({ content: localContent, toolResults: localResults });

    const localUser: ChatMessage = {
      id: `local_${Date.now()}`,
      role: "user",
      content: [{ type: "text", text }],
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
        body: JSON.stringify({ text, current_path: location.pathname + location.search }),
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
        let nlIdx: number;
        // Parse SSE frames: separated by \n\n, each frame is `data: <json>`.
        while ((nlIdx = buf.indexOf("\n\n")) >= 0) {
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
  }, [inputText, busy, location.pathname, location.search, navigate]);

  const allMessages = useMemo<RenderableMessage[]>(() => {
    const out: RenderableMessage[] = messages.map((m) => ({ kind: "saved", message: m }));
    if (inFlight) {
      out.push({ kind: "inflight", message: inFlight });
    }
    return out;
  }, [messages, inFlight]);

  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-r border-border bg-card"
      aria-label="Señor Doco"
    >
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
        <div className="text-xs font-semibold">Señor Doco</div>
      </div>

      <div
        ref={messageListRef}
        className="flex-1 overflow-y-auto px-3 py-3 text-xs leading-relaxed"
      >
        {loadError ? (
          <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            Couldn't load chat history: {loadError}
          </div>
        ) : null}
        {allMessages.length === 0 && !loadError ? (
          <div className="text-[11px] text-muted-foreground">
            Ask me anything about your Docos — I can search, capture decisions, create new Docos or
            orgs, invite collaborators, and take you to any page.
          </div>
        ) : null}
        {allMessages.map((rm, idx) => (
          <MessageBlock key={rm.kind === "saved" ? rm.message.id : `inflight-${idx}`} rm={rm} />
        ))}
      </div>

      <Composer
        value={inputText}
        onChange={setInputText}
        onSend={send}
        busy={busy}
        username={me.username}
      />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type RenderableMessage =
  | { kind: "saved"; message: ChatMessage }
  | { kind: "inflight"; message: InFlightMessage };

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
          <div className="max-w-[90%] space-y-1 rounded-lg bg-primary/10 px-2 py-1.5">
            {m.content.map((b, i) =>
              b.type === "tool_result" ? <ToolResultRow key={i} result={b} /> : null,
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
          "max-w-[90%] space-y-1.5 rounded-lg px-2.5 py-1.5",
          isAssistant ? "bg-primary/10" : "bg-input/60",
        )}
      >
        {message.content.map((b, i) => (
          <BlockView key={i} block={b} />
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
      <div className="max-w-[90%] space-y-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5">
        {msg.content.map((b, i) => {
          if (b.type === "tool_use") {
            const result = msg.toolResults.get(b.id);
            return (
              <div key={i} className="space-y-1">
                <BlockView block={b} />
                {result ? <ToolResultRow result={result} /> : null}
              </div>
            );
          }
          return <BlockView key={i} block={b} />;
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
      <div className="rounded-md bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
        <div className="font-semibold text-foreground">{toolLabel(block.name, block.input)}</div>
      </div>
    );
  }
  if (block.type === "tool_result") {
    return <ToolResultRow result={block} />;
  }
  return null;
}

function ToolResultRow({ result }: { result: ContentBlockToolResult }) {
  return (
    <div
      className={cn(
        "rounded-md px-2 py-1 font-mono text-[10px]",
        result.is_error ? "bg-destructive/10 text-destructive" : "bg-background text-muted-foreground",
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
}: {
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  busy: boolean;
  username: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [value]);
  return (
    <div className="shrink-0 border-t border-border bg-card px-3 py-2">
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
      <div className="mt-1 flex items-center justify-between">
        <div className="text-[10px] text-muted-foreground">
          ⏎ to send · ⇧⏎ for newline
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={busy || value.trim().length === 0}
          className="rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
  | { kind: "done" }
  | { kind: "error"; message: string };
