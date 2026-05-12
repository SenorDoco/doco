import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { rootDir } from "./db";

export interface HostConfig {
  id: string;
  name: string;
  visibility: "private" | "public";
}

export interface HostUser {
  id: string;
  username: string;
  display_name: string;
  email?: string;
}

export interface HostOrg {
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  member_count: number;
}

export interface HostDoco {
  ownerSlug: string;
  docoSlug: string;
  ownerKind: "principal" | "organization";
  ownerId: string;
  docoId: string;
  description?: string;
  hasIndex: boolean;
}

export function loadHostConfig(): HostConfig {
  const root = rootDir();
  const text = readFileSync(join(root, "host.yaml"), "utf8");
  return parseYaml(text) as HostConfig;
}

export function listUsers(): HostUser[] {
  const dir = join(rootDir(), "principals");
  if (!existsSync(dir)) return [];
  const out: HostUser[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    if (e.type !== "human") continue;
    if (e.bootstrap_placeholder === true) continue; // ADR-073: hide from listings
    out.push({
      id: e.id as string,
      username: e.username as string,
      display_name: (e.display_name as string) ?? (e.username as string),
      ...(typeof (e.github_identity as { email?: string } | undefined)?.email === "string"
        ? { email: (e.github_identity as { email: string }).email }
        : {}),
    });
  }
  return out;
}

export function listOrgs(): HostOrg[] {
  const dir = join(rootDir(), "organizations");
  if (!existsSync(dir)) return [];
  const out: HostOrg[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("organization_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    const members = (e.members as { principal_id: string }[] | undefined) ?? [];
    out.push({
      id: e.id as string,
      slug: e.slug as string,
      display_name: (e.display_name as string) ?? (e.slug as string),
      ...(e.description !== undefined ? { description: e.description as string } : {}),
      member_count: members.length,
    });
  }
  return out;
}

/** Return organizations where the given Principal is owner or admin. */
export function listOrgsOwnedOrAdminedBy(principalId: string): HostOrg[] {
  const dir = join(rootDir(), "organizations");
  if (!existsSync(dir)) return [];
  const out: HostOrg[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("organization_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    const members = (e.members as { principal_id: string; role: string }[] | undefined) ?? [];
    const mine = members.find(
      (m) => m.principal_id === principalId && (m.role === "owner" || m.role === "admin"),
    );
    if (!mine) continue;
    out.push({
      id: e.id as string,
      slug: e.slug as string,
      display_name: (e.display_name as string) ?? (e.slug as string),
      ...(e.description !== undefined ? { description: e.description as string } : {}),
      member_count: members.length,
    });
  }
  return out;
}

export function listAllDocos(): HostDoco[] {
  const docosDir = join(rootDir(), "docos");
  if (!existsSync(docosDir)) return [];
  const out: HostDoco[] = [];
  for (const ownerSlug of readdirSync(docosDir)) {
    const ownerDir = join(docosDir, ownerSlug);
    if (!existsSync(ownerDir)) continue;
    for (const docoSlug of readdirSync(ownerDir)) {
      const dir = join(ownerDir, docoSlug);
      const yamlPath = join(dir, "doco.yaml");
      if (!existsSync(yamlPath)) continue;
      const e = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      const ownerId = e.owner_id as string;
      const ownerKind = ownerId.startsWith("organization_") ? "organization" : "principal";
      out.push({
        ownerSlug,
        docoSlug,
        ownerKind,
        ownerId,
        docoId: e.id as string,
        ...(e.description !== undefined ? { description: e.description as string } : {}),
        hasIndex: existsSync(join(dir, ".doco", "cache.db")),
      });
    }
  }
  return out;
}
