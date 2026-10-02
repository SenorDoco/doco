// The Activity calendars: writes, then queries, then imports, over the same
// weeks (columns, Sunday to Saturday, the current week rightmost). They show
// as many weeks as fit the card, up to a year, so the card never scrolls
// sideways. Each calendar is shaded by its own quarters: a day's shade says
// which quarter of the window's active days it falls in, so one huge import
// day doesn't wash every other day out to the palest shade.

import { useLayoutEffect, useRef, useState } from "react";
import type { DailyActivity } from "~/lib/activity-log.server";

/** How many weeks the calendars show at most (about a year), and so how far
 *  back their counts go. */
export const HEATMAP_WEEKS = 52;

const LABEL_WIDTH = 26;
const GAP = 2;
const MIN_CELL = 8;
const MAX_CELL = 11;
// The width drawn on the server, before the card's own width is known: a
// Doco's side column.
const DEFAULT_WIDTH = 288;

/** How many weeks fit `width`, and how big their squares are. */
export function calendarLayout(width: number) {
  const weeks = Math.max(
    4,
    Math.min(HEATMAP_WEEKS, Math.floor((width - LABEL_WIDTH + GAP) / (MIN_CELL + GAP))),
  );
  const fit = (width - LABEL_WIDTH - (weeks - 1) * GAP) / weeks;
  const cell = Math.min(MAX_CELL, Math.floor(fit * 100) / 100);
  return { weeks, cell, gap: GAP, labelWidth: LABEL_WIDTH };
}

/** Each count's shade, 0 (none) to 4: the active days split into quarters. */
export function shadeLevels(counts: number[]): number[] {
  const active = counts.filter((n) => n > 0).sort((a, b) => a - b);
  const cuts = [1, 2, 3].map(
    (q) => active[Math.floor((active.length * q) / 4)] ?? Number.POSITIVE_INFINITY,
  );
  return counts.map((n) => (n <= 0 ? 0 : 1 + cuts.filter((cut) => n > cut).length));
}

const SHADES = {
  writes: [
    "fill-foreground/[0.08]",
    "fill-primary/30",
    "fill-primary/52",
    "fill-primary/76",
    "fill-primary",
  ],
  queries: [
    "fill-foreground/[0.08]",
    "fill-queries/30",
    "fill-queries/52",
    "fill-queries/76",
    "fill-queries",
  ],
  imports: [
    "fill-foreground/[0.08]",
    "fill-imports/30",
    "fill-imports/52",
    "fill-imports/76",
    "fill-imports",
  ],
} as const;

type Log = keyof typeof SHADES;

/** The calendars, top to bottom, with their names and each count's words. */
const LOGS: { log: Log; name: string; one: string; many: string }[] = [
  { log: "writes", name: "Writes", one: "write", many: "writes" },
  { log: "queries", name: "Queries", one: "query", many: "queries" },
  { log: "imports", name: "Imports", one: "import", many: "imports" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const counted = (n: number, { one, many }: { one: string; many: string }) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const allCounted = (counts: Record<Log, number>) =>
  LOGS.map((l) => counted(counts[l.log], l)).join(", ");
function dayLabel(t: number): string {
  const d = new Date(t);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function ActivityHeatmap({ byDay, now }: { byDay: DailyActivity; now?: Date }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      if (box.clientWidth > 0) setWidth(Math.floor(box.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const { weeks, cell, labelWidth } = calendarLayout(width);
  const step = cell + GAP;
  // Days are UTC, as the counts are.
  const today = Math.floor((now ?? new Date()).getTime() / DAY_MS) * DAY_MS;
  const first = today - (new Date(today).getUTCDay() + (weeks - 1) * 7) * DAY_MS;
  const days: { t: number; col: number; row: number; counts: Record<Log, number> }[] = [];
  for (let t = first, i = 0; t <= today; t += DAY_MS, i++) {
    const iso = isoDay(t);
    days.push({
      t,
      col: Math.floor(i / 7),
      row: i % 7,
      counts: {
        writes: byDay.writes[iso] ?? 0,
        queries: byDay.queries[iso] ?? 0,
        imports: byDay.imports[iso] ?? 0,
      },
    });
  }

  const months: { x: number; label: string }[] = [];
  for (const d of days) {
    if (new Date(d.t).getUTCDate() !== 1) continue;
    const x = labelWidth + d.col * step;
    const last = months[months.length - 1];
    if ((last && x - last.x < 26) || x > width - 20) continue;
    months.push({ x, label: MONTHS[new Date(d.t).getUTCMonth()] });
  }

  const gridHeight = 7 * step - GAP;
  const calendars = LOGS.map(({ log, name }, k) => {
    const counts = days.map((d) => d.counts[log]);
    return {
      log,
      name,
      top: 18 + k * (16 + gridHeight + 14),
      total: counts.reduce((a, n) => a + n, 0),
      levels: shadeLevels(counts),
    };
  });
  const totals = Object.fromEntries(calendars.map((cal) => [cal.log, cal.total])) as Record<
    Log,
    number
  >;
  const height = calendars[calendars.length - 1].top + 16 + gridHeight;

  return (
    <div ref={boxRef} className="w-full min-w-0">
      <svg
        role="img"
        aria-label={`Last ${weeks} weeks: ${allCounted(totals)}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto max-w-full"
        onPointerOver={(e) => {
          const target = e.target as Element;
          const text = target.getAttribute("data-tip");
          if (!text) return;
          const r = target.getBoundingClientRect();
          setTip({ text, x: r.left + r.width / 2, y: r.top });
        }}
        onPointerLeave={() => setTip(null)}
      >
        {months.map((m) => (
          <text key={m.x} x={m.x} y={9} fontSize={10} className="fill-muted-foreground">
            {m.label}
          </text>
        ))}
        {calendars.map((cal) => {
          const gridTop = cal.top + 16;
          return (
            <g key={cal.log}>
              <text x={0} y={cal.top + 9} fontSize={11}>
                <tspan fontWeight={700} className="fill-foreground">
                  {cal.name}
                </tspan>
                <tspan dx={6} className="fill-muted-foreground">
                  {cal.total.toLocaleString("en-US")}
                </tspan>
              </text>
              <Legend shades={SHADES[cal.log]} right={width} top={cal.top + 1} />
              {[1, 3, 5].map((row) => (
                <text
                  key={row}
                  x={0}
                  y={gridTop + row * step + cell / 2 + 3.5}
                  fontSize={10}
                  className="fill-muted-foreground"
                >
                  {WEEKDAYS[row]}
                </text>
              ))}
              {days.map((d, i) => (
                <rect
                  key={d.t}
                  x={labelWidth + d.col * step}
                  y={gridTop + d.row * step}
                  width={cell}
                  height={cell}
                  rx={2}
                  className={SHADES[cal.log][cal.levels[i]]}
                  data-tip={`${dayLabel(d.t)}: ${allCounted(d.counts)}`}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {tip ? (
        <div
          role="tooltip"
          className="neu-floating pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-card px-2 py-1 text-xs text-card-foreground"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}

/** "Less ▢▢▢▢▢ More", right-aligned. */
function Legend({ shades, right, top }: { shades: readonly string[]; right: number; top: number }) {
  const swatch = 9;
  const words = 22;
  const left = right - (words + 4 + shades.length * (swatch + 2) - 2 + 4 + words);
  return (
    <g>
      <text x={left} y={top + swatch - 1} fontSize={10} className="fill-muted-foreground">
        Less
      </text>
      {shades.map((shade, i) => (
        <rect
          key={shade}
          x={left + words + 4 + i * (swatch + 2)}
          y={top}
          width={swatch}
          height={swatch}
          rx={2}
          className={shade}
        />
      ))}
      <text
        x={left + words + 4 + shades.length * (swatch + 2) + 2}
        y={top + swatch - 1}
        fontSize={10}
        className="fill-muted-foreground"
      >
        More
      </text>
    </g>
  );
}
