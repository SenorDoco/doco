import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OAuthAccessApprovalForm } from "../oauth-access-approval-form";

describe("OAuthAccessApprovalForm", () => {
  it("offers a single-workspace token picker — no full-access or all-workspaces card", () => {
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
    expect(markup).toContain("Specific workspace(s)");
    expect(markup).toContain("Specific docos");
    expect(markup).toContain('name="grants"');
    // A token is capped at one workspace: the broad grants are gone.
    expect(markup).not.toContain("Full access");
    expect(markup).not.toContain("All your workspaces and docos");
    expect(markup).not.toContain("identity");
    expect(markup).not.toContain('type="radio"');
    // No default grant is pre-selected (the empty array serializes as []).
    expect(markup).toContain('name="grants" value="[]"');
  });

  it("keeps the approve button clickable on an empty form so a click surfaces validation", () => {
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

    expect(markup).not.toContain('disabled="');
  });

  it("scopes to a single bound workspace: an access level only, no other workspaces or picker", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAccessApprovalForm, {
        docos: [],
        workspaces: [],
        boundWorkspace: { id: "workspace_torre", label: "torre", maxRole: "owner" },
        tokenNamePlaceholder: "e.g. Claude Code in repo",
        requestedRole: null,
        approveLabel: "Approve",
        cancelLabel: "Cancel",
        cancelDecisionValue: "cancel",
      }),
    );

    // No multi-workspace scope chooser / picker when the connector is bound.
    expect(markup).not.toContain("What do you want to grant access to?");
    expect(markup).not.toContain('data-testid="grant-picker"');
    // Leads with the bound workspace and an access-level selector.
    expect(markup).toContain("torre");
    expect(markup).toContain('data-testid="bound-workspace-access"');
    expect(markup).toContain("Read only");
    expect(markup).toContain("Can write");
    // The workspace grant is pre-composed (writer by default), not the empty [].
    expect(markup).toContain("workspace_torre");
    expect(markup).not.toContain('name="grants" value="[]"');
  });

  it("shows the empty-state when there is nothing to grant (no full-access fallback)", () => {
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

    expect(markup).not.toContain("Full access");
    expect(markup).not.toContain("identity");
    expect(markup).toContain("You don&#x27;t have anything you can grant access to yet.");
  });
});
