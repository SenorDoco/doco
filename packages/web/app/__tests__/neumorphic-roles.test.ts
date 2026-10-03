import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Alexander, 2026-10-03, on the workspace card ("it appears that we're
// combining two types of neumorphic design"): he picked "one clay", and
// "buttons icons and texts and anything clickable should always be purple".
// One material, three roles: a slab stands out of the page (.neu-surface), a
// well sinks into it (.neu-well, every field), a key is a slab you can press
// (.neu-button, pressed as .neu-pressed); .neu-small scales a slab or key down
// to icon size. Nothing is drawn with hairlines or outlines any more, and no
// rule guesses a role from Tailwind classes.
const appDir = new URL("../", import.meta.url).pathname;
const appCss = readFileSync(join(appDir, "app.css"), "utf8");
/** app.css with its indentation stripped, so a rule inside a layer reads like one outside. */
const flatCss = appCss.replace(/^[ \t]+/gm, "");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}
const sources = tsxFiles(appDir).map((path) => ({
  path: path.slice(appDir.length),
  text: readFileSync(path, "utf8"),
}));

/** The declarations of the first rule whose selector list is exactly this. */
function rule(selector: string): string {
  const at = flatCss.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return flatCss.slice(at, flatCss.indexOf("}", at));
}

/** Every opening tag of a clickable element, braces and quotes respected. */
function clickableTags(text: string): { line: number; tag: string }[] {
  const tags: { line: number; tag: string }[] = [];
  const open = /<(Link|NavLink|a|button)(?=[\s>])/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({ line: text.slice(0, m.index).split("\n").length, tag: text.slice(m.index, i + 1) });
  }
  return tags;
}

describe("one clay: the neumorphic roles in app.css", () => {
  it("draws no hairline or outline anywhere", () => {
    expect(appCss).not.toMatch(/inset -?1px -?1px 0/);
    expect(appCss).not.toMatch(
      /--neu-etched|--neu-border|neu-surface-open-bottom|neu-pill-button|neu-shadow-sm|neu-surface-strong|\.neu-inset|\.neu-bubble/,
    );
  });

  it("guesses no role from Tailwind classes", () => {
    expect(appCss).not.toMatch(/\[class[~*]="(border|border-border|bg-primary)"\]/);
  });

  it("defines a slab, a well, a key and its pressed state, each soft", () => {
    expect(rule(".neu-surface")).toMatch(/box-shadow: var\(--neu-slab\)/);
    expect(rule(".neu-well")).toMatch(/box-shadow: var\(--neu-inset\)/);
    expect(rule(".neu-button")).toMatch(/box-shadow: var\(--neu-key\)/);
    expect(rule(".neu-button.neu-small")).toMatch(/--neu-key: var\(--neu-key-small\)/);
    expect(rule(".neu-surface.neu-small")).toMatch(/--neu-slab: var\(--neu-key-small\)/);
    expect(rule(".neu-button:active,\n.neu-pressed,\n.neu-pressed:hover")).toMatch(
      /box-shadow: var\(--neu-pressed\)/,
    );
    for (const token of [
      "--neu-slab",
      "--neu-key",
      "--neu-key-small",
      "--neu-inset",
      "--neu-pressed",
    ]) {
      expect(appCss, token).toMatch(new RegExp(`${token}: (inset )?-?\\d+px -?\\d+px \\d+px`));
    }
  });

  it("colours every key purple, except a purple key, whose text stays white", () => {
    expect(rule(".neu-button")).toMatch(/color: var\(--color-primary\)/);
    expect(rule(".neu-button.bg-primary")).toMatch(/color: var\(--color-primary-foreground\)/);
    expect(rule("a,\nbutton")).toMatch(/color: var\(--color-primary\)/);
  });

  it("sinks every field into the page", () => {
    const fields = rule('input:not([type="checkbox"]):not([type="radio"]),\ntextarea,\nselect');
    expect(fields).toMatch(/box-shadow: var\(--neu-inset\)/);
    expect(fields).toMatch(/border-color: transparent/);
  });
});

describe("one clay: the components", () => {
  it("outlines no box: every edge is a role class", () => {
    const outlined = sources
      .filter(({ path }) => path !== "components/markdown.tsx")
      .flatMap(({ path, text }) =>
        text
          .split("\n")
          .flatMap((line, i) =>
            /\bborder border-border\b/.test(line) ? [`${path}:${i + 1}`] : [],
          ),
      );
    expect(outlined).toEqual([]);
  });

  it("uses no retired role", () => {
    const retired = sources.flatMap(({ path, text }) =>
      /neu-surface-open-bottom|neu-pill-button|neu-inset|neu-bubble|neu-shadow-sm/.test(text)
        ? [path]
        : [],
    );
    expect(retired).toEqual([]);
  });

  it("paints no clickable text or icon in anything but purple", () => {
    const offenders = sources.flatMap(({ path, text }) =>
      clickableTags(text)
        .filter(({ tag }) => /(?<![:\w/-])(hover:)?text-(muted-|card-)?foreground\b/.test(tag))
        .map(({ line }) => `${path}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("gives the workspace card's Doco tiles the same small key as every icon button", () => {
    const card = sources.find(({ path }) => path === "components/workspace-summary-card.tsx");
    expect(card?.text).toMatch(/neu-button neu-small/);
  });
});
