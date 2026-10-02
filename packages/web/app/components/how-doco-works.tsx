import { useEffect, useState } from "react";
import { DocoMark } from "~/components/doco-mark";
import { cn } from "~/lib/cn";

// Alexander's three steps (2026-10-01). The dial stops at 12, 4 and 8
// o'clock, one step at each, and the step it points at lifts.
const STEPS = [
  { verb: "Collect", line: "One workspace brings your team's knowledge together." },
  { verb: "Connect", line: "Your agents read that context as they work." },
  { verb: "Capture", line: "Agents record important decisions." },
] as const;

// Where each step's number sits on the 176px dial, at 12, 4 and 8 o'clock.
const TICKS = [
  { left: 88, top: 19 },
  { left: 147.8, top: 122.5 },
  { left: 28.2, top: 122.5 },
];

const TURN_MS = 2800;

/**
 * How Doco works, on the home page and under the invite card: a dial that
 * turns from step to step on its own, with the three steps around it. A step
 * can be clicked to turn the dial there, which stops it turning on its own.
 * `turn` only ever grows, so the face always turns clockwise, a whole turn
 * further on each lap.
 */
export function HowDocoWorks() {
  const [turn, setTurn] = useState(0);
  const [turning, setTurning] = useState(true);
  const current = turn % 3;

  useEffect(() => {
    if (!turning) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setTurn((t) => t + 1), TURN_MS);
    return () => clearInterval(timer);
  }, [turning]);

  function turnTo(step: number) {
    setTurning(false);
    setTurn((t) => t + ((step - (t % 3) + 3) % 3));
  }

  return (
    <section className="hdw flex flex-col gap-2 text-center">
      <h2 className="text-2xl font-bold leading-tight md:text-3xl">How Doco works:</h2>
      <ol className="hdw-steps">
        {STEPS.map((step, i) => (
          <li key={step.verb} className={`hdw-s${i + 1}`}>
            <button
              type="button"
              className="hdw-step"
              aria-current={i === current ? "step" : undefined}
              onClick={() => turnTo(i)}
            >
              <span className="hdw-verb">
                <span className="hdw-num">{i + 1}</span> {step.verb}
              </span>{" "}
              <span className="hdw-line">{step.line}</span>
            </button>
          </li>
        ))}
        <li className="hdw-dial" aria-hidden="true">
          <span className="hdw-bezel" />
          <span className="hdw-face" style={{ transform: `rotate(${turn * 120}deg)` }} />
          <span className="hdw-cap">
            <DocoMark variant="mark" height={40} decorative />
          </span>
          {TICKS.map((tick, i) => (
            <span
              key={tick.left}
              className={cn("hdw-tick", i === current && "hdw-tick-on")}
              style={{ left: tick.left, top: tick.top }}
            >
              {i + 1}
            </span>
          ))}
        </li>
      </ol>
    </section>
  );
}
