# Memory recency half-lives (Phase 2)

Chosen curves for `recency_boost_kind` in `crates/cd-core/src/memory/score.rs`.

Formula: `1 / (1 + age_days / half_life_days)`.

| Kind | Half-life (days) | Rationale |
|------|------------------|-----------|
| Task | 14 | Operational; ages out of ranking quickly |
| Project note | 90 | Sprint/context notes |
| Bookmark | 120 | Links stay useful but not forever |
| Preference | 180 | User prefs are sticky |
| Fact / Term | 270 | Durable knowledge |
| Decision / Contact | 365 | Long-lived decisions and people |

Tasks therefore rank lower than facts of the same age once past ~2 weeks. Tuned offline with the hybrid recall harness (`ConceptEmbedBackend`); re-measure if semantic weights change.
