export function qualifiedDocoLabel(input: {
  ownerSlug: string | null | undefined;
  handle: string;
}): string {
  const owner = (input.ownerSlug ?? "").trim();
  const handle = input.handle.trim();
  return owner ? `${owner}/${handle}` : handle;
}

export function orgWideLabel(orgHandle: string): string {
  return `${orgHandle.trim()}/*`;
}
