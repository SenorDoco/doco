import { X } from "lucide-react";
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
  actorGrant,
  applyDocoTypeLevel,
  applyTargetRole,
  availableScopes,
  describeExistingGrant,
  findExistingGrant,
  findGrant,
  inheritedTypeLevel,
  targetRoleOptions,
  targetRoleValue,
  targetsByWorkspace,
  typeDropdownValue,
  writableTypeGroups,
} from "~/lib/grant-picker";

// Shared GRANT WIZARD (collaborators + API-tokens).
//
//   Step 1 — pick the scope (raised buttons; the chosen one sits pressed):
//            specific workspaces / specific docos / specific node or edge
//            types (and, for tokens only, the "all workspaces" actor scope).
//   Then, per scope:
//     workspace     — every workspace listed, each with its own ACCESS dropdown
//               on the right; grant several at once.
//     doco    — first choose ONE workspace (pressed/removable); then its
//               docos, each with an ACCESS dropdown; grant several.
//     types   — choose an workspace, then a doco, then every node type and
//               edge type listed, each with its own level dropdown.
//
// The picker accumulates a LIST of grants and reports it via onChange; the
// host page renders the submit button.

export function GrantPicker({
  catalog,
  grants,
  onChange,
  existing,
  offerActor = false,
  boundWorkspace,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
  /** Grants the grantee/token already holds (widen-existing flow). */
  existing?: ExistingGrant[];
  /**
   * Offer the actor ("all workspaces") scope — a user-level credential that
   * follows live membership. The consent screens set this; the /tokens page
   * surfaces actor through its own top-level toggle instead, so it leaves this
   * off. Suppressed for a bound (per-workspace) connector either way.
   */
  offerActor?: boolean;
  /**
   * When the connector authorized against a workspace-scoped resource, the
   * first scope option becomes "The entire <name> workspace" with its
   * access-level dropdown inline in the row; "Specific docos" / "types" still
   * narrow within it. The catalog is expected to already be scoped to that one
   * workspace.
   */
  boundWorkspace?: { id: string; label: string; maxRole: DocoRole };
}) {
  const scopes = useMemo(
    () =>
      availableScopes(catalog, {
        offerActor,
        boundWorkspaceLabel: boundWorkspace?.label,
      }),
    [catalog, offerActor, boundWorkspace],
  );
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

      {/* Step 1 — scope: raised rows stacked vertically, pressed when selected. */}
      <fieldset className="space-y-2" data-testid="grant-scope-step">
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">
          What do you want to grant access to?
        </legend>
        <div className="space-y-2">
          {scopes.map((s) => {
            const selected = scope === s.scope;
            const boundWorkspaceRow = Boolean(boundWorkspace) && s.scope === "workspace";
            const select = () => {
              setScope(s.scope);
              // Picking the bound workspace composes a default writer grant so
              // its inline dropdown opens on "Can write". The actor scope IS the
              // grant — there's no target or role to pick — so selecting it
              // composes the act-as-me grant directly. Any other scope starts
              // from a clean slate.
              if (boundWorkspace && s.scope === "workspace") {
                onChange(applyTargetRole([], "workspace", boundWorkspace.id, "writer"));
              } else if (s.scope === "actor") {
                onChange([actorGrant()]);
              } else {
                onChange([]);
              }
            };
            const boxCls = `neu-button${selected ? " neu-pressed" : ""} rounded-md border border-border px-3 py-2 text-left text-sm`;
            const label = (
              <>
                <div className="font-semibold">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.blurb}</div>
              </>
            );
            // The bound workspace, once chosen, carries its access-level
            // dropdown on the right of the same row (a <select> can't nest in a
            // <button>, so the row wraps the button + select).
            if (boundWorkspaceRow && selected && boundWorkspace) {
              return (
                <div key={s.scope} className={`flex items-center justify-between gap-3 ${boxCls}`}>
                  <button
                    type="button"
                    data-testid={`grant-scope-${s.scope}`}
                    aria-pressed={selected}
                    onClick={select}
                    className="min-w-0 flex-1 text-left"
                  >
                    {label}
                  </button>
                  <AccessSelect
                    testid="bound-workspace-access"
                    maxRole={boundWorkspace.maxRole}
                    value={targetRoleValue(grants, "workspace", boundWorkspace.id)}
                    includeNoAccess={false}
                    onChange={(v) =>
                      onChange(applyTargetRole(grants, "workspace", boundWorkspace.id, v))
                    }
                  />
                </div>
              );
            }
            return (
              <button
                key={s.scope}
                type="button"
                data-testid={`grant-scope-${s.scope}`}
                aria-pressed={selected}
                onClick={select}
                className={`block w-full ${boxCls}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {scope === "actor" ? (
        <ActorStep grants={grants} onChange={onChange} />
      ) : scope === "workspace" ? (
        // Bound mode grants the whole workspace via the inline dropdown above —
        // no multi-workspace list step.
        boundWorkspace ? null : (
          <WorkspaceMultiStep
            catalog={catalog}
            grants={grants}
            onChange={onChange}
            existing={existing}
          />
        )
      ) : scope === "doco" ? (
        <DocoMultiStep catalog={catalog} grants={grants} onChange={onChange} existing={existing} />
      ) : scope === "types" ? (
        <TypesStep catalog={catalog} grants={grants} onChange={onChange} existing={existing} />
      ) : null}
    </div>
  );
}

/** A labeled ACCESS dropdown ("No access" + capped roles) for one target. */
function AccessSelect({
  testid,
  maxRole,
  value,
  includeNoAccess = true,
  onChange,
}: {
  testid: string;
  maxRole: DocoRole;
  value: TargetRoleChoice;
  includeNoAccess?: boolean;
  onChange: (v: TargetRoleChoice) => void;
}) {
  const opts = targetRoleOptions(maxRole).filter((o) => includeNoAccess || o !== "none");
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
  existing,
  onChange,
}: {
  target: GrantTarget;
  level: "workspace" | "doco";
  grants: ComposedGrant[];
  existing?: ExistingGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const existingGrant = findExistingGrant(existing, level, target.id);
  const value = targetRoleValue(grants, level, target.id, existing);
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
        includeNoAccess={!existingGrant}
        onChange={(v) => onChange(applyTargetRole(grants, level, target.id, v))}
      />
    </li>
  );
}

export function GrantWorkspaceChoiceList({
  workspaces,
  selectedWorkspaceId,
  testIdPrefix,
  onSelect,
  onClear,
}: {
  workspaces: { id: string; label: string }[];
  selectedWorkspaceId: string | null;
  testIdPrefix: string;
  onSelect: (workspaceId: string) => void;
  onClear: () => void;
}) {
  return (
    <GrantChoiceList
      items={workspaces}
      itemKind="workspace"
      selectedItemId={selectedWorkspaceId}
      testIdPrefix={testIdPrefix}
      onSelect={onSelect}
      onClear={onClear}
    />
  );
}

export function GrantDocoChoiceList({
  docos,
  selectedDocoId,
  testIdPrefix,
  onSelect,
  onClear,
}: {
  docos: { id: string; label: string }[];
  selectedDocoId: string | null;
  testIdPrefix: string;
  onSelect: (docoId: string) => void;
  onClear: () => void;
}) {
  return (
    <GrantChoiceList
      items={docos}
      itemKind="doco"
      selectedItemId={selectedDocoId}
      testIdPrefix={testIdPrefix}
      onSelect={onSelect}
      onClear={onClear}
    />
  );
}

function GrantChoiceList({
  items,
  itemKind,
  selectedItemId,
  testIdPrefix,
  onSelect,
  onClear,
}: {
  items: { id: string; label: string }[];
  itemKind: "workspace" | "doco";
  selectedItemId: string | null;
  testIdPrefix: string;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const selectedItem = selectedItemId ? items.find((item) => item.id === selectedItemId) : null;
  const visibleItems = selectedItem ? [selectedItem] : items;

  return (
    <ul className="flex flex-wrap gap-2">
      {visibleItems.map((item) => {
        const selected = item.id === selectedItemId;
        return (
          <li key={item.id}>
            <button
              type="button"
              data-testid={`${testIdPrefix}-${item.id}`}
              aria-pressed={selected}
              aria-label={selected ? `Remove ${item.label} ${itemKind} selection` : undefined}
              onClick={() => {
                if (selected) {
                  onClear();
                } else {
                  onSelect(item.id);
                }
              }}
              className={`neu-button${selected ? " neu-pressed" : ""} inline-flex w-fit max-w-full min-w-36 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm`}
            >
              <span className="min-w-0 truncate">{item.label}</span>
              {selected ? <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// All your workspaces (actor): no target — selecting the scope IS the grant.
// One control: the access ceiling, capped per-workspace by your own role. The
// grant's `role` carries it; "owner" = your full live role.
function ActorStep({
  grants,
  onChange,
}: {
  grants: ComposedGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const role = (grants.find((g) => g.level === "actor")?.role ?? "owner") as DocoRole;
  return (
    <div
      className="space-y-3 rounded-md border border-primary bg-primary/10 px-3 py-3 text-sm"
      data-testid="grant-actor-step"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Access</span>
        <AccessSelect
          testid="grant-role-actor"
          maxRole="owner"
          value={role}
          includeNoAccess={false}
          onChange={(v) => onChange([actorGrant(v === "none" ? "owner" : v)])}
        />
      </div>
      <p className="text-muted-foreground">
        Reaches every workspace you belong to at this level, capped by your own role in each (pick
        owner but you're a writer somewhere and it stays a writer there). New workspaces you join
        are reachable automatically. Revoke any time.
      </p>
    </div>
  );
}

// Workspace: list every workspace, each with its own ACCESS dropdown.
function WorkspaceMultiStep({
  catalog,
  grants,
  existing,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  existing?: ExistingGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const workspaces = catalog.targets.filter((t) => t.level === "workspace");
  return (
    <div className="space-y-2" data-testid="grant-workspace-step">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Choose workspaces — set an access level for each
      </div>
      <ul className="space-y-1">
        {workspaces.map((t) => (
          <TargetRow
            key={t.id}
            target={t}
            level="workspace"
            grants={grants}
            existing={existing}
            onChange={onChange}
          />
        ))}
        {workspaces.length === 0 ? (
          <li className="text-sm text-muted-foreground">No workspaces you can grant.</li>
        ) : null}
      </ul>
    </div>
  );
}

// Doco: choose one workspace (removable), then its docos with dropdowns.
function DocoMultiStep({
  catalog,
  grants,
  existing,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  existing?: ExistingGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const groups = useMemo(() => targetsByWorkspace(catalog), [catalog]);
  const workspacesWithDocos = groups.filter((g) => g.docos.length > 0);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const active = workspacesWithDocos.find((g) => g.workspace.id === workspaceId) ?? null;

  return (
    <div className="space-y-4" data-testid="grant-doco-step">
      <div className="space-y-2" data-testid="grant-doco-workspace-step">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Which workspace is the doco in?
        </div>
        <GrantWorkspaceChoiceList
          workspaces={workspacesWithDocos.map((g) => g.workspace)}
          selectedWorkspaceId={active?.workspace.id ?? null}
          testIdPrefix="grant-doco-workspace"
          onSelect={setWorkspaceId}
          onClear={() => setWorkspaceId(null)}
        />
        {workspacesWithDocos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No docos you can grant.</p>
        ) : null}
      </div>

      {active ? (
        <div className="space-y-2" data-testid="grant-doco-docos-step">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Which docos in {active.workspace.label}?
          </div>
          <ul className="space-y-1">
            {active.docos.map((t) => (
              <TargetRow
                key={t.id}
                target={t}
                level="doco"
                grants={grants}
                existing={existing}
                onChange={onChange}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// Types: workspace → doco → per-type level dropdowns for that doco.
function TypesStep({
  catalog,
  grants,
  existing,
  onChange,
}: {
  catalog: GrantCatalog;
  grants: ComposedGrant[];
  existing?: ExistingGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const groups = useMemo(() => targetsByWorkspace(catalog), [catalog]);
  const workspacesWithDocos = groups.filter((g) => g.docos.length > 0);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [docoId, setDocoId] = useState<string | null>(null);
  const active = workspacesWithDocos.find((g) => g.workspace.id === workspaceId) ?? null;
  const doco = active?.docos.find((d) => d.id === docoId) ?? null;

  return (
    <div className="space-y-4" data-testid="grant-types-step">
      <div className="space-y-2" data-testid="grant-types-workspace-step">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Which workspace is the doco in?
        </div>
        <GrantWorkspaceChoiceList
          workspaces={workspacesWithDocos.map((g) => g.workspace)}
          selectedWorkspaceId={active?.workspace.id ?? null}
          testIdPrefix="grant-types-workspace"
          onSelect={(nextWorkspaceId) => {
            setWorkspaceId(nextWorkspaceId);
            setDocoId(null);
          }}
          onClear={() => {
            setWorkspaceId(null);
            setDocoId(null);
          }}
        />
      </div>

      {active ? (
        <div className="space-y-2" data-testid="grant-types-doco-step">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Which doco in {active.workspace.label}?
          </div>
          <GrantDocoChoiceList
            docos={active.docos.map((d) => ({ id: d.id, label: d.label }))}
            selectedDocoId={doco?.id ?? null}
            testIdPrefix="grant-types-doco"
            onSelect={setDocoId}
            onClear={() => setDocoId(null)}
          />
        </div>
      ) : null}

      {doco ? (
        <div className="space-y-2" data-testid="grant-types-type-step">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Which node or edge types in {doco.label}?
          </div>
          <DocoTypeGrid doco={doco} grants={grants} existing={existing} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

// The node-type / edge-type list for one doco, each row with a level dropdown.
function DocoTypeGrid({
  doco,
  grants,
  existing,
  onChange,
}: {
  doco: GrantTarget;
  grants: ComposedGrant[];
  existing?: ExistingGrant[];
  onChange: (grants: ComposedGrant[]) => void;
}) {
  const { nodes, edges } = writableTypeGroups();
  const allTypes = [...nodes, ...edges];
  const current = findGrant(grants, "doco", doco.id);
  const existingGrant = findExistingGrant(existing, "doco", doco.id);
  const role = current?.role ?? existingGrant?.role ?? "reader";
  const writeTypes = current?.writeTypes ?? existingGrant?.writeTypes ?? [];
  const inherited = inheritedTypeLevel(role, writeTypes);
  const change = (t: string, next: TypeLevel) =>
    onChange(
      applyDocoTypeLevel(grants, doco.id, t, next, allTypes, {
        role,
        writeTypes,
      }),
    );

  return (
    <div
      className="space-y-3 rounded-md border border-border px-3 py-3"
      data-testid="grant-types-grid"
    >
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <TypeColumn
          title="Node types"
          types={nodes}
          docoId={doco.id}
          role={role}
          writeTypes={writeTypes}
          inherited={inherited}
          onChange={change}
        />
        <TypeColumn
          title="Edge types"
          types={edges}
          docoId={doco.id}
          role={role}
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
  role,
  writeTypes,
  inherited,
  onChange,
}: {
  title: string;
  types: readonly string[];
  docoId: string;
  role: DocoRole;
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
            value={typeDropdownValue(role, writeTypes, t)}
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
