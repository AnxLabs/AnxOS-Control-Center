# AIM-1 Implementation Record — Infrastructure Discovery and Inventory

| Field | Value |
| --- | --- |
| Date | 2026-10-14 |
| Branch | `aim/aim-1-inventory` (isolated worktree), based on `origin/dev` `afb66a17bfb092126da88d70c73a013b42a61f0e` |
| Plan | Revision 3.1 (frozen, unchanged) + revision 3.2 addendum (`V2_AUTONOMOUS_INFRASTRUCTURE_PLAN_R3_2_ADDENDUM.md`) |
| Scope | Read-only discovery and inventory. No repair, automation, service control, deployment or production change. |
| Behaviour reference | `docs/INFRASTRUCTURE_INVENTORY.md` |

## Delivered

- Pure inventory model with §5.7 identity tuples, ownership, health, protection
  (unclassified ⇒ production), deduplication, merge, staleness and bounds.
- Desktop inventory service over existing read-only Agent routes, with a GET-only
  route allow-list, bounded fan-out and inspects, single-flight refresh,
  per-section failure reporting, stale retention, identity-mismatch refusal,
  atomic versioned persistence, corrupt-store quarantine, newer-schema refusal
  and restart recovery.
- Systemd service-managed instances (Build 206) inventoried with a stable
  host + instance id + unit identity; `externalMainPid` is informational only.
- IPC (`infrastructureInventory:get` / `:refresh`, `nodes:read`, unlocked Local
  Owner), preload bridge, permission-matrix family and probe.
- Nodes page **Infrastructure Inventory** panel: summary, per-node status with
  unread sections, filterable resource table with health, ownership, identity,
  protection and staleness.

## Validation evidence (executed on Windows 11, Node 24.18.0)

| Check | Result |
| --- | --- |
| `node --check` on every changed or new JavaScript file (12 files) | Pass |
| `git diff --check` (including new files) | Clean |
| `node scripts/infra-inventory-smoke.js` | Pass — 18 tests |
| `node scripts/infra-inventory-agent-smoke.js` (real Agent, fake systemd) | Pass — zero systemd control calls, zero spawned processes, instance record SHA unchanged |
| `node scripts/infra-inventory-ui-qa.js` (real Electron, real Agent) | Pass — panel, discovery, filters, stale rendering, no renderer errors |
| Mutation check of 8 guards (GET-only, allow-list, identity mismatch, registered device, production default, stale carry, full container ID, newer-schema refusal) | 8/8 killed; unmutated control passes |
| `node scripts/permission-matrix-smoke.js` | Pass — 60 desktop families (312 channels), 37 Agent REST families (baseline 59 / 310) |
| `release-validation.js --tier=fast` | Pass — 5 checks |
| `release-validation.js --tier=feature` (with `ANXHUB_ENV_PATH` isolated, see below) | Pass — 40 checks (baseline 38 + 2 inventory smokes) |
| Build 206: runtime, instance, port-ownership, agent-routing, operations, operations-agent smokes | Pass (inside the feature tier) |
| Build 206: `service-managed-ui-qa.js` S1–S4 with AIM-1 changes present | Pass |
| Frozen revision 3.1 plan byte-identical to `afb66a1` | Confirmed |

### Live read-only verification against the Owner's registered Agents

Token-free run (no credential files read or copied; health is public), using a
copy of the node registry and only allow-listed GETs — 11 requests, all `GET`:

| Node | Result |
| --- | --- |
| `Anxlab` (`192.168.1.134:47131`) | Host identity **verified** against the registered device; authenticated sections `AUTH_FAILED` as expected without a token; reports **no** `serviceManagedInstances` capability (not a Build 206 Agent) |
| `127.0.0.1:47132` | `NODE_UNREACHABLE` |
| Installed local Agent `127.0.0.1:47131` (`DESKTOP-TJ50GSE`) | Host identity verified; `serviceManagedInstances.supported: false` (Windows) |

An authenticated live run was not performed: node credentials are encrypted with
Electron `safeStorage` bound to the Owner's profile, and decrypting them outside
the app was deliberately not attempted. The authenticated path is proven against
the real Agent fixture instead.

### Pre-existing test-isolation defect (not caused by AIM-1)

On a fresh checkout the `feature` tier fails at `agent-cli-pairing-smoke.js`
because `ampService` copies `.env.example` to the repo-root `.env` and the
placeholder `AGENT_TOKEN` then reaches the spawned Agent. Reproduced on pristine
`origin/dev` `afb66a1` (30 pass, 1 fail at the same check; passes without `.env`).
AIM-1 validation therefore ran with `ANXHUB_ENV_PATH` pointed at a temporary
file. Generated template copies were moved out of the worktree, never deleted;
they are byte-identical to `.env.example` and contain no real secrets. A separate
fix task was proposed.

## Defects found and fixed during implementation

- **Section failure looked like deletion.** A refresh that reached the host but
  failed a section (401, 403, Docker absent) replaced that node's resources and
  dropped the unread ones. Fixed: unread kinds are carried forward as stale with
  the section's code; covered by a hermetic test and the real-Agent smoke.
- **Transport codes leaked into node status** (`ECONNREFUSED`,
  `AGENT_UNAVAILABLE`). Normalized to `NODE_UNREACHABLE` with the transport code
  kept as `cause`.
- **Allow-list judgment on unsupported hosts.** A Windows host reports
  `allowedUnits: []`; the UI showed "not allowlisted". Now `null` (not
  applicable) unless the host supports service-managed instances.
- **Misleading status label.** "Partially stale" was shown when nothing was
  stale but a node was skipped; now "Incomplete".

## Remaining limitations

See `docs/INFRASTRUCTURE_INVENTORY.md` → Known limitations: GPU not reported;
listener owners and Docker networks unverified; Owner classification (AIM-0) not
implemented; the registered Debian Agent is not yet a Build 206 Agent.

## Next milestone

**AIM-2 — functional contracts and dual health**, gated on AIM-0 contract
sign-off and gate P4 (V2-J). AIM-0 remains open (addendum A8).
