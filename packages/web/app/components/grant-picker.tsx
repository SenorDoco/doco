import { useMemo, useState } from "react";
import {
  type ComposedGrant,
  type DocoRole,
  type ExistingGrant,
  type GrantCatalog,
  type GrantScope,
  type GrantTarget,
  type TypeLevel,
  availableScopes,
  describeExistingGrant,
  describeWriteScope,
  grantableRoles,
  inheritedTypeLevel,
  setTypeLevel,
  targetsByOrg,
  typeDropdownValue,
  writableTypeGroups,
} from "~/lib/grant-picker";

// Shared GRANT WIZARD for the collaborators and API-tokens pages
// (decision_per_type_write_grants + account grants). A guided flow, not a
// wall of checkboxes:
//
//   Step 1 — pick the scope: my entire account / an org / a Doco /
//            specific node+edge types.
//   Step 2 — pick the concrete target (an org, or a Doco), unless the
//            scope is the whole account (no target — the grantor IS it).
//   Step 3 — choose read / write / owner; for the "types" scope (or a
//            write grant) tick the node and edge types.
//
// When EXPANDING an existing grantee/token, `existing` is shown on top so
// the granter sees what they already have before widening it.
//
// Emits a ComposedGrant via onChange; the host page owns the submit
// button so this component is purely about *which access*.

export function GrantPicker({
  catalog,
  value,
  onChange,
  existing,
}: {
  catalog: GrantCatalog;
  value: ComposedGrant | null;
  onChange: (grant: ComposedGrant | null) => void;
  /** Grants the grantee/token already holds (widen-existing flow). */
  existing?: ExistingGrant[];
}) {
  const scopes = useMemo(() => availableScopes(catalog), [catalog]);
  const [scope, setScope] = useState<GrantScope | null>(null);

  if (scopes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="grant-picker-empty">
        You don't have anything you can grant access to yet.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="grant-picker">
      {existing && existing.length > 0 ? (
        <div
          className="rounded-md border border-border bg-muted/40 px-3 py-2"
          data-testid="grant-existing"
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Already has access to
          </div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {existing.map((g) => (
              <li key={`${g.level}:${g.label}`} data-testid="grant-existing-row">
                {describeExistingGrant(g)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Step 1 — scope */}
      <fieldset className="space-y-2" data-testid="grant-scope-step">
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">
          What do you want to grant access to?
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {scopes.map((s) => (
            <button
              key={s.scope}
              type="button"
              data-testid={`grant-scope-${s.scope}`}
              aria-pressed={scope === s.scope}
              onClick={() => {
                setScope(s.scope);
                onChange(null);
              }}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                scope === s.scope ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
              }`}
            >
              <div className="font-semibold">{s.title}</div>
              <div className="text-xs text-muted-foreground">{s.blurb}</div>
            </button>
          ))}
        </div>
      </fieldset>

      {/* Steps 2–3 — adapt to the chosen scope */}
      {scope === "account" ? (
        <AccountStep value={value} onChange={onChange} catalog={catalog} />
      ) : scope === "org" ? (
        <TargetStep
          level="org"
          catalog={catalog}
          value={value}
          onChange={onChange}
          typesAllowed={false}
        />
      ) : scope === "doco" ? (
        <TargetStep
          level="doco"
          catalog={catalog}
          value={value}
          onChange={onChange}
          typesAllowed={false}
        />
      ) : scope === "types" ? (
        <TargetStep
          level="doco"
          catalog={catalog}
          value={value}
          onChange={onChange}
          typesAllowed={true}
        />
      ) : null}
    </div>
  );
}

// Account scope: no target to pick — choose the role (+ per-type) that
// applies across every org the granter owns.
function AccountStep({
  value,
  onChange,
  catalog,
}: {
  value: ComposedGrant | null;
  onChange: (g: ComposedGrant | null) => void;
  catalog: GrantCatalog;
}) {
  // The cap for an account grant is owner (you can only grant your whole
  // account if you own orgs, and you may delegate up to owner there).
  const maxRole: DocoRole = catalog.targets.some((t) => t.level === "org" && t.maxRole === "owner")
    ? "owner"
    : "reader";
  const current =
    value?.level === "account"
      ? value
      : { level: "account" as const, targetId: "", role: "reader" as DocoRole, writeTypes: [] };
  return (
    <div className="rounded-md border border-border px-3 py-3" data-testid="grant-account-step">
      <p className="mb-2 text-sm text-muted-foreground">
        Grants this access on <strong>every organization you own</strong> and all their docos —
        including ones created later.
      </p>
      <AccessControls
        idBase="account"
        maxRole={maxRole}
        role={current.role}
        writeTypes={current.writeTypes}
        typesAllowed={true}
        onChange={(role, writeTypes) =>
          onChange({ level: "account", targetId: "", role, writeTypes })
        }
      />
    </div>
  );
}

// Org / doco scope: pick the concrete target (grouped by org), then set
// access. When typesAllowed, the access step shows the per-type level
// dropdowns (the "specific types" scope).
function TargetStep({
  level,
  catalog,
  value,
  onChange,
  typesAllowed,
}: {
  level: "org" | "doco";
  catalog: GrantCatalog;
  value: ComposedGrant | null;
  onChange: (g: ComposedGrant | null) => void;
  typesAllowed: boolean;
}) {
  const groups = useMemo(() => targetsByOrg(catalog), [catalog]);
  // Flatten the targets of this level, grouped under their org for display.
  const orgsWithTargets = groups
    .map((g) => ({
      org: g.org,
      targets: level === "org" ? (g.orgTarget ? [g.orgTarget] : []) : g.docos,
    }))
    .filter((g) => g.targets.length > 0);

  const selected = value && value.level === level ? value : null;
  const target = selected
    ? (catalog.targets.find((t) => t.level === level && t.id === selected.targetId) ?? null)
    : null;

  return (
    <div className="space-y-3" data-testid={`grant-target-step-${level}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Choose {level === "org" ? "an organization" : "a doco"}
      </div>
      <div className="space-y-2">
        {orgsWithTargets.map((g) => (
          <div key={g.org.id}>
            {level === "doco" ? (
              <div className="text-[11px] font-semibold text-muted-foreground">{g.org.label}</div>
            ) : null}
            <ul className="space-y-1">
              {g.targets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    data-testid={`grant-target-${t.id}`}
                    aria-pressed={target?.id === t.id}
                    onClick={() =>
                      onChange({
                        level,
                        targetId: t.id,
                        role: "reader",
                        writeTypes: [],
                      })
                    }
                    className={`w-full rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                      target?.id === t.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {orgsWithTargets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No grantable targets of this kind.</p>
        ) : null}
      </div>

      {target ? (
        <div className="rounded-md border border-border px-3 py-3" data-testid="grant-access-step">
          <div className="mb-2 text-sm font-medium">{target.label}</div>
          <AccessControls
            idBase={target.id}
            maxRole={target.maxRole}
            role={selected?.role ?? "reader"}
            writeTypes={selected?.writeTypes ?? []}
            typesAllowed={typesAllowed}
            onChange={(role, writeTypes) =>
              onChange({ level, targetId: target.id, role, writeTypes })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// The role + per-type controls, shared by the account and target steps.
function AccessControls({
  idBase,
  maxRole,
  role,
  writeTypes,
  typesAllowed,
  onChange,
}: {
  idBase: string;
  maxRole: DocoRole;
  role: DocoRole;
  writeTypes: string[];
  typesAllowed: boolean;
  onChange: (role: DocoRole, writeTypes: string[]) => void;
}) {
  const roles = grantableRoles(maxRole);
  const { nodes, edges } = writableTypeGroups();
  const allTypes = [...nodes, ...edges];
  const inherited = inheritedTypeLevel(role, writeTypes);

  const changeTypeLevel = (t: string, next: TypeLevel) =>
    onChange(role, setTypeLevel(role, writeTypes, t, next, allTypes));

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Access</span>
        <select
          data-testid={`grant-role-${idBase}`}
          value={role}
          onChange={(e) => {
            const r = e.currentTarget.value as DocoRole;
            // When the per-type controls aren't shown (org / whole-doco
            // scope), the role alone decides write: a writer writes
            // everything (wildcard), a reader writes nothing, an owner
            // administers. Only the "specific types" scope keeps an explicit
            // per-type set; changing the base role there resets overrides so
            // every type follows the new inherited level.
            const nextTypes = !typesAllowed
              ? r === "writer"
                ? ["*"]
                : []
              : r === "writer"
                ? ["*"]
                : [];
            onChange(r, nextTypes);
          }}
          className="rounded-md px-2 py-1"
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {describeWriteScope(role, writeTypes)}
        </span>
      </label>

      {role !== "owner" && typesAllowed ? (
        <div className="space-y-2" data-testid={`grant-types-${idBase}`}>
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <TypeGroup
              title="Node types"
              types={nodes}
              idBase={idBase}
              role={role}
              writeTypes={writeTypes}
              inherited={inherited}
              onChangeLevel={changeTypeLevel}
            />
            <TypeGroup
              title="Edge types"
              types={edges}
              idBase={idBase}
              role={role}
              writeTypes={writeTypes}
              inherited={inherited}
              onChangeLevel={changeTypeLevel}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Each type defaults to its inherited level; override any with the dropdown.
          </p>
        </div>
      ) : role === "owner" ? (
        <p className="text-xs text-muted-foreground">Owner administers and writes every type.</p>
      ) : null}
    </div>
  );
}

function TypeGroup({
  title,
  types,
  idBase,
  role,
  writeTypes,
  inherited,
  onChangeLevel,
}: {
  title: string;
  types: readonly string[];
  idBase: string;
  role: DocoRole;
  writeTypes: string[];
  inherited: "read" | "write";
  onChangeLevel: (t: string, next: TypeLevel) => void;
}) {
  const defaultLabel = `Default — ${inherited === "write" ? "can write" : "read only"}`;
  return (
    <fieldset className="col-span-1 space-y-1">
      <legend className="text-xs uppercase tracking-wide text-muted-foreground">{title}</legend>
      {types.map((t) => (
        <label key={t} className="flex items-center justify-between gap-2 text-sm">
          <span className="font-mono">{t}</span>
          <select
            data-testid={`grant-type-${idBase}-${t}`}
            value={typeDropdownValue(role, writeTypes, t)}
            onChange={(e) => onChangeLevel(t, e.currentTarget.value as TypeLevel)}
            className="rounded-md px-2 py-0.5 text-xs"
          >
            <option value="default">{defaultLabel}</option>
            <option value="read">Read only</option>
            <option value="write">Can write</option>
          </select>
        </label>
      ))}
    </fieldset>
  );
}
