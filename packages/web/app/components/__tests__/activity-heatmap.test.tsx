// The Activity calendars: writes, then queries, then imports, the same weeks,
// each shaded by its own quarters. They show as many weeks as fit the card, so the card
// never scrolls sideways.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityHeatmap, calendarLayout, shadeLevels } from "../activity-heatmap";

describe("calendarLayout", () => {
  it("fits as many weeks as the width holds, up to a year", () => {
    for (const width of [240, 288, 388, 1200]) {
      const { weeks, cell, gap, labelWidth } = calendarLayout(width);
      expect(labelWidth + weeks * cell + (weeks - 1) * gap).toBeLessThanOrEqual(width);
      expect(cell).toBeGreaterThanOrEqual(8);
    }
    // About five months on a Doco's side column, eight on a workspace's, a year
    // when there's room.
    expect(calendarLayout(288).weeks).toBe(26);
    expect(calendarLayout(388).weeks).toBe(36);
    expect(calendarLayout(1200).weeks).toBe(52);
  });
});

describe("shadeLevels", () => {
  it("splits the active days into quarters, so one big day doesn't wash out the rest", () => {
    const levels = shadeLevels([0, 1, 2, 3, 4, 5, 6, 7, 8, 2140]);
    expect(levels[0]).toBe(0);
    expect(levels[9]).toBe(4);
    expect(new Set(levels.slice(1))).toEqual(new Set([1, 2, 3, 4]));
  });
});

describe("ActivityHeatmap", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const html = renderToStaticMarkup(
    createElement(ActivityHeatmap, {
      byDay: {
        writes: { "2026-09-30": 12, "2026-09-29": 3 },
        queries: { "2026-09-30": 140, "2026-10-01": 7 },
        imports: { "2026-09-30": 2100 },
      },
      now,
    }),
  );

  it("draws writes, then queries, then imports, each with its total", () => {
    expect(html.indexOf(">Writes<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Queries<")).toBeGreaterThan(html.indexOf(">Writes<"));
    expect(html.indexOf(">Imports<")).toBeGreaterThan(html.indexOf(">Queries<"));
    expect(html).toContain(">15<");
    expect(html).toContain(">147<");
    expect(html).toContain(">2,100<");
  });

  it("names every count for each day", () => {
    expect(html).toContain('data-tip="Wed, Sep 30, 2026: 12 writes, 140 queries, 2,100 imports"');
    expect(html).toContain('data-tip="Thu, Oct 1, 2026: 0 writes, 7 queries, 0 imports"');
  });

  it("never scrolls sideways", () => {
    expect(html).not.toContain("overflow-x");
  });
});
