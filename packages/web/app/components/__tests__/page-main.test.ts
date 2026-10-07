import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NarrowPageMain, PageMain } from "../page-main";

const APP = new URL("../../", import.meta.url).pathname;

function renderClassName(element: ReactElement): string {
  const markup = renderToStaticMarkup(element);
  return markup.match(/class="([^"]+)"/)?.[1] ?? "";
}

/** Every page and component source, as [path under app/, source]. */
function sources(dir: string): Array<[string, string]> {
  return readdirSync(join(APP, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx") && !file.includes("__tests__"))
    .map((file) => [join(dir, file), readFileSync(join(APP, dir, file), "utf8")]);
}

const ALL = [
  ...sources("routes"),
  ...sources("components"),
  ["root.tsx", readFileSync(join(APP, "root.tsx"), "utf8")],
] as Array<[string, string]>;

// Alexander, 2026-10-07: "448px and 1152 - no 768px." A page that isn't full
// screen is 1152px wide, or 448px when it is one small card.
describe("page widths", () => {
  it("are 1152px, or 448px for a page that is one small card", () => {
    expect(renderClassName(createElement(PageMain))).toMatch(/\bmax-w-6xl\b/);
    expect(renderClassName(createElement(NarrowPageMain))).toMatch(/\bmax-w-md\b/);
  });

  it("come only from PageMain and NarrowPageMain: no other <main> sets a width", () => {
    const offenders = ALL.filter(
      ([file, src]) =>
        file !== "components/page-main.tsx" &&
        [...src.matchAll(/<main\b[^>]*>/g)].some(([tag]) => /max-w-|maxWidth/.test(tag)),
    ).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("leave no narrower column centred inside a page", () => {
    const offenders = ALL.filter(
      ([file, src]) =>
        (file.startsWith("routes/") || file === "root.tsx") &&
        /className="[^"]*\bmx-auto\b[^"]*\bmax-w-|className="[^"]*\bmax-w-[^"]*\bmx-auto\b/.test(
          src,
        ),
    ).map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
