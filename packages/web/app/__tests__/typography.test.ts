import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Doco's text is set in torre.ai's face, Merriweather; code and identifiers
// stay in Ubuntu Mono. The Google Fonts import loads exactly the faces the
// theme names, nothing more.
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const theme = appCss.slice(
  appCss.indexOf("@theme {"),
  appCss.indexOf("\n}", appCss.indexOf("@theme {")),
);
const fontsUrl =
  appCss.match(/@import url\("(https:\/\/fonts\.googleapis\.com\/[^"]+)"\)/)?.[1] ?? "";
const imported = [...new URL(fontsUrl).searchParams.getAll("family")];

function fontToken(name: string): string | undefined {
  return theme
    .match(new RegExp(`--font-${name}:\\s*([^;]+);`))?.[1]
    .replace(/\s+/g, " ")
    .trim();
}

describe("typography", () => {
  it("sets the page in torre.ai's face, Merriweather", () => {
    expect(fontToken("serif")).toMatch(/^"Merriweather", Georgia,/);
    expect(appCss).toMatch(/html,\s*body \{[^}]*font-family: var\(--font-serif\);/);
  });

  it("loads Merriweather upright and italic across torre.ai's 300 to 900 weights", () => {
    expect(imported).toContain("Merriweather:ital,wght@0,300..900;1,300..900");
  });

  it("keeps Ubuntu Mono for code and identifiers", () => {
    expect(fontToken("mono")).toMatch(/^"Ubuntu Mono",/);
  });

  it("downloads only the faces the theme names", () => {
    const named = [...theme.matchAll(/--font-[\w-]+:\s*"([^"]+)"/g)].map((m) => m[1]);
    const loaded = imported.map((f) => f.split(":")[0].replaceAll("+", " "));
    expect(loaded.sort()).toEqual([...new Set(named)].sort());
  });
});
