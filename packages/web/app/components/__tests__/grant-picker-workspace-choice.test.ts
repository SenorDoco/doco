import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GrantWorkspaceChoiceList } from "../grant-picker";

const workspaces = [
  { id: "workspace_alpha", label: "alpha" },
  { id: "workspace_beta", label: "beta" },
  { id: "workspace_gamma", label: "gamma" },
];

describe("GrantWorkspaceChoiceList", () => {
  it("collapses to the pressed workspace choice when one is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(GrantWorkspaceChoiceList, {
        workspaces,
        selectedWorkspaceId: "workspace_beta",
        testIdPrefix: "grant-doco-workspace",
        onSelect: () => {},
        onClear: () => {},
      }),
    );

    expect(markup).not.toContain("alpha");
    expect(markup).toContain("beta");
    expect(markup).not.toContain("gamma");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Remove beta workspace selection"');
    expect(markup).not.toContain(" w-full ");
  });

  it("shows every compact workspace choice before a selection is made", () => {
    const markup = renderToStaticMarkup(
      createElement(GrantWorkspaceChoiceList, {
        workspaces,
        selectedWorkspaceId: null,
        testIdPrefix: "grant-doco-workspace",
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
