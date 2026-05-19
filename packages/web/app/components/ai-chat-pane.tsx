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

interface ChatAttachmentMeta {
  name: string;
  size: number;
  mime: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  operations?: ChatOperation[];
  attachments?: ChatAttachmentMeta[];
}

interface AiChatPaneProps {
  chatEndpoint: string;
  /** Friendly noun for the placeholder, e.g. "decision" or "rule". */
  nodeTypeLabel: string;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function AiChatPane({ chatEndpoint, nodeTypeLabel }: AiChatPaneProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const revalidator = useRevalidator();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const turnCount = turns.length;
  useEffect(() => {
    if (!scrollRef.current) return;
    // Reading `turnCount` + `pending` here keeps biome's exhaustive-deps
    // check happy and ensures we re-scroll on every new turn / spinner toggle.
    if (turnCount === 0 && !pending) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turnCount, pending]);

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setAttachments((prev) => {
      const next = [...prev, ...Array.from(picked)];
      const total = next.reduce((s, f) => s + f.size, 0);
      if (total > MAX_ATTACHMENT_BYTES) {
        setError(
          `Total attachment size ${(total / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cap.`,
        );
      } else {
        setError(null);
      }
      return next;
    });
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  async function send(prompt: string) {
    const trimmed = prompt.trim();
    if (pending) return;
    if (!trimmed && attachments.length === 0) return;
    const totalSize = attachments.reduce((s, f) => s + f.size, 0);
    if (totalSize > MAX_ATTACHMENT_BYTES) {
      setError(
        `Total attachment size ${(totalSize / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cap.`,
      );
      return;
    }
    setError(null);
    const encoded = await Promise.all(attachments.map(fileToAttachment));
    const userTurn: ChatTurn = {
      role: "user",
      content: trimmed,
      attachments: attachments.map((f) => ({ name: f.name, size: f.size, mime: f.type })),
    };
    const priorHistory = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setPending(true);
    try {
      const res = await fetch(chatEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history: priorHistory,
          attachments: encoded,
        }),
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
    <div className="flex h-full min-h-0 flex-col bg-accent/5">
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
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1 text-[10px]">
            {attachments.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-input px-2 py-0.5"
              >
                <span className="font-mono">{file.name}</span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${file.name}`}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => addFiles(e.target.files)}
          className="sr-only"
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] hover:border-primary hover:text-foreground disabled:opacity-50"
            aria-label="Attach files"
          >
            📎 Attach
          </button>
          <span className="flex-1 truncate">Enter to send · Shift+Enter for newline</span>
          <button
            type="submit"
            disabled={pending || (input.trim().length === 0 && attachments.length === 0)}
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
        {turn.content ? <p className="whitespace-pre-wrap break-words">{turn.content}</p> : null}
        {turn.attachments && turn.attachments.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1 text-[10px]">
            {turn.attachments.map((att, i) => (
              <li
                key={`${att.name}-${i}`}
                className="inline-flex items-center gap-1 rounded border border-border/60 bg-card/60 px-1.5 py-0.5"
              >
                <span aria-hidden>📎</span>
                <span className="font-mono">{att.name}</span>
                <span className="text-muted-foreground">{formatBytes(att.size)}</span>
              </li>
            ))}
          </ul>
        ) : null}
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToAttachment(
  file: File,
): Promise<{ name: string; mime: string; size: number; dataUrl: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
  return {
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    dataUrl,
  };
}
