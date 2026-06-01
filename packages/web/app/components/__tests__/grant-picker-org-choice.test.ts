import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GrantOrgChoiceList } from "../grant-picker";

const orgs = [
  { id: "organization_alpha", label: "alpha" },
  { id: "organization_beta", label: "beta" },
  { id: "organization_gamma", label: "gamma" },
];

describe("GrantOrgChoiceList", () => {
  it("collapses to the pressed organization choice when one is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(GrantOrgChoiceList, {
        orgs,
        selectedOrgId: "organization_beta",
        testIdPrefix: "grant-doco-org",
        onSelect: () => {},
        onClear: () => {},
      }),
    );

    expect(markup).not.toContain("alpha");
    expect(markup).toContain("beta");
    expect(markup).not.toContain("gamma");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Remove beta organization selection"');
    expect(markup).not.toContain(" w-full ");
  });

  it("shows every compact organization choice before a selection is made", () => {
    const markup = renderToStaticMarkup(
      createElement(GrantOrgChoiceList, {
        orgs,
        selectedOrgId: null,
        testIdPrefix: "grant-types-org",
        onSelect: () => {},
        onClear: () => {},
      }),
    );

    expect(markup).toContain("alpha");
    expect(markup).toContain("beta");
    expect(markup).toContain("gamma");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain(" w-full ");
  });
});
