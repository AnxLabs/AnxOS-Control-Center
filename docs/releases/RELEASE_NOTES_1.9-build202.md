# Release Notes — AnxOS Control Center v1.9 build 202

**Channel:** Private Alpha
**Status:** Release candidate — UX/quality follow-ups recoated from the held batch

Build 202 completes the UX/quality half of the original bug batch whose
crash-only half shipped in Build 201. It rides on top of the published
Build 201 stable.

## Added

- A truthful Agent health `mode` derived from the configured API permissions
  (`read-write` / `read-only` / `no-access`) replaces the hard-coded
  "read-only" label that misreported write-enabled agents.
- A regression smoke locks the health-mode computation against permission
  shapes (`*`, wildcards, read-only, empty).
- A regression smoke for the node-switch reset contract (generation-keyed,
  unconditional cleanup).

## Fixed

- The node selector no longer sticks on "Switching node…" when a switch never
  completes: the in-progress flag now resets in an unconditional
  finally-style guard keyed by a switch generation.
- The optional AnxOS cloud device-login no longer hard-fails on machines with
  no default browser: the pending login is kept, `manualOpenRequired` is
  surfaced, and a manual open/copy-link fallback path is shown. Local control
  is unaffected.
- The versioning smoke's RC-retry provenance scenario is advanced together
  with each build bump so release metadata checks track the current build.

## QA

- Full source validation (187 suites) passes before this build is eligible
  for release-candidate work.
- Reused the disposable-sandbox in-place upgrade acceptance pattern proven in
  the Build 201 cycle.
