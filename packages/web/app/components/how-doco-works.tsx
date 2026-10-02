import { Bot, MousePointer2, Sparkles, Terminal, Users } from "lucide-react";
import { type CSSProperties, type ComponentType, useEffect, useRef, useState } from "react";
import { GitHubIcon, NotionIcon, SlackIcon } from "~/components/brand-icons";
import { DocoMark } from "~/components/doco-mark";

// Alexander's three steps (2026-10-01), in his words.
const STEPS = [
  { verb: "Collect", line: "One workspace brings your team's knowledge together." },
  { verb: "Connect", line: "Your agents read that context as they work." },
  { verb: "Capture", line: "Agents record important decisions." },
] as const;

/** How long the diagram spends on each step. */
const STEP_MS = 3400;

type Glyph = ComponentType<{ className: string }>;
interface Chip {
  label: string;
  /** Absent on the "+ more" chip that ends each column. */
  Icon?: Glyph;
}

// Alexander, 2026-10-02: people first among the sources; Claude (not Claude
// Code) and Qwen among the agents; and each column says there are more.
const SOURCES: Chip[] = [
  { label: "People", Icon: Users },
  { label: "GitHub", Icon: GitHubIcon },
  { label: "Slack", Icon: SlackIcon },
  { label: "Notion", Icon: NotionIcon },
  { label: "+ more" },
];
const AGENTS: Chip[] = [
  { label: "Claude", Icon: Sparkles },
  { label: "Cursor", Icon: MousePointer2 },
  { label: "Codex", Icon: Terminal },
  { label: "Qwen", Icon: Bot },
  { label: "+ more" },
];

/** The wires lit in each step: sources in, agents out, and agents back. */
const LIT = ["src", "agent", "back"] as const;
/** The pulses that travel each step's wires: one per wire, three back. */
const PULSES = [SOURCES.length, AGENTS.length, 3].flatMap((count, s) =>
  Array.from({ length: count }, (_, j) => ({ id: `${s}-${j}`, s, k: s === 2 ? 0 : j, j })),
);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Label {
  text: string;
  x: number;
  y: number;
  anchor?: "middle" | "end";
  className: "hdw-hdr" | "hdw-back-label";
}
/**
 * Where everything sits in a diagram, in the SVG's units. The wires, labels
 * and pulses are drawn in the SVG; the chips and the workspace are HTML laid
 * over it at the same coordinates (as shares of the diagram, so they scale
 * with it), which lets them wear the app's shadows. The CSS turns one unit
 * into pixels as --u.
 */
interface Layout {
  className: "hdw-dia-desktop" | "hdw-dia-phone";
  width: number;
  height: number;
  sources: Box[];
  agents: Box[];
  srcWire: (chip: Box) => string;
  agentWire: (chip: Box) => string;
  backWire: string;
  ws: Box;
  labels: Label[];
  pulse: { halo: number; dot: number };
}

// Sources in a column on the left, agents in one on the right, both centred
// on the workspace between them. The return wire leaves the bottom of the
// agents column and comes back up under the workspace.
const DESKTOP: Layout = (() => {
  const column = (x: number): Box[] =>
    [0, 1, 2, 3, 4].map((k) => ({ x, y: 20 + k * 54, w: 132, h: 36 }));
  const ws = { x: 270, y: 94, w: 180, h: 104 };
  const wsMid = ws.y + ws.h / 2;
  return {
    className: "hdw-dia-desktop",
    width: 720,
    height: 326,
    sources: column(0),
    agents: column(588),
    srcWire: (c) =>
      `M${c.x + c.w} ${c.y + c.h / 2} C 200 ${c.y + c.h / 2}, 200 ${wsMid}, ${ws.x} ${wsMid}`,
    agentWire: (c) =>
      `M${ws.x + ws.w} ${wsMid} C 520 ${wsMid}, 520 ${c.y + c.h / 2}, ${c.x} ${c.y + c.h / 2}`,
    backWire: `M654 276 C 654 338, 360 338, 360 ${ws.y + ws.h}`,
    ws,
    labels: [
      { text: "Sources", x: 0, y: 9, className: "hdw-hdr" },
      {
        text: "Workspace",
        x: ws.x + ws.w / 2,
        y: ws.y - 10,
        anchor: "middle",
        className: "hdw-hdr",
      },
      { text: "Agents", x: 720, y: 9, anchor: "end", className: "hdw-hdr" },
      {
        text: "decisions, rules, logs",
        x: 507,
        y: 301,
        anchor: "middle",
        className: "hdw-back-label",
      },
    ],
    pulse: { halo: 9, dot: 4 },
  };
})();

// Upright: a row of sources on top, the workspace below, a row of agents at
// the bottom, and the return wire climbing the right-hand side. Chips are as
// wide as their label needs so that five fit in a row.
const PHONE: Layout = (() => {
  const chipH = 32;
  const width = 372;
  const gap = 5;
  /** A row of chips of the given widths, centred across the diagram. */
  const row = (y: number, widths: number[]): Box[] => {
    const boxes: Box[] = [];
    let x = (width - widths.reduce((sum, w) => sum + w + gap, -gap)) / 2;
    for (const w of widths) {
      boxes.push({ x, y, w, h: chipH });
      x += w + gap;
    }
    return boxes;
  };
  const ws = { x: 111, y: 140, w: 150, h: 92 };
  const wsMid = ws.x + ws.w / 2;
  const sources = row(22, [64, 66, 58, 65, 48]);
  const agents = row(318, [65, 65, 62, 60, 48]);
  const last = agents[agents.length - 1];
  return {
    className: "hdw-dia-phone",
    width,
    height: 378,
    sources,
    agents,
    srcWire: (c) =>
      `M${c.x + c.w / 2} ${c.y + c.h} C ${c.x + c.w / 2} 100, ${wsMid} 96, ${wsMid} ${ws.y}`,
    agentWire: (c) =>
      `M${wsMid} ${ws.y + ws.h} C ${wsMid} 285, ${c.x + c.w / 2} 275, ${c.x + c.w / 2} ${c.y}`,
    backWire: `M${last.x + last.w} ${last.y + last.h / 2} C 366 ${last.y + last.h / 2}, 366 186, ${ws.x + ws.w} 186`,
    ws,
    labels: [
      { text: "Sources", x: sources[0].x, y: 11, className: "hdw-hdr" },
      { text: "Agents", x: agents[0].x, y: 370, className: "hdw-hdr" },
    ],
    pulse: { halo: 8, dot: 3.5 },
  };
})();

/** A box's place in its diagram, as shares of it, so it scales with it. */
function place(box: Box, layout: Layout): CSSProperties {
  const share = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
  return {
    left: share(box.x, layout.width),
    top: share(box.y, layout.height),
    width: share(box.w, layout.width),
    height: share(box.h, layout.height),
  };
}

function ChipNode({
  chip,
  box,
  layout,
  on,
}: { chip: Chip; box: Box; layout: Layout; on: boolean }) {
  const { Icon } = chip;
  const className = `hdw-chip${Icon ? "" : " hdw-chip-more"}${on ? " hdw-on" : ""}`;
  return (
    <div className={className} style={place(box, layout)}>
      {Icon ? <Icon className="hdw-ic" /> : null}
      <span>{chip.label}</span>
    </div>
  );
}

/** One pulse that the frame loop moves along a wire; hidden until it does. */
function Pulse({ s, k, j, layout }: { s: number; k: number; j: number; layout: Layout }) {
  return (
    <g className="hdw-pulse" data-s={s} data-k={k} data-j={j} style={{ display: "none" }}>
      <circle className="hdw-pulse-halo" r={layout.pulse.halo} />
      <circle className="hdw-pulse-dot" r={layout.pulse.dot} />
    </g>
  );
}

function Flow({ layout, step }: { layout: Layout; step: number }) {
  const lit = LIT[step];
  const wire = (kind: (typeof LIT)[number], k: number, d: string) => (
    <path
      key={`${kind}${k}`}
      className={`hdw-wire hdw-wire-${kind}${lit === kind ? " hdw-on" : ""}`}
      data-s={LIT.indexOf(kind)}
      data-k={k}
      d={d}
    />
  );
  const size = {
    aspectRatio: `${layout.width} / ${layout.height}`,
    "--u": `calc(100cqw / ${layout.width})`,
  } as CSSProperties;
  return (
    <div className={`hdw-dia ${layout.className}`} style={size} aria-hidden="true">
      <svg className="hdw-flow" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.labels.map((label) => (
          <text
            key={label.text}
            className={label.className}
            x={label.x}
            y={label.y}
            textAnchor={label.anchor}
          >
            {label.text}
          </text>
        ))}
        {layout.sources.map((box, k) => wire("src", k, layout.srcWire(box)))}
        {layout.agents.map((box, k) => wire("agent", k, layout.agentWire(box)))}
        {wire("back", 0, layout.backWire)}
        {PULSES.map((pulse) => (
          <Pulse key={pulse.id} s={pulse.s} k={pulse.k} j={pulse.j} layout={layout} />
        ))}
      </svg>
      {SOURCES.map((chip, k) => (
        <ChipNode
          key={chip.label}
          chip={chip}
          box={layout.sources[k]}
          layout={layout}
          on={step === 0}
        />
      ))}
      {AGENTS.map((chip, k) => (
        <ChipNode
          key={chip.label}
          chip={chip}
          box={layout.agents[k]}
          layout={layout}
          on={step > 0}
        />
      ))}
      <div className="hdw-ws" style={place(layout.ws, layout)}>
        <DocoMark variant="mark" height={44} decorative className="hdw-orb" />
        <span>Your workspace</span>
      </div>
    </div>
  );
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
/** Ease in and out, so a pulse leaves and arrives gently. */
function ease(u: number): number {
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
}

/**
 * How Doco works, on the home page and under the invite card: a wiring
 * diagram of what Doco is, on one raised plate. Sources on the left feed the
 * workspace, agents on the right read it, and a return wire carries what
 * they write back. The three steps sit under it; the diagram moves from
 * step to step on its own, lighting that step's wires and filling its bar,
 * and holds a step that is clicked. The wires, chips and current step are
 * React's; the pulses on the wires and the bars' fill are drawn by a frame
 * loop that writes straight to the DOM, since they move every frame.
 */
export function HowDocoWorks() {
  const [step, setStep] = useState(0);
  const [held, setHeld] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const stepRef = useRef(0);
  const startRef = useRef(0);

  useEffect(() => {
    stepRef.current = step;
    startRef.current = performance.now();
  }, [step]);

  useEffect(() => {
    if (held || reducedMotion()) return;
    const timer = setInterval(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => clearInterval(timer);
  }, [held]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reducedMotion() || typeof requestAnimationFrame !== "function") return;
    const bars = [...root.querySelectorAll<HTMLElement>(".hdw-step")];
    const diagrams = [...root.querySelectorAll<HTMLElement>(".hdw-dia")].map((dia) => ({
      ws: dia.querySelector<HTMLElement>(".hdw-ws"),
      pulses: [...dia.querySelectorAll<SVGGElement>(".hdw-pulse")].map((g) => {
        const s = Number(g.getAttribute("data-s"));
        const wire = dia.querySelector<SVGPathElement>(
          `.hdw-wire[data-s="${s}"][data-k="${g.getAttribute("data-k")}"]`,
        );
        return {
          g,
          s,
          j: Number(g.getAttribute("data-j")),
          halo: g.querySelector<SVGCircleElement>(".hdw-pulse-halo"),
          // Only a browser can measure a path; without that, the pulses stay hidden.
          wire: typeof wire?.getTotalLength === "function" ? wire : null,
        };
      }),
    }));
    let frame = 0;
    const draw = (now: number) => {
      const i = stepRef.current;
      const p = ((((now - startRef.current) % STEP_MS) + STEP_MS) % STEP_MS) / STEP_MS;
      bars.forEach((bar, k) => bar.style.setProperty("--p", String(k < i ? 1 : k === i ? p : 0)));
      for (const diagram of diagrams) {
        let arrived = false;
        for (const pulse of diagram.pulses) {
          // Each pulse sets off a little after the one before and takes half
          // the step to arrive.
          const u = pulse.s === i ? (p - (0.06 + pulse.j * 0.1)) / 0.5 : -1;
          if (u >= 1) arrived = true;
          if (u <= 0 || u >= 1 || !pulse.wire) {
            pulse.g.style.display = "none";
            continue;
          }
          const at = pulse.wire.getPointAtLength(pulse.wire.getTotalLength() * ease(u));
          // A pulse fades in as it sets off and out as it arrives.
          pulse.g.style.opacity = Math.min(1, u / 0.15, (1 - u) / 0.15).toFixed(2);
          pulse.g.style.display = "";
          pulse.g.setAttribute("transform", `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
          pulse.halo?.setAttribute("r", (7 + 4 * Math.sin(u * Math.PI)).toFixed(1));
        }
        // The workspace lights up as knowledge and decisions reach it.
        diagram.ws?.setAttribute("data-lit", String(i !== 1 && arrived));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  function hold(i: number) {
    setHeld(true);
    setStep(i);
  }

  return (
    <section ref={rootRef} className="hdw">
      <h2 className="text-lg font-bold leading-tight md:text-xl">How Doco works:</h2>
      <p className="sr-only">
        Sources such as people, GitHub, Slack and Notion feed one workspace. Agents such as Claude,
        Cursor, Codex and Qwen read it as they work, and write decisions back.
      </p>
      <div className="hdw-plate">
        <Flow layout={DESKTOP} step={step} />
        <Flow layout={PHONE} step={step} />
      </div>
      <ol className="hdw-steps">
        {STEPS.map((s, i) => (
          <li key={s.verb}>
            <button
              type="button"
              className="hdw-step"
              data-step={i}
              aria-current={i === step ? "step" : undefined}
              onClick={() => hold(i)}
            >
              <span className="hdw-verb">
                <span className="hdw-num">{i + 1}</span> {s.verb}
              </span>{" "}
              <span className="hdw-line">{s.line}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
