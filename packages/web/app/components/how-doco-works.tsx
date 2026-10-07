// Alexander's three steps (2026-10-06), in his words: a bold lead-in, then
// the rest of the sentence.
const STEPS = [
  {
    lead: "Your knowledge is collected,",
    rest: "including chats, GitHub, Slack, Notion, and AI agents",
  },
  {
    lead: "Agents query such knowledge:",
    rest: "when agents work, Doco tells them what to keep in mind for their task at hand",
  },
  {
    lead: "Agents capture more knowledge:",
    rest: "important decisions and chats are collected and shared",
  },
] as const;

/**
 * How Doco works, on the home page and under the invite card: three numbered
 * steps. Side by side where the block is wide enough (the home page on a
 * computer), one under the other elsewhere. The numbers are sunk into the
 * page, not raised as keys, since nothing here can be clicked.
 */
export function HowDocoWorks() {
  return (
    <section className="@container flex flex-col items-center gap-6 text-center">
      <h2 className="text-lg font-bold leading-tight md:text-xl">How Doco works:</h2>
      <ol className="grid w-full max-w-3xl gap-5 text-left @2xl:grid-cols-3 @2xl:gap-8">
        {STEPS.map((step, i) => (
          <li
            key={step.lead}
            className="flex items-start gap-4 @2xl:flex-col @2xl:items-center @2xl:text-center"
          >
            <span className="neu-well flex size-9 shrink-0 items-center justify-center rounded-full font-bold">
              {i + 1}
            </span>
            <p className="text-pretty leading-relaxed text-muted-foreground">
              <strong className="text-foreground">{step.lead}</strong> {step.rest}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
