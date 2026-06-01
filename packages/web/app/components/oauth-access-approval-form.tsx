import type { DocoRole } from "@doco/db";
import { useMemo, useState } from "react";
import { GrantPicker } from "~/components/grant-picker";
import type { ApprovalDocoOption, ApprovalOrgOption } from "~/lib/approval-grants";
import {
  type ComposedGrant,
  type GrantCatalog,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";

// The picker's data shapes live in ~/lib/approval-grants — the single
// source shared with the device + OAuth approve loaders.
export type OAuthApprovalDoco = ApprovalDocoOption;
export type OAuthApprovalOrg = ApprovalOrgOption;

export function OAuthAccessApprovalForm({
  docos,
  orgs,
  tokenNamePlaceholder,
  requestedRole,
  approveLabel,
  cancelLabel,
  cancelDecisionValue,
  hiddenFields,
}: {
  docos: OAuthApprovalDoco[];
  orgs: OAuthApprovalOrg[];
  tokenNamePlaceholder: string;
  requestedRole: DocoRole | null;
  approveLabel: string;
  cancelLabel: string;
  cancelDecisionValue: "cancel" | "deny";
  hiddenFields?: Record<string, string>;
}) {
  const catalog = useMemo(() => approvalCatalog(docos, orgs), [docos, orgs]);
  const [tokenName, setTokenName] = useState("");
  const [grants, setGrants] = useState<ComposedGrant[]>([]);
  const grantsPayload = useMemo(() => JSON.stringify(grants.map(grantPayload)), [grants]);
  const nothingSelected = grants.length === 0;

  return (
    <form method="post" className="space-y-4">
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}
      <input type="hidden" name="grants" value={grantsPayload} />

      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Token name
        </span>
        <input
          type="text"
          name="token_name"
          value={tokenName}
          onChange={(e) => setTokenName(e.currentTarget.value)}
          required
          maxLength={120}
          placeholder={tokenNamePlaceholder}
          className="block w-full max-w-md rounded-md px-3 py-2 text-sm"
        />
      </label>

      <GrantPicker catalog={catalog} grants={grants} onChange={setGrants} />

      {requestedRole ? (
        <p className="text-xs text-muted-foreground">
          The client requested <code>{requestedRole}</code> access; choose that role or a narrower
          one in the matrix.
        </p>
      ) : null}

      {nothingSelected ? (
        <p className="text-xs text-muted-foreground">
          Select at least one access grant to approve.
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={nothingSelected || !tokenName.trim()}
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
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

function approvalCatalog(docos: OAuthApprovalDoco[], orgs: OAuthApprovalOrg[]): GrantCatalog {
  return catalogFromOptions(
    orgs.map((o) => ({
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
      orgId: d.org_id ?? undefined,
      orgLabel: d.org_label ?? undefined,
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
