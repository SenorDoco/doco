import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Doco's text is set in torre.ai's face, Merriweather; code and identifiers
// stay in Ubuntu Mono, drawn at Merriweather's size. Between the Google Fonts
// import and Doco's own @font-face rules, the page loads exactly the faces
// the theme names, nothing more.
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const theme = appCss.slice(
  appCss.indexOf("@theme {"),
  appCss.indexOf("\n}", appCss.indexOf("@theme {")),
);
const fontsUrl =
  appCss.match(/@import url\("(https:\/\/fonts\.googleapis\.com\/[^"]+)"\)/)?.[1] ?? "";
const imported = [...new URL(fontsUrl).searchParams.getAll("family")];
const fontFaces = [...appCss.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);

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

  // Ubuntu Mono's lowercase and capitals stand 0.464 and 0.619 of its em
  // high, Merriweather's 0.555 and 0.743: at the same font size the mono
  // reads 20% smaller (Alexander, 2026-10-03: "Font sizes feel different").
  // Doco serves Ubuntu Mono itself, 120% of its natural size, so any font
  // size names the same visible size in either face, inline or in a block.
  it("draws Ubuntu Mono at Merriweather's size, in all four of its faces", () => {
    const mono = fontFaces.filter((f) => /font-family: "Ubuntu Mono";/.test(f));
    const faces = mono.map((f) => {
      const src = f.match(/src: url\("(\/fonts\/[\w-]+\.woff2)"\) format\("woff2"\);/)?.[1];
      expect(src && existsSync(new URL(`../../public${src}`, import.meta.url))).toBeTruthy();
      expect(f).toMatch(/size-adjust: 120%;/);
      return `${f.match(/font-weight: (\d+);/)?.[1]} ${f.match(/font-style: (\w+);/)?.[1]}`;
    });
    expect(faces.sort()).toEqual(["400 italic", "400 normal", "700 italic", "700 normal"]);
  });

  it("downloads only the faces the theme names", () => {
    const named = [...theme.matchAll(/--font-[\w-]+:\s*"([^"]+)"/g)].map((m) => m[1]);
    const fromGoogle = imported.map((f) => f.split(":")[0].replaceAll("+", " "));
    const ownFaces = fontFaces.map((f) => f.match(/font-family: "([^"]+)";/)?.[1]);
    const loaded = new Set([...fromGoogle, ...ownFaces]);
    expect([...loaded].sort()).toEqual([...new Set(named)].sort());
    expect(fromGoogle.filter((f) => ownFaces.includes(f))).toEqual([]);
  });
});
