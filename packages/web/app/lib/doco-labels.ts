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
