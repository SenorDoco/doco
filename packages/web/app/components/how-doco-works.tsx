// Alexander's three steps (2026-10-06), in his words. He wrote each as a bold
// lead-in and the rest of the sentence; on 2026-10-07 ("We have titles and
// text after all") the lead-in became the step's title and the rest its text.
const STEPS = [
  {
    title: "Your knowledge is collected",
    text: "Including chats, GitHub, Slack, Notion, and AI agents",
  },
  {
    title: "Agents query such knowledge",
    text: "When agents work, Doco tells them what to keep in mind for their task at hand",
  },
  {
    title: "Agents capture more knowledge",
    text: "Important decisions and chats are collected and shared",
  },
] as const;

/**
 * How Doco works, on the home page and under the invite card: three numbered
 * steps, each a title over its text. Side by side where the block is wide
 * enough (both pages on a computer), one under the other on phones. The
 * numbers are sunk into the page, not raised as keys, since nothing here can
 * be clicked.
 */
export function HowDocoWorks() {
  return (
    <section className="@container flex flex-col items-center gap-6 text-center">
      <h2 className="text-lg font-bold leading-tight md:text-xl">How Doco works:</h2>
      <ol className="grid w-full gap-6 text-left @2xl:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="neu-surface flex flex-col gap-3 rounded-2xl bg-card p-6">
            <span className="neu-well flex size-9 items-center justify-center rounded-full font-bold">
              {i + 1}
            </span>
            <h3 className="text-lg font-bold leading-snug">{step.title}</h3>
            <p className="text-pretty leading-relaxed text-muted-foreground">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
