import type { DocoRole } from "@doco/db";
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
  actorGrant,
  applyTargetRole,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";

// The picker's data shapes live in ~/lib/approval-grants — the single
// source shared with the device + OAuth approve loaders.
export type OAuthApprovalDoco = ApprovalDocoOption;
export type OAuthApprovalWorkspace = ApprovalWorkspaceOption;

const CAN: Record<DocoRole, string> = {
  reader: "read",
  writer: "read and write",
  owner: "read, write and manage",
};

/**
 * What a person sees when an agent signs in to Doco: one sentence saying what
 * the agent will reach, and Allow (decision_01M4EQPJ6AKETJ1508W254DXVB). By
 * default the agent acts as the person in all their workspaces, or, for a
 * connector bound to one workspace, reads and writes that workspace, at the
 * level the client asked for when it asked. Limit access opens the picker for
 * anyone who wants less. The connection goes by the client's own name, so
 * there is no token to name.
 */
export function OAuthAccessApprovalForm({
  clientName,
  docos,
  workspaces,
  boundWorkspace,
  requestedRole,
  cancelLabel,
  cancelDecisionValue,
  hiddenFields,
}: {
  clientName: string;
  docos: OAuthApprovalDoco[];
  workspaces: OAuthApprovalWorkspace[];
  /**
   * When the connector authorized against a workspace-scoped resource, the
   * agent gets that workspace, and the picker leads with "The entire <name>
   * workspace" and can still narrow to Docos within it — never other
   * workspaces. The catalog is expected to already be scoped to it.
   */
  boundWorkspace?: { id: string; label: string; maxRole: DocoRole };
  requestedRole: DocoRole | null;
  cancelLabel: string;
  cancelDecisionValue: "cancel" | "deny";
  hiddenFields?: Record<string, string>;
}) {
  const catalog = useMemo(() => approvalCatalog(docos, workspaces), [docos, workspaces]);
  const role = requestedRole ?? (boundWorkspace ? "writer" : "owner");
  const [limiting, setLimiting] = useState(false);
  const [grants, setGrants] = useState<ComposedGrant[]>(() =>
    boundWorkspace ? applyTargetRole([], "workspace", boundWorkspace.id, role) : [actorGrant(role)],
  );
  const grantsPayload = useMemo(() => JSON.stringify(grants.map(grantPayload)), [grants]);
  const [errors, setErrors] = useState<Partial<Record<GrantFormFieldKey, string>>>({});
  const grantsRef = useRef<HTMLDivElement>(null);

  // Allow always submits (it is never disabled) so that a click on an empty
  // pick surfaces the reason instead of silently doing nothing. Cancel/Deny
  // carries a different decision value, so it skips validation.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter && submitter.value !== "approve") return;

    const found = validateGrantForm({ grantCount: grants.length });
    if (found.length === 0) {
      setErrors({});
      return;
    }

    e.preventDefault();
    setErrors(Object.fromEntries(found.map((f) => [f.field, f.message])));
    focusFirstError(found[0].field, { grants: grantsRef.current });
  }

  return (
    <form method="post" noValidate onSubmit={handleSubmit} className="space-y-4">
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}
      <input type="hidden" name="grants" value={grantsPayload} />

      {limiting ? (
        <div ref={grantsRef}>
          <GrantPicker
            catalog={catalog}
            grants={grants}
            onChange={(next) => {
              setGrants(next);
              if (next.length > 0) setErrors({});
            }}
            offerActor
            boundWorkspace={boundWorkspace}
          />
          {errors.grants ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {errors.grants}
            </p>
          ) : grants.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{GRANT_REQUIRED_MESSAGE}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm">
          {clientName} will be able to {CAN[role]}{" "}
          {boundWorkspace
            ? `the ${boundWorkspace.label} workspace.`
            : "everything you can, in all your workspaces, including ones you join later."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
        >
          Allow
        </button>
        <button
          type="submit"
          name="decision"
          value={cancelDecisionValue}
          formNoValidate
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
        >
          {cancelLabel}
        </button>
        {limiting ? null : (
          <button
            type="button"
            onClick={() => {
              setGrants([]);
              setLimiting(true);
            }}
            className="ml-auto text-sm text-primary hover:underline"
          >
            Limit access
          </button>
        )}
      </div>
    </form>
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
