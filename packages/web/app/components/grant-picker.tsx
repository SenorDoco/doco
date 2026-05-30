import { useMemo, useState } from "react";
import {
  type ComposedGrant,
  type DocoRole,
  type GrantCatalog,
  type GrantTarget,
  describeWriteScope,
  grantableRoles,
  targetsByOrg,
  writableTypeGroups,
} from "~/lib/grant-picker";

// Shared permission picker for the collaborators and API-tokens pages
// (decision_per_type_write_grants). Drill-down, NOT a flat dropdown of
// every org and doco at once:
//
//   1. pick an organization
//   2. see its Docos (and the org itself) listed below
//   3. expand a target → choose read / write / owner
//   4. for write → tick the node and edge TYPES to grant
//
// Emits a ComposedGrant via onChange; the host page renders the submit
// affordance (invite button / token mint / save) so this component stays
// purely about *which access*.

export function GrantPicker({
  catalog,
  value,
  onChange,
}: {
  catalog: GrantCatalog;
  value: ComposedGrant | null;
  onChange: (grant: ComposedGrant | null) => void;
}) {
  const groups = useMemo(() => targetsByOrg(catalog), [catalog]);
  const [orgId, setOrgId] = useState<string>(groups[0]?.org.id ?? "");

  const active = groups.find((g) => g.org.id === orgId) ?? groups[0];
  if (!active) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="grant-picker-empty">
        No organizations you can grant access into.
      </p>
    );
  }

  const targetsHere: GrantTarget[] = [
    ...(active.orgTarget ? [active.orgTarget] : []),
    ...active.docos,
  ];

  return (
    <div className="space-y-3" data-testid="grant-picker">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Organization</span>
        <select
          data-testid="grant-org"
          value={active.org.id}
          onChange={(e) => {
            setOrgId(e.currentTarget.value);
            onChange(null);
          }}
          className="rounded-md px-3 py-2"
        >
          {groups.map((g) => (
            <option key={g.org.id} value={g.org.id}>
              {g.org.label}
            </option>
          ))}
        </select>
      </label>

      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Docos in {active.org.label}
      </div>
      <ul className="space-y-1" data-testid="grant-targets">
        {targetsHere.map((t) => (
          <TargetRow
            key={`${t.level}:${t.id}`}
            target={t}
            selected={value?.level === t.level && value?.targetId === t.id ? value : null}
            onSelect={onChange}
          />
        ))}
        {targetsHere.length === 0 ? (
          <li className="text-sm text-muted-foreground">No grantable targets in this org.</li>
        ) : null}
      </ul>
    </div>
  );
}

function TargetRow({
  target,
  selected,
  onSelect,
}: {
  target: GrantTarget;
  selected: ComposedGrant | null;
  onSelect: (grant: ComposedGrant | null) => void;
}) {
  const open = selected !== null;
  const role: DocoRole = selected?.role ?? "reader";
  const writeTypes = selected?.writeTypes ?? [];
  const roles = grantableRoles(target.maxRole);
  const { nodes, edges } = writableTypeGroups();

  const emit = (next: { role?: DocoRole; writeTypes?: string[] }) =>
    onSelect({
      level: target.level,
      targetId: target.id,
      role: next.role ?? role,
      writeTypes: next.writeTypes ?? writeTypes,
    });

  const toggleType = (t: string, on: boolean) => {
    const set = new Set(writeTypes.filter((x) => x !== "*"));
    if (on) set.add(t);
    else set.delete(t);
    emit({ writeTypes: [...set] });
  };

  const allTypes = [...nodes, ...edges];
  const wildcard = writeTypes.includes("*");
  const writeMode = role !== "reader" || writeTypes.length > 0;

  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        data-testid={`grant-target-${target.id}`}
        onClick={() => (open ? onSelect(null) : emit({ role: "reader" }))}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
      >
        <span>
          <span className="rounded bg-input px-1.5 py-0.5 text-xs">[{target.level}]</span>{" "}
          {target.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {open ? describeWriteScope(role, writeTypes) : "click to grant"}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Access</span>
            <select
              data-testid={`grant-role-${target.id}`}
              value={role}
              onChange={(e) => {
                const r = e.currentTarget.value as DocoRole;
                // Switching to owner drops the per-type set (owner writes all);
                // switching to reader clears write unless types are picked.
                emit({ role: r, writeTypes: r === "owner" ? [] : writeTypes });
              }}
              className="rounded-md px-2 py-1"
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          {role !== "owner" ? (
            <div className="space-y-2" data-testid={`grant-types-${target.id}`}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  data-testid={`grant-write-all-${target.id}`}
                  checked={wildcard}
                  onChange={(e) => emit({ writeTypes: e.currentTarget.checked ? ["*"] : [] })}
                />
                Write everything
              </label>
              {!wildcard ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  <TypeGroup
                    title="Nodes"
                    types={nodes}
                    targetId={target.id}
                    writeTypes={writeTypes}
                    onToggle={toggleType}
                  />
                  <TypeGroup
                    title="Edges"
                    types={edges}
                    targetId={target.id}
                    writeTypes={writeTypes}
                    onToggle={toggleType}
                  />
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {writeMode
                  ? "Reads everything; writes only the ticked types."
                  : "Read-only. Tick types (or “Write everything”) to grant write."}
                {allTypes.length === writeTypes.filter((t) => t !== "*").length
                  ? " (all types — same as Write everything)"
                  : ""}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Owner administers the {target.level} and writes every type.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function TypeGroup({
  title,
  types,
  targetId,
  writeTypes,
  onToggle,
}: {
  title: string;
  types: readonly string[];
  targetId: string;
  writeTypes: string[];
  onToggle: (t: string, on: boolean) => void;
}) {
  return (
    <fieldset className="col-span-1">
      <legend className="text-xs uppercase tracking-wide text-muted-foreground">{title}</legend>
      {types.map((t) => (
        <label key={t} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            data-testid={`grant-type-${targetId}-${t}`}
            checked={writeTypes.includes(t)}
            onChange={(e) => onToggle(t, e.currentTarget.checked)}
          />
          {t}
        </label>
      ))}
    </fieldset>
  );
}
