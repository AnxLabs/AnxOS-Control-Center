# Documentation Status

## Current Normative Documents

The following documents describe the current `dev` implementation and release
gates:

- `ARCHITECTURE.md`
- `OPERATION_FRAMEWORK.md`
- `NODE_TARGETING.md`
- `ERROR_CONTRACT.md`
- `SECURITY_BOUNDARIES.md`
- `CONFIG_MIGRATIONS.md`
- `RECOVERY_MODEL.md`
- `TEST_MATRIX.md`
- `KNOWN_LIMITATIONS.md`
- `PRIVATE_ALPHA_RC_REAL_MACHINE_TEST_SHEET.md`
- `MARKETPLACE_TEMPLATE_CERTIFICATION.md`
- `KNOWN_LIMITATIONS_REMEDIATION_REPORT.md`
- `RELEASE_BLOCKER_CLOSURE_REPORT.md`
- `QA_CONTRACT_RECONCILIATION_REPORT.md`
- `PRIVATE_ALPHA_READINESS_REPORT_FINAL.md`
- `MASTER_ROADMAP.md`
- `B0_BASELINE.md`
- `V1_ACCEPTANCE_RECORD.md`
- `BUILD200_RC4_ACCEPTANCE_RECORD.md`
- `V1_FEATURE_SET.md`
- `V1_AUDIT_TRAIL_DECISION.md`
- `OPERATOR_NOTES_V2.md` (V2 operator-facing behavior reference)
- `API_SURFACE_V2.md` (V2 Agent endpoint and desktop IPC contract reference)

When a current document conflicts with a build-numbered report, the current
document controls.

## V2 Campaign Records

`docs/v2/` holds the current V2 engineering campaign's records. They describe
the current `dev` line, but they are working records rather than normative
specifications: where a milestone design brief and a later campaign-log cycle
entry disagree, the later cycle entry controls, and the code controls over both.

- `docs/v2/V2_CAMPAIGN_LOG.md` — authoritative per-cycle campaign log (milestone
  ladder, rules of engagement, cycle decisions, validation and commit records).
- `docs/v2/V2_CAMPAIGN_QUEUES.md` — live implementation, review, regression,
  test, harness, security, reliability, roadmap-gap, docs, release, cleanup, and
  final-audit queues with evidence and status.
- `docs/v2/SECURITY_TRIAGE_RECORD.md` — Mimosa deep-scan disposition serving as
  the V2-I security-gate evidence; requires a re-scan at the final audit.
- `docs/v2/V2_WAVE1_IMPLEMENTATION_RECORD.md` — Wave-1 (V2-A close-out plus
  first V2-C / V2-D slices) implementation, commits, and validation.
- `docs/v2/V2_WAVE2_IMPLEMENTATION_RECORD.md` — Wave-2 (V2-C follow-on: durable
  Docker jobs, deny-by-default policy, volume protection, create preflight).
- `docs/v2/V2A_DECISIONS.md`, `V2A_IDENTITY_MODEL.md`,
  `V2A_AUTHORITY_PERMISSIONS.md`, `V2A_AGENT_ENROLLMENT.md`,
  `V2A_JOB_LIFECYCLE.md`, `V2A_SUPPORT_MATRIX.md`,
  `V2A_BROWSER_SURFACE_WAVE1.md`, `V2A_WAVE1_REVIEW.md` — V2-A milestone design
  briefs and the independent Wave-1 review.
- `docs/v2/V2B_DASHBOARD_APPS_WAVE1.md`, `docs/v2/V2C_CONTAINERS_WAVE1.md`,
  `docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md` — V2-B / V2-C / V2-D milestone
  design briefs.
- `docs/v2/BUILD201_STATS_UNAUTHORIZED_REPORT.md` — build-scoped report, treated
  as historical evidence for its named build only.

The V1-era normative contract `docs/V2_RELIABILITY_CONTRACT.md` remains in this
directory and is not superseded by the campaign records.

## Historical Evidence

Files whose names contain a build number, publication report, packaged
validation report, or past readiness audit are immutable historical evidence.
They describe the named commit/artifact only and are not instructions for the
current candidate. A historical `PASS` never transfers to a later commit or
artifact.

`PRIVATE_ALPHA_RELEASE_GATE.md` and `REAL_MACHINE_VALIDATION.md` are retained as
historical workflows. Their current replacements are the final readiness report
and the RC real-machine test sheet.

Per-build release notes are historical evidence too. The notes file for the
current release candidate lives at the repository root as
`RELEASE_NOTES_<version>-build<build>.md` (the Desktop Release workflow attaches
it to the GitHub release, and `scripts/versioning-smoke.js` asserts the naming
contract). All older notes are archived under `releases/` in this directory.

## Generated Release Data

`release.json` is the source of public version, build, and channel identity.
`website/config.js`, `website/release-notes.json`, update manifests, generated
`release-build.json`, artifact names, and checksums must be derived from that
identity and validated for the exact candidate. Generated files do not prove
that an artifact was built, signed, installed, or exercised on a real machine.
