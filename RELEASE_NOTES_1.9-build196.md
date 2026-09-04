# AnxOS Control Center v1.9 Build 196 — Private Alpha

Build 196 focuses on validation-gate integrity, resource operation and instance health lifecycle hardening, and roadmap/baseline documentation.

## Added

- Resource operation lifecycle module with regression coverage for stable resource identity, transient operation overlays, cancellation, and stale-response protection.
- Instance metrics lifecycle module with bounded scheduling and node-scoped stale-response protection, plus regression coverage.
- Instance health summary module with regression coverage for health classification across reconciliation and failure evidence.
- New lifecycle smoke suites (resource operations, instance metrics, instance health summary, instance health state) wired into the feature validation tier.
- Master product roadmap (docs/MASTER_ROADMAP.md) and B0 baseline capability matrix (docs/B0_BASELINE.md) with Phase 11A reconciliation outcomes, both indexed in docs/DOCUMENTATION_INDEX.md.

## Fixed

- Updated the node-switch smoke's Docker assertion to match the hardened Docker refresh finalizer that always releases the in-flight flag, preventing refresh deadlock after a node switch mid-request; the assertion now pins the stronger invariant instead of the pre-refactor guard shape.
- Documented historical SSH browser confirmation-dialog smoke failure as resolved by re-execution; ui:polish smoke passes.

## QA

- Fast tier passed (5 checks); feature tier passed 17/17 including the four newly wired lifecycle smokes.
- Full RC source validation executed; packaging smoke validated against a freshly rebuilt signed Windows installer.
- Phase 11A findings reconciled by direct code inspection: Docker service shims confirmed as an intentional packaging seam; Public Access provisioning contract limits documented.

## Known Issues

- Live two-instance plus connected-Agent acceptance remains outstanding and is required before the V1-A acceptance gate can close.
- SSH connectivity remains under stabilization. Some SSH scenarios may not function correctly and will be addressed in a future build.
