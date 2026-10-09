/** The value of cookie `name` in a request's Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
