# Doco connections

This repo connects to the following Docos. A Doco listed here is one
the project owner has linked to this codebase; an agent's actual
read/write access on each one is determined at OAuth time, not by this
file. A Doco can be "aware-only" — listed here but not in any token's
`granted_doco_ids` — which means the agent knows it exists but cannot
read or write to it.

The canonical handle is the URL slug. The format is
`<org-handle>-<doco-suffix>` (v15).

## Active connections

- https://doco.to/torrenegra-meta-doco/ — Doco's own Doco (decisions,
  intents, rules, history about Doco-the-product). Renamed from
  `meta-doco` by the v17 handle-prefix backfill.

## Notes

- Internal ULID for `torrenegra-meta-doco`: `doco_01KR441EA0ZDMF0N5DY38GSVS3`.
- This file replaces the v12 `DOCO.md` (single Doco URL) with a
  list of Docos. A repo can connect to multiple Docos with different
  per-token access levels.
