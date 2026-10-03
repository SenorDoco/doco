// The instructions to hand an agent, with a Copy button. /agents shows the
// generic block; a workspace's Connect agent page shows it with the line
// that connects the project to that workspace.

import { useState } from "react";

export function AgentInstructionsBlock({
  title,
  instructions,
}: {
  title: string;
  instructions: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <CopyButton text={instructions} />
      </div>
      <pre
        id="instructions"
        className="neu-well min-w-0 whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-input p-5 text-left font-mono text-xs leading-relaxed"
      >
        {instructions}
      </pre>
    </section>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="neu-button shrink-0 rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}
