import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  contractForAttachedPerspectives,
  relationKindList,
} from "~/lib/graph-authoring-contract.server";
import { CAPTURE_REGISTRY } from "~/lib/neuron-capture-registry.server";
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
  const entityTypes = Object.values(CAPTURE_REGISTRY).map((entry) => ({
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
        note: "Creates one neuron. Alias can be referenced later as $optional_name in the same changeset.",
      },
      relate: {
        shape: {
          op: "relate",
          relation_kind: "sequence_flow",
          from: "source_or_$alias",
          to: "target_or_$alias",
          label: "optional edge label",
        },
        note: "Adds a typed relation by patching whichever field owns that relation kind.",
      },
      append: {
        shape: {
          op: "append",
          relation_kind: "sequence_flow",
          after: "existing_source_id",
          entity_type: "action",
          alias: "new_action",
          body: {},
          label: "optional edge label",
        },
        note: "Creates a neuron and immediately relates an existing neuron to it. Preferred for ordered perspectives.",
      },
    },
    examples: [
      {
        purpose: "Create a BPMN action to the right of an existing gateway branch",
        body: {
          validate_against: "bpmn",
          operations: [
            {
              op: "append",
              relation_kind: "sequence_flow",
              after: "decision_01...",
              label: "Yes",
              entity_type: "action",
              alias: "charge_card",
              body: {
                action: "SuD charges the authorized card",
                verb: "charge",
                lifecycle: "drafting",
                actor_principal_id: "principal_01...",
              },
            },
          ],
        },
      },
      {
        purpose: "Create two neurons and relate them without knowing the second id ahead of time",
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
              relation_kind: "gated_by",
              from: "action_01...",
              to: "$refund_rule",
            },
          ],
        },
      },
    ],
  });
}
