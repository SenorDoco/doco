// Filesystem watcher that keeps the per-Doco SQLite/FTS5 index up to
// date without agents having to call reindex. Per the
// `auto-reindex-on-file-changes` Intent + ADR.
//
// Implementation:
//   - One singleton watcher per process, started lazily on first import.
//   - Uses Node's built-in `fs.watch` with `recursive: true`. On macOS
//     this is backed by FSEvents (lightweight, kernel-level). On Linux
//     recursive isn't supported by inotify but `fs.watch` falls back to
//     a polling alternative; for our dev use case macOS is the path that
//     matters most.
//   - On any change under `<root>/docos/<owner>/<doco>/`, we identify
//     the affected Doco directory, debounce 250ms, and run a single
//     reindex(docoDir). Burst saves coalesce.
//   - State is observable via `getWatcherStatus()` — the lint page
//     surfaces it.
//
// Future hardening (tracked in the same Intent):
//   - Per-file incremental updates instead of full reindex.
//   - chokidar fallback for Linux recursive coverage.
//   - Multi-process coordination (lockfile) if we ever run multiple web
//     servers per host.

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { rootDir } from "./db.server";
import { reindex } from "./redeem.server";

interface WatcherStatus {
  enabled: boolean;
  started_at: string | null;
  watcher_root: string | null;
  last_tick_at: string | null;
  /** Per-Doco queue: docoKey → next-fire timer + last-event time. */
  pending: { docoKey: string; queued_at: string }[];
  /** Recent reindex events (newest first, capped). */
  recent: { docoKey: string; ran_at: string; duration_ms: number; ok: boolean; error?: string }[];
  total_reindexes: number;
}

const DEBOUNCE_MS = 250;
const RECENT_CAP = 50;

let singleton: AutoReindexer | null = null;

class AutoReindexer {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private queueAt = new Map<string, string>();
  private status: WatcherStatus = {
    enabled: false,
    started_at: null,
    watcher_root: null,
    last_tick_at: null,
    pending: [],
    recent: [],
    total_reindexes: 0,
  };

  start(): void {
    if (this.watcher) return;
    let root: string;
    try {
      root = rootDir();
    } catch {
      return; // host not ready yet; the next request will retry via getStatus
    }
    const docosRoot = join(root, "docos");
    if (!existsSync(docosRoot)) return;
    try {
      this.watcher = watch(docosRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        this.onChange(filename, docosRoot);
      });
    } catch (e) {
      // recursive watch may not be supported on some platforms; fail soft.
      console.error("auto-reindex watcher failed to start:", e);
      return;
    }
    this.status.enabled = true;
    this.status.started_at = new Date().toISOString();
    this.status.watcher_root = docosRoot;
  }

  private onChange(filename: string, docosRoot: string): void {
    // filename is relative to docosRoot, e.g.
    // "torrenegra/doco/decisions/decision_…md"
    const parts = filename.split(sep);
    if (parts.length < 2) return;
    const ownerName = parts[0];
    const docoSlug = parts[1];
    if (!ownerName || !docoSlug) return;
    if (ownerName.startsWith(".") || docoSlug.startsWith(".")) return; // skip .deleted/ etc.
    // We only care about content changes — md/yaml under known subdirs.
    // The reindex itself filters, so we don't need to be picky here. But
    // ignore changes under .doco/ (cache.db etc.) to prevent reindex loops.
    if (parts[2] === ".doco") return;
    const docoDir = join(docosRoot, ownerName, docoSlug);
    if (!existsSync(join(docoDir, "doco.yaml"))) return;
    const docoKey = `${ownerName}/${docoSlug}`;
    const now = new Date().toISOString();
    this.queueAt.set(docoKey, now);
    this.status.last_tick_at = now;
    const existing = this.timers.get(docoKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(docoKey);
      this.queueAt.delete(docoKey);
      this.fireReindex(docoKey, docoDir);
    }, DEBOUNCE_MS);
    this.timers.set(docoKey, timer);
  }

  private async fireReindex(docoKey: string, docoDir: string): Promise<void> {
    const startedAt = Date.now();
    let ok = true;
    let error: string | undefined;
    try {
      await reindex(docoDir);
    } catch (e) {
      ok = false;
      error = (e as Error).message;
    }
    this.status.total_reindexes += 1;
    this.status.recent.unshift({
      docoKey,
      ran_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ok,
      ...(error ? { error } : {}),
    });
    while (this.status.recent.length > RECENT_CAP) this.status.recent.pop();
  }

  getStatus(): WatcherStatus {
    return {
      ...this.status,
      pending: [...this.queueAt.entries()].map(([docoKey, queued_at]) => ({ docoKey, queued_at })),
      recent: [...this.status.recent],
    };
  }
}

function get(): AutoReindexer {
  if (!singleton) {
    singleton = new AutoReindexer();
    singleton.start();
  }
  return singleton;
}

/**
 * Public surface — returns a snapshot of the watcher state for the lint
 * page (or any other observable use). Side-effect: starts the watcher
 * on first call if not already running.
 */
export function getWatcherStatus(): WatcherStatus {
  return get().getStatus();
}

/**
 * Eagerly start the watcher (idempotent). Call from request hot paths
 * to ensure the watcher is running.
 */
export function ensureWatcherStarted(): void {
  get();
}
