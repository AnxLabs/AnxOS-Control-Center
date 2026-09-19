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

## Downgrade: what a rollback does to schema-versioned data

**Every statement in this section is code-grounded. No downgrade has been
executed — not on a real host, not in a sandbox, not hermetically.** There is no
downgrade drill result anywhere in this repository, and nothing below may be
reported as one. What was done is: read each store's schema constant and refusal
path, and make the update manifest state the difference between an application
rollback and a data-schema rollback. The hermetic smoke
`scripts/update-rollback-signalling-smoke.js` proves the signalling, not the
downgrade.

### The distinction the manifest used to hide

An **application rollback** replaces the installed binaries with an older build.
A **data-schema rollback** would rewrite the stored records back to an older
schema. AnxOS does not do the second one: every store below refuses a record
whose schema is newer than the build's own and leaves the file exactly as the
newer build wrote it. So after a downgrade the data is preserved on disk and the
older build cannot read it. The old manifest `rollback` block
(`preservesUserData` / `preservesInstances` / `preservesBackups: true`) was
literally true and read as "a rollback is safe", which is where the dishonesty
was.

### Per-store downgrade behaviour

"Read behaviour in an older build" is the refusal the older build raises when it
meets a newer schema. "Outcome" is `readable` (no schema change to meet),
`preserved + refused` (data intact, store unusable in that build), or `unknown`.
No store in this table rewrites a newer-schema record on read, so **no store here
is at risk of data loss from the refusal path itself**.

| Store | Schema constant (`file:line`) | Ver | Refusal in an older build (`file:line`) | Outcome | Oldest build that reads it |
| --- | --- | --- | --- | --- | --- |
| Instance configuration | `src/shared/instances/instanceServiceCore.js:76` | 2 | `INSTANCE_CONFIG_SCHEMA_UNSUPPORTED` (409) at `instanceServiceCore.js:3486` | preserved + refused | Build 200 |
| Node registry (`nodes.json`) | `src/services/nodeService.js:22` | 3 | `NODE_SCHEMA_UNSUPPORTED` at `nodeService.js:990` | preserved + refused | Build 150 |
| Node credential store | `src/services/nodeCredentialStore.js:6` | 2 | `NODE_CREDENTIAL_SCHEMA_UNSUPPORTED` at `nodeCredentialStore.js:66` | preserved + refused | Build 150 |
| Update store (`updates.json`) | `src/services/updateManager.js:29` | 2 | `UPDATE_STORE_SCHEMA_UNSUPPORTED` at `updateManager.js:546`; `saveStore()` then refuses to write | preserved + refused | Build 150 |
| Marketplace provider config | `src/services/providerConfigService.js:5` | 2 | `MARKETPLACE_CONFIG_SCHEMA_UNSUPPORTED` at `providerConfigService.js:132` | preserved + refused | Build 150 |
| Encrypted session state | `src/services/secureSessionStore.js:7` | 1 | `SECURE_SESSION_SCHEMA_UNSUPPORTED` at `secureSessionStore.js:109` | readable | any build that knows the store |
| Agent runtime config | `src/shared/agentRuntimeConfigStore.js:4` | 1 | `AGENT_RUNTIME_CONFIG_FUTURE_VERSION` at `agentRuntimeConfigStore.js:30` | readable | any build that knows the store |
| Agent backup metadata | `agent/src/services/backupService.js:23` | 1 | `BACKUP_METADATA_SCHEMA_UNSUPPORTED` (409) at `backupService.js:676` | readable | any build that knows the store |
| Agent backup schedules | `agent/src/services/backupService.js:24` | 1 | `BACKUP_SCHEDULE_SCHEMA_UNSUPPORTED` (409) at `backupService.js:598` | readable | any build that knows the store |
| Agent backup destinations | `agent/src/services/backupDestinationService.js:49` | 1 | `BACKUP_DESTINATION_SCHEMA_UNSUPPORTED` (409) at `backupDestinationService.js:248` | readable | any build that knows the store |
| Agent device identity | `agent/src/services/deviceIdentityService.js:11` | 2 | `DEVICE_IDENTITY_SCHEMA_UNSUPPORTED` at `deviceIdentityService.js:72` | preserved + refused | Build 202 |
| 17 further schema-versioned stores (all schema 1) | listed in the manifest at `rollback.dataSchemaRollback.coverage.unenumeratedConstants` | 1 | not read individually by this lane | readable by the baseline rule; refusal path **UNPROVEN** | any build that knows the store |

Reading the table: a downgrade to Build 199 degrades **instance configuration**
(Build 200) on the desktop and **device identity** (Build 202) on the agent. The
node registry, node credentials, update store and marketplace config are already
readable by Build 199 because those schemas date from Build 150.

**UNPROVEN in this table.** (a) No downgrade was performed, so "preserved +
refused" is read from the refusal code, not observed. (b) The 17 unenumerated
stores are at schema 1, so no older build meets a newer schema in them — but
their refusal paths were not read and are not claimed. (c) The `file:line`
citations are pointers that a refactor can move; the manifest re-reads the
schema *versions* from the code on every generation and the smoke asserts each
citation still lands on the declaration it names, but a citation is not evidence
on its own.

### Where the numbers come from

- **Schema versions: read from the code**, not hardcoded.
  `scripts/write-update-manifest.js` locates `const <NAME>_SCHEMA_VERSION = <n>;`
  in each store's source at generation time and cites the `file:line`
  (`readSchemaConstant`, `scanSchemaConstants`). A store whose constant cannot be
  read reports `schemaVersion: null` and `UNKNOWN`.
- **"Oldest build that reads it": hardcoded, with a drift guard.** There is no
  declaration in the code that links a schema version to the build that
  introduced it, so these are declared in `SCHEMA_STORES`
  (`scripts/write-update-manifest.js:126`) from schema history — the bump commit
  and the `release.json` build committed with it (instance schema 2 at commit
  `65b5ad2`, build 200; node registry schema 3 / node credentials schema 2 /
  update store schema 2 / marketplace config schema 2 at build 150; agent device
  identity schema 2 at commit `e4a12f2`, build 202). Each declaration is pinned
  to `declaredForSchemaVersion`; if the code reports a different version the
  minimum build is discarded and the store reports `UNKNOWN`
  (`minimumBuildSource: "stale-declaration ..."`), so the list cannot drift
  silently.
- **A `DEGRADED` verdict additionally requires the refusal literal to exist in
  the cited source** (`refusalCodeVerifiedInSource`). If it is missing, the store
  reports `UNKNOWN` and claims nothing about preservation.
- **`UNKNOWN` is the default.** With no candidate downgrade build named, every
  bumped store is `UNKNOWN`; an unreadable source, an unenumerated bumped store,
  a stale declaration, or an unverified refusal path all produce `UNKNOWN`.
  Nothing falls back to `SAFE`.

### The manifest contract

`npm run updates:manifest` now emits, alongside the unchanged preservation
flags, a `rollback.applicationRollback` block and a
`rollback.dataSchemaRollback` block. Actual shape (abridged, Build 203 manifest
generated with `ANXOS_ROLLBACK_CANDIDATE_BUILD=199`):

```json
"rollback": {
  "preservesUserData": true,
  "preservesInstances": true,
  "preservesBackups": true,
  "rollbackMetadataRequired": true,
  "preservationIsNotReadability": true,
  "preservationScope": "These three flags describe data preservation during a binary downgrade. They do not assert that the downgraded build can read the preserved records; see dataSchemaRollback.",
  "applicationRollback": {
    "inAppDowngradeSupported": false,
    "capabilityNote": "AnxOS does not implement an in-app downgrade. An older build is installed by the operator (or by the OS installer), and the application cannot make that operation schema-safe.",
    "description": "Replacing the installed binaries with an older build. User data, instances and backups are not deleted.",
    "dataSchemaIsNotRolledBack": true
  },
  "dataSchemaRollback": {
    "direction": "forward-only",
    "candidateBuild": 199,
    "candidateBuildSource": "env:ANXOS_ROLLBACK_CANDIDATE_BUILD",
    "noDowngradeDrill": true,
    "stores": [
      {
        "id": "instance-config",
        "component": "desktop",
        "schemaVersion": 2,
        "schemaVersionSource": "src/shared/instances/instanceServiceCore.js:76 (INSTANCE_CONFIG_SCHEMA_VERSION)",
        "minimumBuild": 200,
        "minimumBuildSource": "declared-schema-history",
        "declaredForSchemaVersion": 2,
        "refusalCode": "INSTANCE_CONFIG_SCHEMA_UNSUPPORTED",
        "refusalSource": "src/shared/instances/instanceServiceCore.js:3486",
        "refusalCodeVerifiedInSource": true,
        "refusalPreservesData": true,
        "downgradeStatus": "DEGRADED",
        "downgradeStatusSource": "candidate build 199 < minimum build 200",
        "downgradeEffect": "preserved-not-readable"
      }
    ],
    "components": {
      "desktop": { "readAllStoresFloorBuild": 200, "floorComplete": true, "status": "DEGRADED", "storeCount": 7 },
      "agent": { "readAllStoresFloorBuild": 202, "floorComplete": true, "status": "DEGRADED", "storeCount": 5 }
    },
    "summary": {
      "status": "DEGRADED",
      "downgradeIsSafe": false,
      "counts": { "safe": 26, "degraded": 2, "unknown": 0 },
      "degradedStores": ["instance-config", "agent-device-identity"],
      "unknownStores": []
    },
    "coverage": { "enumerated": 11, "unenumerated": 17, "unenumeratedConstants": ["..."] }
  }
}
```

`readAllStoresFloorBuild` is the single number an operator needs: rolling back
below the **desktop** floor (200) degrades instance configuration, and below the
**agent** floor (202) degrades device identity. The desktop and the agent are
listed separately because a desktop downgrade does not downgrade the bundled
Agent runtime. `status` is the worst of the stores, so a `DEGRADED` store can
never be averaged away by `SAFE` ones.

### The updater's signalling change

`src/services/updateManager.js` now reads the contract and refuses to imply that
a downgrade is safe:

- `normalizeRollbackGuidance` (`updateManager.js:279`) reduces the manifest's
  block, and reports the **worse** of the declared summary status and the status
  of every store it lists — so a manifest claiming `SAFE` overall while listing a
  degraded store is corrected rather than trusted. A manifest carrying only the
  old preservation flags has `contractPresent: false` and status `UNKNOWN`.
- `evaluateRollbackGuidance` (`updateManager.js:320`) compares the **running**
  build against each store's minimum build. `rollbackIsSafe` is true only for an
  explicit contract whose every store is `SAFE` *and* a running build at or above
  every store minimum; every other path, including "nothing to compare", is
  false. `installedBuildVsDataSchema` is `older` / `not-older` / `unknown` (never
  a bare false for an unknown state).
- `resolveUpdateResult` (`updateManager.js:695`) attaches that evaluation to the
  update result and logs an explicit `Rollback caveat.` warning
  (`ROLLBACK_CONTRACT_MISSING` or `ROLLBACK_DEGRADED_OR_UNREADABLE`) when the
  contract is missing, the downgrade is degraded, or the installed build is older
  than the data schema.

**Limitation:** the renderer (`app.js`) is not owned by this lane and does not
render `rollbackGuidance` yet, so today the warning reaches the update status
payload and the update log, not the operator's screen. That is a follow-up, not
a claim.

### Follow-ups (not done here)

- Register `updates:rollback-signalling:smoke` →
  `node scripts/update-rollback-signalling-smoke.js` in `package.json`, which
  would also add it to the `rc:validate` suite set.
- `scripts/validate-release-artifacts.js` still validates only the preservation
  flags of its fixture manifest; it does not yet require the data-schema contract
  to be present and consistent in a real release manifest.
- Render `rollbackGuidance` in the update UI so the caveat is visible to an
  operator rather than only to the log.
- Run the downgrade drill (item 9 in "Drills that have NOT run") — the only way
  any row above becomes `VERIFIED (drill)`.