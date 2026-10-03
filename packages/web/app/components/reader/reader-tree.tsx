// The reader's tree: what a codebase Doco copied, opening in place. It starts
// with the listings the server sent for the open item's place, and fetches a
// folder's children (tree.json) the first time it opens, so moving around
// never reloads the tree. A Notion copy has none (reader-layout.tsx); the
// icons here serve its search list too.
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { GitHubIcon } from "~/components/brand-icons";
import { cn } from "~/lib/cn";
import { type ReaderListing, type ReaderTreeItem, readerHref } from "~/lib/reader";

const ROW =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 text-[13px] text-foreground hover:bg-input";
const ROW_ON = "bg-primary/10 font-semibold text-primary hover:bg-primary/15";

export function ItemIcon({
  item,
  open = false,
}: {
  item: Pick<ReaderTreeItem, "kind" | "icon">;
  open?: boolean;
}) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (item.kind === "repo") return <GitHubIcon aria-hidden className={className} />;
  if (item.kind === "dir") {
    const Icon = open ? FolderOpen : Folder;
    return <Icon aria-hidden className={cn(className, "text-accent")} />;
  }
  if (item.kind === "file")
    return <File aria-hidden className={cn(className, "text-muted-foreground")} />;
  if (item.icon && /^https?:\/\//i.test(item.icon)) {
    return <img src={item.icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />;
  }
  if (item.icon) {
    return (
      <span aria-hidden className="w-3.5 shrink-0 text-center text-[12px] leading-none">
        {item.icon}
      </span>
    );
  }
  const Icon = item.kind === "database" ? Database : FileText;
  return <Icon aria-hidden className={cn(className, "text-muted-foreground")} />;
}

export function fetchJson<T>(url: string): Promise<T | null> {
  return fetch(url, { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
    .catch(() => null);
}

export function ReaderTree({
  handle,
  listings: initial,
  trail,
  current,
  onNavigate,
}: {
  handle: string;
  /** Listings the server sent: the top ("") and the open item's place. */
  listings: Record<string, ReaderListing>;
  /** The open item's place: its ancestors, then itself. */
  trail: string[];
  /** The open item's id ("" for the repositories), null while searching. */
  current: string | null;
  /** Called when a link in the tree is followed (the phone drawer closes). */
  onNavigate?: () => void;
}) {
  const [listings, setListings] = useState(initial);
  // A refresh while the copy comes in brings newer listings: take them,
  // keeping the ones opened since.
  useEffect(() => setListings((prev) => ({ ...prev, ...initial })), [initial]);
  // Open from the start along the trail, so the first paint shows the place.
  const [open, setOpen] = useState(() => new Set(trail.filter((id) => id in initial)));
  const loading = useRef(new Set<string>());

  const load = useCallback(
    (id: string) => {
      if (loading.current.has(id)) return;
      loading.current.add(id);
      void fetchJson<ReaderListing>(`/${handle}/tree.json?under=${encodeURIComponent(id)}`).then(
        (listing) => {
          if (listing) setListings((prev) => ({ ...prev, [id]: listing }));
          else loading.current.delete(id);
        },
      );
    },
    [handle],
  );

  // Moving to another item opens the tree down to it: every ancestor, and
  // the item itself when it has something under it, which its parent's
  // listing says once it has loaded.
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const trailKey = trail.join("\n");
  const parentId = trail.length > 1 ? trail[trail.length - 2] : "";
  const parentKnown = parentId in listings;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the trail's content is its key
  useEffect(() => {
    const known = listingsRef.current;
    const opening = trail.slice(0, -1);
    const last = trail.at(-1);
    const item = last ? known[parentId]?.items.find((it) => it.id === last) : undefined;
    if (last && (item ? item.hasChildren : last in known)) opening.push(last);
    if (opening.length === 0) return;
    setOpen((prev) => new Set([...prev, ...opening]));
    for (const id of opening) if (!(id in known)) load(id);
  }, [trailKey, parentKnown, load]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!(id in listings)) load(id);
  };

  const renderListing = (under: string, depth: number) => {
    const listing = listings[under];
    if (!listing) {
      return (
        <p
          className="py-1 text-xs italic text-muted-foreground"
          style={{ paddingLeft: depth * 12 + 26 }}
        >
          Loading…
        </p>
      );
    }
    return (
      <ul>
        {listing.items.map((item) => {
          const isOpen = open.has(item.id);
          const on = item.id === current;
          return (
            <li key={item.id}>
              <div className={cn(ROW, on && ROW_ON)} style={{ paddingLeft: depth * 12 + 4 }}>
                {item.hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggle(item.id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Close" : "Open"} ${item.name}`}
                    className="flex h-5 w-4 shrink-0 items-center justify-center rounded"
                  >
                    {isOpen ? (
                      <ChevronDown aria-hidden className="h-3 w-3" />
                    ) : (
                      <ChevronRight aria-hidden className="h-3 w-3" />
                    )}
                  </button>
                ) : (
                  <span aria-hidden className="w-4 shrink-0" />
                )}
                <Link
                  to={readerHref(handle, "code", item.id)}
                  aria-current={on ? "page" : undefined}
                  onClick={onNavigate}
                  title={item.pending ? "Not copied yet" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5",
                    item.pending && "italic text-primary/60",
                  )}
                >
                  <ItemIcon item={item} open={isOpen} />
                  <span className="truncate">{item.name || "Untitled"}</span>
                  {item.kind === "repo" && item.files !== null ? (
                    <span className="ml-auto pl-2 text-[11px] font-normal text-muted-foreground">
                      {item.files.toLocaleString("en-US")}
                    </span>
                  ) : null}
                </Link>
              </div>
              {item.hasChildren && isOpen ? renderListing(item.id, depth + 1) : null}
            </li>
          );
        })}
        {listing.more > 0 ? (
          <li
            className="py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: depth * 12 + 26 }}
          >
            {listing.more.toLocaleString("en-US")} more
          </li>
        ) : null}
      </ul>
    );
  };

  return (
    <nav aria-label="Files" className="min-h-0 flex-1 overflow-auto px-1.5 py-2.5">
      {renderListing("", 0)}
    </nav>
  );
}
