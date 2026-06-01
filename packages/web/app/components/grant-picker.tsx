import { useMemo, useState } from "react";
import {
  type ComposedGrant,
  type DocoRole,
  type ExistingGrant,
  type GrantCatalog,
  type GrantScope,
  type GrantTarget,
  type TargetRoleChoice,
  type TypeLevel,
  applyDocoTypeLevel,
  applyTargetRole,
  availableScopes,
  describeExistingGrant,
  inheritedTypeLevel,
  targetRoleOptions,
  targetRoleValue,
  targetsByOrg,
  typeDropdownValue,
  writableTypeGroups,
} from "~/lib/grant-picker";

// Shared GRANT WIZARD (collaborators + API-tokens).
//
//   Step 1 — pick the scope (raised buttons; the chosen one sits pressed):
//            my entire account / a specific organization / a specific doco /
//            specific node or edge types.
//   Then, per scope:
//     account — one ACCESS dropdown (read/write/own) over the whole account.
//     org     — every organization listed, each with its own ACCESS dropdown
//               on the right; grant several at once.
//     doco    — first choose ONE organization (removable, to switch); then its
//               docos, each with an ACCESS dropdown; grant several.
//     types   — choose an organization, then a doco, then every node type and
//               edge type listed, each with its own level dropdown.
//
// The picker accumulates a LIST of grants and reports it via onChange; the
// host page renders the submit button.

export function GrantPicker({
  catalog,
  grants,
  onChange,
  existing,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
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
        <div className="neu-surface rounded-md px-3 py-2" data-testid="grant-existing">
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

      {/* Step 1 — scope: raised buttons, pressed when selected. */}
      <fieldset className="space-y-2" data-testid="grant-scope-step">
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">
          What do you want to grant access to?
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {scopes.map((s) => {
            const selected = scope === s.scope;
            return (
              <button
                key={s.scope}
                type="button"
                data-testid={`grant-scope-${s.scope}`}
                aria-pressed={selected}
                onClick={() => {
                  setScope(s.scope);
                  onChange([]); // switching scope clears the selection
                }}
                className={`neu-button${selected ? " neu-pressed" : ""} rounded-md border border-border px-3 py-2 text-left text-sm`}
              >
                <div className="font-semibold">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.blurb}</div>
              </button>
            );
          })}
        </div>
      </fieldset>

      {scope === "account" ? (
        <AccountStep catalog={catalog} grants={grants} onChange={onChange} />
      ) : scope === "org" ? (
        <OrgMultiStep catalog={catalog} grants={grants} onChange={onChange} />
      ) : scope === "doco" ? (
        <DocoMultiStep catalog={catalog} grants={grants} onChange={onChange} />
      ) : scope === "types" ? (
        <TypesStep catalog={catalog} grants={grants} onChange={onChange} />
      ) : null}
    </div>
  );
}

/** A labeled ACCESS dropdown ("No access" + capped roles) for one target. */
function AccessSelect({
  testid,
  maxRole,
  value,
  onChange,
}: {
  testid: string;
  maxRole: DocoRole;
  value: TargetRoleChoice;
  onChange: (v: TargetRoleChoice) => void;
}) {
  const opts = targetRoleOptions(maxRole);
  const label = (o: TargetRoleChoice) =>
    o === "none"
      ? "No access"
      : o === "owner"
        ? "Owner"
        : o === "writer"
          ? "Can write"
          : "Read only";
  return (
    <select
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as TargetRoleChoice)}
      className="rounded-md px-2 py-1 text-xs"
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {label(o)}
        </option>
      ))}
    </select>
  );
}

/** A target row: label on the left, its ACCESS dropdown on the right. */
function TargetRow({
  target,
  level,
  grants,
  onChange,
}: {
  target: GrantTarget;
  level: "org" | "doco";
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const value = targetRoleValue(grants, level, target.id);
  const selected = value !== "none";
  return (
    <li
      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
        selected ? "border-primary bg-primary/10" : "border-border"
      }`}
    >
      <span className="text-sm">{target.label}</span>
      <AccessSelect
        testid={`grant-row-${level}-${target.id}`}
        maxRole={target.maxRole}
        value={value}
        onChange={(v) => onChange(applyTargetRole(grants, level, target.id, v))}
      />
    </li>
  );
}

// Account: one ACCESS dropdown over the whole account (no per-type, no target).
function AccountStep({
  catalog,
  grants,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const maxRole: DocoRole = catalog.targets.some((t) => t.level === "org" && t.maxRole === "owner")
    ? "owner"
    : "reader";
  const current = grants.find((g) => g.level === "account");
  const value: TargetRoleChoice = current?.role ?? "none";
  const apply = (v: TargetRoleChoice) => {
    if (v === "none") {
      onChange(grants.filter((g) => g.level !== "account"));
    } else {
      onChange([
        ...grants.filter((g) => g.level !== "account"),
        { level: "account", targetId: "", role: v, writeTypes: v === "writer" ? ["*"] : [] },
      ]);
    }
  };
  return (
    <div className="rounded-md border border-border px-3 py-3" data-testid="grant-account-step">
      <p className="mb-2 text-sm text-muted-foreground">
        Grants this access on <strong>every organization you own</strong> and all their docos —
        including ones created later.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Access</span>
        <AccessSelect
          testid="grant-role-account"
          maxRole={maxRole}
          value={value}
          onChange={apply}
        />
      </div>
    </div>
  );
}

// Org: list every organization, each with its own ACCESS dropdown.
function OrgMultiStep({
  catalog,
  grants,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const orgs = catalog.targets.filter((t) => t.level === "org");
  return (
    <div className="space-y-2" data-testid="grant-org-step">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Choose organizations — set an access level for each
      </div>
      <ul className="space-y-1">
        {orgs.map((t) => (
          <TargetRow key={t.id} target={t} level="org" grants={grants} onChange={onChange} />
        ))}
        {orgs.length === 0 ? (
          <li className="text-sm text-muted-foreground">No organizations you can grant.</li>
        ) : null}
      </ul>
    </div>
  );
}

// Doco: choose one organization (removable), then its docos with dropdowns.
function DocoMultiStep({
  catalog,
  grants,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const groups = useMemo(() => targetsByOrg(catalog), [catalog]);
  const orgsWithDocos = groups.filter((g) => g.docos.length > 0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const active = orgsWithDocos.find((g) => g.org.id === orgId) ?? null;

  if (!active) {
    return (
      <div className="space-y-2" data-testid="grant-doco-org-step">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Which organization is the doco in?
        </div>
        <ul className="space-y-1">
          {orgsWithDocos.map((g) => (
            <li key={g.org.id}>
              <button
                type="button"
                data-testid={`grant-doco-org-${g.org.id}`}
                onClick={() => setOrgId(g.org.id)}
                className="neu-button w-full rounded-md border border-border px-3 py-2 text-left text-sm"
              >
                {g.org.label}
              </button>
            </li>
          ))}
          {orgsWithDocos.length === 0 ? (
            <li className="text-sm text-muted-foreground">No docos you can grant.</li>
          ) : null}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="grant-doco-step">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Docos in {active.org.label}
        </div>
        <button
          type="button"
          data-testid="grant-doco-change-org"
          onClick={() => setOrgId(null)}
          className="neu-button rounded-md border border-border px-2 py-1 text-xs"
        >
          ← Change organization
        </button>
      </div>
      <ul className="space-y-1">
        {active.docos.map((t) => (
          <TargetRow key={t.id} target={t} level="doco" grants={grants} onChange={onChange} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Pick docos here, or change organization to grant docos in another — selections add up.
      </p>
    </div>
  );
}

// Types: org → doco → per-type level dropdowns for that doco.
function TypesStep({
  catalog,
  grants,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const groups = useMemo(() => targetsByOrg(catalog), [catalog]);
  const orgsWithDocos = groups.filter((g) => g.docos.length > 0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [docoId, setDocoId] = useState<string | null>(null);
  const active = orgsWithDocos.find((g) => g.org.id === orgId) ?? null;
  const doco = active?.docos.find((d) => d.id === docoId) ?? null;

  if (!active) {
    return (
      <div className="space-y-2" data-testid="grant-types-org-step">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Which organization is the doco in?
        </div>
        <ul className="space-y-1">
          {orgsWithDocos.map((g) => (
            <li key={g.org.id}>
              <button
                type="button"
                data-testid={`grant-types-org-${g.org.id}`}
                onClick={() => setOrgId(g.org.id)}
                className="neu-button w-full rounded-md border border-border px-3 py-2 text-left text-sm"
              >
                {g.org.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!doco) {
    return (
      <div className="space-y-2" data-testid="grant-types-doco-step">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Which doco in {active.org.label}?
          </div>
          <button
            type="button"
            data-testid="grant-types-change-org"
            onClick={() => setOrgId(null)}
            className="neu-button rounded-md border border-border px-2 py-1 text-xs"
          >
            ← Change organization
          </button>
        </div>
        <ul className="space-y-1">
          {active.docos.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                data-testid={`grant-types-doco-${d.id}`}
                onClick={() => setDocoId(d.id)}
                className="neu-button w-full rounded-md border border-border px-3 py-2 text-left text-sm"
              >
                {d.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <DocoTypeGrid doco={doco} grants={grants} onChange={onChange} onBack={() => setDocoId(null)} />
  );
}

// The node-type / edge-type list for one doco, each row with a level dropdown.
function DocoTypeGrid({
  doco,
  grants,
  onChange,
  onBack,
}: {
  doco: GrantTarget;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
  onBack: () => void;
}) {
  const { nodes, edges } = writableTypeGroups();
  const allTypes = [...nodes, ...edges];
  const current = grants.find((g) => g.level === "doco" && g.targetId === doco.id);
  const writeTypes = current?.writeTypes ?? [];
  // Base for the per-type display is always reader (types scope grants write
  // selectively on top of read-everything).
  const inherited = inheritedTypeLevel("reader", writeTypes);
  const change = (t: string, next: TypeLevel) =>
    onChange(applyDocoTypeLevel(grants, doco.id, t, next, allTypes));

  return (
    <div
      className="space-y-3 rounded-md border border-border px-3 py-3"
      data-testid="grant-types-grid"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{doco.label}</div>
        <button
          type="button"
          data-testid="grant-types-change-doco"
          onClick={onBack}
          className="neu-button rounded-md border border-border px-2 py-1 text-xs"
        >
          ← Change doco
        </button>
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <TypeColumn
          title="Node types"
          types={nodes}
          docoId={doco.id}
          writeTypes={writeTypes}
          inherited={inherited}
          onChange={change}
        />
        <TypeColumn
          title="Edge types"
          types={edges}
          docoId={doco.id}
          writeTypes={writeTypes}
          inherited={inherited}
          onChange={change}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Reads everything; each type defaults to read — set any to “Can write”.
      </p>
    </div>
  );
}

function TypeColumn({
  title,
  types,
  docoId,
  writeTypes,
  inherited,
  onChange,
}: {
  title: string;
  types: readonly string[];
  docoId: string;
  writeTypes: string[];
  inherited: "read" | "write";
  onChange: (t: string, next: TypeLevel) => void;
}) {
  const defaultLabel = `Default — ${inherited === "write" ? "can write" : "read only"}`;
  return (
    <fieldset className="col-span-1 space-y-1">
      <legend className="text-xs uppercase tracking-wide text-muted-foreground">{title}</legend>
      {types.map((t) => (
        <label key={t} className="flex items-center justify-between gap-2 text-sm">
          <span className="font-mono">{t}</span>
          <select
            data-testid={`grant-type-${docoId}-${t}`}
            value={typeDropdownValue("reader", writeTypes, t)}
            onChange={(e) => onChange(t, e.currentTarget.value as TypeLevel)}
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
