# Release Notes — AnxOS Control Center v1.9 build 201

**Channel:** Private Alpha
**Status:** Release candidate — crash-only bugfix batch

Build 201 ships the crash-only bugfix batch on top of the Build 200 V2
reliability baseline. Scope was intentionally trimmed to stability fixes;
the UX/quality follow-ups (browserless device-login fallback, truthful agent
health mode label, node-switch reset) are queued for a later build.

## Added

- An EPIPE-safe console facade centralizes best-effort logging so a closed
  or broken pipe cannot destabilize the app.
- Unreadable or corrupt instance configs now surface as an explicit
  `Unavailable` instance instead of being silently dropped (honest-state
  contract).
- An actionable `AGENT_AUTH_FAILED` error with Repair / Rotate Token / Pair
  guidance is raised when the Agent rejects the request token.

## Fixed

- Uncaught `EPIPE` from best-effort console writes can no longer crash the
  app when the write target's pipe is closed (IPC handlers now route logging
  through an EPIPE-safe console facade).
- An unreadable or corrupt instance config is now surfaced as an explicit
  `Unavailable` instance instead of being silently dropped, restoring the
  honest-state contract.
- The Agent instance-root fallback is now Windows-aware (`%LOCALAPPDATA%
  \anxos\instances`) and emits a loud diagnostic instead of silently pointing
  at a stray `/srv/...` path on Windows.
- A rejected Agent token on `/api/v1/stats` now returns an actionable
  `AGENT_AUTH_FAILED` error pointing to Agent Control (Repair / Rotate Token /
  Pair) instead of a bare unexplained `UNAUTHORIZED`.

## QA

- Regression smokes cover the EPIPE guard, the unavailable-config surface,
  and the health/instance behavior that changed.
- Two non-`EOL`-normalizing smokes were hardened and the dependency IPC
  diagnostics stub updated so the full source validation suite passes.
- Full source validation must pass before Build 201 is eligible for commit or
  release-candidate work.