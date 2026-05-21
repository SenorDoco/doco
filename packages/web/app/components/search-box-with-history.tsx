// Search input with a recent-searches dropdown backed by localStorage.
// Used on the per-Doco home page.

import { useEffect, useState } from "react";
import { Form } from "react-router";

const RECENT_LIMIT = 8;

interface RecentSearch {
  q: string;
  ts: number;
}

function recentSearchesKey(handle: string): string {
  return `doco:recent-searches:${handle}`;
}

function loadRecent(handle: string): RecentSearch[] {
  try {
    const raw = localStorage.getItem(recentSearchesKey(handle));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentSearch =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as RecentSearch).q === "string" &&
          typeof (r as RecentSearch).ts === "number",
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function saveRecent(handle: string, q: string): void {
  const trimmed = q.trim();
  if (trimmed.length === 0) return;
  const existing = loadRecent(handle).filter((r) => r.q !== trimmed);
  const next = [{ q: trimmed, ts: Date.now() }, ...existing].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(recentSearchesKey(handle), JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private mode, quota) — non-fatal.
  }
}

function removeRecent(handle: string, q: string): RecentSearch[] {
  const next = loadRecent(handle).filter((r) => r.q !== q);
  try {
    localStorage.setItem(recentSearchesKey(handle), JSON.stringify(next));
  } catch {
    // non-fatal.
  }
  return next;
}

function clearAllRecent(handle: string): void {
  try {
    localStorage.removeItem(recentSearchesKey(handle));
  } catch {
    // non-fatal.
  }
}

function relativeTimeMs(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SearchBoxWithHistory({
  handle,
  placeholder,
  compact = false,
}: {
  handle: string;
  placeholder: string;
  compact?: boolean;
}) {
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setRecent(loadRecent(handle));
  }, [handle]);

  const showDropdown = focused && query.trim().length === 0 && recent.length > 0;

  const inputClass = compact
    ? "w-full rounded-md border border-border bg-input/95 px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary"
    : "w-full rounded-md border border-border bg-input px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary";
  const buttonClass = compact
    ? "rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
    : "rounded-md border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted";

  return (
    <Form
      method="get"
      action={`/${handle}/search`}
      className="flex gap-2"
      onSubmit={() => {
        saveRecent(handle, query);
      }}
    >
      <div className="relative flex-1">
        <input
          name="q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className={inputClass}
        />
        {showDropdown ? (
          <ul
            aria-label="Recent searches"
            className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-border bg-card text-sm text-card-foreground shadow-sm"
          >
            {recent.map((r) => (
              <li key={r.q} className="flex items-center hover:bg-muted">
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    saveRecent(handle, r.q);
                    window.location.href = `/${handle}/search?q=${encodeURIComponent(r.q)}`;
                  }}
                  className="flex flex-1 items-center justify-between gap-3 px-4 py-2 text-left"
                >
                  <span className="truncate">{r.q}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {relativeTimeMs(r.ts)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove "${r.q}" from recent searches`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setRecent(removeRecent(handle, r.q));
                  }}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-base leading-none text-muted-foreground hover:bg-input hover:text-foreground"
                >
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
            <li className="border-t border-border">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  clearAllRecent(handle);
                  setRecent([]);
                }}
                className="block w-full px-4 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Clear all
              </button>
            </li>
          </ul>
        ) : null}
      </div>
      <button type="submit" className={buttonClass}>
        Search
      </button>
    </Form>
  );
}
