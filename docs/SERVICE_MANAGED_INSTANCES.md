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

## Operations layer: health, players, Safe Restart, history

Build 206 adds a read-mostly operations layer on top of the controller. It never changes who owns
the process: systemd still starts, stops and restarts the unit, and the Agent still runs only the
pinned `systemctl start|stop|restart <unit>` argv. There is still no shell and no new sudoers rule.

### Operator configuration

Everything is optional and lives in the root-owned instance record under `serviceManager.operations`.
Without it the instance behaves exactly as in the first phase and Safe Restart is disabled with an
explanation.

```json
"serviceManager": {
  "kind": "systemd",
  "unit": "anxrp-fxserver.service",
  "operations": {
    "health":   { "kind": "anxrp-status-file", "path": "/var/lib/anxrp/status/anxrp-status.json", "maxAgeSeconds": 120 },
    "players":  { "kind": "fxserver-http", "baseUrl": "http://127.0.0.1:30120" },
    "listeners": { "ports": [30120], "protocols": ["tcp", "udp"] },
    "safeRestart": { "timeoutSeconds": 180 }
  }
}
```

- `health.path` must be absolute, already normalized (no `..`), end in `.json`, and sit inside a
  directory listed in the new Agent environment variable **`AGENT_SERVICE_STATUS_ROOTS`**
  (separated by the platform path delimiter, `:` on Linux). With no roots set, no file is read. The file is read as one bounded
  JSON document and must be fresh (`maxAgeSeconds`, 10 to 3600, default 120): a stale file never
  counts as READY.
- `players.baseUrl` must be `http://<loopback>:<port>` (`127.0.0.1`, `localhost` or `[::1]`), with
  no credentials or path. The Agent reads `/dynamic.json` and `/players.json`, keeps **only the
  count** and requires both endpoints to agree. Names and identifiers are never stored or logged.
- `listeners.ports` defaults to the instance's `ports`; protocols default to `tcp` and `udp`. They
  are read from the host's `/proc/net` tables, never by probing.
- `safeRestart.timeoutSeconds` is 30 to 600 (default 180).

### Deployment manifest (optional)

`<instance dir>/deployment.json`, root-owned and read-only to the Agent, tells the desktop which
Agent build this host runs and which rollback artifact and backup exist:

```json
{
  "schema": 1,
  "agentBuild": { "origin": "local-unofficial", "artifactVersion": "2.0-build206", "builtFromCommit": "cc862de", "sha256": "<64 hex>", "note": "temporary package" },
  "rollback": { "artifact": { "name": "AnxOS-Agent-2.0-build205.deb", "path": "/var/backups/...", "sha256": "<64 hex>" },
                "backup": { "dir": "/var/backups/...", "createdAt": "2026-10-07T22:20:31Z" } },
  "notes": ["Rollback package kept intact"]
}
```

Only `origin: "official"` counts as official; anything else, including a typo, is shown as an
**unofficial/local build** warning. Rollback paths are reported `present`, `missing` or
`unverifiable` (for example permission denied); an unreadable path is never reported as gone.

### API

| Route | Tier | Purpose |
|---|---|---|
| `GET /api/v1/instances/:id/service/overview` | `instance:read` | systemd MainPID and uptime, AnxRP health and boot id, player count, listeners, deployment, recent operations |
| `GET .../service/safe-restart/preflight` | `instance:read` | the checklist, with no side effect |
| `POST .../service/safe-restart` | `instance:lifecycle` | `{confirm:true, expectedMainPid?, expectedUnit?}`; `202` with the operation |
| `GET .../service/operations/:opId` | `instance:read` | poll the steps and outcome |
| `GET .../service/history` | `instance:read` | append-only restart/lifecycle history |

### Safe Restart

Preflight, all of which must **pass** (unknown, unreadable and ambiguous all fail): configured;
correct instance and unit; unit active and running with a MainPID; the MainPID still matches what
the caller was looking at; no other operation running; AnxRP READY from a fresh status file with a
boot id; **0 players**, with both endpoints agreeing; every configured port listening; history
writable. Then, with the lock held:

1. the player count is read again immediately before the command;
2. **exactly one** `systemctl restart` is issued (a failed command is never retried);
3. wait for a new active MainPID and a newer start time;
4. wait for every configured port to listen;
5. wait for AnxRP READY with a boot id different from the old one;
6. after a short settle window, confirm the same process is still up and systemd did not restart it
   by itself (a manual `systemctl restart` resets `NRestarts`, so only a rise counts).

Any wait that expires ends as `timeout`, a failed check as `failed` or `refused`; nothing is
retried and nothing is killed. While it runs, plain start, stop and restart are refused
(`SERVICE_OPERATION_IN_PROGRESS`) and a second Safe Restart cannot start. Every attempt, including
refusals, is written to `logs/service-history.jsonl` (a `started` record before the command, a
`finished` record after), and plain lifecycle actions are recorded too. A `started` record with no
`finished` and no live operation is reported as `interrupted`. If the history file cannot be
written, Safe Restart refuses to run: there is no un-audited restart.

### Desktop

The workspace shows a **SYSTEMD MANAGED** badge and a panel with systemd's MainPID (labelled as not
owned by the Agent), uptime, AnxRP state, boot id and version, player count, listening ports, the
unofficial-build warning, rollback artifact and backup status, the Safe Restart preflight, progress
and result, and the history. Each disabled control carries its own reason (force kill, delete,
duplicate, backups, scheduled restarts, console commands, file edits), repeated in a "Why are some
actions unavailable?" list. The Console tab shows the journal read-only.

## Desktop behaviour

The instance shows as **systemd service**, ownership **Managed by systemd**, with a notice that
names the unit. Stop and Reload work; Start is available when the service is stopped or failed.
Everything the Agent refuses is disabled with a specific reason (see the operations panel below), including the console input, backups, scheduled restarts, file edits and the whole
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
| Operations layer, every fail-closed branch (fake clock) | `node scripts/service-managed-operations-smoke.js` |
| Operations API and lock against a real Agent | `node scripts/service-managed-operations-agent-smoke.js` |
| Real Electron UI against a real Agent | `node scripts/service-managed-ui-qa.js` |
| Guards are load-bearing (mutation check) | `node scripts/service-managed-mutation-check.js` |
| Real systemd end to end (disposable Linux VM only) | `tools/service-managed/linux-systemd-e2e.sh` |

The mutation check removes each guard in a throwaway copy and requires a test to fail; it also
runs unmutated *controls* that must pass, so a "killed" mutant cannot be a broken harness.

Running the Electron checks from a VS Code or Claude extension host: that host exports
`ELECTRON_RUN_AS_NODE=1`, which makes every Electron launch fail with "Process failed to
launch!". Unset it (and the `VSCODE_*` variables) first.

## Limitations (phase 1)

- Without `operations.health`, "ready" only means the unit is active. With it, Safe Restart waits for
  the workload's own READY and a new boot id.
- Safe Restart refuses unless 0 players are connected. There is no in-game warning or countdown.
- The in-process lock covers one Agent process; run one Agent per node.
- No console, so no in-game restart warnings and no force-kill.
- Linux with systemd only; other platforms report `SERVICE_MANAGER_UNSUPPORTED`.
- The journal is read as one fixed 200-line tail.
