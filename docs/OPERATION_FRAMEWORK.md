# Shared Operation Framework

## Resource ownership invariant

A long-running operation changes the state of an existing resource; it does
not determine whether that resource exists in the UI. The renderer keeps
authoritative resource snapshots and transient operation records separate,
reconciles them by stable resource id, and retains the last authoritative
resource while an operation is active or a poll temporarily fails. Keyed DOM
nodes are updated in place so reloads, downloads, updates, and failures do not
destroy and recreate visual identity. Terminal and timestamp ordering also
prevents an older poll or duplicate event from regressing a newer completion.

The renderer lifecycle helper is `src/shared/resourceOperationLifecycle.js`.
It complements the persistent backend registry in
`src/shared/longOperationService.js`; it does not replace backend truth or
manufacture progress telemetry.

## Instance telemetry invariant

A running instance's monitoring lifecycle is owned by the instance, not by
whether the user has selected or opened it. Common CPU, memory, process, and
runtime telemetry therefore remains separate from both authoritative instance
data and temporary operation state:

```text
authoritative instance + transient operation + transient telemetry
                         all keyed by node scope and stable instance.id
```

`src/shared/instanceMetricsLifecycle.js` stores telemetry independently for
each instance. The Instances refresh path discovers every running instance and
feeds a bounded, deduplicated scheduler (at most three concurrent Agent
requests). Overview, selected-instance details, and Console consume the same
store; selecting an instance never starts another request loop. A first sample
is `loading`, a first failure is `unavailable`, and a refresh failure after a
valid sample is `stale` while retaining that sample.

Node changes clear the entire scoped telemetry store. Stopped, deleted, or
otherwise ineligible instances are removed from monitoring. Request IDs,
sample timestamps, and node request contexts prevent old completions from
overwriting newer samples or crossing node boundaries. Metrics are not placed
in `resourceOperationLifecycle.js`: monitoring and long-running commands have
different lifetimes even though both use the same stable resource identity.

This document describes the actual implementation of the shared long-running
operation framework as it exists in the codebase today. It is not an
aspirational design; every claim below is backed by working code and
regression coverage.

## Location and runtime compatibility

Canonical implementation: `src/shared/longOperationService.js`.

This module is required by both:

- The Electron desktop main process (via `src/services/*`).
- The standalone Agent runtime (`agent/src/services/*`), which never has the
  `electron` package available.

Because of this, structured logging is soft-loaded (`require("../services/diagnosticsService")`
wrapped in `try/catch`) and falls back to `console.info`/`console.warn` when
Electron is unavailable. This is verified by
`scripts/long-operation-framework-smoke.js`, which spawns a child process that
monkey-patches `Module._load` to throw for `"electron"` and confirms the
module still creates/completes operations correctly.

Packaging: `src/shared/**/*` is bundled as a glob for both the desktop
`app.asar` (`files` in `package.json`) and the Agent's `extraResources` copy
(`local-agent-runtime/src/shared`). `scripts/packaging-artifact-smoke.js`
asserts the specific files exist in a real packaged build and, when an
unpacked build is present, actually `require()`s the packaged Agent's
`dockerService.js` and `backupService.js` from their real packaged path depth
to prove the relative `../../../src/shared/...` requires resolve correctly —
not just that the files exist.

## Operation record shape

```
{
  id,               // string, auto-generated unless an explicit id is passed
  kind,              // e.g. "marketplace-download", "docker-image-pull", "backup-create"
  nodeId,            // string | null
  lockKey,           // string | null — used for duplicate-operation prevention
  status,            // "queued" | "running" | "paused" | "complete" | "failed" | "cancelled" | "interrupted"
  stage,             // human-readable current stage, or null
  message,           // human-readable current message, or null
  progress,          // number | null
  progressMode,      // "determinate" | "indeterminate"
  error,             // { code, message } | null
  canCancel,         // boolean — honest only if a cancel handler is registered
  canRetry,          // boolean
  retryable,         // boolean (used by failOperation to set canRetry)
  rollbackSupported, // boolean, defaults to false — see "Rollback honesty" below
  startedAt, updatedAt, completedAt,
  timeoutMs,         // number | null — auto-fails the operation if it runs this long
  parentId, childIds,
  logs,              // capped at the most recent 50 entries
  metadata,          // arbitrary caller-defined payload (redacted before persistence)
}
```

## API

- `createOperation(spec)` — generates an id, enforces `lockKey` duplicate
  prevention (throws `DUPLICATE_OPERATION` with the existing operation id if
  one is already active for the same lock key), persists immediately.
- `upsertOperation(id, patch)` — explicit id, used by compatibility shims
  (e.g. Marketplace's `downloads` Map-like object). No lock enforcement, since
  the id is caller-supplied.
- `updateOperation` / `completeOperation` / `failOperation` — mutate an
  existing operation. Terminal transitions (`complete`, `failed`, `cancelled`,
  `interrupted`) flush persistence immediately and clear any timeout.
- `cancelOperation(id)` — requires `canCancel === true`, awaits the registered
  cancel handler (`registerCancelHandler`), then marks the operation cancelled.
  A rejected handler leaves the record active and returns
  `OPERATION_CANCEL_FAILED`.
- `retryOperation(id)` — requires `canRetry === true` **and** a registered
  retry handler (`registerRetryHandler`). If `canRetry` is true but no
  handler was registered, this throws `OPERATION_RETRY_HANDLER_MISSING`
  rather than silently doing nothing — a `canRetry: true` claim can never be
  a hollow promise.
- `findActiveByLockKey(lockKey)` / `listOperations(filter)` / `getOperation(id)`
  / `deleteOperation(id)`.

## Persistence and crash recovery

State is written to `<configDir>/long-operations.json` (debounced ~300ms for
non-terminal updates, flushed immediately on terminal status changes, using
an atomic temp-file-then-rename write). On module load, any operation still
in an active status (`queued`/`running`/`paused`) is rewritten as
`interrupted` with error code `INTERRUPTED_BY_RESTART` — it is never silently
resumed or reported as still running. Verified by
`scripts/long-operation-framework-smoke.js` (creates an operation, forces a
flush, reloads the module fresh, asserts the recovered state).

Recovered records do not advertise cancellation or retry because executable
runtime handlers are not persisted. Recovery must create a new operation
attempt through an owning service using persisted, non-secret domain metadata.

## Secret redaction

Before anything is written to disk, `sanitizeForPersistence`:

1. Strips non-serializable values (functions, class instances like
   `AbortController`, circular references) entirely.
2. Redacts any object key matching `SENSITIVE_KEY` from
   `src/shared/redaction.js` (e.g. `token`, `password`, `apiKey`,
   `authorization`) to the literal string `"[redacted]"`.
3. Passes every string value through `redactString`, which strips bearer
   tokens, JWTs, credentials embedded in URLs, and large base64 blobs.

The **live in-memory** operation (returned by `getOperation`) is never
redacted — only the on-disk snapshot is. This is intentional: in-memory
metadata may need to retain real values (e.g. an `AbortController` for
cancellation), while the persisted copy must never leak secrets even if a
future caller accidentally stores one in `metadata`. Verified by a dedicated
test in `scripts/long-operation-framework-smoke.js`.

## Rollback honesty

`rollbackSupported` defaults to `false` on every operation and is never
inferred. Only operations with a tested owning-service rollback path pass
`rollbackSupported: true`:

- Provider Marketplace installs abort active network streams through the
  registered operation handler and delete the incomplete instance on failure
  or cancellation. Cleanup failures remain in redacted diagnostics, and retry
  starts a new locked execution attempt. Covered by
  `scripts/marketplace-provider-cancellation-smoke.js` and
  `scripts/marketplace-cleanup-reporting-smoke.js`.
- Backup restore creates a verified safety snapshot before mutation and, after
  a partial restore failure, replaces the partial state from that snapshot and
  verifies `config.json`. This rollback is implemented by the owning backup
  service rather than a generic framework callback, and is covered by
  `scripts/security-backup-smoke.js`.
- Docker image pulls and file transfers have no rollback concept (a failed
  pull/transfer simply leaves no new state to roll back).

If a future migration adds genuine framework-level rollback, it must pass
`rollbackSupported: true` explicitly and add regression coverage proving the
rollback actually restores prior state — this field must never be flipped to
`true` without that proof.

## Migrated systems and what is actually true for each

| System | Progress | Cancel | Retry (via framework) | Lock/dedupe | Rollback | Timeout |
|---|---|---|---|---|---|---|
| Marketplace downloads/dependency installs | Yes (bytes/stage) | Yes for real HTTP downloads and provider archive extraction (`AbortController` wired to the underlying stream); dependency installs are not cancellable (`canCancel: false`, matches reality) | Provider installs register a real new-attempt retry handler; template downloads use `retryDownload` to re-invoke `installTemplate` | Provider installs use `marketplace-provider:${nodeId}:${instanceId}`; template downloads retain id-based dedupe | Provider installs delete incomplete instances; standalone downloads have no rollback state | No |
| File transfers | Yes (bytes) | Yes — real stream destruction via `transferControllers` | No (canRetry never set true; caller re-initiates through the UI) | No lock key (one transfer id per transfer) | No | No |
| Backup create/restore | No (single-shot) | No (`canCancel: false`, matches reality — archive/extract are not interruptible) | **Yes** — `registerRetryHandler` re-invokes `createBackup(payload)` / `restoreBackup(payload)` with the original payload, producing a genuinely new operation id and a genuinely new archive/restore attempt | Yes — `backup:${instanceId}` prevents concurrent create/restore on the same instance | Restore only — verified safety snapshot and partial-restore rollback | Expected-duration marker only; because cancellation is unsupported, exceeding it retains the live lock until the task resolves or the process restarts |
| Docker image pull | No (single-shot) | No (`canCancel: false` — the underlying child process is not currently interruptible via the framework) | **Yes** — `registerRetryHandler` re-invokes `pullImage(target)` | Yes — `docker-pull:${image}` prevents duplicate concurrent pulls of the same image | No | The Docker process has its own 10-minute timeout; the 11-minute framework marker cannot release the lock unless underlying cancellation is confirmed |

## Deliberately not migrated

- **Public Access provisioning** (`src/shared/publicAccessServiceRegistry.js`):
  `createAccessService`/`updateAccessService` are fully synchronous
  read-modify-write functions with no `await` between the duplicate check and
  the write. Node's single-threaded execution model means two IPC-triggered
  calls cannot interleave at the JavaScript level, so there is no real race
  to guard against here. Adding framework locking would add complexity
  without closing any actual gap.
- **Auto-updater** (`src/services/updateManager.js`): already has its own
  `downloadInFlight`/`checkInFlight` boolean guards. Migrating it onto the
  shared framework was judged higher-risk (touching the mechanism that
  updates the shipped app) than the marginal benefit for this pass, given the
  existing guards already prevent duplicate concurrent update operations.

## Regression coverage

- `npm run operations:framework:smoke` — the framework itself: lifecycle,
  lock dedupe, cancel/retry handler wiring (including the
  `OPERATION_RETRY_HANDLER_MISSING` distinction), `rollbackSupported`
  honesty, cancellation-aware timeout handling, persistence + crash recovery, secret
  redaction, and Agent-runtime (no-Electron) compatibility.
- `npm run operations:domain-cancellation:smoke` — proves Marketplace
  cancellation aborts its real `AbortController` and file-transfer
  cancellation destroys the attached stream rather than only updating the
  registry record.
- `npm run docker:smoke` — Docker snapshot/lifecycle including the pull lock.
- `node scripts/security-backup-smoke.js` — backup lifecycle including: two
  concurrent `createBackup` calls for the same instance (exactly one
  succeeds), lock release after both success and failure, and a full
  fail-then-fix-then-retry sequence proving `retryOperation` produces a
  genuinely new, successful operation while leaving the original failed
  record untouched.
- `npm run files:smoke` / `npm run marketplace:smoke` /
  `npm run dependencies:smoke` — confirm the Marketplace and file-transfer
  migrations did not change existing external behavior.
- `node scripts/packaging-artifact-smoke.js --platform=linux` — confirms both
  new shared modules are present in a real packaged build and can actually be
  `require()`d from the packaged Agent's real directory depth.
