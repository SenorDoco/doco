import type { DocoRole } from "@doco/db";
import { WRITE_ALL } from "@doco/shared";
import { useMemo, useRef, useState } from "react";
import { GrantPicker } from "~/components/grant-picker";
import type { ApprovalDocoOption, ApprovalWorkspaceOption } from "~/lib/approval-grants";
import {
  GRANT_REQUIRED_MESSAGE,
  type GrantFormFieldKey,
  focusFirstError,
  validateGrantForm,
} from "~/lib/grant-form-validation";
import {
  type ComposedGrant,
  type GrantCatalog,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";

// The picker's data shapes live in ~/lib/approval-grants — the single
// source shared with the device + OAuth approve loaders.
export type OAuthApprovalDoco = ApprovalDocoOption;
export type OAuthApprovalWorkspace = ApprovalWorkspaceOption;

export function OAuthAccessApprovalForm({
  docos,
  workspaces,
  boundWorkspace,
  tokenNamePlaceholder,
  requestedRole,
  approveLabel,
  cancelLabel,
  cancelDecisionValue,
  hiddenFields,
}: {
  docos: OAuthApprovalDoco[];
  workspaces: OAuthApprovalWorkspace[];
  /**
   * When the connector is bound to one workspace (per-workspace MCP), skip the
   * multi-workspace picker entirely: grant that workspace and just pick an
   * access level.
   */
  boundWorkspace?: { id: string; label: string; maxRole: DocoRole };
  tokenNamePlaceholder: string;
  requestedRole: DocoRole | null;
  approveLabel: string;
  cancelLabel: string;
  cancelDecisionValue: "cancel" | "deny";
  hiddenFields?: Record<string, string>;
}) {
  const catalog = useMemo(() => approvalCatalog(docos, workspaces), [docos, workspaces]);
  const [tokenName, setTokenName] = useState("");
  // No default grant in the open picker: the approver picks the one workspace
  // (or Docos within it) this token may reach. When bound to a workspace, the
  // grant is that workspace — pre-composed as writer, the access level the user
  // then adjusts. A token is capped at a single workspace either way.
  const [grants, setGrants] = useState<ComposedGrant[]>(
    boundWorkspace ? [boundWorkspaceGrant(boundWorkspace.id, "writer")] : [],
  );
  const grantsPayload = useMemo(() => JSON.stringify(grants.map(grantPayload)), [grants]);
  const [errors, setErrors] = useState<Partial<Record<GrantFormFieldKey, string>>>({});

  const boundRole: DocoRole = grants[0]?.role ?? "writer";

  const tokenNameRef = useRef<HTMLInputElement>(null);
  const grantsRef = useRef<HTMLDivElement>(null);

  function clearError(field: GrantFormFieldKey) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const { [field]: _cleared, ...rest } = prev;
      return rest;
    });
  }

  // The Approve button always submits (it is never disabled) so that a click
  // on an incomplete form surfaces the reason instead of silently doing
  // nothing. Validate here, and if anything is missing, block the POST, show
  // the app's error styling, and scroll + focus the first offending field.
  // Deny/Cancel carries a different decision value and `formNoValidate`, so it
  // skips validation entirely.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter && submitter.value !== "approve") return;

    const found = validateGrantForm({
      name: { value: tokenName, message: "Enter a name for this token." },
      grantCount: grants.length,
    });
    if (found.length === 0) {
      setErrors({});
      return;
    }

    e.preventDefault();
    setErrors(Object.fromEntries(found.map((f) => [f.field, f.message])));
    focusFirstError(found[0].field, {
      name: tokenNameRef.current,
      grants: grantsRef.current,
    });
  }

  return (
    <form method="post" noValidate onSubmit={handleSubmit} className="space-y-4">
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}
      <input type="hidden" name="grants" value={grantsPayload} />

      <div>
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Token name
          </span>
          <input
            ref={tokenNameRef}
            type="text"
            name="token_name"
            value={tokenName}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setTokenName(next);
              if (next.trim()) clearError("name");
            }}
            required
            maxLength={120}
            placeholder={tokenNamePlaceholder}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "token-name-error" : undefined}
            className={`block w-full max-w-md rounded-md px-3 py-2 text-sm${
              errors.name ? " border border-destructive ring-1 ring-destructive" : ""
            }`}
          />
        </label>
        {errors.name ? (
          <p id="token-name-error" role="alert" className="mt-1 text-xs text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div ref={grantsRef}>
        {boundWorkspace ? (
          <BoundWorkspaceAccess
            workspaceLabel={boundWorkspace.label}
            maxRole={boundWorkspace.maxRole}
            role={boundRole}
            onChange={(role) => setGrants([boundWorkspaceGrant(boundWorkspace.id, role)])}
          />
        ) : (
          <>
            <GrantPicker
              catalog={catalog}
              grants={grants}
              onChange={(next) => {
                setGrants(next);
                if (next.length > 0) clearError("grants");
              }}
              forToken
            />
            {errors.grants ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {errors.grants}
              </p>
            ) : grants.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{GRANT_REQUIRED_MESSAGE}</p>
            ) : null}
          </>
        )}
      </div>

      {requestedRole ? (
        <p className="text-xs text-muted-foreground">
          The client requested <code>{requestedRole}</code> access; choose that role or a narrower
          one in the matrix.
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
        >
          {approveLabel}
        </button>
        <button
          type="submit"
          name="decision"
          value={cancelDecisionValue}
          formNoValidate
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold text-foreground"
        >
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}

// The whole-workspace grant a bound connector composes: writer carries
// write-all, like the picker's plain "Can write" choice (grant-picker `["*"]`).
function boundWorkspaceGrant(workspaceId: string, role: DocoRole): ComposedGrant {
  return {
    level: "workspace",
    targetId: workspaceId,
    role,
    writeTypes: role === "writer" ? [WRITE_ALL] : [],
  };
}

// Bound-connector consent: the workspace is fixed, so the only choice is how
// much access — read, write, or own — over that whole workspace.
function BoundWorkspaceAccess({
  workspaceLabel,
  maxRole,
  role,
  onChange,
}: {
  workspaceLabel: string;
  maxRole: DocoRole;
  role: DocoRole;
  onChange: (role: DocoRole) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Grant access to the <strong>{workspaceLabel}</strong> workspace — all of its Docos.
      </p>
      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Access level
        </span>
        <select
          data-testid="bound-workspace-access"
          value={role}
          onChange={(e) => onChange(e.currentTarget.value as DocoRole)}
          className="rounded-md px-2 py-1.5 text-sm"
        >
          <option value="reader">Read only</option>
          <option value="writer">Can write</option>
          {maxRole === "owner" ? <option value="owner">Owner</option> : null}
        </select>
      </label>
    </div>
  );
}

function approvalCatalog(
  docos: OAuthApprovalDoco[],
  workspaces: OAuthApprovalWorkspace[],
): GrantCatalog {
  return catalogFromOptions(
    workspaces.map((o) => ({
      id: o.id,
      label:
        o.display_name && o.display_name !== o.handle
          ? `${o.handle} · ${o.display_name}`
          : o.handle,
      maxRole: o.my_role,
    })),
    docos.map((d) => ({
      id: d.id,
      label: d.handle,
      maxRole: d.my_role,
      workspaceId: d.workspace_id ?? undefined,
      workspaceLabel: d.workspace_label ?? undefined,
    })),
  );
}

function grantPayload(g: ComposedGrant) {
  return {
    level: g.level,
    targetId: g.targetId,
    role: g.role,
    writeTypes: resolveWriteTypes(g.role, g.writeTypes),
  };
}
