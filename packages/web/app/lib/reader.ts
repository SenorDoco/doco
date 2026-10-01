// The reader: how a Doco that copies files or pages from a source is browsed.
// A codebase Doco opens at /<doco>/code, a Notion Doco at /<doco>/pages,
// instead of the node home: a codebase's tree of what was copied on the
// left (a Notion copy has no tree), the file or page in the middle. Every item has one address in the reader: a
// file by its repository and path, as on GitHub, a page by its Notion id.
// Pure, so the browser shares it with the server.

export type ReaderKind = "code" | "pages";

/** The reader a Doco created from `template` opens in, or null for a Doco
 *  of nodes. The kind names the reader's first URL segment. */
export function readerFor(template: string | null | undefined): ReaderKind | null {
  switch (template) {
    case "codebase":
      return "code";
    case "notion":
      return "pages";
    default:
      return null;
  }
}

/** One item of a reader's tree, or of the list under its search box. */
export interface ReaderTreeItem {
  /** The item's address in the reader: "owner/repo/path/to/file" for code
   *  (the repository itself is "owner/repo"), the page id for Notion. */
  id: string;
  name: string;
  kind: "repo" | "dir" | "file" | "page" | "database";
  /** A Notion page's own icon: an emoji or an image URL. */
  icon: string | null;
  hasChildren: boolean;
  /** The files inside a repository or folder; null for a file or a page. */
  files: number | null;
  /** A Notion page the copy knows by name only: its text is still to come. */
  pending: boolean;
  /** Where an item in that list lives: its folder, or its ancestor pages. Empty
   *  in the tree, where the place shows. */
  where: string;
}

/** What is directly under one item of the tree ("" for the top). */
export interface ReaderListing {
  items: ReaderTreeItem[];
  /** Items past the ones listed. */
  more: number;
}

/** The reader's address of an item ("" for the reader's home). */
export function readerHref(handle: string, reader: ReaderKind, id = ""): string {
  const path = id.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return path ? `/${handle}/${reader}/${path}` : `/${handle}/${reader}`;
}

/** The tree's first listings for an item: the top, then each step of its
 *  trail that has something under it (a file has nothing; neither does an
 *  item the copy lacks). */
export async function listingsAlong(
  trail: string[],
  list: (under: string) => Promise<ReaderListing>,
): Promise<Record<string, ReaderListing>> {
  const tree: Record<string, ReaderListing> = { "": await list("") };
  for (const id of trail) {
    const listing = await list(id);
    if (listing.items.length === 0) break;
    tree[id] = listing;
  }
  return tree;
}

/** A code item's repository (its first two segments) and its path in it. */
export function splitCodeId(id: string): { repo: string; path: string } | null {
  const [owner, name, ...rest] = id.split("/").filter(Boolean);
  if (!owner || !name) return null;
  return { repo: `${owner}/${name}`, path: rest.join("/") };
}

/** A code item's place in the tree: its repository, then each folder down
 *  to the item itself. */
export function codeTrail(id: string): string[] {
  const split = splitCodeId(id);
  if (!split) return [];
  const trail = [split.repo];
  let at = split.repo;
  for (const segment of split.path.split("/").filter(Boolean)) {
    at = `${at}/${segment}`;
    trail.push(at);
  }
  return trail;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A file on GitHub. */
export function githubFileUrl(repo: string, path: string): string {
  return `https://github.com/${repo}/blob/HEAD/${encodePath(path)}`;
}

/** A folder on GitHub ("" for the repository's root). */
export function githubTreeUrl(repo: string, dir: string): string {
  return dir
    ? `https://github.com/${repo}/tree/HEAD/${encodePath(dir)}`
    : `https://github.com/${repo}`;
}
