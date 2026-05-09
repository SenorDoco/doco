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

export interface HostEvalo {
  ownerSlug: string;
  evaloSlug: string;
  ownerKind: "principal" | "organization";
  ownerId: string;
  evaloId: string;
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

export function listAllEvalos(): HostEvalo[] {
  const evalosDir = join(rootDir(), "evalos");
  if (!existsSync(evalosDir)) return [];
  const out: HostEvalo[] = [];
  for (const ownerSlug of readdirSync(evalosDir)) {
    const ownerDir = join(evalosDir, ownerSlug);
    if (!existsSync(ownerDir)) continue;
    for (const evaloSlug of readdirSync(ownerDir)) {
      const dir = join(ownerDir, evaloSlug);
      const yamlPath = join(dir, "evalo.yaml");
      if (!existsSync(yamlPath)) continue;
      const e = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
      const ownerId = e.owner_id as string;
      const ownerKind = ownerId.startsWith("organization_") ? "organization" : "principal";
      out.push({
        ownerSlug,
        evaloSlug,
        ownerKind,
        ownerId,
        evaloId: e.id as string,
        ...(e.description !== undefined ? { description: e.description as string } : {}),
        hasIndex: existsSync(join(dir, ".evalo", "cache.db")),
      });
    }
  }
  return out;
}
