import { describe, expect, it } from "vitest";
import { DEFAULT_INDICATOR_PREFIX, buildSearchDisplay } from "../indicator-lines";

describe("buildSearchDisplay", () => {
  const prefix = "[🔮 Doco Codex on behalf of @torrenegra]";

  it("builds the §1 found line verbatim from prefix + count + duration", () => {
    const d = buildSearchDisplay({
      indicatorPrefix: prefix,
      count: 3,
      durationMs: 432,
      label: "acme/proj1",
    });
    // The exact string an agent should paste — no manufacturing required.
    expect(d.found).toBe(`${prefix} 3 relevant nodes found (0.4s)`);
    expect(d.prefix).toBe(prefix);
  });

  it("builds the §3 tally as the read-only (zero) form, with the bold count", () => {
    const d = buildSearchDisplay({
      indicatorPrefix: prefix,
      count: 3,
      durationMs: 1000,
      label: "acme/proj1",
    });
    // The tally the agent drops most often on a read-only turn — handed over ready.
    expect(d.tally).toBe(`${prefix} acme/proj1: **0** nodes added/updated`);
    // The count is bold per protocol.
    expect(d.tally).toContain("**0**");
  });

  it("renders seconds to one decimal place", () => {
    expect(
      buildSearchDisplay({ indicatorPrefix: prefix, count: 0, durationMs: 1960, label: "d" }).found,
    ).toBe(`${prefix} 0 relevant nodes found (2.0s)`);
  });

  it("falls back to the plain prefix when no credential is known", () => {
    const d = buildSearchDisplay({ indicatorPrefix: null, count: 1, durationMs: 100, label: "d" });
    expect(d.prefix).toBe(DEFAULT_INDICATOR_PREFIX);
    expect(d.found).toBe(`${DEFAULT_INDICATOR_PREFIX} 1 relevant nodes found (0.1s)`);
    expect(d.tally).toBe(`${DEFAULT_INDICATOR_PREFIX} d: **0** nodes added/updated`);
  });

  it("never emits a negative count or duration", () => {
    const d = buildSearchDisplay({
      indicatorPrefix: prefix,
      count: -5,
      durationMs: -10,
      label: "d",
    });
    expect(d.found).toBe(`${prefix} 0 relevant nodes found (0.0s)`);
  });
});
