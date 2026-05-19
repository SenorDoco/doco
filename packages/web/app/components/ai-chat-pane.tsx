// Left-rail chat panel on the node detail view.
//
// Project owner types a request in plain English ("change the lifecycle to
// retired", "add this to #important", "tighten the summary"); the panel POSTs
// to the per-node chat endpoint, which calls OpenAI with tool use and
// applies the mutation via the existing capture helpers. The assistant's
// reply renders inline alongside the list of operations that fired.
//
// After a successful mutation we ask react-router to revalidate the parent
// route so the graph + header reflect the new state immediately.

import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

interface ChatOperation {
  tool: string;
  description: string;
  applied: boolean;
  error?: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  operations?: ChatOperation[];
}

interface AiChatPaneProps {
  chatEndpoint: string;
  /** Friendly noun for the placeholder, e.g. "decision" or "rule". */
  nodeTypeLabel: string;
}

export function AiChatPane({ chatEndpoint, nodeTypeLabel }: AiChatPaneProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const turnCount = turns.length;
  useEffect(() => {
    if (!scrollRef.current) return;
    // Reading `turnCount` + `pending` here keeps biome's exhaustive-deps
    // check happy and ensures we re-scroll on every new turn / spinner toggle.
    if (turnCount === 0 && !pending) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turnCount, pending]);

  async function send(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || pending) return;
    setError(null);
    const userTurn: ChatTurn = { role: "user", content: trimmed };
    const priorHistory = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    setPending(true);
    try {
      const res = await fetch(chatEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: priorHistory }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        operations?: ChatOperation[];
        mutated?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Couldn't reach the chat backend: ${data.error ?? `HTTP ${res.status}`}`,
          },
        ]);
        return;
      }
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply ?? "(no reply)",
          operations: data.operations ?? [],
        },
      ]);
      if (data.mutated) revalidator.revalidate();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      setTurns((prev) => [...prev, { role: "assistant", content: `Network error: ${message}` }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          AI chat
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Ask the assistant to change this {nodeTypeLabel}.
        </p>
      </header>
      <div ref={scrollRef} className="flex-1 min-h-0 space-y-3 overflow-auto px-3 py-3 text-xs">
        {turns.length === 0 ? (
          <EmptyHint nodeTypeLabel={nodeTypeLabel} onSuggest={send} />
        ) : (
          turns.map((turn, idx) => <TurnBubble key={`${turn.role}-${idx}`} turn={turn} />)
        )}
        {pending ? <div className="text-muted-foreground">Assistant is thinking…</div> : null}
        {error ? <div className="text-destructive">⚠ {error}</div> : null}
      </div>
      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={3}
          placeholder={`Ask the assistant to change this ${nodeTypeLabel}…`}
          className="block w-full resize-none rounded-md border border-border bg-input px-3 py-2 text-xs focus:border-primary focus:outline-none"
          disabled={pending}
        />
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Enter to send · Shift+Enter for newline</span>
          <button
            type="submit"
            disabled={pending || input.trim().length === 0}
            className="rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TurnBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-md bg-primary/15 px-3 py-2 text-foreground"
            : "max-w-[85%] rounded-md border border-border bg-card px-3 py-2 text-foreground"
        }
      >
        <p className="whitespace-pre-wrap break-words">{turn.content}</p>
        {turn.operations && turn.operations.length > 0 ? (
          <ul className="mt-2 space-y-1 text-[11px]">
            {turn.operations.map((op, i) => (
              <li
                key={`${op.tool}-${i}`}
                className={
                  op.applied
                    ? "rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1"
                    : "rounded border border-destructive/40 bg-destructive/10 px-2 py-1"
                }
              >
                <span className="font-mono">
                  {op.applied ? "✓" : "✗"} {op.tool}
                </span>
                <span className="ml-2">{op.description}</span>
                {op.error ? <p className="mt-0.5 text-muted-foreground">{op.error}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function EmptyHint({
  nodeTypeLabel,
  onSuggest,
}: {
  nodeTypeLabel: string;
  onSuggest: (prompt: string) => void;
}) {
  const suggestions = [
    `Tighten the summary of this ${nodeTypeLabel}.`,
    "Append an update note explaining recent context.",
    "Change the lifecycle to retired.",
  ];
  return (
    <div className="space-y-2 text-muted-foreground">
      <p>Type a request and the assistant will apply it. Examples:</p>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onSuggest(s)}
              className="text-left text-primary hover:underline"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
