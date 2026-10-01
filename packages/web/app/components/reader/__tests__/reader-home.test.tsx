// A reader Doco's home shows the same activity column as every other Doco's
// home: the Activity chart, the latest recorded writes and who made them.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DocoActivity } from "~/lib/doco-activity.server";
import { ReaderHome } from "../reader-parts";

const activity: DocoActivity = {
  byDay: { "2026-09-30": 4 },
  items: [
    {
      event_id: "ev_1",
      id: "decision_1",
      entity_type: "decision",
      summary: "Keep the handbook in Notion",
      at: "2026-09-30T12:00:00.000Z",
      op: "entity.create",
      lifecycle: "active",
      before: null,
      after: null,
    },
  ],
  topContributors: [
    { userId: "user_ana", username: "ana", lastAt: "2026-09-30T12:00:00.000Z", eventCount: 1 },
  ],
};

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReaderHome handle="torre-notion" activity={activity}>
        <p>Recently edited</p>
      </ReaderHome>
    </MemoryRouter>,
  );
}

describe("ReaderHome", () => {
  it("shows the home beside the Doco's activity, latest writes and contributors", () => {
    const html = render();
    expect(html).toContain("Recently edited");
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Latest activity<");
    expect(html).toContain("Keep the handbook in Notion");
    expect(html).toContain(">Top contributors<");
    expect(html).toContain(">ana<");
  });

  it("links each write to its node", () => {
    expect(render()).toContain('href="/torre-notion/decision/decision_1"');
  });
});
