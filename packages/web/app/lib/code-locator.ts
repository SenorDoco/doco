// Pure, client-safe parsing of repository code locators and the GitHub blob
// URLs they resolve to. This lives outside `*.server.ts` so both the server
// (PR ↔ code matching in github-pr-import.server) and the client (note/edge
// dialogs, which turn a Reference's `locator` permalink into a clickable
// GitHub link) share one implementation and can't drift.

export interface CodeReferenceLocator {
  path: string;
  start: number;
  end: number;
}

const LINE_ANCHOR_RE = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?/i;
const COLON_LINE_RE = /^(.*):(\d+)(?:-(\d+))?$/;

/** Parse a repository code locator that includes an explicit line or line range. */
export function parseCodeReferenceLocator(
  locator: string | null | undefined,
): CodeReferenceLocator | null {
  const raw = (locator ?? "").trim();
  if (!raw) return null;

  let start: number | null = null;
  let end: number | null = null;
  let pathPart = raw;

  const anchor = LINE_ANCHOR_RE.exec(raw);
  if (anchor) {
    start = Number(anchor[1]);
    end = Number(anchor[2] ?? anchor[1]);
    pathPart = raw.slice(0, anchor.index);
  } else {
    pathPart = raw.replace(/[?#].*$/, "");
    const colon = COLON_LINE_RE.exec(pathPart);
    if (colon && !colon[1].match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i)) {
      pathPart = colon[1];
      start = Number(colon[2]);
      end = Number(colon[3] ?? colon[2]);
    }
  }

  if (!start || !end) return null;
  return {
    path: normalizeReferencePath(pathPart),
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function normalizeReferencePath(raw: string): string {
  const withoutQuery = raw.replace(/[?#].*$/, "");
  try {
    const url = new URL(withoutQuery);
    return normalizePath(`${url.hostname}${decodePath(url.pathname)}`);
  } catch {
    return normalizePath(withoutQuery);
  }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function normalizePath(path: string): string {
  return decodePath(path).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();
}

/**
 * Heuristic guard so we only promote a `path:line` token to a GitHub link when
 * the path actually looks like a file path — it has a directory separator or a
 * file extension. Keeps incidental `12:30` / `ratio 3:14` strings from being
 * mistaken for code references.
 */
export function looksLikeCodePath(path: string): boolean {
  return path.includes("/") || /\.[a-z0-9]{1,12}$/i.test(path);
}

/** Build a GitHub blob URL for a parsed locator. `ref` defaults to HEAD (the repo's default branch). */
export function githubBlobUrl(repo: string, loc: CodeReferenceLocator, ref = "HEAD"): string {
  const anchor = loc.end > loc.start ? `#L${loc.start}-L${loc.end}` : `#L${loc.start}`;
  return `https://github.com/${repo}/blob/${ref}/${loc.path}${anchor}`;
}

/**
 * Resolve a bare code locator (e.g. `packages/web/app/foo.ts:42`,
 * `vader:components/X.ts:10-20`) to a GitHub blob permalink for the Doco's
 * connected `repo` ("owner/name"). Returns null when there is no connected
 * repo, when the value is already a full URL (those are linkified as plain
 * URLs, not re-resolved), or when the value doesn't look like a code path.
 */
export function codeLocatorGithubUrl(
  repo: string | null | undefined,
  locator: string,
  ref = "HEAD",
): string | null {
  if (!repo) return null;
  const raw = locator.trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  const loc = parseCodeReferenceLocator(raw);
  if (!loc || !looksLikeCodePath(loc.path)) return null;
  return githubBlobUrl(repo, loc, ref);
}
