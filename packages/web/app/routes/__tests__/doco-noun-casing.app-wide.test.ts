import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// House style (confirmed by the project owner): the document-unit noun is
// lowercase ("this doco", "your docos", "delete this doco") EXCEPT when it
// begins a sentence/heading/label. The *product/agent name* stays capitalized
// — "Doco hosts a remote MCP server", "Continue to Doco", "Señor Doco", the
// "· Doco" page-title brand — as do brand-y compounds ("Doco ID",
// "Doco concepts", "Doco-readers"). This locks the rule across the
// user-facing surfaces swept beyond the integrations pages.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("doco noun is lowercase app-wide (brand + sentence-initial stay capitalized)", () => {
  it("doco settings page", () => {
    const src = read("$docoHandle.settings.tsx");
    expect(src).toContain("Sign in to delete this doco.");
    expect(src).toContain("the doco's owner");
    expect(src).toContain("type the doco handle exactly");
    expect(src).toContain("Delete doco</CardTitle>");
    expect(src).not.toContain("this Doco");
    expect(src).not.toContain("Delete Doco<");
    // Brand/label-initial titles keep their capital.
    expect(src).toContain("Doco ID</CardTitle>");
    expect(src).toContain("Doco's goal</CardTitle>");
  });

  it("project tokens page", () => {
    const src = read("$docoHandle.project-tokens.tsx");
    expect(src).toContain("read-only credential for this doco");
    expect(src).toContain("only the doco's owner");
    expect(src).not.toContain("this Doco");
  });

  it("device authorization page", () => {
    const src = read("device.tsx");
    expect(src).toContain("access to your docos");
    expect(src).toContain("pick individual docos");
    expect(src).toContain("own any docos");
    expect(src).not.toContain("your Docos");
    expect(src).not.toContain("individual Docos");
  });

  it("invite landing page — noun lowercased, brand kept in the title", () => {
    const src = read("invite.$code.tsx");
    expect(src).toContain('title: "Join a doco · Doco"');
    expect(src).toContain("The doco this invite pointed at");
    expect(src).toContain("The doco it pointed at");
    expect(src).not.toContain("Join a Doco ·");
    expect(src).not.toContain("The Doco this invite");
    // Brand subject stays capitalized.
    expect(src).toContain("Doco keeps people");
  });
});
