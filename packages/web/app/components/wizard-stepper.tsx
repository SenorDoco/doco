const STEPS = [
  { n: 1, label: "Org + name" },
  { n: 2, label: "Constitution" },
  { n: 3, label: "Template" },
  { n: 4, label: "All set" },
] as const;

export function WizardStepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground">
      {STEPS.map((s, i) => {
        const state = s.n < current ? "done" : s.n === current ? "current" : "pending";
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={
                state === "current"
                  ? "inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2 font-semibold text-primary-foreground"
                  : state === "done"
                    ? "inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-primary px-2 font-semibold text-primary"
                    : "inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border px-2"
              }
            >
              {s.n}
            </span>
            <span className={state === "current" ? "font-semibold text-foreground" : ""}>
              {s.label}
            </span>
            {i < STEPS.length - 1 ? <span aria-hidden="true">·</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
