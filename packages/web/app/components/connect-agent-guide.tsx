// Connecting Doco to the agent a person uses: they pick their agent, and the
// steps for it follow, each page to open in a new tab and each thing to paste
// with a Copy button. A workspace's onboarding, its Invite agent dialog,
// /agents/connect and the Tokens page's Add MCP tab all show it; agents carry
// none of these steps, their instructions send the person to /agents/connect.

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "~/components/agent-instructions-block";
import type { AgentGuide } from "~/lib/agent-connect-guides";
import { cn } from "~/lib/cn";

export function ConnectAgentGuide({
  guides,
  initial = null,
}: {
  guides: readonly AgentGuide[];
  /** The agent picked before the page loaded (`?agent=`), if any. */
  initial?: string | null;
}) {
  const [picked, setPicked] = useState(initial);
  const guide = guides.find((g) => g.id === picked) ?? null;

  return (
    <div className="space-y-4 text-sm">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">Which agent do you use?</legend>
        <div className="flex flex-wrap gap-2 pb-1">
          {guides.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={g.id === picked}
              onClick={() => setPicked(g.id)}
              className={cn(
                "neu-button rounded-md px-3 py-1.5 text-xs font-semibold",
                g.id === picked && "neu-pressed",
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
      </fieldset>
      {guide ? <GuideSteps guide={guide} /> : null}
    </div>
  );
}

function GuideSteps({ guide }: { guide: AgentGuide }) {
  return (
    <section aria-label={`Connect Doco to ${guide.name}`} className="space-y-3">
      {guide.note ? <p className="text-xs text-muted-foreground">{guide.note}</p> : null}
      <ol className="space-y-3">
        {guide.steps.map((step, i) => (
          <li key={step.text} className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-muted-foreground neu-well">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <p>
                {step.text}
                {step.link ? (
                  <>
                    {" "}
                    <GuideLink href={step.link.href}>{step.link.label}</GuideLink>
                  </>
                ) : null}
              </p>
              {step.code ? (
                <div className="flex items-start gap-2">
                  <pre className="neu-well min-w-0 flex-1 whitespace-pre-wrap rounded-md [overflow-wrap:anywhere] bg-input px-3 py-2 font-mono text-xs leading-relaxed">
                    {step.code}
                  </pre>
                  <CopyButton text={step.code} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {guide.docs ? (
        <p className="text-xs text-muted-foreground">
          Stuck? <GuideLink href={guide.docs}>{guide.name}'s own guide</GuideLink> has the details.
        </p>
      ) : null}
    </section>
  );
}

/** A page on the web opens in a new tab, with the new-window icon; a link
 *  that opens an app (Cursor's, VS Code's) opens it in place. */
function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!href.startsWith("https://")) {
    return (
      <a href={href} className="font-semibold">
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-semibold">
      {children}
      <ExternalLink aria-hidden className="ml-0.5 inline h-3 w-3 align-[-0.125em]" />
    </a>
  );
}
