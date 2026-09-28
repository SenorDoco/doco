import { describe, expect, it } from "vitest";
import { fuseRankings } from "../rank-fusion";

describe("fuseRankings", () => {
  it("puts an id near the top of two lists above one leading a single list", () => {
    expect(
      fuseRankings([
        ["a", "b", "c"],
        ["b", "d", "a"],
      ]),
    ).toEqual(["b", "a", "d", "c"]);
  });

  it("keeps a lone ranking as it is", () => {
    expect(fuseRankings([["x", "y", "z"]])).toEqual(["x", "y", "z"]);
  });

  it("counts an id once per list, and breaks ties by id", () => {
    expect(fuseRankings([["a", "a", "b"], ["b"]])).toEqual(["b", "a"]);
    expect(fuseRankings([["b"], ["a"]])).toEqual(["a", "b"]);
  });

  it("is empty with nothing to fuse", () => {
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([[], []])).toEqual([]);
  });
});
