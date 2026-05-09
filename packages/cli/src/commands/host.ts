import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  addOrganization,
  addPrincipal,
  createEvaloInHost,
  createHost,
  detectMode,
  listEvalos,
  listOrganizations,
  listPrincipals,
  loadHost,
} from "@evalo/host";
import { c, checkmark, cross, header, rule } from "../output.js";

const initCmd = defineCommand({
  meta: { name: "init", description: "Create a new Host at <path>." },
  args: {
    path: { type: "positional", description: "Directory for the host.", required: true },
    name: { type: "string", description: "Display name of the host.", required: true },
    "owner-username": {
      type: "string",
      description: "GitHub username to register as the bootstrap owner Principal.",
    },
    "owner-email": { type: "string", description: "Email for the bootstrap owner." },
    visibility: { type: "string", default: "private" },
  },
  async run({ args }) {
    const path = resolve(args.path as string);
    const { host } = await createHost(path, {
      name: args.name as string,
      ...(args["owner-username"] ? { ownerUsername: args["owner-username"] as string } : {}),
      ...(args["owner-email"] ? { ownerEmail: args["owner-email"] as string } : {}),
      visibility: (args.visibility as "private" | "public") ?? "private",
    });
    console.log();
    console.log(header(`Created Host: ${host.name}`));
    console.log(rule());
    console.log(checkmark(`Path:       ${c.dim(path)}`));
    console.log(checkmark(`Host ID:    ${c.dim(host.id)}`));
    if (args["owner-username"]) {
      console.log(checkmark(`Bootstrap:  user "${args["owner-username"]}" registered`));
    }
    console.log();
    console.log(c.dim(`Next: cd ${path} && evalo host evalo new <owner>/<evalo-slug>`));
    console.log();
  },
});

function findHostRoot(): string | null {
  // Reuse: walk upward looking for host.yaml. Implemented inline to avoid tight coupling.
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (detectMode(dir) === "host") return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function rootArgOrFind(args: Record<string, unknown>): string | null {
  const arg = args.root as string | undefined;
  if (arg) return resolve(arg);
  return findHostRoot();
}

const userCreateCmd = defineCommand({
  meta: { name: "create", description: "Register a User Principal in the host." },
  args: {
    username: { type: "positional", required: true },
    email: { type: "string" },
    "display-name": { type: "string" },
    root: { type: "string", description: "Host root (default: walk upward from cwd)." },
  },
  async run({ args }) {
    const root = rootArgOrFind(args);
    if (!root) return failNoHost();
    const id = await addPrincipal(root, {
      username: args.username as string,
      ...(args.email !== undefined ? { email: args.email as string } : {}),
      ...(args["display-name"] !== undefined ? { display_name: args["display-name"] as string } : {}),
    });
    console.log(checkmark(`User registered: ${args.username} ${c.dim(`(${id})`)}`));
  },
});

const userCmd = defineCommand({
  meta: { name: "user", description: "Manage users (Principals) in the host." },
  subCommands: { create: userCreateCmd },
});

const orgCreateCmd = defineCommand({
  meta: { name: "create", description: "Create an Organization in the host." },
  args: {
    slug: { type: "positional", required: true },
    owner: { type: "string", description: "Username of the user that owns the org.", required: true },
    "display-name": { type: "string" },
    description: { type: "string" },
    visibility: { type: "string", default: "private" },
    root: { type: "string" },
  },
  async run({ args }) {
    const root = rootArgOrFind(args);
    if (!root) return failNoHost();
    const id = await addOrganization(root, {
      slug: args.slug as string,
      ownerUsername: args.owner as string,
      ...(args["display-name"] !== undefined ? { display_name: args["display-name"] as string } : {}),
      ...(args.description !== undefined ? { description: args.description as string } : {}),
      visibility: (args.visibility as "private" | "public") ?? "private",
    });
    console.log(checkmark(`Organization created: ${args.slug} ${c.dim(`(${id})`)}`));
  },
});

const orgCmd = defineCommand({
  meta: { name: "org", description: "Manage organizations in the host." },
  subCommands: { create: orgCreateCmd },
});

const evaloNewCmd = defineCommand({
  meta: { name: "new", description: "Create a new Evalo in the host owned by a user or org." },
  args: {
    slug: {
      type: "positional",
      description: "owner_slug/evalo_slug, e.g. alice/my-project",
      required: true,
    },
    description: { type: "string" },
    visibility: { type: "string", default: "private" },
    root: { type: "string" },
  },
  async run({ args }) {
    const root = rootArgOrFind(args);
    if (!root) return failNoHost();
    const slug = args.slug as string;
    const parts = slug.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(cross(`Invalid slug "${slug}" — expected <owner>/<evalo>.`));
      process.exitCode = 2;
      return;
    }
    const rec = await createEvaloInHost(root, {
      ownerSlug: parts[0],
      evaloSlug: parts[1],
      ...(args.description !== undefined ? { description: args.description as string } : {}),
      visibility: (args.visibility as "private" | "public") ?? "private",
    });
    console.log();
    console.log(checkmark(`Evalo created: ${rec.ownerSlug}/${rec.evaloSlug}`));
    console.log(`  ${c.dim("path:")}      ${rec.path}`);
    console.log(`  ${c.dim("evalo id:")}  ${rec.evaloId}`);
    console.log(`  ${c.dim("owner:")}     ${rec.ownerKind} (${rec.ownerId})`);
    console.log();
    console.log(c.dim(`Next: cd ${rec.path} && evalo validate && evalo reindex`));
    console.log();
  },
});

const evaloCmd = defineCommand({
  meta: { name: "evalo", description: "Manage Evalos in the host." },
  subCommands: { new: evaloNewCmd },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List Users, Organizations, and Evalos in the host." },
  args: {
    root: { type: "string" },
    json: { type: "boolean", default: false },
  },
  async run({ args }) {
    const root = rootArgOrFind(args);
    if (!root) return failNoHost();
    const host = await loadHost(root);
    const [users, orgs, evalos] = await Promise.all([
      listPrincipals(root),
      listOrganizations(root),
      listEvalos(root),
    ]);
    if (args.json) {
      console.log(JSON.stringify({ host, users, organizations: orgs, evalos }, null, 2));
      return;
    }
    console.log();
    console.log(header(`${host.name} ${c.dim(`(${host.id})`)}`));
    console.log(rule());
    console.log(c.bold(`Users (${users.length})`));
    for (const u of users) console.log(`  ${u.slug.padEnd(24)} ${c.dim(u.id)}`);
    console.log();
    console.log(c.bold(`Organizations (${orgs.length})`));
    for (const o of orgs) console.log(`  ${o.slug.padEnd(24)} ${c.dim(o.id)}`);
    console.log();
    console.log(c.bold(`Evalos (${evalos.length})`));
    for (const e of evalos) {
      console.log(`  ${`${e.ownerSlug}/${e.evaloSlug}`.padEnd(36)} ${c.dim(`${e.ownerKind} → ${e.evaloId}`)}`);
    }
    console.log();
  },
});

function failNoHost(): void {
  console.error(
    cross("Could not find host.yaml in this directory or any parent. Run `evalo host init <path>` first."),
  );
  process.exitCode = 2;
}

export const hostCmd = defineCommand({
  meta: {
    name: "host",
    description: "Multi-tenant host: many Evalos owned by Users or Organizations (ADR-061).",
  },
  subCommands: {
    init: initCmd,
    user: userCmd,
    org: orgCmd,
    evalo: evaloCmd,
    list: listCmd,
  },
});
