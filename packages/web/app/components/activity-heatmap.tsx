// GitHub-style activity calendar: 7 rows (days) × N columns (weeks),
// rightmost column is the current week. Cells colored by daily count.
//
// Layout:
//   [day-of-week labels (fixed)] [scrollable: month labels + cells]
//   [Less … More legend]
//
// The day-of-week column lives OUTSIDE the scrollable area so it stays
// pinned to the left at any horizontal scroll position. The legend also
// lives outside the scroll so it's always visible. On mount we set
// `scrollLeft = scrollWidth` so the most recent week is in view.

import { useEffect, useRef, useState } from "react";

interface ActivityHeatmapProps {
  /** Map of yyyy-mm-dd → count of neurons added that day. */
  byDay: Record<string, number>;
  /** Number of week-columns to render. Default 52 (~1 year). */
  weeks?: number;
}

function bucket(n: number): number {
  if (n === 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 7) return 3;
  return 4;
}

const BUCKET_CLASS = [
  "bg-card neu-inset",
  "bg-primary/20",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
];

const BUCKET_LABEL = ["0", "1", "2–3", "4–7", "8+"];

// Row 0 is Sunday (Date#getDay() === 0), row 6 is Saturday.
const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function ActivityHeatmap({ byDay, weeks = 52 }: ActivityHeatmapProps) {
  const today = new Date();
  const totalDays = weeks * 7;
  const days: { date: string; count: number; weekday: number }[] = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = toLocalIso(d);
    days.push({ date: iso, count: byDay[iso] ?? 0, weekday: d.getDay() });
  }
  const firstWeekday = days[0]?.weekday ?? 0;
  const cells: ((typeof days)[number] | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...days,
  ];
  const cols: ((typeof days)[number] | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const slice = cells.slice(i, i + 7);
    while (slice.length < 7) slice.push(null);
    cols.push(slice);
  }

  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let c = 0; c < cols.length; c++) {
    const firstReal = cols[c].find((x) => x != null);
    if (!firstReal) continue;
    const mo = new Date(firstReal.date).getMonth();
    if (mo !== lastMonth) {
      monthLabels.push({
        col: c,
        label: new Date(firstReal.date).toLocaleString(undefined, { month: "short" }),
      });
      lastMonth = mo;
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Default the view to the most recent week.
    el.scrollLeft = el.scrollWidth;
  }, []);

  // Instant hover tooltip — replaces native `title` (which has a ~500ms
  // browser delay). Anchored to the hovered cell via getBoundingClientRect
  // so it floats above the scroll container without clipping.
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  function showTip(e: React.MouseEvent<HTMLElement>, text: string) {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.top });
  }
  function hideTip() {
    setTip(null);
  }

  const cell = "h-[11px] w-[11px] rounded-[2px]";
  // Top padding on the weekday column = month-row height (10px) +
  // gap-1.5 (6px) so the first weekday label aligns with the first
  // data-cell row.
  const weekdayTopPad = "pt-[16px]";

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex gap-1.5">
        {/* Weekday labels — fixed, outside the scroll area. */}
        <div className={`flex flex-col gap-[3px] ${weekdayTopPad}`}>
          {WEEKDAY_LABEL.map((label) => (
            <div
              key={label}
              className="h-[11px] w-[24px] text-[10px] leading-none text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>
        {/* Scrollable region: month labels + data cells. Pin overflow-y
            explicitly — Tailwind's overflow-x-auto otherwise implies
            overflow-y: auto, and the horizontal scrollbar's thickness
            then forces a vertical scrollbar too. */}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {/* `inline-flex` sizes the inner wrap to its content (so the
              horizontal scrollWidth equals the cells' width) but is
              inline-level — its vertical-align defaults to `baseline`,
              which sat the wrap ~9px below the scroll container's top
              and visibly de-aligned every cell row from its weekday
              label. `align-top` pins vertical-align to `top` so row 0
              of cells lines up with row 0 of labels.
              pb-5 reserves 20px below the cells so the horizontal
              scrollbar doesn't clip into the last row (Sat); macOS
              classic scrollbars are 15–17px and pb-3 (12px) was
              under-reserved. */}
          <div className="inline-flex flex-col gap-1.5 pb-5 align-top">
            <div className="flex gap-[3px]">
              {cols.map((col, c) => {
                const m = monthLabels.find((ml) => ml.col === c);
                const firstReal = col.find((x) => x != null);
                const colKey = firstReal?.date ?? "empty";
                return (
                  <div
                    key={`month-${colKey}`}
                    className="w-[11px] text-[10px] leading-none text-muted-foreground"
                  >
                    {m ? <span className="whitespace-nowrap">{m.label}</span> : null}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-[3px]">
              {cols.map((col) => {
                const firstReal = col.find((x) => x != null);
                const colKey = firstReal?.date ?? "empty";
                return (
                  <div key={`cells-${colKey}`} className="flex flex-col gap-[3px]">
                    {col.map((d, di) =>
                      d == null ? (
                        <div key={`empty-${colKey}-${WEEKDAY_LABEL[di]}`} className={cell} />
                      ) : (
                        <div
                          key={d.date}
                          className={`${cell} ${BUCKET_CLASS[bucket(d.count)]}`}
                          aria-label={`${d.date}: ${d.count} neuron${d.count === 1 ? "" : "s"}`}
                          onMouseEnter={(e) =>
                            showTip(e, `${d.date}: ${d.count} neuron${d.count === 1 ? "" : "s"}`)
                          }
                          onMouseLeave={hideTip}
                        />
                      ),
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Legend — outside the scroll area so it's always visible. */}
      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        {BUCKET_CLASS.map((cls, i) => (
          <span
            key={cls}
            className={`${cell} ${cls}`}
            aria-label={BUCKET_LABEL[i]}
            onMouseEnter={(e) => showTip(e, BUCKET_LABEL[i])}
            onMouseLeave={hideTip}
          />
        ))}
        <span>More</span>
      </div>

      {tip ? (
        <div
          role="tooltip"
          className="neu-surface pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-card px-2 py-1 text-xs text-card-foreground"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}
