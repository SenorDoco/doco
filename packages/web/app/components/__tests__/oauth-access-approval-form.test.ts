import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OAuthAccessApprovalForm } from "../oauth-access-approval-form";

describe("OAuthAccessApprovalForm", () => {
  it("uses access option cards instead of a redundant radio mode selector", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [
          {
            id: "doco_bpms",
            handle: "torre-bpms",
            my_role: "owner",
            workspace_id: "workspace_torre",
          },
        ],
        workspaces: [
          {
            id: "workspace_torre",
            handle: "torre",
            display_name: "Torre",
            my_role: "owner",
          },
        ],
        tokenNamePlaceholder: "e.g. Codex in Doco repo",
        requestedRole: null,
        approveLabel: "Approve",
        cancelLabel: "Cancel",
        cancelDecisionValue: "cancel",
      }),
    );

    expect(markup).toContain('data-testid="grant-picker"');
    expect(markup).toContain("What do you want to grant access to?");
    expect(markup).toContain("Full access");
    expect(markup).toContain("Specific workspace(s)");
    expect(markup).toContain("Specific docos");
    expect(markup).toContain('name="grants"');
    expect(markup).toContain("identity");
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain('name="access_mode"');
    expect(markup).not.toContain("Specific Docos");
  });

  it("keeps the approve button clickable on an empty form so a click surfaces validation", () => {
    // The old form disabled Approve until a token name + a grant existed, so
    // clicking it did nothing and gave no reason. Now it always submits and
    // the form raises visible, app-styled errors instead.
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [],
        workspaces: [
          {
            id: "workspace_torre",
            handle: "torre",
            display_name: "Torre",
            my_role: "owner",
          },
        ],
        tokenNamePlaceholder: "e.g. Codex in Doco repo",
        requestedRole: null,
        approveLabel: "Approve",
        cancelLabel: "Deny",
        cancelDecisionValue: "deny",
      }),
    );

    // No element carries a `disabled` attribute (the Tailwind `disabled:`
    // variant would not produce `disabled="` so this only catches the prop).
    expect(markup).not.toContain('disabled="');
  });

  it("still offers the live full-access card when there are no owned targets yet", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [],
        workspaces: [],
        tokenNamePlaceholder: "e.g. Codex in Doco repo",
        requestedRole: null,
        approveLabel: "Approve",
        cancelLabel: "Cancel",
        cancelDecisionValue: "cancel",
      }),
    );

    expect(markup).toContain("Full access");
    expect(markup).toContain("identity");
    expect(markup).not.toContain("You don&#x27;t have anything you can grant access to yet.");
  });
});
