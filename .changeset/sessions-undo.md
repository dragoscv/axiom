---
"@codai/axiom-mcp": minor
---

Session guards and undo (S-1209, S-1215, S-1210): `session-guard.ts` adds cross-session overwrite
detection (`session.foreignWrite`), the blind whole-file overwrite guard (`blind.overwrite`) and the
stale-script guard (`blind.staleScript`), configured by `"sessions"` in the gate profile. `undo.ts`
captures gate-side pre-images into the CAS and restores a session's writes conflict-aware
(`undoSession`). `axiom gc` keeps undo pre-images younger than `undoTtlMs` (default 7 days) live and
prunes expired undo logs; `GcResult` gains `undoLive` and `undoPruned`.
