// Browser-safe DocoRole helpers.
//
// Why this file exists: route components on /oauth/authorize and
// /device need `ROLE_RANK` / `roleAtLeast` in JSX (filtering the per-
// Doco role dropdown). Pulling them from the `@doco/db` barrel drags
// the Postgres client (`node:path`, `pg`, `fs`) into the browser
// bundle, which Vite can't bundle for the client and which breaks
// the production build.
//
// These constants must match `@doco/db`'s definitions exactly — both
// modules are authoritative within their bundle target.

import type { DocoRole } from "@doco/db";

export const ROLE_RANK: Record<DocoRole, number> = {
  reader: 1,
  writer: 2,
  owner: 3,
};

export function roleAtLeast(have: DocoRole, want: DocoRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[want];
}

export const DOCO_ROLES: DocoRole[] = ["reader", "writer", "owner"];
