// Shared field set for the new + edit policy forms. Renders the standalone
// `kind` selector and, for deterministic policies, a menu of every check we
// offer with the inputs that apply to the chosen `sub_kind`. The deterministic
// inputs are generated from the check registry's field schema (`checkFields`),
// so adding a check needs no edit here. The parent route wraps this in a <Form>
// and supplies the submit buttons.

import {
  type DeterministicSubKind,
  EDGE_TYPES,
  type FieldSpec,
  NODE_TYPES,
  checkFields,
  checkLabel,
} from "@doco/shared";
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

function EdgeTypeSelect({
  name = "edge_type",
  defaultValue,
}: {
  name?: string;
  defaultValue?: string;
}) {
  return (
    <select name={name} defaultValue={defaultValue ?? ""} className={INPUT}>
      <option value="">(choose edge type)</option>
      {EDGE_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function DirectionSelect({
  name = "direction",
  defaultValue,
}: {
  name?: string;
  defaultValue?: string;
}) {
  return (
    <select name={name} defaultValue={defaultValue ?? ""} className={INPUT}>
      <option value="">(either direction)</option>
      <option value="outgoing">outgoing</option>
      <option value="incoming">incoming</option>
    </select>
  );
}

/** One deterministic field, rendered from its schema entry. */
function DeterministicField({ field, init }: { field: FieldSpec; init: PolicyFormInitial }) {
  const rec = init as unknown as Record<string, string | boolean | undefined>;
  const str = (key: string) => {
    const v = rec[key];
    return typeof v === "string" ? v : "";
  };
  switch (field.control) {
    case "edge-type":
      return (
        <Field label={field.formLabel}>
          <EdgeTypeSelect name={field.name} defaultValue={str(field.name)} />
        </Field>
      );
    case "node-type":
      return (
        <Field label={field.formLabel}>
          <NodeTypeSelect name={field.name} defaultValue={str(field.name)} />
        </Field>
      );
    case "direction":
      return (
        <Field label={field.formLabel}>
          <DirectionSelect name={field.name} defaultValue={str(field.name)} />
        </Field>
      );
    case "number":
      return (
        <Field label={field.formLabel}>
          <input
            name={field.name}
            type="number"
            min={0}
            defaultValue={str(field.name)}
            placeholder="1"
            className={INPUT}
          />
        </Field>
      );
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={field.name} defaultChecked={rec[field.name] === true} />
          {field.formLabel}
        </label>
      );
    case "condition":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${field.formLabel} — field (optional)`}>
            <input
              name={`${field.name}_field`}
              defaultValue={str(`${field.name}_field`)}
              className={INPUT}
            />
          </Field>
          <Field label={`${field.formLabel} — equals`}>
            <input
              name={`${field.name}_equals`}
              defaultValue={str(`${field.name}_equals`)}
              className={INPUT}
            />
          </Field>
        </div>
      );
    default:
      // text + the comma-separated controls — a plain text input.
      return (
        <Field label={field.formLabel}>
          <input name={field.name} defaultValue={str(field.name)} className={INPUT} />
        </Field>
      );
  }
}

/** The inputs that apply to a given deterministic check, generated from its schema. */
function DeterministicFields({ subKind, init }: { subKind: string; init: PolicyFormInitial }) {
  if (!(DETERMINISTIC_SUB_KINDS as readonly string[]).includes(subKind)) return null;
  return (
    <>
      {checkFields(subKind as DeterministicSubKind).map((field) => (
        <DeterministicField key={field.name} field={field} init={init} />
      ))}
    </>
  );
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
    from_node_type: "",
    to_node_type: "",
    target_node_type: "",
    min_count: "",
    exempt_when_other_node_type: "",
    max_count: "",
    direction: "",
    fields: "",
    field: "",
    pattern: "",
    flags: "",
    case_fold: false,
    node_types: "",
    edge_types: "",
    entity_types: "",
    list_field: "",
    incoming_node_type: "",
    incoming_field_must_match: "",
    initial_when_field: "",
    initial_when_equals: "",
    terminal_when_field: "",
    terminal_when_equals: "",
    when_node_type: "",
    on_violation: "block",
    fires_when_node_lifecycle: "",
    ...initial,
  };
  const [kind, setKind] = useState<PolicyKind>(init.kind);
  const [subKind, setSubKind] = useState<string>(init.sub_kind);
  // A probabilistic policy can be node-scoped (judge one node) or edge-scoped
  // (fire on edge creation; judge both endpoints). An `edge_type` on the stored
  // predicate means it was edge-scoped.
  const [edgeScoped, setEdgeScoped] = useState<boolean>(Boolean(init.edge_type));

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
                  {checkLabel(sk)}
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
            <>
              <fieldset className="flex flex-wrap gap-2">
                <legend className={LABEL}>Scope</legend>
                {(
                  [
                    ["node", "Node — judge one node"],
                    ["edge", "Edge — judge a relationship (both endpoints)"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="neu-button inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold"
                  >
                    <input
                      type="radio"
                      name="__scope"
                      value={value}
                      checked={edgeScoped === (value === "edge")}
                      onChange={() => setEdgeScoped(value === "edge")}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              {edgeScoped ? (
                <>
                  <Field label="Edge type">
                    <EdgeTypeSelect defaultValue={init.edge_type} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="From node type (optional)">
                      <NodeTypeSelect name="from_node_type" defaultValue={init.from_node_type} />
                    </Field>
                    <Field label="To node type (optional)">
                      <NodeTypeSelect name="to_node_type" defaultValue={init.to_node_type} />
                    </Field>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Fires when a matching edge is created; the judge sees both endpoint nodes.
                  </p>
                </>
              ) : (
                <Field label="When node type (comma-separated, optional)">
                  <input
                    name="when_node_type"
                    defaultValue={init.when_node_type}
                    className={INPUT}
                  />
                </Field>
              )}
            </>
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
