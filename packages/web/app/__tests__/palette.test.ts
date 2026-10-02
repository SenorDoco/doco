import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The palette in app.css: the page wears torre.ai's background, the neutrals
// share its warm hue, and text stays WCAG AA (4.5:1) on every surface.
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const theme = appCss.slice(
  appCss.indexOf("@theme {"),
  appCss.indexOf("\n}", appCss.indexOf("@theme {")),
);

function token(name: string): string {
  const m = theme.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} is not in @theme`);
  return m[1].trim();
}

type Oklch = [number, number, number];

function oklch(value: string): Oklch {
  const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!m) throw new Error(`not an opaque oklch() color: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function srgb([l, c, h]: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  const [r, g, bl] = linear.map((x) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  });
  return [r, g, bl];
}

function hex(color: Oklch): string {
  return `#${srgb(color)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function contrast(a: Oklch, b: Oklch): number {
  const luminance = (c: Oklch) => {
    const [r, g, bl] = srgb(c).map((v) =>
      v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("palette", () => {
  it("paints the page with torre.ai's background, #f3f2ee", () => {
    expect(hex(oklch(token("color-background")))).toBe("#f3f2ee");
    expect(token("color-card")).toBe(token("color-background"));
  });

  // color-mix(in oklch, …) treats a near-grey hex as hueless, so a mix with
  // white (the header, the side panel, every neumorphic highlight) comes out
  // with hue 0 and a pink cast. Written as oklch() the hue survives the mix.
  it("writes every color in oklch() so color-mix keeps its hue", () => {
    const colors = [...theme.matchAll(/--color-[\w-]+:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(colors.length).toBeGreaterThan(10);
    for (const value of colors) expect(value).toMatch(/^oklch\(/);
  });

  it("gives the neutrals the background's warm hue", () => {
    const hue = oklch(token("color-background"))[2];
    for (const name of ["foreground", "muted", "muted-foreground", "input", "card-foreground"]) {
      expect(Math.abs(oklch(token(`color-${name}`))[2] - hue), name).toBeLessThan(1);
    }
  });

  it("keeps text at WCAG AA (4.5:1) on the background, muted and input surfaces", () => {
    const surfaces = ["background", "muted", "input"].map((s) => oklch(token(`color-${s}`)));
    const comment = oklch(appCss.match(/\.tok-c \{\s*color: (oklch\([^)]+\))/)?.[1] ?? "");
    for (const text of [
      oklch(token("color-foreground")),
      oklch(token("color-muted-foreground")),
      comment,
    ]) {
      for (const surface of surfaces) expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
