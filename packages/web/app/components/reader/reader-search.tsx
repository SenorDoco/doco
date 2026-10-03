// The reader's one search box. As you type it lists the files (or pages)
// whose names match, and picking one opens it; the first row, picked by
// Enter, searches inside them instead (?q= on the current address, so
// closing the search comes back to what was open). Without JavaScript the
// box is a plain GET form doing the same search.
import { Search } from "lucide-react";
import { type KeyboardEvent, type Ref, useEffect, useId, useState } from "react";
import { Form, Link, useLocation, useNavigate } from "react-router";
import { cn } from "~/lib/cn";
import { type ReaderKind, type ReaderListing, type ReaderTreeItem, readerHref } from "~/lib/reader";
import { ItemIcon, fetchJson } from "./reader-tree";

const LOOKUP_DELAY_MS = 120;

export function ReaderSearch({
  handle,
  reader,
  query,
  inputRef,
}: {
  handle: string;
  reader: ReaderKind;
  /** The search the reader shows, "" when browsing. */
  query: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const listId = useId();
  const [text, setText] = useState(query);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<ReaderTreeItem[]>([]);
  const [active, setActive] = useState(0);
  const words = text.trim();

  // A new search (or leaving one) shows in the box.
  useEffect(() => setText(query), [query]);

  // The names matching what is typed, once typing pauses.
  useEffect(() => {
    if (!open || !words) return;
    const timer = setTimeout(() => {
      void fetchJson<ReaderListing>(`/${handle}/tree.json?find=${encodeURIComponent(words)}`).then(
        (listing) => {
          setFound(listing?.items ?? []);
          setActive(0);
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [handle, words, open]);

  const showing = open && words !== "";
  const close = () => {
    setOpen(false);
    setFound([]);
  };

  // The first row searches inside the files (or pages); the rest open a match.
  const rows = [
    {
      id: "",
      to: `${pathname}?${new URLSearchParams({ q: words })}`,
      label: (
        <>
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {reader === "code" ? "Search the code" : "Search every page"} for “{words}”
          </span>
        </>
      ),
    },
    ...found.map((item) => ({
      id: item.id,
      to: readerHref(handle, reader, item.id),
      label: (
        <>
          <ItemIcon item={item} />
          <span className="truncate">{item.name || "Untitled"}</span>
        </>
      ),
      where: item.where,
    })),
  ];
  const pick = (row: (typeof rows)[number]) => {
    close();
    // Opening a match leaves the box empty; a search stays in it.
    if (row.id) setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      close();
    } else if (showing && event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (showing && event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && words) {
      event.preventDefault();
      const row = (showing && rows[active]) || rows[0];
      pick(row);
      navigate(row.to);
    }
  };
  const rowId = (i: number) => `${listId}-${i}`;

  return (
    <Form method="get" action={pathname} className="relative flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        name="q"
        type="search"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={showing ? rowId(active) : undefined}
        placeholder={
          reader === "code" ? "Find a file or search the code" : "Find a page or search every page"
        }
        aria-label={
          reader === "code" ? "Find a file or search the code" : "Find a page or search every page"
        }
        className="w-full rounded-md bg-background py-1.5 pl-8 pr-8 text-sm"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-b-2 border-border px-1 text-[10px] leading-4 text-muted-foreground sm:block">
        /
      </kbd>
      {showing ? (
        <ul
          id={listId}
          aria-label={reader === "code" ? "Files" : "Pages"}
          // Keeps the box focused while a row is clicked.
          onMouseDown={(event) => event.preventDefault()}
          className="neu-floating absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-md bg-card py-1"
        >
          {rows.map((row, i) => (
            <li key={row.id}>
              <Link
                id={rowId(i)}
                to={row.to}
                onClick={() => pick(row)}
                onMouseEnter={() => setActive(i)}
                className={cn("block px-3 py-1.5", i === active && "bg-primary/10")}
              >
                <span className="flex items-center gap-2 text-[13px]">{row.label}</span>
                {"where" in row && row.where ? (
                  <span className="block truncate pl-[22px] text-[11px] text-muted-foreground">
                    {row.where}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Form>
  );
}
