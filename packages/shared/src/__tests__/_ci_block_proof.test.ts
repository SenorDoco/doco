import { expect, test } from "vitest";

// Throwaway: proves the required CI check blocks a red PR from merging.
// This whole branch/PR is disposable and will be closed, not merged.
test("ci-block-proof — intentional failure", () => {
  expect(1).toBe(2);
});
