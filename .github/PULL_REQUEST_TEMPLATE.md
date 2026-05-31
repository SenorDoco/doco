<!--
This PR is tracked in Doco as a Reference node (ref_type: url, keyed on the PR
URL). The title + this body become the Reference's prose, so write them for the
reader who finds this PR months from now via Doco search — explain the *why*,
not just the *what*.
-->

## What & why

<!-- What changed, and the reasoning/constraints behind it. -->

## Doco links

<!--
Optional but encouraged. Name the institutional memory this PR touches so the
tracked Reference carries the context. Reference nodes by id (or doco.to URL):

- Implements: <bpm_… / intent_…>   — the process or intent this ships
- Fixes:      <bug_…>              — the bug this closes
- Enacts:     <decision_…>         — the decision this puts into effect

(These are read by humans and agents today. Automatic edge-wiring from
`Doco-Implements:` / `Doco-Fixes:` trailers is proposed, not yet implemented —
see docs/proposals/pull-request-node-and-template.md.)
-->

## Checklist

- [ ] Behavior change is covered by a test that was **red before, green after** (`pnpm verify`)
- [ ] Updated docs/proposals if this changes a documented convention
