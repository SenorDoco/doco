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
    // The broad option for a token is the actor ("act as me") scope — a
    // user-level credential, one workspace per session — NOT the old
    // all-workspaces snapshot.
    expect(markup).toContain('data-testid="grant-scope-actor"');
    expect(markup).toContain("Act as you");
    // A token is capped at one workspace: the broad snapshot grants are gone.
    expect(markup).not.toContain("Full access");
    expect(markup).not.toContain("All your workspaces and docos");
    expect(markup).not.toContain("identity");
    expect(markup).not.toContain('type="radio"');
    // The scope options stack vertically — no 2-column matrix.
    expect(markup).not.toContain("sm:grid-cols-2");
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

  it("scopes a bound connector to its one workspace: picker leads with 'The entire <name> workspace'", () => {
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
          { id: "workspace_torre", handle: "torre", display_name: "torre", my_role: "owner" },
        ],
        boundWorkspace: { id: "workspace_torre", label: "torre", maxRole: "owner" },
        tokenNamePlaceholder: "e.g. Claude Code in repo",
        requestedRole: null,
        approveLabel: "Approve",
        cancelLabel: "Cancel",
        cancelDecisionValue: "cancel",
      }),
    );

    // The bound consent reuses the shared picker, scoped to the one workspace.
    expect(markup).toContain('data-testid="grant-picker"');
    expect(markup).toContain("What do you want to grant access to?");
    // First option names the bound workspace; the generic/plural labels are gone.
    expect(markup).toContain("The entire torre workspace");
    expect(markup).not.toContain("Specific workspace(s)");
    expect(markup).not.toContain("All your workspaces and docos");
    // A bound connector can't mint an all-workspaces actor token.
    expect(markup).not.toContain('data-testid="grant-scope-actor"');
    expect(markup).not.toContain("Act as you");
    // The two narrowing options remain (Docos / types within that workspace).
    expect(markup).toContain('data-testid="grant-scope-doco"');
    expect(markup).toContain('data-testid="grant-scope-types"');
    // The options stack vertically; nothing is selected by default; the old
    // narrow link is gone.
    expect(markup).not.toContain("sm:grid-cols-2");
    expect(markup).toContain('name="grants" value="[]"');
    expect(markup).not.toContain('data-testid="bound-narrow"');
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
