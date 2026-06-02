import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OAuthAccessApprovalForm } from "../oauth-access-approval-form";

describe("OAuthAccessApprovalForm", () => {
  it("uses the shared grant picker matrix for OAuth approvals", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [
          {
            id: "doco_bpms",
            handle: "torre-bpms",
            my_role: "owner",
            org_id: "organization_torre",
          },
        ],
        orgs: [
          {
            id: "organization_torre",
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
    expect(markup).toContain("Specific node or edge types");
    expect(markup).toContain('name="grants"');
    expect(markup).not.toContain("Select all");
    expect(markup).not.toContain("Deselect all");
  });

  it("keeps the approve button clickable on an empty form so a click surfaces validation", () => {
    // The old form disabled Approve until a token name + a grant existed, so
    // clicking it did nothing and gave no reason. Now it always submits and
    // the form raises visible, app-styled errors instead.
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [],
        orgs: [
          {
            id: "organization_torre",
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
});
