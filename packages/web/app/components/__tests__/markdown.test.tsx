// Inline code in a Doco's text is the size of the sentence it sits in: the
// mono face is drawn at Merriweather's size (typography.test.ts), so a
// smaller size class on the code would make it read smaller than its words.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../markdown";

describe("Markdown inline code", () => {
  it("takes the size of the text around it", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { markdown: "Run `pnpm verify` first.", dialect: "github" }),
    );
    const code = html.match(/<code class="([^"]*)">pnpm verify<\/code>/)?.[1];
    expect(code).toBeDefined();
    expect(code).not.toMatch(/(^|\s)text-(xs|sm|base|\[)/);
  });
});
