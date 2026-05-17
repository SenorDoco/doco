export function isLiveScopeLifecycle(lifecycle: string | null | undefined): boolean {
  const value = lifecycle ?? "active";
  return value === "active" || value === "proposed";
}
