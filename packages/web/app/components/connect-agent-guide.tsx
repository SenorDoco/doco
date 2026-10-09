// Connecting Doco to an agent: every agent's ways in, each under its name
// (in a terminal, or in its desktop app), each step with its thing to paste
// and a Copy button; pick an agent and only its ways stay. A workspace's
// setup shows it as the step before the message for the agent, and
// /agents/connect shows it to anyone, with every agent's steps in the page
// as served (Alexander, 2026-10-09: a page read as text had three names and
// nothing else), so nothing waits on a pick.

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "~/components/agent-instructions-block";
import type { AgentGuide, GuideWay } from "~/lib/agent-connect-guides";
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
  const shown = guides.filter((g) => g.id === picked);

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
      {(shown.length > 0 ? shown : guides).map((g) => (
        <GuideWays key={g.id} guide={g} />
      ))}
    </div>
  );
}

function GuideWays({ guide }: { guide: AgentGuide }) {
  return (
    <section aria-label={`Connect Doco to ${guide.name}`} className="space-y-3">
      <h2 className="text-sm font-semibold">{guide.name}</h2>
      {guide.note ? <p className="text-xs text-muted-foreground">{guide.note}</p> : null}
      {guide.ways.map((way) => (
        <WaySteps key={way.name} way={way} />
      ))}
      <p className="text-xs text-muted-foreground">
        Stuck?{" "}
        <a href={guide.docs} target="_blank" rel="noreferrer" className="font-semibold">
          {guide.name}'s own guide
          <ExternalLink aria-hidden className="ml-0.5 inline h-3 w-3 align-[-0.125em]" />
        </a>{" "}
        has the details.
      </p>
    </section>
  );
}

function WaySteps({ way }: { way: GuideWay }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-muted-foreground">{way.name}</h3>
      <ol className="space-y-3">
        {way.steps.map((step, i) => (
          <li key={step.text} className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-muted-foreground neu-well">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <p>{step.text}</p>
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
    </div>
  );
}
