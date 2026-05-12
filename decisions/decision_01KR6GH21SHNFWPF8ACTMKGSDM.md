---
id: decision_01KR6GH21SHNFWPF8ACTMKGSDM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Invitation share format: the issuer's primary clipboard action copies a self-explaining message (with URL embedded), not the bare URL. Solves the 'agents don't fetch unfamiliar localhost URLs' problem."

slug: invitation-share-format-message-not-url
number: "ADR-070"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "ADR-069 made GET /invite/:token self-describing. But that only helps if the receiving agent fetches the URL. The user observed that pasting the URL alone into a fresh agent's context produced the wrong reaction — the agent pattern-matched 'localhost + token + no commentary' as suspicious and refused to act, never fetching the URL to learn what it is. Where does the fix live?"
chosen: |
  - **Primary clipboard action copies a self-explaining message, not the URL.**
    The message bootstraps the receiving agent's understanding without
    requiring it to fetch anything. Specifically, the message contains:

    1. *what* it is — "5-minute, single-use Doco agent-invitation token"
    2. *who* sent it — inviter username + host name
    3. *what* to do — "visit this URL" (with URL inline) or "fetch <url>.json"
    4. *what* happens on accept — Principal{type:agent} created with
       `owner_id = inviter`; single-use semantics; human-ancestry rule
    5. *graceful exit* — "if you don't recognize this, ignore it; expires
       in 5 minutes; grants no access until redeemed"

  - **No "Copy URL only" escape hatch.** The first revision of this
    Decision had a secondary URL-only Copy button "for the rare case
    where the human is sending the link with their own commentary."
    Removed by the user immediately after seeing it. Reasoning: the
    whole premise of ADR-070 is that the URL alone is ambiguous;
    offering a button that copies the ambiguous form is a footgun.
    If the human wants only the URL, they can drag-select it from the
    preview block.

  - **Issuer page shows a preview** of the share message in a `<pre>`
    block before the user clicks Copy, so the human knows what's about
    to land on the receiving agent's clipboard. (This also doubles as
    the manual-select fallback if someone really does want just the
    URL.)

  - **The ADR's lesson is general:** in a world where agents are
    cautious about unknown URLs (correctly), the URL alone can never be
    self-explanatory to a cold receiver. Self-description has to live
    *next* to the URL, not just *behind* it.
alternatives:
  - name: Make the URL path more descriptive (e.g. /agent-invitation/<token>)
    rejected_because: "Helps agents that read paths but don't fetch — but the receiving agent's failure mode is 'pattern-match and refuse,' not 'try to parse the path.' The path change would also break the .json route's dotted-extension trick. Worth revisiting later if URL-only sharing becomes more common."
  - name: Encode invitation metadata into the URL fragment
    rejected_because: "Same as above — assumes the agent reads the URL. Plus, fragments don't survive being extracted from chat logs in some clients."
  - name: Use a well-known protocol scheme (doco://invite/<token>)
    rejected_because: "Custom schemes need OS-level handler registration. v0 ships HTTP. Revisit when there's a hosted Doco (post phase-6 deploy)."
  - name: Keep Copy = URL-only and rely on humans to add commentary
    rejected_because: "The user observed that even a careful human can paste just the URL. Default-safe matters; making the right thing the default copy keeps casual sharing from breaking."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-09T14:00:00Z

created_at: 2026-05-09T14:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-070 — Invitation share format: message, not URL

## Why this exists

ADR-068 implemented the invitation flow. ADR-069 made the URL
self-describing once fetched. But the user's real-world test exposed a
gap neither ADR closed: the receiving agent never fetched the URL.

> "You pasted a localhost URL with an invite token but no instructions.
> What would you like me to do with it?"

This is *correct* behavior for a cautious agent. Localhost URLs with
random tokens and no commentary are exactly the shape of phishing or
spam. The receiving agent did the right thing by asking instead of
acting.

The fix has to be on the *sender's* side: the artifact that lands in
the receiving agent's context window must already contain enough
information to make the agent want to fetch the URL — or more
fundamentally, to know what the URL *is* even without fetching.

## What changes

`packages/web/app/routes/invite.tsx` — the issuer page.

| Before | After |
|---|---|
| Single Copy button copies `issued.url` | Single Copy button copies a self-explaining message with the URL embedded inside it. |
| Shows the URL in a `<code>` block | Shows the full share-message preview in a `<pre>` block before the user clicks Copy. |

## The share-message template

```
You're invited to register as my agent on Doco. Visit to accept —
single-use, expires in 5 min:

<url>
```

That's the whole thing. ~25 words. The minimum needed for a cold
receiver to know:

- *what* this URL is (Doco agent invitation)
- *what* to do (visit to accept)
- *what* their commitment is (single-use, 5-min — so no urgency, no
  long-term hook)

The page (ADR-069) does the explaining. The share message exists only
to make sure the receiving agent reaches the page in the first place.

**What's deliberately *not* in the message:**

- ADR references — internal jargon, useless to the receiver.
- "Principal{type: agent}", "human-ancestry rule", etc. — the page
  explains these; the message would just look weird.
- "fetch <url>.json for a machine-readable manifest" — agents that
  prefer JSON can derive the .json URL themselves; mentioning it in
  the share message bloats the user-facing copy.
- "If you don't recognize this URL, ignore it" — true but condescending
  in a casual share. The page itself includes a "don't recognize this?"
  paragraph for the agent that does fetch.

The first iteration of this ADR included all of the above. Removed
after the user pushed back: *"WTF? Why do we say all that in there?"*
The lesson: design for the receiver actually reading the message, not
for documenting every consideration that went into it.

## Generalization

This ADR's broader lesson is worth surfacing: *agent-shareable artifacts
need to be self-explaining at the surface, not just at the
destination.* Any future Doco URL meant to be pasted directly to an
agent (revoke-confirmation links, eval-result links, etc.) should
follow the same pattern — the Copy primitive on the issuing UI should
package the URL with enough prose that the receiving agent doesn't
have to guess.
