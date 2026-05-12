# AGENT.md — read this first

You're in a Doco-tracked project. Your real instructions are served by the
host so they're always up-to-date. Fetch them now:

```
curl -s $DOCO_HOST/api/v1/agent-bootstrap
```

Read the `canonical_instructions` field. The same response also includes
this Doco's scopes, known lint issues, recent activity, and the
authoritative way to navigate. Don't start work until you've read it.

If `DOCO_HOST` or `DOCO_TOKEN` aren't in `./.env`, ask the human to
visit the host, paste them, and write them to `.env` (gitignored). Don't
ask where — `.env` is always the answer.

That's it. Everything else lives at the bootstrap endpoint.
