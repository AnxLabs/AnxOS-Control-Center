# V2 Wave-1 Implementation Record

**Date:** 2026-09-16
**Milestone:** V2-A close-out + first V2-C / V2-D slices
**Status:** Implemented and pushed to `origin/dev` (HEAD `7d47aa8`)

## Approved scope

The six Wave-1 design briefs in this directory were owner-approved on
2026-09-16 ("approved on every single one"). This record captures what was
implemented, the evidence, and what remains.

## Commits (all pushed)

| Commit | Change | Validation |
| --- | --- | --- |
| `a41eaaf` | `.gitignore`: ignore `config/device-identity.json` + `config/enrollment.json` | `git check-ignore` PASS |
| `49c33f5` | `agent/src/routes/jobs.js` stale "dormant" comment corrected; `scripts/instance-job-lifecycle-smoke.js` pins `DESTRUCTIVE_JOB_TYPES` exactly | `node --check`; job-lifecycle smoke PASS |
| `b28b038` | Six Wave-1 briefs: `V2A_WAVE1_REVIEW`, `V2A_SUPPORT_MATRIX`, `V2A_BROWSER_SURFACE`, `V2B_DASHBOARD_APPS`, `V2C_CONTAINERS`, `V2D_MARKETPLACE_RUNTIMES` | review approved |
| `7c6e0e5` | V2-C engine detection: exported `parseDockerVersion`/`parseComposeVersion`/`classifyDockerFailure`; `scripts/docker-capabilities-smoke.js` pins route manifest, capability report, prerequisite diagnostics, per-platform resolver | `docker:capabilities:smoke` PASS |
| `35f0b48` | V2-C container lifecycle on the durable job store: `agent/src/services/dockerJobService.js` (docker.\* jobs; destructive ops refuse idempotency keys), six routes wired, `sanitizeTarget` gains `containerId/imageId/volumeId/networkId/projectName`, `scripts/docker-job-lifecycle-smoke.js` | docker-job + instance-job smokes PASS |
| `7d47aa8` | V2-D package metadata v2: opt-in `packageVersion`/`checksum`/`provenance` validation in `marketplaceInstallerRegistry.js`, loader defaults in `marketplaceService.js`, `scripts/marketplace-template-metadata-smoke.js` | metadata + certification (33 templates) + marketplace smokes PASS |

## Tree-level evidence

- `rc:validate` **193/193 PASS** (run on Windows, Node 24, with the
  `npm_execpath` workaround) after all six commits.
- `git diff --check` clean at each commit.
- Working tree clean at `7d47aa8`; `git rev-list --count origin/dev..HEAD` = 0.

## Owner-approved decisions recorded in briefs (2026-09-16)

- V2-A: adopt all six resolution sentences (a-f) — (a) job store stays
  per-instance `<instanceRoot>/jobs`; (b) recovery owner-first both sides;
  (c) short-TTL single-use nonce (already enforced → `ENROLL_NONCE_REUSED`);
  (d) owner-only revoke / admin rotate with confirmation; (e) legacy binding
  migration scoped to explicit enrollment; (f) curated idempotency set, no
  destructive replay — plus the nonce single-use + destructive-set smokes.
- V2-A support matrix accepted; Linux V2-A acceptance target = Debian 12 x64
  (recommended), live acceptance outstanding.
- V2-B: existing template/preset catalog for Wave 1; adopt-first for existing
  resources; agent `metricsUpdated` staleness policy; app detail page ships
  with the dashboard slice.
- V2-C: Docker CLI (no `dockerode`); router-based local vs agent ownership;
  Compose v2 first; privileged containers / host mounts / socket access
  denied by default.
- V2-D: evolve the existing template schema (backward compatible); record
  provenance + checksum with trust warnings for unverified items; enforce
  per-workload runtime isolation; install transactions ride the V2-A job
  lifecycle.
- Browser surface: Option A (agent-served, 47131), short-lived sessions,
  full role set, loopback-only, reuse enroll + owner unlock.

## Remaining (staged)

- V2-B renderer slice (dashboard widget grid, ownership/adopt, staleness).
- Browser surface Option A implementation.
- V2-C follow-on: compose/images/volumes/networks routes onto the job store;
  volume-protection preflight UI.
- Release-readiness chain: changelog → version bump → RC → sandbox acceptance
  → `confirmed` / `🚀 publish` gates.

## Open risks

- Mimosa full re-audit still owed (both prior runs `scanner_enobufs`).
- `dc6cd56` promote-release fix (actions:write + split make_latest) not yet
  exercised by a real promote run.
- Live-engine acceptance (Docker containers, real instance ops) not run in a
  sandbox for these slices; contract coverage is via smokes.
- Generated local `config/device-identity.json` / `config/enrollment.json`
  remain on disk (now gitignored).