-- 061_group_chat_role_collapse.sql
-- ============================================================
-- Follow-up to 060_collapse_roles_and_lifecycle.sql.
--
-- 060 collapsed the access-role ladder (owner / approver / author /
-- reader -> owner / writer / reader) across doco_users, org_users, and
-- oauth_device_authorizations, but missed group_chat_channel_connections
-- (created in 047_group_chat_integrations.sql). That table still carried
-- the old four-role CHECK, so:
--   * any pre-existing 'author'/'approver' channel-default rows were left
--     inconsistent with the rest of the system, and
--   * new inserts now bind a collapsed role ('writer'), which the stale
--     CHECK rejects — breaking Slack channel-default-role saves.
--
-- This migration converts the surviving rows and swaps the constraint to
-- the three-role set. Idempotent and guarded, matching 060's conventions.
-- The runner wraps each migration in a single BEGIN/COMMIT, so this file
-- omits transaction control.
-- ============================================================

-- 1. Convert existing channel-default role grants BEFORE tightening.
UPDATE group_chat_channel_connections
   SET role = 'writer'
 WHERE role IN ('author', 'approver');

-- 2. Swap the role CHECK to the three-role set. The inline constraint in
--    047 got Postgres's auto-generated name.
ALTER TABLE group_chat_channel_connections
  DROP CONSTRAINT IF EXISTS group_chat_channel_connections_role_check;
ALTER TABLE group_chat_channel_connections
  ADD CONSTRAINT group_chat_channel_connections_role_check
  CHECK (role IN ('owner', 'writer', 'reader'));
