import { describe, expect, it } from "vitest";
import { resolveScalarValue, tokenizeProse } from "../link-tokens";

describe("tokenizeProse", () => {
  it("returns a single text token when there are no links", () => {
    expect(tokenizeProse("plain text")).toEqual([{ kind: "text", text: "plain text" }]);
  });

  it("linkifies a bare url", () => {
    expect(tokenizeProse("see https://example.com now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "url", url: "https://example.com", label: "https://example.com" },
      { kind: "text", text: " now" },
    ]);
  });

  it("strips trailing punctuation off a bare url", () => {
    expect(tokenizeProse("(https://example.com).")).toEqual([
      { kind: "text", text: "(" },
      { kind: "url", url: "https://example.com", label: "https://example.com" },
      { kind: "text", text: ")." },
    ]);
  });

  it("elevates a markdown link to its label", () => {
    expect(tokenizeProse("a [label](https://x.io/p) b")).toEqual([
      { kind: "text", text: "a " },
      { kind: "url", url: "https://x.io/p", label: "label" },
      { kind: "text", text: " b" },
    ]);
  });
});

describe("resolveScalarValue", () => {
  it("links a whole-value url", () => {
    expect(resolveScalarValue("https://github.com/a/b/pull/1", null)).toEqual([
      {
        kind: "url",
        url: "https://github.com/a/b/pull/1",
        label: "https://github.com/a/b/pull/1",
      },
    ]);
  });

  it("resolves a bare code locator to a github permalink", () => {
    expect(resolveScalarValue("packages/web/app/foo.ts:42", "torrenegra/Doco")).toEqual([
      {
        kind: "code",
        url: "https://github.com/torrenegra/Doco/blob/HEAD/packages/web/app/foo.ts#L42",
        label: "packages/web/app/foo.ts:42",
      },
    ]);
  });

  it("leaves a code locator as plain text when no repo is connected", () => {
    expect(resolveScalarValue("packages/web/app/foo.ts:42", null)).toEqual([
      { kind: "text", text: "packages/web/app/foo.ts:42" },
    ]);
  });

  it("falls back to prose tokenizing for mixed values", () => {
    expect(resolveScalarValue("see https://x.io", null)).toEqual([
      { kind: "text", text: "see " },
      { kind: "url", url: "https://x.io", label: "https://x.io" },
    ]);
  });
});
