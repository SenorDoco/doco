---
id: decision_01KREQ7P27K069RBX42APKTBQX
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"

slug: hosted-multi-tenant-is-the-only-shape
number: "ADR-092"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
follows:
  - decision_01KR441EA1X74DH9WBDY5Z6HQ6   # ADR-061 (host concept)
  - decision_01KR441EA28XBT5BRN2KMM1EDD   # ADR-062 (Organization)
  - decision_01KR441EA9BAYSS7WTJE1Q6SFM   # ADR-067 (self-service)
summary: "Supersedes ADR-087. Doco is a hosted multi-tenant solution — anyone signs up, owns multiple Docos, collaborates via permissions. localhost today; public domain soon. One shape; single-doco mode goes away in ADR-093."

question: "ADR-087 collapsed Doco to a local-solo shape (one Doco per workspace folder, no auth). The founder reviewed and stated the actual target: a hosted multi-tenant SaaS where anyone can sign up, own multiple Docos, and collaborate. localhost today, public domain soon. What's the canonical shape?"

chosen: |
  **Hosted multi-tenant. Always.** One shape, no modes.

  ### Shape

  - **Host** is the deployment unit. Identified by `host.yaml` at the
    workspace root. Holds Principals, Organizations, and Docos under
    `docos/<owner>/<slug>/`.
  - **Anyone can sign up.** Sign-up creates a `Principal{type:human}`.
    In localhost it's a username picker (ADR-066); in production it's
    GitHub OAuth (ADR-034 — needs build-out).
  - **Each user owns N Docos.** Self-service `/new-doco` (ADR-067)
    creates them. Organizations (ADR-062) own Docos for groups.
  - **Agents collaborate via session tokens** (ADR-037, ADR-068,
    ADR-069, ADR-070, ADR-071). Each agent's `Principal.owner_id`
    walks back to a human; that invariant remains the trust property.
  - **Routes are owner-prefixed** — `/<owner>/<doco>/...` for Doco
    pages, `/<owner>` for owner profile, `/` for the host home.

  ### Reversal of ADR-087

  ADR-087's reasoning (every feature ships twice; hosted multi-tenant
  was ahead of demand) was wrong: the demand IS the product. Hosted
  multi-tenant isn't a future deployment shape; it's *the* shape.
  Single-doco mode was always a temporary scaffolding for the
  meta-doco's own bootstrap, never a user-facing offering.

  ADR-087 is marked `lifecycle: superseded`. The 12 ADRs it
  superseded — ADR-037, ADR-038, ADR-061, ADR-062, ADR-063, ADR-066,
  ADR-067, ADR-068, ADR-069, ADR-070, ADR-071, ADR-073 — are
  un-flipped back to `lifecycle: active`.

  ### Single-doco mode removal

  Captured separately as ADR-093: the meta-doco migrates to host
  shape; `getMode()` and every single-doco-only code path comes out.

  ### Public deploy

  Captured separately as ADR-094: domain, OAuth, session storage,
  hosting platform, DNS, TLS, observability.

  ### Vocabulary

  "Doco" the product is always hosted multi-tenant. References to
  "local-solo" / "single-Doco mode" / "solo Doco" are vestigial; new
  prose doesn't use them. Historical ADRs that mention them stay
  intact (Decisions are append-only) but are marked superseded where
  the underlying mechanism is no longer code.

alternatives:
  - name: Keep dual-mode (single-doco for local-dev, host for prod)
    rejected_because: "ADR-087 already showed this taxed every feature with double rendering. The user explicitly rejected it: 'Doco is always a hosted multi-tenant solution.' Local-dev runs against a localhost host; one mode."
  - name: Reintroduce hosted-multi-tenant gradually, keep single-doco for now
    rejected_because: "Single-doco mode actively misrepresents the product. The faster we delete it, the faster every PR is judged against the right shape. No production users to break."
  - name: Branch a 'hosted-mt' track and rebuild in parallel
    rejected_because: "The hosted code already exists in git history (everything before Phase 22) and is restored by the revert. Branching now means duplicating two parallel tracks; that's the trap ADR-087 fell into."

rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T13:00:00Z

created_at: 2026-05-12T13:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-092 — Hosted multi-tenant is the only shape

## How this Decision was reached

ADR-087 (local-solo collapse) shipped on 2026-05-12 morning. The
founder reviewed and corrected course:

> "We messed up big time. What we needed to implement is the hosted
> Doco. We need this software to be software where anyone can sign in.
> Anyone can create an account, and they can add as many Doco's as they
> want. Right now it's on localhost, but we are going to publish it to
> a public domain where anyone can use it."

This Decision codifies the corrective direction. The wrong work was
reverted in commit `cc2468d`. Single-doco mode removal lands in ADR-093;
public deploy planning lands in ADR-094.

## Why ADR-087 was wrong

ADR-087's reasoning was: "every feature ships twice" — once for single-doco,
once for host. The fix proposed: delete one (the host side). The
unstated assumption was that single-doco was the dominant case and host was
speculative.

The correct read: the hosted side IS the product. Single-doco was the
bootstrap scaffolding (D-002 says "a Doco is a git repo"; for the meta-doco
that boots itself, single-doco was a way to skip account creation). Hosted
multi-tenant is what the world buys.

## What changes from this Decision

- Twelve ADRs (037, 038, 061-063, 066-071, 073) — un-superseded; their
  prescriptions hold.
- ADR-087 — `lifecycle: superseded`, `superseded_by: ADR-092`.
- The Phase 22 + 23 ADRs that *were not* dependent on the collapse
  (ADR-088 sub-bar nav, ADR-089 live feed, ADR-090 drift coverage,
  ADR-091 drift layers) get re-issued as Phase 25+ work — they apply
  to hosted just as they did to local-solo.
- Single-doco mode removal — ADR-093.
- Public deploy plan — ADR-094.
