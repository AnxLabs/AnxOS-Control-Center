# V1 Action Audit Trail — Decision Record

**Milestone:** V1-B item 4 (docs/MASTER_ROADMAP.md Section 5)
**Decided:** 2026-09-04
**Status:** Decision recorded — durable structured audit deferred to V2; existing
operation records + structured logs designated as the V1 evidence path.

## Decision

V1 ships **without a dedicated queryable action-audit-trail UI**. The audit evidence
path for V1 is the combination of:

1. **Operation records** (`docs/OPERATION_FRAMEWORK.md`): every long-running operation
   (instance start/stop/reload, marketplace installs, SteamCMD updates) is created with
   an id, kind, nodeId, status and timestamps, written to `operations.log`, and surfaced
   in the Operations page. Live evidence 2026-09-04: `operations.log` contains dated
   `Long operation created` records for the build-198 SteamCMD update session on node
   `agent-device-b4c3…50a7e5`.
2. **Structured main-process logs** (`logs/live.log`, `latest-error.json`): every IPC
   request is logged with correlationId, operation name, duration, and error codes.
3. **Security-confirmation dialogs**: destructive actions (stop/restart/delete/reload)
   require an explicit user confirmation before running, so the log record of the action
   implies a deliberate user decision.
4. **Redaction**: all of the above pass through `src/shared/redaction.js`; no secrets,
   tokens, or credentials are written to logs (`redaction:smoke`).

## Rationale for deferring a dedicated audit store

- V1's single-owner, single-node threat model makes the operation-record + IPC-log path
  sufficient to answer "what happened, when, to what, with what result" — the question
  the V1-B checklist actually asks ("basic action audit records").
- A durable, tamper-evident, queryable audit log is an architectural surface (storage,
  retention, export, tamper resistance) that belongs with V2-I (security maturity) where
  roles and revocation land, rather than being bolted on at the end of V1.
- Building a partial audit UI now would create a false sense of audit-grade assurance in
  a Private Alpha channel, contradicting the honesty-over-convenience principle.

## What would change this decision (V2 trigger conditions)

- Introduction of non-owner roles (V2-A): audit becomes mandatory for privilege changes.
- Fleet/multi-node orchestration (V2-G): cross-node action attribution needs a unified
  audit sink.
- Any compliance/publish requirement for tamper-evident action history.

Until then, this record closes V1-B item 4 as a **documented decision with rationale**,
and `docs/V1_ACCEPTANCE_RECORD.md` item 4's "no queryable action audit trail" gap is
closed as "decision recorded, deferred with rationale".

## Cross-references

- `docs/OPERATION_FRAMEWORK.md` — operation record contract.
- `docs/SECURITY_BOUNDARIES.md` — IPC authorization and fail-closed sessions.
- `docs/OPERATION_FRAMEWORK.md` + Operations page — where the records are visible.
