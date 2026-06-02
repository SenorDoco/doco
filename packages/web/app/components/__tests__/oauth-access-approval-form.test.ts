import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OAuthAccessApprovalForm } from "../oauth-access-approval-form";

describe("OAuthAccessApprovalForm", () => {
  it("defaults to full access (defer to the live matrix), granular picker behind a toggle", () => {
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

    // Two access modes, "full" selected by default.
    expect(markup).toContain('name="access_mode"');
    expect(markup).toContain("Full access");
    expect(markup).toContain("Specific Docos");
    // The default submission defers to the matrix — the identity grant — so
    // the connector follows the user's live permissions with no re-auth.
    expect(markup).toContain('name="grants"');
    expect(markup).toContain("identity");
    // The granular owner-scoped picker (its own markup is tested in
    // grant-picker.test) stays hidden until "Specific Docos" is chosen.
    expect(markup).not.toContain('data-testid="grant-picker"');
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
});
