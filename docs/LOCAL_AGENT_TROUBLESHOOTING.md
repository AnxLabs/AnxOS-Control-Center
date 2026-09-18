# Local Agent Troubleshooting

Use Agent Control diagnostics before asking users to edit files or run terminal commands.

## Agent Missing

Show `Install Local Agent`, `Learn More`, and `Use Remote Agent Instead`. Explain that the Local Agent lets AnxOS manage servers, files, backups, dependencies, and services on this computer.

## Agent Offline

Try:

- Start service.
- Restart Agent.
- Repair service.
- Check port availability.
- Reconnect desktop.

If the service cannot start, show recent sanitized logs and plain-English recovery guidance.

## Authentication Required

Use `Repair Pairing`. Do not ask the user to copy tokens or edit JSON. If credentials are corrupted, rotate and re-pair locally.

## Version Mismatch

Show `Local Agent Update Available` when the packaged desktop is newer and a compatible update path exists. If the Agent is newer than the desktop, prevent update loops and explain that the desktop may need an update.

On Linux, an in-place runtime update requires the managed **systemd user unit**
(`anxos-agent.service`). If background startup is not installed, the update is
refused with `LINUX_AGENT_UNIT_NOT_INSTALLED`; install background startup from
Agent Control, then retry. On Windows the update stays desktop-driven through
the task lifecycle and never swaps the runtime in place.

The Linux update stages the new runtime next to the live one and lets a
short-lived `systemd-run --user` unit perform the swap after the Agent exits
(stop unit, move the old runtime to a backup path, rename the staged runtime
into place, restart the unit). On failure, guide the operator to:

- the update record at `<userData>/agent/updates/last-linux-update.json`, which
  names the backup path, the swap script, and the result marker;
- `journalctl --user -u anxos-agent-update` for a timed-out swap;
- the previous runtime backup at `<runtimeRoot>.backup-<stamp>`.

If the swap reported `failed-rollback-failed`, neither runtime is in place and
the backup at the reported path is the recovery source. The desktop also
best-effort restarts the Agent on the previous runtime after a failed update and
reports `restartAttempted` / `agentRestarted` honestly, including a
`restartErrorCode` when the restart also failed.

The Linux self-update path is currently validated hermetically only; a live
version-delta drill is still owed, so do not present it as live-validated. See
`OPERATOR_NOTES_V2.md` for the full path and artifact locations.

## Node Removal and Revocation

Removing an Agent node attempts a best-effort enrollment revocation on the Agent
using the node's own credential. The Agent allows revoke only for an owner-tier
credential, so a restricted node may be refused with HTTP 403 or may time out if
unreachable. Report the outcome as it is returned (`revocation.revoked: false`
with a code) and never claim a revoked Agent when the revocation failed. The
node is removed locally regardless. If credentials are locked, revocation is not
attempted at all and that is also reported.

## Repair Required

Use diagnostics to check runtime files, configuration, service registration, permissions, storage paths, logs, disk space, and update compatibility. Preserve instances and backups during repair.

## Port Conflict

Explain which port is in use and that AnxOS cannot start the Local Agent until the conflict is resolved. Do not silently switch to a different localhost port unless the node registry and desktop are updated safely.

## Dependency Problems

Re-scan dependencies after install or restart. Show whether a dependency is missing, installed but unavailable, unsupported, requires admin access, or requires restart.

## Marketplace Install Failure

Check selected node, disk space, dependency readiness, port conflicts, provider errors, and sanitized installer logs. Do not expose CurseForge keys or provider credentials.

## Files and Backups

For file errors, confirm the selected node and allowed root. For restore errors, validate archive integrity, disk space, locked files, traversal protection, and overwrite confirmation.

## Public Access

Provider installed is not the same as provider ready. Check sign-in state, tunnel state, local endpoint, firewall requirements, and provider-specific configuration.
