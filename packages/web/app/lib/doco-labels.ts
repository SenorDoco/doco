export function qualifiedDocoLabel(input: {
  ownerSlug: string | null | undefined;
  handle: string;
}): string {
  const owner = (input.ownerSlug ?? "").trim();
  const handle = input.handle.trim();
  return owner ? `${owner}/${handle}` : handle;
}

export function workspaceWideLabel(workspaceHandle: string): string {
  return `${workspaceHandle.trim()}/*`;
}

/**
 * Render the policy block a Doco contributes to Señor Doco's bootstrap
 * context. Each policy line carries its own `/<handle>/policies/<id>` link so
 * the agent — told to cite policies by URL — has the link in context and never
 * has to guess it.
 */
export function renderPolicyContextSnippet(
  docoLabel: string,
  handle: string,
  policies: ReadonlyArray<{ id: string; kind: string; label: string }>,
): string {
  const lines = [`Policies for ${docoLabel} (path=/${handle}):`];
  for (const p of policies) {
    lines.push(`  - ${p.kind}: ${p.label} (link: /${handle}/policies/${p.id})`);
  }
  return lines.join("\n");
}
