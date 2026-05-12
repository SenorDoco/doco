# Rules — 5 entities

| Slug | Modality | Phase | Severity | On violation | File |
|---|---|---|---|---|---|
| priority-order | must | declared | blocker | warn | [rule_01KR441EAF7M5QPF65BXGD1ET1.md](rule_01KR441EAF7M5QPF65BXGD1ET1.md) |
| explicit-over-implicit | must | declared | warning | warn | [rule_01KR441EAGVR2GFZAP9BMTSBG8.md](rule_01KR441EAGVR2GFZAP9BMTSBG8.md) |
| only-humans-delete-doco | must | pre | blocker | block | [rule_01KR441EAH8KJZ2F4TMP8YPQPB.md](rule_01KR441EAH8KJZ2F4TMP8YPQPB.md) |
| agent-ancestry-terminates-at-human | must | invariant | blocker | block | [rule_01KR441EAJCPF378ZGM9DMDFH0.md](rule_01KR441EAJCPF378ZGM9DMDFH0.md) |
| no-secrets-in-doco | must_not | pre | blocker | block | [rule_01KR441EAK6MKGDZZWH5TRZ9HQ.md](rule_01KR441EAK6MKGDZZWH5TRZ9HQ.md) |

## Phase legend

- **declared** — policy that always holds (formerly *Constraint*).
- **pre / post / invariant** — runtime evaluation point (formerly *Assertion*).

See [ADR-010](../decisions/decision_01KR441EAX8KMFVDQA06HQY2JW.md) for why
Constraint and Assertion were unified into a single `Rule` entity with a
`phase` field.

## `born_from` lineage

| Rule | Born from | Why |
|---|---|---|
| priority-order | [ADR-001](../decisions/decision_01KR441EAMKYKCEBSEYHGJ8M3Z.md) | The priority order Decision is operationalized as this Rule. |
| only-humans-delete-doco | [ADR-040](../decisions/decision_01KR441EBVNSWGHVP39KMWE1ZT.md) | Only humans can delete; Decision spawns the runtime check Rule. |
| agent-ancestry-terminates-at-human | [ADR-035](../decisions/decision_01KR441EBPZB0X7K59C411PHAQ.md) | Agents-via-invitation Decision implies the trust invariant; this Rule enforces it. |
| no-secrets-in-doco | [ADR-039](../decisions/decision_01KR441EBTZDSJC0PEDTX4QHNE.md) | Tokens-stored-externally Decision; the Rule scans commits for the same. |
| explicit-over-implicit | (none) | Foundational principle, not derived from any single Decision. |
