---
id: action_01KR6GH21YJ5A519KV7TYB11QZ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 8.2 — share-message Copy on the issuer page. Default Copy now puts a self-explaining message (with URL embedded) on the clipboard; URL-only is a secondary action. Closes the cold-receiver gap not fixed by ADR-069."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_share_message_copy

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6GH21SHNFWPF8ACTMKGSDM   # ADR-070 (this Action operationalizes it)
  - decision_01KR6FYFQNZRCV7KQSKEVGV9PK   # ADR-069 (predecessor — page-level self-description)

inputs:
  user_observation: |
    The user pasted the bare invitation URL into a fresh Claude Code
    session in another project. The receiving agent replied:
      "You pasted a localhost URL with an invite token but no
       instructions. What would you like me to do with it?"
    The agent never fetched the URL — it pattern-matched
    "localhost + token + no commentary" as out-of-place and (correctly)
    asked for clarification. ADR-069's self-describing page only helps
    if the receiving agent fetches.

outputs:
  source_files_changed:
    - packages/web/app/routes/invite.tsx               # Copy button → "Copy share message" (primary, full context paragraph) + "Copy URL only" (secondary). Share-message preview shown in a <pre> block.
    - decisions/decision_01KR6GH21SHNFWPF8ACTMKGSDM.md  # ADR-070 captures the design choice
    - packages/index/src/__tests__/build.test.ts       # decision/action counts
    - packages/core/src/__tests__/loader.test.ts       # decision lower-bound
  tests:
    full_workspace: "all 10 packages green via `pnpm -r test`"
  e2e_browser_verified:
    - "Click Generate invitation → preview shows the full share-message text"
    - "Click 'Copy share message' → clipboard receives the message"
    - "Click 'Copy URL only' → clipboard receives just the URL"

started_at: 2026-05-09T13:55:00Z
ended_at: 2026-05-09T14:00:00Z

created_at: 2026-05-09T14:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 8.2 — share-message Copy

The user's second test showed the limit of ADR-069: the receiving
agent didn't fetch the URL, so the page's self-description was never
seen. The gap was on the *sharing* surface, not the *destination*.

## Fix

The issuer page (`/invite`) now generates a self-explaining share
message at render time, using the loaded inviter username and host
name. The default Copy button puts that message on the clipboard.
URL-only is a secondary action.

The message gives a cold-receiving agent what it needs to know without
requiring a fetch:

- *what* the token is (Doco agent invitation, single-use, 5-min)
- *who* sent it (inviter username, host name)
- *what* to do to accept (visit the URL, or fetch the .json variant)
- *what* the receiver becomes if they accept (Principal{type:agent}
  with `owner_id = inviter`)
- *graceful exit* (ignore if unexpected; grants no access until
  redeemed)
- *links to provenance* (ADR-068, ADR-069)

## What was deferred

Per ADR-070 alternatives section:
- Descriptive URL paths (`/agent-invitation/<token>`) — useful for
  agents that read paths, but the observed failure mode is
  pattern-match-and-refuse, not parse-the-path.
- Custom URL scheme (`doco://invite/<token>`) — needs OS handler
  registration; revisit post phase-6 deploy.
- Fragment-based URL — orthogonal log-hygiene improvement; ADR-068
  already deferred this.
