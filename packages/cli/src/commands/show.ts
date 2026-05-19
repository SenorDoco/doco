import { type Entity, type EntityId, isEntityId } from "@doco/shared";
import { defineCommand } from "citty";
import { findDocoRoot } from "../find-root.js";
import { loadDocoFromRoot } from "../load-doco.js";
import { c, cross, header, rule } from "../output.js";

export const showCmd = defineCommand({
  meta: {
    name: "show",
    description: "Print one entity by id (or scope/principal/org by name/username).",
  },
  args: {
    target: {
      type: "positional",
      description:
        "Entity id (e.g. decision_01H...). For scope, principal, or organization, the name/username also resolves.",
      required: true,
    },
    root: {
      type: "string",
      description: "Path to the Doco root (default: walk upward from cwd).",
    },
    json: {
      type: "boolean",
      description: "Emit JSON instead of formatted output.",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target as string;
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }

    const loaded = await loadDocoFromRoot(root);

    let entity: Entity | undefined;
    if (isEntityId(target)) {
      entity = loaded.entities.get(target as EntityId)?.entity;
    } else {
      // For scope/principal/organization the readable handle is the name/username.
      for (const le of loaded.entities.values()) {
        const data = le.entity as unknown as Record<string, unknown>;
        if (data.name === target || data.username === target) {
          entity = le.entity;
          break;
        }
      }
    }

    if (!entity) {
      console.error(cross(`No entity found for "${target}".`));
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    const data = entity as unknown as Record<string, unknown>;
    console.log();
    console.log(header(`${entity.id}`));
    if (data.title) console.log(c.dim(`title: ${data.title}`));
    if (data.name) console.log(c.dim(`name: ${data.name}`));
    if (data.username) console.log(c.dim(`username: ${data.username}`));
    console.log(rule());
    console.log(`${c.bold("type:")}    ${entity.node_type}`);
    if (data.lifecycle) console.log(`${c.bold("lifecycle:")} ${data.lifecycle}`);
    if (data.purpose) console.log(`${c.bold("purpose:")} ${data.purpose}`);
    if (entity.node_type !== "scope" && data.summary) {
      console.log(`${c.bold("summary:")}  ${data.summary}`);
    }
    console.log();
  },
});
