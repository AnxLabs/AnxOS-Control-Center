# Release Notes — AnxOS Control Center v1.9 build 199

**Channel:** Private Alpha
**Date:** 2026-09-04

This is the final V1 build: it closes the remaining V1-B acceptance evidence gaps from
`docs/V1_ACCEPTANCE_RECORD.md`. Build 200 is reserved for V2 and is intentionally not
created.

## Added

- `docs/V1_FEATURE_SET.md` — the explicit V1 feature set (20 features with
  Supported/Alpha-form maturity), the unsupported-in-V1 list, and the five UI labeling
  rules used to communicate experimental/unsupported features. Closes V1-B item 1.
- `docs/V1_AUDIT_TRAIL_DECISION.md` — the action-audit-trail decision: V1 relies on
  operation records + structured IPC logs + confirmation dialogs; a tamper-evident audit
  store is deferred to V2-I with explicit trigger conditions. Closes V1-B item 4.

## Changed

- `docs/V1_ACCEPTANCE_RECORD.md`: V1-B items 1, 4, 5 upgraded to Met with dated
  2026-09-04 evidence; item 3 partially met with live state-contract evidence. V1-B gate
  position upgraded to **met** (item 7 tester-feedback evidence remains pending).
- `docs/DOCUMENTATION_INDEX.md`: added the two new V1 records to Current Normative
  Documents.

## Fixed

- V1-B acceptance-record gaps: items 1 (feature-set + labeling matrix), 4 (audit-trail
  decision), and 5 (live backup→restore round trip) are now recorded as Met with dated
  evidence; item 3 gained live state-contract evidence. `docs/V1_ACCEPTANCE_RECORD.md`
  gate position upgraded to met.

## QA

- Live backup→restore round trip executed 2026-09-04 on Better MC [FORGE] BMC4 via the
  packaged v1.9 build 198 app against the Anxlab agent: world backup created (complete),
  restore with confirmation dialog, agent safety snapshot before restore (complete),
  `backups:restore` completed, restart-after-restore flow verified. Custom-command
  instances correctly reject world backups with `WORLD_PATH_NOT_FOUND`.
- `qa:fast`, `qa:feature`, `rc:validate`, `docs:architecture:smoke`, `onboarding:smoke`
  executed for this build.

## Known Issues

- V1-B item 7 (additional-tester feedback / multi-environment Beta regression) remains
  evidence-pending and is carried into the V1 closeout notes.
- Code-signing certificate expires 2026-09-05; renew before the next signed release.
- Custom-command instances (Terraria, Rust) have no world directory, so world-only
  backups are unavailable for them (full-instance backups still apply).
