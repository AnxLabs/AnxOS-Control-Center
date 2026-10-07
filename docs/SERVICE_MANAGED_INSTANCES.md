# Service-managed instances (systemd)

A **service-managed instance** (`type: "systemd-service"`) is an existing OS service
that the Agent *observes and controls* but never *owns*. systemd stays the single
owner of the process. This is how a production FiveM server that already runs as
`anxrp-fxserver.service` is managed from AnxOS without ever risking a second copy.

Status: phase 1. Console commands and READY integration are deliberately deferred
(phase 2). Architecture decision: ADR 0031 (AnxRP repository), addendum 2026-10-07.

## What the Agent does and does not do

| Operation | Behaviour |
|---|---|
| Status / list | `systemctl show` mapped to Running, Starting, Restarting, Stopping, Stopped, Failed or **Unknown** |
| Start | Refused with `INSTANCE_ALREADY_RUNNING` if the unit is active or activating; otherwise `systemctl start` |
| Stop | No-op if already stopped; otherwise `systemctl stop` |
| Restart | One atomic `systemctl restart`, never stop-then-start |
| Logs | `journalctl` tail (redacted), merged with the Agent's own action notes |
| Console commands, force-kill | Not available yet (`SERVICE_MANAGED_OPERATION_UNSUPPORTED`) |
| Edit, rename, duplicate, delete | Refused (the record is operator-authored) |
| File writes, game-config writes, installers, FiveM license/readiness writes | Refused |
| Backup and restore | Refused (a stopped-consistency backup would stop production to archive an empty stub) |
| Scheduled restarts | Refused until the console exists, because players could not be warned |
| `forget` | Allowed: removes only the Agent's record |

Invariants, each covered by a test that fails if the guard is removed:

1. **The Agent never launches the workload.** All four owned-process spawn sites call
   `assertNotServiceManaged()`, the lifecycle entry points branch before any spawn path,
   and a static test fails if a new spawn site appears unguarded.
2. **State comes from systemd only**, is derived per call and never persisted. The unit's
   `MainPID` is shown as information (`serviceStatus.externalMainPid`); `pid` is always `null`.
3. **Fail closed.** Unreadable or unrecognised state is `Unknown`, never `Stopped`, and
   start/stop/restart refuse to act on it (`SERVICE_STATE_UNVERIFIED`).
4. **Operator-authored and allowlisted.** `systemd-service` is not in `INSTANCE_TYPES`, so the
   API cannot create or edit it. The unit must also be listed in `AGENT_SYSTEMD_UNIT_ALLOWLIST`
   in the root-owned `/etc/anxos-agent/agent.env`.
5. **Least privilege, exact argv, no shell.** Control runs `[sudo -n] /usr/bin/systemctl
   (start|stop|restart) <unit>`; logs run one fixed `journalctl` command line. No other verb
   (`kill`, `disable`, `mask`, ...) can be issued.
6. **The Agent's lifecycle is independent of the service.** Agent shutdown, restart or `SIGKILL`
   never touches it.

The port-conflict check now also fails closed for every instance type: a listening socket
whose owner cannot be resolved is a conflict (`ownerUnknown`), and an unreadable socket table
raises `PORT_OWNERSHIP_UNVERIFIABLE` instead of being read as "no conflict".

## Operator setup (Linux, systemd)

Environment (`/etc/anxos-agent/agent.env`, root-owned):

```
AGENT_SYSTEMD_UNIT_ALLOWLIST=anxrp-fxserver.service
AGENT_SYSTEMD_ELEVATION=sudo
```

`AGENT_SYSTEMD_ELEVATION` is `none` (default) or `sudo`; no other value is accepted.

Sudoers drop-in (validate with `visudo -cf` before installing):

```
anxos-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start anxrp-fxserver.service, /usr/bin/systemctl stop anxrp-fxserver.service, /usr/bin/systemctl restart anxrp-fxserver.service, /usr/bin/journalctl -u anxrp-fxserver.service -n 200 -o short-iso --no-pager -q
```

Instance record (`<instanceRoot>/<id>/config.json`), written *after* the Agent that understands
this type is running, owned `root:anxos-agent` mode 0640, with the instance directory
`root:anxos-agent` 0750 and only `logs/` writable by the Agent:

```json
{
  "id": "fivem-fxserver",
  "type": "systemd-service",
  "templateId": "fivem",
  "displayName": "AnxRP",
  "serverSoftware": "FiveM FXServer",
  "schemaVersion": 2,
  "installationState": "active",
  "workingDirectory": "data",
  "ports": [30120],
  "autoStart": false,
  "restartPolicy": "never",
  "serviceManager": { "kind": "systemd", "unit": "anxrp-fxserver.service" }
}
```

`restartPolicy` stays `never`: crash recovery belongs to systemd.

## Desktop behaviour

The instance shows as **systemd service**, ownership **Managed by systemd**, with a notice that
names the unit. Stop and Reload work; Start is available when the service is stopped or failed.
Everything the Agent refuses is disabled with the reason "Not available for a service-managed
instance", including the console input, backups, scheduled restarts, file edits and the whole
Settings tab (Forget stays available). An unreadable service is shown as **Unknown** with a
readable reason and all lifecycle controls disabled. The desktop also skips the marketplace
dependency pre-check when starting one, so a template's dependencies can never gate or trigger
installs on a host whose runtime the Agent does not own.

## Verification

| Check | Command |
|---|---|
| Controller, state mapping, exact argv | `node scripts/service-managed-runtime-smoke.js` |
| Instance core against a fake systemd | `node scripts/service-managed-instance-smoke.js` |
| Fail-closed port ownership | `node scripts/port-ownership-fail-closed-smoke.js` |
| Desktop service layer against a real Agent | `node scripts/service-managed-agent-routing-smoke.js` |
| Real Electron UI against a real Agent | `node scripts/service-managed-ui-qa.js` |
| Guards are load-bearing (mutation check) | `node scripts/service-managed-mutation-check.js` |
| Real systemd end to end (disposable Linux VM only) | `tools/service-managed/linux-systemd-e2e.sh` |

The mutation check removes each guard in a throwaway copy and requires a test to fail; it also
runs unmutated *controls* that must pass, so a "killed" mutant cannot be a broken harness.

Running the Electron checks from a VS Code or Claude extension host: that host exports
`ELECTRON_RUN_AS_NODE=1`, which makes every Electron launch fail with "Process failed to
launch!". Unset it (and the `VSCODE_*` variables) first.

## Limitations (phase 1)

- "Ready" means the unit is active. A workload's own READY signal (for example AnxRP's status
  file) is not inferred.
- No console, so no in-game restart warnings and no force-kill.
- Linux with systemd only; other platforms report `SERVICE_MANAGER_UNSUPPORTED`.
- The journal is read as one fixed 200-line tail.
