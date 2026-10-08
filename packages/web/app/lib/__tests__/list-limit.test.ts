import { describe, expect, it } from "vitest";
import { LIST_PAGE, parseListLimit } from "../list-limit";

describe("parseListLimit", () => {
  it("opens a list with one page of 50", () => {
    expect(LIST_PAGE).toBe(50);
    expect(parseListLimit(null)).toBe(50);
  });

  it("reads the grown limit Show more put in the URL", () => {
    expect(parseListLimit("100")).toBe(100);
    expect(parseListLimit("150")).toBe(150);
  });

  it.each(["", "abc", "0", "-50", "10", "75.5"])("falls back to one page for %j", (value) => {
    expect(parseListLimit(value)).toBe(50);
  });
});
