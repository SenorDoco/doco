import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocoPageMain, SingleColumnPageMain } from "../page-main";

function renderClassName(element: ReactElement): string {
  const markup = renderToStaticMarkup(element);
  return markup.match(/class="([^"]+)"/)?.[1] ?? "";
}

describe("page main widths", () => {
  it("uses the wide workspace width by default", () => {
    const className = renderClassName(createElement(SingleColumnPageMain));

    expect(className).toContain("max-w-6xl");
    expect(className).not.toContain("max-w-4xl");
  });

  it("keeps Doco-scoped single-column pages narrow", () => {
    const className = renderClassName(createElement(DocoPageMain));

    expect(className).toContain("max-w-4xl");
    expect(className).not.toContain("max-w-6xl");
  });
});
