# Decisions — 45 ADRs

Each row is one Decision entity. Filenames use the ULID-prefixed ID (per
[ADR-004](decision_01KR441EAQ1J516HMAMZ66NKRJ.md)). Slugs and ADR numbers are
the human-side handles ([ADR-018](decision_01KR441EB5JDWDYQ4JP4KS33EX.md),
[ADR-022](decision_01KR441EB9E6VBGNJGW6VQNVTM.md)).

## Index by ADR number

### Foundation (D-001 … D-005)

| ADR | Slug | File |
|---|---|---|
| ADR-001 | optimization-priority-order | [decision_01KR441EAMKYKCEBSEYHGJ8M3Z.md](decision_01KR441EAMKYKCEBSEYHGJ8M3Z.md) |
| ADR-002 | storage-is-git-repository | [decision_01KR441EAN4CD2MXV5A2E4TYCB.md](decision_01KR441EAN4CD2MXV5A2E4TYCB.md) |
| ADR-003 | yaml-frontmatter-plus-markdown-body | [decision_01KR441EAPAGA5XME562JACT5Q.md](decision_01KR441EAPAGA5XME562JACT5Q.md) |
| ADR-004 | ids-are-node-type-prefixed-ulid | [decision_01KR441EAQ1J516HMAMZ66NKRJ.md](decision_01KR441EAQ1J516HMAMZ66NKRJ.md) |
| ADR-005 | discriminator-field-is-node-type | [decision_01KR441EARA83PWX3JVA1MGK3F.md](decision_01KR441EARA83PWX3JVA1MGK3F.md) |

### Schema shape (D-006 … D-008)

| ADR | Slug | File |
|---|---|---|
| ADR-006 | common-fields-on-every-entity | [decision_01KR441EAS39KJC9RN9WCD648W.md](decision_01KR441EAS39KJC9RN9WCD648W.md) |
| ADR-007 | canonical-lifecycle | [decision_01KR441EATN151XB3HV6FWT0ZQ.md](decision_01KR441EATN151XB3HV6FWT0ZQ.md) |
| ADR-008 | per-evalo-schema-version | [decision_01KR441EAVQJCFXJV7PVY5NPAJ.md](decision_01KR441EAVQJCFXJV7PVY5NPAJ.md) |

### Node types (D-009 … D-013)

| ADR | Slug | File |
|---|---|---|
| ADR-009 | final-node-type-list | [decision_01KR441EAWNQ4ZAPG0XGA9RJZX.md](decision_01KR441EAWNQ4ZAPG0XGA9RJZX.md) |
| ADR-010 | rule-subsumes-constraint-and-assertion | [decision_01KR441EAX8KMFVDQA06HQY2JW.md](decision_01KR441EAX8KMFVDQA06HQY2JW.md) |
| ADR-011 | membership-as-edge-not-node | [decision_01KR441EAY946TF9J62FAKCA57.md](decision_01KR441EAY946TF9J62FAKCA57.md) |
| ADR-012 | reasoning-is-first-class | [decision_01KR441EAZ9KR2BE2QY84S301E.md](decision_01KR441EAZ9KR2BE2QY84S301E.md) |
| ADR-013 | decision-and-rule-are-distinct | [decision_01KR441EB0180W94FYGMNHFVMM.md](decision_01KR441EB0180W94FYGMNHFVMM.md) |

### Edges (D-014 … D-017)

| ADR | Slug | File |
|---|---|---|
| ADR-014 | drop-justified-by-edge | [decision_01KR441EB1HY7C49GKKYF53WVC.md](decision_01KR441EB1HY7C49GKKYF53WVC.md) |
| ADR-015 | drop-bounded-by-edge | [decision_01KR441EB2Y5VARC8Q9A1KZ4B4.md](decision_01KR441EB2Y5VARC8Q9A1KZ4B4.md) |
| ADR-016 | born-from-as-generic-provenance | [decision_01KR441EB35F9SKC831F3K2HC5.md](decision_01KR441EB35F9SKC831F3K2HC5.md) |
| ADR-017 | fields-as-edges | [decision_01KR441EB4D3NMVGJYJX5PHQZF.md](decision_01KR441EB4D3NMVGJYJX5PHQZF.md) |

### Naming (D-018 … D-022)

| ADR | Slug | File |
|---|---|---|
| ADR-018 | per-node-handle-field | [decision_01KR441EB5JDWDYQ4JP4KS33EX.md](decision_01KR441EB5JDWDYQ4JP4KS33EX.md) |
| ADR-019 | slugs-are-immutable | [decision_01KR441EB68799CQN8XTBZKQMH.md](decision_01KR441EB68799CQN8XTBZKQMH.md) |
| ADR-020 | url-form | [decision_01KR441EB71JXXK3NS1NTK0NWR.md](decision_01KR441EB71JXXK3NS1NTK0NWR.md) |
| ADR-021 | reserved-tag-conventions | [decision_01KR441EB8Q0VKHGMK7D1TV8T4.md](decision_01KR441EB8Q0VKHGMK7D1TV8T4.md) |
| ADR-022 | optional-adr-number-on-decision | [decision_01KR441EB9E6VBGNJGW6VQNVTM.md](decision_01KR441EB9E6VBGNJGW6VQNVTM.md) |

### Query layer (D-023 … D-027)

| ADR | Slug | File |
|---|---|---|
| ADR-023 | tiered-architecture-source-and-derived-index | [decision_01KR441EBAXTCN4P60ZDC61ZV9.md](decision_01KR441EBAXTCN4P60ZDC61ZV9.md) |
| ADR-024 | index-is-sqlite-plus-fts5 | [decision_01KR441EBB0R991A2P0XXV0VR1.md](decision_01KR441EBB0R991A2P0XXV0VR1.md) |
| ADR-025 | edges-as-adjacency-table | [decision_01KR441EBC9QWZVT240Q78R021.md](decision_01KR441EBC9QWZVT240Q78R021.md) |
| ADR-026 | denormalized-scope-match | [decision_01KR441EBDM29DN9WQ08TET4D8.md](decision_01KR441EBDM29DN9WQ08TET4D8.md) |
| ADR-027 | sql-is-primary-query-surface | [decision_01KR441EBE86RXPB9YXQXCVWAH.md](decision_01KR441EBE86RXPB9YXQXCVWAH.md) |

### Scoping (D-028 … D-029)

| ADR | Slug | File |
|---|---|---|
| ADR-028 | four-scope-cases-three-mechanisms | [decision_01KR441EBFN04DA4BBAKWC0QDY.md](decision_01KR441EBFN04DA4BBAKWC0QDY.md) |
| ADR-029 | cross-evalo-imports-pinned-namespaced-additive | [decision_01KR441EBG1VMFYTCPP1YPXGS8.md](decision_01KR441EBG1VMFYTCPP1YPXGS8.md) |

### Rule discovery (D-030 … D-033)

| ADR | Slug | File |
|---|---|---|
| ADR-030 | five-strategy-rule-discovery | [decision_01KR441EBHFPX0HJM33TNRJC6M.md](decision_01KR441EBHFPX0HJM33TNRJC6M.md) |
| ADR-031 | vector-embeddings-alongside-fts5 | [decision_01KR441EBJAPKRA4JNWPZWMXEX.md](decision_01KR441EBJAPKRA4JNWPZWMXEX.md) |
| ADR-032 | glossary-as-flat-config | [decision_01KR441EBK4VVQN19Q8AHYV8D0.md](decision_01KR441EBK4VVQN19Q8AHYV8D0.md) |
| ADR-033 | hard-soft-separation-in-discovery | [decision_01KR441EBMZYHYKE0RMVCKY3RN.md](decision_01KR441EBMZYHYKE0RMVCKY3RN.md) |

### Identity & auth (D-034 … D-040)

| ADR | Slug | File |
|---|---|---|
| ADR-034 | humans-sign-in-via-github-only | [decision_01KR441EBNZJTAW29W7YM38K30.md](decision_01KR441EBNZJTAW29W7YM38K30.md) |
| ADR-035 | agents-via-invitation-only | [decision_01KR441EBPZB0X7K59C411PHAQ.md](decision_01KR441EBPZB0X7K59C411PHAQ.md) |
| ADR-036 | username-convention | [decision_01KR441EBQQZXZ7J304KJF72P0.md](decision_01KR441EBQQZXZ7J304KJF72P0.md) |
| ADR-037 | token-lifecycle-invitation-then-session | [decision_01KR441EBR170TWHVZMZG0SVZS.md](decision_01KR441EBR170TWHVZMZG0SVZS.md) |
| ADR-038 | token-revocation-cascades-strictly | [decision_01KR441EBSMYJB6YMTGCRKTVZS.md](decision_01KR441EBSMYJB6YMTGCRKTVZS.md) |
| ADR-039 | tokens-stored-externally | [decision_01KR441EBTZDSJC0PEDTX4QHNE.md](decision_01KR441EBTZDSJC0PEDTX4QHNE.md) |
| ADR-040 | only-humans-can-delete-evalos | [decision_01KR441EBVNSWGHVP39KMWE1ZT.md](decision_01KR441EBVNSWGHVP39KMWE1ZT.md) |

### Product flows (D-041 … D-045)

| ADR | Slug | File |
|---|---|---|
| ADR-041 | greenfield-and-brownfield-onboarding | [decision_01KR441EBWS09RRX4BTQQPT9MJ.md](decision_01KR441EBWS09RRX4BTQQPT9MJ.md) |
| ADR-042 | backfill-with-proposed-quarantine | [decision_01KR441EBX2DT05R98XX5KKG0N.md](decision_01KR441EBX2DT05R98XX5KKG0N.md) |
| ADR-043 | backfilled-entities-carry-reference | [decision_01KR441EBY879Z65Z8PYV0ZR5S.md](decision_01KR441EBY879Z65Z8PYV0ZR5S.md) |
| ADR-044 | api-first-web-is-a-consumer | [decision_01KR441EBZDSDGJGDX7GQTXEAY.md](decision_01KR441EBZDSDGJGDX7GQTXEAY.md) |
| ADR-045 | recent-changes-feed-is-home | [decision_01KR441EC0TNQSZYYS0EXB975C.md](decision_01KR441EC0TNQSZYYS0EXB975C.md) |

## Open questions

12 open questions remain (DECISIONS.md §13). They are *not* yet Decisions —
they are documented as "to be settled during implementation, or escalated."
When resolved, each becomes a new Decision entity here.
