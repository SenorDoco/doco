import { Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";

interface ChatOperation {
  tool: string;
  description: string;
  applied: boolean;
  error?: string;
  footer_lines?: string[];
  navigate_to?: string;
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

interface SenorDocoChatPaneProps {
  endpoint: string;
  handle: string;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function SenorDocoChatPane({ endpoint, handle }: SenorDocoChatPaneProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const turnCount = turns.length;
  useEffect(() => {
    if (!scrollRef.current) return;
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
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history: priorHistory,
          attachments: encoded,
          currentPath: `${location.pathname}${location.search}`,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        operations?: ChatOperation[];
        mutated?: boolean;
        navigate_to?: string;
        error?: string;
      };
      if (!res.ok) {
        const message = data.error ?? `HTTP ${res.status}`;
        setError(message);
        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `I couldn't complete that: ${message}`,
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
      if (data.navigate_to) {
        navigate(data.navigate_to);
      } else if (data.mutated) {
        revalidator.revalidate();
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      setTurns((prev) => [...prev, { role: "assistant", content: `Network error: ${message}` }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">Señor Doco</h2>
            <p className="truncate text-[11px] text-muted-foreground">{handle}</p>
          </div>
          <div className="h-2 w-2 shrink-0 rounded-full bg-success" aria-label="Online" />
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 space-y-3 overflow-auto px-3 py-3 text-xs">
        {turns.length === 0 ? <EmptyHint onSuggest={send} /> : null}
        {turns.map((turn, idx) => (
          <TurnBubble key={`${turn.role}-${idx}`} turn={turn} />
        ))}
        {pending ? <div className="text-muted-foreground">Thinking...</div> : null}
        {error ? <div className="text-destructive">{error}</div> : null}
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
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-input px-2 py-0.5"
              >
                <span className="truncate font-mono">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${file.name}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
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
          rows={4}
          placeholder="Ask anything about this Doco..."
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
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:border-primary hover:text-primary disabled:opacity-50"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            type="submit"
            disabled={pending || (input.trim().length === 0 && attachments.length === 0)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            aria-label="Send"
            title="Send"
          >
            <Send className="h-4 w-4" />
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
            ? "max-w-[88%] rounded-md bg-primary/15 px-3 py-2 text-foreground"
            : "max-w-[88%] rounded-md border border-border bg-background px-3 py-2 text-foreground"
        }
      >
        {turn.content ? <p className="whitespace-pre-wrap break-words">{turn.content}</p> : null}
        {turn.attachments && turn.attachments.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1 text-[10px]">
            {turn.attachments.map((att, i) => (
              <li
                key={`${att.name}-${i}`}
                className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-card/60 px-1.5 py-0.5"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{att.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(att.size)}</span>
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
                    ? "rounded border border-success/40 bg-success/10 px-2 py-1"
                    : "rounded border border-destructive/40 bg-destructive/10 px-2 py-1"
                }
              >
                <div className="font-mono">
                  {op.applied ? "ok" : "err"} {op.tool}
                </div>
                <div>{op.description}</div>
                {op.error ? <p className="mt-0.5 text-muted-foreground">{op.error}</p> : null}
                {op.footer_lines && op.footer_lines.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {op.footer_lines.map((line) => (
                      <li key={line} className="break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function EmptyHint({ onSuggest }: { onSuggest: (prompt: string) => void }) {
  const suggestions = [
    "Add a decision for the current choice.",
    "Create an intent in #user-flows.",
    "Change this node to planned.",
  ];
  return (
    <div className="space-y-2 text-muted-foreground">
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSuggest(s)}
          className="block w-full rounded-md border border-border px-3 py-2 text-left text-xs hover:border-primary hover:text-foreground"
        >
          {s}
        </button>
      ))}
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
