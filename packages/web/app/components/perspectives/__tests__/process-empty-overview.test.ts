import { describe, expect, it } from "vitest";
import {
  TOP_LEVEL_POOL_ID,
  processEmptyMessage,
} from "~/components/perspectives/process-perspective";
import type { ProcessPool } from "~/lib/process-perspective.server";

// The synthetic "home" overview pool — present only when at least one Action is
// flagged `top_level`. Its absence is what the home view turns into a prompt.
const topLevelPool: ProcessPool = {
  id: TOP_LEVEL_POOL_ID,
  process_id: null,
  label: "Processes",
  lifecycle: null,
};

const processPool: ProcessPool = {
  id: "pool:action_1",
  process_id: "action_1",
  label: "Post a job",
  lifecycle: "active",
};

describe("processEmptyMessage", () => {
  it("prompts to mark a top-level action when the home overview has no top-level pool", () => {
    // Home (default open) on a Doco that has process pools but nothing flagged
    // top-level: the overview is the directory of top-level Actions, so it is
    // empty by design — prompt the author instead of falling back to an
    // arbitrary process pool.
    expect(processEmptyMessage({ home: true, pools: [processPool], laneCount: 3 })).toBe(
      "No actions have been marked as top-level yet.",
    );
  });

  it("prompts on a wholly empty Doco opened at home", () => {
    expect(processEmptyMessage({ home: true, pools: [], laneCount: 0 })).toBe(
      "No actions have been marked as top-level yet.",
    );
  });

  it("renders the canvas (no message) when the top-level overview pool exists", () => {
    expect(
      processEmptyMessage({ home: true, pools: [topLevelPool, processPool], laneCount: 3 }),
    ).toBeNull();
  });

  it("renders the canvas (no message) when drilled into a process, even with no top-level pool", () => {
    // A direct node URL / drill-in leaves home; the focused process must still
    // render even though no Action is flagged top-level.
    expect(processEmptyMessage({ home: false, pools: [processPool], laneCount: 3 })).toBeNull();
  });

  it("falls back to the generic empty state when not at home and there is nothing to show", () => {
    expect(processEmptyMessage({ home: false, pools: [], laneCount: 0 })).toBe("So empty");
  });
});
