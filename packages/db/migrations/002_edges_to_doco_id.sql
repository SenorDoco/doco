-- Cross-Doco edges (add-document-edge-connections).
--
-- Allow an entity in one Doco to reference an entity in another Doco
-- when the access rules permit. Adds `to_doco_id` to the `edges` table
-- so the materialized graph records both endpoints' Docos. The existing
-- `doco_id` column stays as the "source" / "from" Doco (= the Doco that
-- owns the edge and gets re-indexed when the source entity changes).
--
-- Access rules (enforced at index time by @doco/index/cross-doco):
--   1) The source and target Docos share an `org_id`, OR
--   2) The target Doco's `visibility = 'public'`.
--
-- Existing rows are backfilled to `to_doco_id = doco_id` (intra-Doco).
-- A FK to `docos(id) ON DELETE CASCADE` mirrors the source-side FK so
-- a deleted Doco cascades through edges in either direction.
--
-- Idempotent guards on every step — safe to re-run on already-migrated
-- DBs (the migration runner records the id, but the guards are belt-
-- and-braces for any partial-apply scenario).

ALTER TABLE edges ADD COLUMN IF NOT EXISTS to_doco_id text;

UPDATE edges SET to_doco_id = doco_id WHERE to_doco_id IS NULL;

ALTER TABLE edges ALTER COLUMN to_doco_id SET NOT NULL;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'edges_to_doco_id_fkey'
  ) THEN
    ALTER TABLE edges ADD CONSTRAINT edges_to_doco_id_fkey
      FOREIGN KEY (to_doco_id) REFERENCES docos(id) ON DELETE CASCADE;
  END IF;
END
$fk$;

CREATE INDEX IF NOT EXISTS edges_to_doco_idx ON edges (to_doco_id);
CREATE INDEX IF NOT EXISTS edges_cross_doco_idx ON edges (doco_id, to_doco_id)
  WHERE doco_id <> to_doco_id;
