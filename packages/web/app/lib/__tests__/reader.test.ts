import { describe, expect, it } from "vitest";
import { codeTrail, readerFor, readerHref, splitCodeId } from "../reader";

describe("readerFor", () => {
  it("opens codebase Docos in the code reader and Notion Docos in the pages reader", () => {
    expect(readerFor("codebase")).toBe("code");
    expect(readerFor("notion")).toBe("pages");
  });

  it("leaves every other Doco on its node home", () => {
    expect(readerFor("slack")).toBeNull();
    expect(readerFor("github-pull-requests")).toBeNull();
    expect(readerFor("toString")).toBeNull();
    expect(readerFor(null)).toBeNull();
  });
});

describe("readerHref", () => {
  it("addresses a file by its repository and path, like GitHub", () => {
    expect(readerHref("acme-codebase", "code", "acme/app/src/billing/tax.ts")).toBe(
      "/acme-codebase/code/acme/app/src/billing/tax.ts",
    );
  });

  it("encodes what a path segment can't hold, keeping the slashes", () => {
    expect(readerHref("acme-codebase", "code", "acme/app/docs/a b#1?.md")).toBe(
      "/acme-codebase/code/acme/app/docs/a%20b%231%3F.md",
    );
  });

  it("addresses a page by its id, and the reader's home without one", () => {
    expect(readerHref("acme-notion", "pages", "11111111-0000-4000-8000-000000000001")).toBe(
      "/acme-notion/pages/11111111-0000-4000-8000-000000000001",
    );
    expect(readerHref("acme-notion", "pages")).toBe("/acme-notion/pages");
    expect(readerHref("acme-codebase", "code", "")).toBe("/acme-codebase/code");
  });
});

describe("splitCodeId", () => {
  it("reads the repository from the first two segments and the path from the rest", () => {
    expect(splitCodeId("acme/app/src/index.ts")).toEqual({
      repo: "acme/app",
      path: "src/index.ts",
    });
    expect(splitCodeId("acme/app")).toEqual({ repo: "acme/app", path: "" });
    expect(splitCodeId("acme/app/")).toEqual({ repo: "acme/app", path: "" });
  });

  it("is null without a repository", () => {
    expect(splitCodeId("")).toBeNull();
    expect(splitCodeId("acme")).toBeNull();
  });
});

describe("codeTrail", () => {
  it("lists the repository and each folder down to the item", () => {
    expect(codeTrail("acme/app/src/billing/tax.ts")).toEqual([
      "acme/app",
      "acme/app/src",
      "acme/app/src/billing",
      "acme/app/src/billing/tax.ts",
    ]);
    expect(codeTrail("acme/app")).toEqual(["acme/app"]);
    expect(codeTrail("")).toEqual([]);
  });
});
