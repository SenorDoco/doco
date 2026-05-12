import { describe, expect, it } from "vitest";
import { ftsSanitize } from "../fts.js";

describe("ftsSanitize", () => {
  it("returns empty string for empty / whitespace input", () => {
    expect(ftsSanitize("")).toBe("");
    expect(ftsSanitize("    \t\n  ")).toBe("");
  });

  it("lowercases every token", () => {
    expect(ftsSanitize("PRIORITY Order Tradeoffs")).toBe("priority OR order OR tradeoffs");
  });

  it("drops tokens shorter than 3 chars", () => {
    expect(ftsSanitize("a bc def gh ijk")).toBe("def OR ijk");
  });

  it("drops tokens longer than 30 chars (likely junk IDs)", () => {
    expect(ftsSanitize("hello aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa world")).toBe("hello OR world");
  });

  it("strips FTS5 operator chars (quotes, colons, asterisks, parens, plus, caret)", () => {
    expect(ftsSanitize('foo: "bar" (baz)')).toBe("foo OR bar OR baz");
    expect(ftsSanitize("a*b c+d e^f")).toBe("");
    expect(ftsSanitize("priority^order")).toBe("priority OR order");
  });

  it("keeps hyphens inside tokens (so 'user-flow' stays one token)", () => {
    expect(ftsSanitize("user-flow priority")).toBe("user-flow OR priority");
  });

  it("emits OR between tokens (FTS5 disjunction)", () => {
    expect(ftsSanitize("alpha bravo charlie")).toBe("alpha OR bravo OR charlie");
  });

  it("collapses multiple whitespace characters", () => {
    expect(ftsSanitize("alpha    bravo\n\tcharlie")).toBe("alpha OR bravo OR charlie");
  });
});
