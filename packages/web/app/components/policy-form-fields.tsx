// Shared field set for the new + edit policy forms. Renders the standalone
// `kind` selector and, for deterministic policies, a menu of every check we
// offer with the inputs that apply to the chosen `sub_kind`. The parent route
// wraps this in a <Form> and supplies the submit buttons.

import { EDGE_TYPES, NODE_TYPES } from "@doco/shared";
import { useState } from "react";
import { POLICY_KIND_HELP } from "~/lib/policy-copy";
import { DETERMINISTIC_SUB_KINDS, type PolicyFormInitial } from "~/lib/policy-form";

type PolicyKind = "suggestion" | "deterministic" | "probabilistic";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";
const INPUT = "mt-1 block w-full rounded-md px-3 py-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is always passed as children.
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function NodeTypeSelect({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <select name={name} defaultValue={defaultValue ?? ""} className={INPUT}>
      <option value="">(any)</option>
      {NODE_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function EdgeTypeSelect({ defaultValue }: { defaultValue?: string }) {
  return (
    <select name="edge_type" defaultValue={defaultValue ?? ""} className={INPUT}>
      <option value="">(choose edge type)</option>
      {EDGE_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** The inputs that apply to a given deterministic check. */
function DeterministicFields({ subKind, init }: { subKind: string; init: PolicyFormInitial }) {
  const whenField = (
    <Field label="When node type (comma-separated, optional)">
      <input name="when_node_type" defaultValue={init.when_node_type} className={INPUT} />
    </Field>
  );
  switch (subKind) {
    case "requires_edge":
    case "forbids_edge":
      return (
        <>
          <Field label="Edge type">
            <EdgeTypeSelect defaultValue={init.edge_type} />
          </Field>
          <Field label="Target node type (optional)">
            <NodeTypeSelect name="target_node_type" defaultValue={init.target_node_type} />
          </Field>
          {whenField}
        </>
      );
    case "requires_edge_role":
      return (
        <>
          <Field label="Edge type">
            <EdgeTypeSelect defaultValue={init.edge_type} />
          </Field>
          <Field label="Edge role">
            <input name="edge_role" defaultValue={init.edge_role} className={INPUT} />
          </Field>
          <Field label="Target node type (optional)">
            <NodeTypeSelect name="target_node_type" defaultValue={init.target_node_type} />
          </Field>
          {whenField}
        </>
      );
    case "requires_field":
    case "forbids_field":
      return (
        <>
          <Field label="Fields (comma-separated)">
            <input name="fields" defaultValue={init.fields} className={INPUT} />
          </Field>
          {whenField}
        </>
      );
    case "unique_field":
      return (
        <>
          <Field label="Field">
            <input name="field" defaultValue={init.field} className={INPUT} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="case_fold" defaultChecked={init.case_fold} />
            Case-insensitive
          </label>
          {whenField}
        </>
      );
    case "requires_node_type":
      return (
        <Field label="Allowed node types (comma-separated)">
          <input name="node_types" defaultValue={init.node_types} className={INPUT} />
        </Field>
      );
    case "requires_entity_type":
      return (
        <Field label="Allowed entity types (comma-separated)">
          <input name="entity_types" defaultValue={init.entity_types} className={INPUT} />
        </Field>
      );
    case "requires_field_resolves_to_principal":
      return (
        <>
          <Field label="Field">
            <input name="field" defaultValue={init.field} className={INPUT} />
          </Field>
          {whenField}
        </>
      );
    case "graph-completeness":
      return (
        <>
          <Field label="List field">
            <input name="list_field" defaultValue={init.list_field} className={INPUT} />
          </Field>
          <Field label="Edge type">
            <EdgeTypeSelect defaultValue={init.edge_type} />
          </Field>
          <Field label="Incoming node type">
            <NodeTypeSelect name="incoming_node_type" defaultValue={init.incoming_node_type} />
          </Field>
          <Field label="Incoming field must match">
            <input
              name="incoming_field_must_match"
              defaultValue={init.incoming_field_must_match}
              className={INPUT}
            />
          </Field>
          {whenField}
        </>
      );
    default:
      return null;
  }
}

export function PolicyFormFields({
  initial,
}: {
  initial?: Partial<PolicyFormInitial>;
}) {
  const init: PolicyFormInitial = {
    kind: "suggestion",
    agent_instruction: "",
    sub_kind: "requires_field",
    edge_type: "",
    edge_role: "",
    target_node_type: "",
    fields: "",
    field: "",
    case_fold: false,
    node_types: "",
    entity_types: "",
    list_field: "",
    incoming_node_type: "",
    incoming_field_must_match: "",
    when_node_type: "",
    on_violation: "block",
    fires_when_node_lifecycle: "",
    ...initial,
  };
  const [kind, setKind] = useState<PolicyKind>(init.kind);
  const [subKind, setSubKind] = useState<string>(init.sub_kind);

  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-2">
        <legend className={LABEL}>Kind</legend>
        {(["suggestion", "deterministic", "probabilistic"] as const).map((k) => (
          <label
            key={k}
            className="neu-button inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold"
          >
            <input
              type="radio"
              name="kind"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {k}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">{POLICY_KIND_HELP[kind]}</p>

      {kind === "deterministic" ? (
        <>
          <Field label="Check type">
            <select
              name="sub_kind"
              value={subKind}
              onChange={(e) => setSubKind(e.target.value)}
              className={INPUT}
            >
              {DETERMINISTIC_SUB_KINDS.map((sk) => (
                <option key={sk} value={sk}>
                  {sk}
                </option>
              ))}
            </select>
          </Field>
          <DeterministicFields subKind={subKind} init={init} />
        </>
      ) : (
        <>
          <Field label="Agent instruction">
            <textarea
              name="agent_instruction"
              required
              rows={6}
              defaultValue={init.agent_instruction}
              placeholder={
                kind === "probabilistic"
                  ? "Judge only the node being captured. Pass when…"
                  : "Guidance agents should follow while authoring…"
              }
              className={INPUT}
            />
          </Field>
          {kind === "probabilistic" ? (
            <Field label="When node type (comma-separated, optional)">
              <input name="when_node_type" defaultValue={init.when_node_type} className={INPUT} />
            </Field>
          ) : null}
        </>
      )}

      {kind !== "suggestion" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fires on lifecycles (comma-separated)">
            <input
              name="fires_when_node_lifecycle"
              defaultValue={init.fires_when_node_lifecycle}
              placeholder="active"
              className={INPUT}
            />
          </Field>
          <Field label="On violation">
            <select name="on_violation" defaultValue={init.on_violation} className={INPUT}>
              <option value="block">block</option>
              <option value="warn">warn</option>
              <option value="log">log</option>
            </select>
          </Field>
        </div>
      ) : null}
    </div>
  );
}
