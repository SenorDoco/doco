import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GrantDocoChoiceList, GrantOrgChoiceList } from "../grant-picker";

const orgs = [
  { id: "organization_alpha", label: "alpha" },
  { id: "organization_beta", label: "beta" },
  { id: "organization_gamma", label: "gamma" },
];

const docos = [
  { id: "doco_alpha", label: "alpha/runbook" },
  { id: "doco_beta", label: "beta/plan" },
  { id: "doco_gamma", label: "gamma/log" },
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

describe("GrantDocoChoiceList", () => {
  it("collapses to the pressed doco choice when one is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(GrantDocoChoiceList, {
        docos,
        selectedDocoId: "doco_beta",
        testIdPrefix: "grant-types-doco",
        onSelect: () => {},
        onClear: () => {},
      }),
    );

    expect(markup).not.toContain("alpha/runbook");
    expect(markup).toContain("beta/plan");
    expect(markup).not.toContain("gamma/log");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Remove beta/plan doco selection"');
    expect(markup).not.toContain(" w-full ");
  });
});
