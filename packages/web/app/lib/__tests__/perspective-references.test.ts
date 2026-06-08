import { describe, expect, it } from "vitest";
import { type ReferenceCandidate, referencesFromCandidates } from "../perspective-references";

function candidate(
  id: string,
  x: number,
  y: number,
  overrides: Partial<ReferenceCandidate> = {},
): ReferenceCandidate {
  return {
    id,
    entity_type: "action",
    label: id.toUpperCase(),
    lifecycle: "active",
    href: `/d/${id}`,
    position: { x, y },
    width: 100,
    height: 40,
    ...overrides,
  };
}

describe("referencesFromCandidates", () => {
  it("numbers the rendered set in canvas reading order: rows top-to-bottom, left-to-right", () => {
    // B and A share the top row (same y, within height); C is a row below.
    const refs = referencesFromCandidates([
      candidate("a", 100, 0),
      candidate("b", 0, 0),
      candidate("c", 0, 200),
    ]);
    expect(refs.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(refs.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it("breaks exact position ties deterministically by id", () => {
    const refs = referencesFromCandidates([candidate("d2", 0, 0), candidate("d1", 0, 0)]);
    expect(refs.map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("derives numbers from canvas position alone — no viewport, so they never shift on pan/zoom", () => {
    // The whole point of the simplification: the same candidate set always
    // yields the same numbering. There is no viewport argument to vary.
    const candidates = [candidate("a", 0, 0), candidate("b", 0, 200), candidate("c", 0, 400)];
    const first = referencesFromCandidates(candidates);
    const again = referencesFromCandidates(candidates);
    expect(again).toEqual(first);
    expect(first.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("carries each candidate's display fields through to the reference item", () => {
    const [ref] = referencesFromCandidates([
      candidate("a", 0, 0, {
        entity_type: "principal",
        label: "Alice",
        lifecycle: "retired",
        href: "/d/alice",
      }),
    ]);
    expect(ref).toEqual({
      number: 1,
      id: "a",
      entity_type: "principal",
      label: "Alice",
      lifecycle: "retired",
      href: "/d/alice",
    });
  });

  it("does not mutate the caller's candidate array", () => {
    const candidates = [candidate("a", 100, 0), candidate("b", 0, 0)];
    const order = candidates.map((c) => c.id);
    referencesFromCandidates(candidates);
    expect(candidates.map((c) => c.id)).toEqual(order);
  });
});
