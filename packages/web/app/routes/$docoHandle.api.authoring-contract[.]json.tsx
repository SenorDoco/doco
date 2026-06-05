import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  contractForAttachedPerspectives,
  relationKindList,
} from "~/lib/graph-authoring-contract.server";
import { BESPOKE_CAPTURE_REGISTRY, CAPTURE_REGISTRY } from "~/lib/node-capture-registry.server";
import { listPerspectivesForDoco } from "~/lib/perspectives.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const attached = await listPerspectivesForDoco(meta.docoId);
  // Generic AND bespoke node types — agents discover every authorable type,
  // including bespoke ones like `principal`, from this one contract.
  const entityTypes = [
    ...Object.values(CAPTURE_REGISTRY),
    ...Object.values(BESPOKE_CAPTURE_REGISTRY),
  ].map((entry) => ({
    entity_type: entry.entityType,
    collection: entry.type,
    capture_endpoint: `/${params.docoHandle}/api/${entry.type}.json`,
  }));
  return Response.json({
    ok: true,
    doco_id: meta.docoId,
    entity_types: entityTypes,
    relation_kinds: relationKindList(),
    perspective_contracts: contractForAttachedPerspectives(attached),
    changeset_endpoint: `/${params.docoHandle}/api/changesets.json`,
    operations: {
      create: {
        shape: { op: "create", entity_type: "action", alias: "optional_name", body: {} },
        note: "Creates one node. Alias can be referenced later as $optional_name in the same changeset.",
      },
      relate: {
        shape: {
          op: "relate",
          relation_kind: "flows_to",
          from: "source_or_$alias",
          to: "target_or_$alias",
          label: "optional edge label",
        },
        note: "Adds a typed relation as a first-class edge row.",
      },
      relate_many: {
        shape: {
          op: "relate_many",
          relations: [
            {
              relation_kind: "flows_to",
              from: "source_or_$alias",
              to: "target_or_$alias",
              label: "optional edge label",
            },
          ],
        },
        note: "Adds multiple typed relations as first-class edge rows. Use this when sibling edges must be valid together.",
      },
      append: {
        shape: {
          op: "append",
          relation_kind: "flows_to",
          after: "existing_source_id",
          entity_type: "action",
          alias: "new_action",
          body: {},
          label: "optional edge label",
        },
        note: "Creates a node and immediately relates an existing node to it. Preferred for ordered perspectives.",
      },
      activate: {
        shape: { op: "activate", target: "node_id_or_$alias" },
        note: "Transition a node to 'active' (in force; publish a draft). Renamed from 'assert'. target is an id or a $alias from this changeset.",
      },
      queue: {
        shape: { op: "queue", target: "node_id_or_$alias" },
        note: "Transition a node to 'queued' (ready, awaiting activation). target is an id or a $alias from this changeset.",
      },
      retire: {
        shape: { op: "retire", target: "node_id_or_$alias" },
        note: "Soft-retire a node — a tombstone; history is kept and it's reversible by re-activating. Use to clean up mistakes.",
      },
      supersede: {
        shape: {
          op: "supersede",
          target: "old_node_id",
          entity_type: "action",
          alias: "optional_name",
          body: {},
        },
        note: "Replace a node: creates the replacement, retires the old one, and links them with a first-class 'replaces' edge.",
      },
    },
    examples: [
      {
        purpose: "Create a BPMN action to the right of an existing gateway branch",
        body: {
          validate_against: "process",
          operations: [
            {
              op: "append",
              relation_kind: "flows_to",
              after: "decision_01...",
              label: "Yes",
              entity_type: "action",
              alias: "charge_card",
              body: {
                action: "SuD charges the authorized card",
                verb: "charge",
                lifecycle: "drafting",
              },
            },
            {
              op: "relate",
              relation_kind: "attributed_to",
              from: "$charge_card",
              to: "principal_01...",
            },
          ],
        },
      },
      {
        purpose: "Create an exhaustive gateway branch set without an invalid intermediate state",
        body: {
          validate_against: "process",
          operations: [
            {
              op: "create",
              entity_type: "action",
              alias: "charge_card",
              body: {
                action: "Charge the authorized card",
                verb: "charge",
                lifecycle: "drafting",
              },
            },
            {
              op: "create",
              entity_type: "action",
              alias: "manual_review",
              body: {
                action: "Send payment request to manual review",
                verb: "send",
                lifecycle: "drafting",
              },
            },
            {
              op: "relate_many",
              relations: [
                {
                  relation_kind: "flows_to",
                  from: "decision_01...",
                  to: "$charge_card",
                  label: "Yes",
                },
                {
                  relation_kind: "flows_to",
                  from: "decision_01...",
                  to: "$manual_review",
                  label: "No",
                },
                {
                  relation_kind: "attributed_to",
                  from: "$charge_card",
                  to: "principal_01...",
                },
                {
                  relation_kind: "attributed_to",
                  from: "$manual_review",
                  to: "principal_01...",
                },
              ],
            },
          ],
        },
      },
      {
        purpose: "Create two nodes and relate them without knowing the second id ahead of time",
        body: {
          operations: [
            {
              op: "create",
              entity_type: "rule",
              alias: "refund_rule",
              body: {
                rule: "Refunds require a cancellation Decision",
                predicate: "Refund Actions cite the cancellation Decision.",
              },
            },
            {
              op: "relate",
              relation_kind: "constrained_by",
              from: "action_01...",
              to: "$refund_rule",
            },
          ],
        },
      },
    ],
  });
}
