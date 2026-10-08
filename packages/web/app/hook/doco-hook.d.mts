// Types for the Doco hook script, which stays plain JavaScript so a project
// runs it with node alone. The test imports its pure parts.
export const DOCO_REMINDER: string;
export const INSTRUCTIONS_PATH: string;

export interface HookConfig {
  root: string;
  origin: string;
  workspace: string | null;
  token: string | null;
  timeoutMs: number;
  budget: number;
}

export function readProjectWorkspace(
  cwd: string,
): { root: string; origin: string | null; workspace: string | null } | null;
export function readHookToken(cwd: string, workspace: string | null): string | null;
export function resolveConfig(env: Record<string, string | undefined>, cwd: string): HookConfig;
export function requestFor(
  event: Record<string, unknown>,
  config: HookConfig,
): { url: string; cacheKey: string | null; marksSeen: boolean } | null;
export function main(
  stdinText: string,
  env?: Record<string, string | undefined>,
  cwd?: string,
): Promise<string | null>;
