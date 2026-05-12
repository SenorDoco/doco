import { openDb } from "~/lib/db";
import type { RecentItem } from "./_index";

/**
 * Resource route — JSON feed for live Recent updates (ADR-089).
 *
 * GET /api/recent?since=<ISO datetime>
 *   Returns items with `created_at > since`, ordered ASC.
 *   Without `since`, returns up to the most recent 200 items.
 */
export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  const db = openDb();
  try {
    const where = since ? "WHERE created_at > ?" : "WHERE created_at IS NOT NULL";
    const args: unknown[] = since ? [since, limit] : [limit];
    const items = db
      .prepare(
        `SELECT id, node_type, summary, created_at, slug, number, title FROM (
           SELECT id, 'decision' AS node_type, summary, created_at, slug, number, NULL AS title FROM decision
           UNION ALL
           SELECT id, 'intent' AS node_type, summary, created_at, slug, NULL, title FROM intent
           UNION ALL
           SELECT id, 'idea' AS node_type, summary, created_at, NULL, NULL, NULL FROM idea
           UNION ALL
           SELECT id, 'rule' AS node_type, summary, created_at, slug, NULL, NULL FROM rule
           UNION ALL
           SELECT id, 'action' AS node_type, summary, created_at, NULL, NULL, NULL FROM action
           UNION ALL
           SELECT id, 'reasoning' AS node_type, summary, created_at, NULL, NULL, NULL FROM reasoning
           UNION ALL
           SELECT id, 'scope' AS node_type, summary, created_at, NULL, NULL, name AS title FROM scope
         )
         ${where}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...args) as RecentItem[];
    return Response.json({ items });
  } finally {
    db.close();
  }
}
