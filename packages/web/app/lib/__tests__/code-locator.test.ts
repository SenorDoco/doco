import { describe, expect, it } from "vitest";
import {
  codeLocatorGithubUrl,
  githubBlobUrl,
  looksLikeCodePath,
  parseCodeReferenceLocator,
} from "../code-locator";

describe("parseCodeReferenceLocator", () => {
  it("parses a bare path:line", () => {
    expect(parseCodeReferenceLocator("packages/web/app/foo.ts:42")).toEqual({
      path: "packages/web/app/foo.ts",
      start: 42,
      end: 42,
    });
  });

  it("parses a path with a line range", () => {
    expect(parseCodeReferenceLocator("src/x.ts:10-20")).toEqual({
      path: "src/x.ts",
      start: 10,
      end: 20,
    });
  });

  it("strips a repo-name prefix (vader:components/X.ts:42)", () => {
    expect(parseCodeReferenceLocator("vader:components/X.ts:42")).toEqual({
      path: "components/X.ts",
      start: 42,
      end: 42,
    });
  });

  it("keeps the line anchor from a full URL locator", () => {
    expect(
      parseCodeReferenceLocator(
        "https://github.com/torrenegra/doco/blob/main/packages/web/app/lib/x.ts#L210-L211",
      ),
    ).toEqual({
      path: "github.com/torrenegra/doco/blob/main/packages/web/app/lib/x.ts",
      start: 210,
      end: 211,
    });
  });

  it("returns null when there is no line number", () => {
    expect(parseCodeReferenceLocator("src/x.ts")).toBeNull();
    expect(parseCodeReferenceLocator("")).toBeNull();
    expect(parseCodeReferenceLocator(null)).toBeNull();
    expect(parseCodeReferenceLocator(undefined)).toBeNull();
  });
});

describe("looksLikeCodePath", () => {
  it("accepts paths with a slash or a file extension", () => {
    expect(looksLikeCodePath("components/X.ts")).toBe(true);
    expect(looksLikeCodePath("X.tsx")).toBe(true);
  });
  it("rejects bare tokens with neither", () => {
    expect(looksLikeCodePath("3")).toBe(false);
    expect(looksLikeCodePath("ratio 3")).toBe(false);
  });
});

describe("githubBlobUrl", () => {
  it("builds a single-line blob url at HEAD by default", () => {
    expect(githubBlobUrl("torrenegra/Doco", { path: "a/b.ts", start: 5, end: 5 })).toBe(
      "https://github.com/torrenegra/Doco/blob/HEAD/a/b.ts#L5",
    );
  });

  it("builds a line-range blob url", () => {
    expect(githubBlobUrl("o/r", { path: "a.ts", start: 5, end: 9 })).toBe(
      "https://github.com/o/r/blob/HEAD/a.ts#L5-L9",
    );
  });

  it("honors an explicit ref", () => {
    expect(githubBlobUrl("o/r", { path: "a.ts", start: 1, end: 1 }, "main")).toBe(
      "https://github.com/o/r/blob/main/a.ts#L1",
    );
  });
});

describe("codeLocatorGithubUrl", () => {
  it("resolves a bare code locator against the connected repo", () => {
    expect(codeLocatorGithubUrl("torrenegra/Doco", "packages/web/app/foo.ts:42")).toBe(
      "https://github.com/torrenegra/Doco/blob/HEAD/packages/web/app/foo.ts#L42",
    );
  });

  it("resolves a range and strips a repo prefix", () => {
    expect(codeLocatorGithubUrl("o/r", "vader:components/X.ts:10-20")).toBe(
      "https://github.com/o/r/blob/HEAD/components/X.ts#L10-L20",
    );
  });

  it("returns null without a connected repo", () => {
    expect(codeLocatorGithubUrl(null, "a/b.ts:1")).toBeNull();
    expect(codeLocatorGithubUrl("", "a/b.ts:1")).toBeNull();
  });

  it("ignores values that are already full URLs (linkified as plain URLs instead)", () => {
    expect(codeLocatorGithubUrl("o/r", "https://github.com/a/b/blob/main/x.ts#L5")).toBeNull();
  });

  it("ignores non-path-like colon-number strings to avoid false positives", () => {
    expect(codeLocatorGithubUrl("o/r", "3:14")).toBeNull();
    expect(codeLocatorGithubUrl("o/r", "ratio 3:14")).toBeNull();
    expect(codeLocatorGithubUrl("o/r", "just text")).toBeNull();
  });
});
