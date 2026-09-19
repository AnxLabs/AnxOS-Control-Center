# V2-J — Recovery Targets (RTO / RPO)

**Status of every number in this document: TARGET, NOT VERIFIED BY A DRILL, unless
the row explicitly says otherwise.** No timed recovery drill has been run for any
recovery class in this build. Nothing here is an observed result and nothing here
may be reported as one.

This is the V2-J deliverable "publish operator recovery procedures,
recovery-time/data-loss targets and drill results"
(`docs/MASTER_ROADMAP.md:305`). The procedures already exist and are authoritative;
this document adds the missing targets and states, per target, what evidence exists.

- Procedural source of truth: `docs/RECOVERY_MODEL.md`.
- Operator procedures: `docs/OPERATOR_NOTES_V2.md` (§4 backups, §8 Agent
  self-update, §9 workload transfer, §12 re-pairing, §13 Host/origin rules).
- The V2-J acceptance gate is **NOT VERIFIED**: the induced-failure drill is
  queued (`docs/MASTER_ROADMAP.md:296,307`).
- `docs/B0_BASELINE.md` contains **no numeric RTO/RPO basis** — it records
  capability coverage, not targets. The numbers below are therefore **proposed**
  and require owner ratification; they are not inherited from an approved baseline.

## Terminology

| Term | Meaning here |
| --- | --- |
| **RPO** | Maximum acceptable data loss, expressed as the age of the newest acceptable recovery point at the moment of failure. |
| **RTO** | Maximum acceptable time from "operator decides to recover" to "service is usable again", on the affected node, with the documented procedure. |
| **TARGET** | Proposed number. No drill has measured it. |
| **VERIFIED (mechanism)** | A hermetic smoke proves the code path behaves as described. It is **not** a timing or end-to-end result. |
| **VERIFIED (drill)** | A documented drill produced an observed result. Named explicitly where it exists. |

## Targets and current status

| Recovery class | RPO target | RTO target | Recovery source and procedure | Current status |
| --- | --- | --- | --- | --- |
| **Instance configuration** (`instances/<id>/config.json`, schema 2) | 0 for the file itself — every write is an atomic rewrite; the previous record is preserved once as `config.json.schema-v1.backup` on migration (`docs/V2_RELIABILITY_CONTRACT.md:20-29`) | ≤ 15 min for a single instance on the same node (restore from a backup, or re-create the instance from its known settings) | Restore from a backup (`docs/RECOVERY_MODEL.md:81-88`); legacy/future schemas fail closed rather than being rewritten (`docs/V2_RELIABILITY_CONTRACT.md:28-29`) | **TARGET (UNVERIFIED).** Mechanism: `VERIFIED (mechanism)` by `instances:config-migration:smoke`, `backups:metadata-migration:smoke`, `instances:runtime:smoke`. No timed drill. |
| **World data** (instance data roots) | Equal to the newest recovery point: default retention is `keepLast: 10`, `maxAgeDays: 30`, and the newest recovery point of an instance is never pruned even when the policy says it should go (`docs/OPERATOR_NOTES_V2.md:123-130`) | ≤ 30 min for a single world on the same node (restore a world backup, verify, restart) | Backup/restore with a safety snapshot before mutation; a partial restore failure rolls back (`docs/RECOVERY_MODEL.md:81-88`) | **TARGET (UNVERIFIED).** Mechanism: `VERIFIED (mechanism)` by `backups:consistency:smoke`, `backups:integrity:smoke`, `restore:targeting:smoke`, `alpha:loop:backup:smoke`. No restore drill on a real host has been performed. |
| **Backups** (archives, metadata, schedules, destinations) | The backup set itself is not a recovery point; losing it costs the RPO above. Schedules default to per-instance intervals the operator chooses (`docs/OPERATOR_NOTES_V2.md:96-141`) | ≤ 30 min to restore the ability to create backups (repair metadata/schedule store, or point at another destination) | Interrupted archives without committed metadata are removed at startup while matching archives are preserved; metadata and schedule stores are quarantined/migrated rather than lost (`docs/RECOVERY_MODEL.md:59-69`) | **TARGET (UNVERIFIED).** Mechanism: `VERIFIED (mechanism)` by `backups:interrupted-recovery:smoke`, `backups:metadata-migration:smoke`, `backup:destinations:smoke`. No live remote-destination push/restore drill. |
| **Node credentials / enrollment** | 0 for the stored record — loss requires re-establishing the credential, not replaying data | ≤ 60 min remote when Control Center still holds the credential (it now presents it automatically, `docs/OPERATOR_NOTES_V2.md:426-428`); **on-host action, no RTO guarantee**, when the credential is genuinely lost (`docs/OPERATOR_NOTES_V2.md:429-435`) | Present the existing credential; or on the Agent machine run `npm run agent:pair` / use Control Center there; or revoke the enrollment (`enroll/revoke`, owner-authenticated) and pair again (`docs/OPERATOR_NOTES_V2.md:429-435`) | **TARGET (UNVERIFIED).** Mechanism: `VERIFIED (mechanism)` by `agent:pairing-credential-gate:smoke`, `node:credential-repair:smoke`, `node:credential-recovery:smoke`, `agent:enroll:smoke`. No drill on a second real machine. |
| **Audit records** (`config/audit.log`) | 0 for recorded evidence: the store is append-only and this build never rewrites it (`src/services/securityService.js:639-651,1178-1201`) | Not time-bounded — audit evidence is not a service-availability input; the target is **never to lose or silently alter a record** | There is no automatic backup of the audit log. Recovery is: read the file directly; use the retention report / access review / export (`src/services/securityService.js:1178-1217`) | **TARGET (UNVERIFIED).** Mechanism: `VERIFIED (mechanism)` by `scripts/audit-retention-smoke.js` (protected classes are never pruned; an unsatisfiable cap is refused; export is redacted and deterministic) plus `security:backup:smoke`. **No audit backup, restore or rotation drill exists, and no backup path for the audit log is implemented.** |

## Reconciliation of the targets with the roadmap

- RTO/RPO are stated per class, not per product. A product-level "we recover in
  N minutes" claim would be unsupported by any evidence in this repository.
- The two targets that are **not** time-bounded (audit evidence) are stated as
  integrity targets on purpose. Inventing a minute figure there would be
  fabrication.
- Nothing in this table has been validated against a real failure. The V2-J
  acceptance gate says exactly that (`docs/MASTER_ROADMAP.md:307`).

## Drills that HAVE produced results

These are the only observed recovery results in-repo. None of them measures RTO
or RPO.

1. **In-place desktop upgrade, disposable Windows Sandbox (Build 199 → RC4).**
   Application data exercised by the harness and close/reopen state were
   preserved; the downloaded installer SHA-256 matched the recorded RC4 checksum
   (`docs/BUILD200_RC4_ACCEPTANCE_RECORD.md:14-17`).
2. **Packaged schema-v1 → schema-v2 instance migration, RC4 Agent.** Executed in
   the disposable sandbox at `2026-09-16T04:38:43.3835871Z` and passed: the
   fixture was returned on two authenticated Agent REST reads, the record
   migrated to schema 2, `installationState` was added, the display name was
   preserved, and exactly one byte-stable schema-v1 backup survived the second
   read (`docs/BUILD200_RC4_ACCEPTANCE_RECORD.md:70-80`). This is a **migration
   + data-preservation** result, not a recovery-time result.
3. **Hermetic recovery smokes** (mechanism, not timing):
   `backups:interrupted-recovery:smoke`, `backups:metadata-migration:smoke`,
   `backups:integrity:smoke`, `backups:consistency:smoke`,
   `restore:targeting:smoke`, `workload:transfer:smoke`,
   `multi-node:fleet:smoke` (interrupt / isolation / revocation /
   `JOB_INTERRUPTED` recovery legs), `instances:runtime:smoke`,
   `agent:self-update:smoke`, `security:backup:smoke`,
   `scripts/audit-retention-smoke.js`.

## Drills that have NOT run

Listed so that no reader mistakes a smoke for a drill.

1. **Induced service-failure drill** (the V2-J acceptance gate: raise one useful
   alert, then resolve it correctly). Queued, not run
   (`docs/MASTER_ROADMAP.md:296,307`).
2. **Live restore drill on a real host from a real backup**, including the
   roadmap rule that a backup is not accepted until a restore is performed
   (`docs/B0_BASELINE.md:33`).
3. **Scheduled-backup → age-out → restore drill** (automatic schedule runs,
   retention prunes, then the surviving point is restored). Hermetic coverage
   only.
4. **Remote backup destination (SFTP) live push and restore drill.** Hermetic
   only (`backup:destinations:smoke`).
5. **Node credential-loss recovery drill on a second machine** (on-host
   `npm run agent:pair`, and the revoke-then-pair path).
6. **Fleet drill transfer and per-OS legs.** The harness has the transfer leg
   implementable but not appended (`docs/v2/V2_CAMPAIGN_QUEUES.md:90`); the
   running fleet drill covers interrupt/isolation/revocation only.
7. **Linux Agent self-update with a genuine version delta.** The ordered swap is
   covered hermetically, but the full path has not been exercised live and the
   result markers have not been observed on a real host
   (`docs/RECOVERY_MODEL.md:122-142`).
8. **Interrupted desktop update recovery on a real machine** (kill the updater
   mid-download / mid-handoff and confirm `handoff-unconfirmed` guidance).
   Hermetic only (`updates:download-safety:smoke`).
9. **Schema-2 → older-build downgrade drill.** The downgrade behaviour is
   documented (`docs/OPERATOR_NOTES_V2.md` §14) and the data-preservation claim
   is reasoned from code; no live downgrade was performed.
10. **Audit corruption / rotation drill.** No drill exists; the retention model
    is decision-only and there is no automatic enforcement to drill against.
11. **Operator walkthrough drill** for the responsive/browser workflows
    (V2-B bullet 6 deferral, `docs/MASTER_ROADMAP.md:158`).
12. **Timed RTO measurement of any kind**, for any class in this document.

## Documentation conflict to resolve (not fixed here)

`docs/RECOVERY_MODEL.md:155-160` records the declined transfer-preview cleanup
as a known exception that can delete a pre-existing target instance. The campaign
record says that defect was fixed and smoke-pinned
(`docs/v2/V2_CAMPAIGN_QUEUES.md:83`) and the current transfer service gates the
cleanup on the placeholder it created (`src/services/workloadTransferService.js:327,343,374-375`).
One of the two is stale. `docs/RECOVERY_MODEL.md` is **not** owned by this lane,
so it is flagged rather than edited. Until it is reconciled, the recovery-time
target for **world data** carries this as a residual risk: a declined transfer
preview against a target whose instance id already exists must not be run
(`docs/RECOVERY_MODEL.md:157-160`).