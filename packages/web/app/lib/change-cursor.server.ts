/**
 * Live-feed change cursor — server read (ADR-089, real-time refinement).
 *
 * Every node alteration — create, update, lifecycle transition, edge add —
 * writes an audit_events row, so the latest event for a Doco is a complete
 * "has anything changed?" signal. The (doco_id, at DESC) index makes the
 * latest-event lookup a single-row read, cheap enough to poll once a second
 * per open tab. The heavy perspective loader only re-runs when this advances.
 */

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/**
 * The Doco's latest audit-event id, or null when it has no history yet.
 *
 * `event_id` is the audit row's stable primary key; ordering by (at DESC,
 * event_id DESC) makes the tiebreak deterministic when two events share a
 * timestamp, so the returned cursor only changes when a genuinely newer event
 * lands.
 */
export async function readChangeCursor(c: QueryClient, docoId: string): Promise<string | null> {
  const { rows } = await c.query<{ event_id: string }>(
    `SELECT event_id FROM audit_events
      WHERE doco_id = $1
      ORDER BY at DESC, event_id DESC
      LIMIT 1`,
    [docoId],
  );
  return rows[0]?.event_id ?? null;
}
