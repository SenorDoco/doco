import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import { INTEGRATION_CATALOG } from "~/lib/integrations-catalog";
import { BRAND_ICONS, GitHubIcon, NotionIcon, SlackIcon } from "../brand-icons";
import { DOCO_TYPE_ICONS, DocoTypeIcon } from "../doco-type-icon";

describe("Doco type icons", () => {
  it("gives every template its own icon", () => {
    for (const template of DOCO_TEMPLATES) {
      expect(DOCO_TYPE_ICONS[template.handle], template.handle).toBeDefined();
    }
    const icons = DOCO_TEMPLATES.map((template) => DOCO_TYPE_ICONS[template.handle]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("wears the brand mark of the service a Doco copies from", () => {
    expect(DOCO_TYPE_ICONS.slack).toBe(SlackIcon);
    expect(DOCO_TYPE_ICONS.notion).toBe(NotionIcon);
    expect(DOCO_TYPE_ICONS["github-pull-requests"]).toBe(GitHubIcon);
  });

  it("names the Doco type for screen readers, falling back to a generic page", () => {
    expect(renderToStaticMarkup(createElement(DocoTypeIcon, { template: "bugs" }))).toContain(
      'aria-label="Bug tracker"',
    );
    const unknown = renderToStaticMarkup(createElement(DocoTypeIcon, { template: null }));
    expect(unknown).toContain('aria-label="Doco"');
  });
});

describe("Integration brand icons", () => {
  // Every integration shows its brand, including ones added later.
  it("has a brand mark for every integration in the catalog", () => {
    for (const integration of INTEGRATION_CATALOG) {
      expect(BRAND_ICONS[integration.id], integration.id).toBeDefined();
    }
  });
});
