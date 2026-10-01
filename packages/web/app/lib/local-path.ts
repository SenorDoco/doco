/** A path on this site: one slash, never `//host` or `/\host`, which a
 *  browser would follow off-site. An OAuth state names one to come back to,
 *  and nothing else may ride through it. Pure. */
export function isLocalPath(path: unknown): path is string {
  return typeof path === "string" && /^\/(?![/\\])/.test(path);
}
