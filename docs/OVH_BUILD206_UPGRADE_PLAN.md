# OVH upgrade plan: temporary unsigned Build 206 -> official Build 206

**Status: PLAN ONLY. Nothing here has been run on OVH. It needs explicit approval.**

Scope: replace the locally built Agent package (SHA-256 `59842c83...979f`, from `cc862de`) with the official Build 206 Agent package, then optionally enable the operations layer. **FXServer is never restarted by any step.** Safe Restart (the new feature) is a separate, later, optional action in an empty-server window.

## Why FXServer does not restart

- The package is a `dpkg -i` of `anxos-agent`. Its maintainer scripts touch only `anxos-agent.service` (`daemon-reload`, `enable --now`, `try-restart anxos-agent`). They never reference `anxrp-fxserver.service`.
- The unit file has no `PartOf=`/`BindsTo=`/`Requires=` relation to the game unit.
- Rehearsed on a real-systemd VM (temporary 206 -> official 206 -> 205 rollback): workload MainPID and start time were identical at every step; 18/18. The same held on OVH in Phase 3 (205 -> temporary 206).
- Only the Agent restarts (a few seconds; Control Center reconnects). No players are affected.

## What differs from the temporary package

| | temporary (on OVH now) | official candidate |
|---|---|---|
| Source | `cc862de` (PR #1 work) + build bump | `dev` `e84707b` (PR #1 + PR #2) |
| dpkg version | `2.0-build206` | `2.0-build206` (same string: install with `dpkg -i`, not `apt`) |
| New code | no operations layer | service operations layer, Safe Restart, `--timestamp=unix` for `systemctl show`, `safe-restart` lifecycle tier |
| Provenance | `agent-release.json` built from a local build | official `v2.0-build206` stamp |
| Stray files | has `ssh2/lib/protocol/crypto/build/` from the build host | none |
| Signing | unsigned | CI-built (the Agent `.deb` is distributed with a `.sha256`; the Windows installer is Authenticode-signed) |

## Preconditions (read only)

1. Official `AnxOS-Agent-2.0-build206.deb` and its `.sha256` are published/available and `sha256sum -c` passes on OVH. (**Publication is not approved yet.**)
2. The Build 205 rollback artifact is still on the host with its recorded SHA-256 `7b9410c0...7acd`, and the temporary package is kept too.
3. `systemctl show anxrp-fxserver.service -p MainPID,NRestarts,ActiveEnterTimestamp` recorded as the "before" value. FXServer processes: 2. 30120 listening tcp+udp.
4. `sudo -n sudo -l -U anxos-agent` still shows only the four pinned commands.
5. Agent env: `AGENT_SYSTEMD_UNIT_ALLOWLIST=anxrp-fxserver.service`, `AGENT_SYSTEMD_ELEVATION=sudo` present.

## Step A - upgrade the Agent package (no FXServer restart)

```
sudo cp -a /var/lib/anxos-agent /var/backups/anxos-agent-pre-official206   # data + config backup (as in Phase 1)
sudo dpkg -i AnxOS-Agent-2.0-build206.deb                                    # same-version reinstall; restarts only anxos-agent
systemctl is-active anxos-agent
```

Verify: `dpkg -s anxos-agent | grep Version` is `2.0-build206`; `cat /usr/lib/anxos-agent/agent-release.json` shows the official stamp; `dpkg --verify anxos-agent` is clean; `/api/v1/instances` still lists `fivem-fxserver` as Running with the same `externalMainPid`; FXServer "before" values unchanged.

## Step B - enable the operations layer (optional, Agent restart only)

1. Find the status file as the Agent user (the file lives under the `anxrp` user's tree):
   `sudo -u anxos-agent test -r "/srv/anxrp/server-data/resources/[local]/anxrp/status/anxrp-status.json" && echo readable`
   If it is not readable, grant read with the narrowest ACL (`setfacl -m u:anxos-agent:r` on the file, `u:anxos-agent:x` on each parent directory) or ask for a different location. **Do not widen modes** (see the `main.lua` mode 666 note below).
2. Append to the root-owned env file: `AGENT_SERVICE_STATUS_ROOTS=/srv/anxrp/server-data/resources/[local]/anxrp/status`
3. Add `serviceManager.operations` to `/var/lib/anxos-agent/instances/fivem-fxserver/config.json` (root-owned, 0640 root:anxos-agent; back it up first and `sha256sum` it before and after):
   ```
   "operations": {
     "health":   { "kind": "anxrp-status-file", "path": "/srv/anxrp/server-data/resources/[local]/anxrp/status/anxrp-status.json", "maxAgeSeconds": 120 },
     "players":  { "kind": "fxserver-http", "baseUrl": "http://127.0.0.1:30120" },
     "listeners": { "ports": [30120], "protocols": ["tcp", "udp"] },
     "safeRestart": { "timeoutSeconds": 180 }
   }
   ```
4. Optional deployment manifest (root-owned, 0640 root:anxos-agent) at `/var/lib/anxos-agent/instances/fivem-fxserver/deployment.json`, `agentBuild.origin: "official"`, `artifactVersion: "2.0-build206"`, `rollback.artifact` = the kept 205 package (name, path, sha256) and `rollback.backup` = the Phase 1 backup directory.
5. `sudo systemctl restart anxos-agent` (Agent only). Check `GET /api/v1/instances/fivem-fxserver/service/overview`: MainPID matches systemd, AnxRP READY with the live boot id, players 0 (or the real count), 30120 tcp+udp listening, `deployment.unofficial=false`.
6. Confirm refusals still hold: start (409 already running), command, force-kill, backup, schedule.

The operations layer is read-only until someone invokes Safe Restart. Do **not** run Safe Restart as part of this upgrade.

## Rollback

- Package: `sudo dpkg -i <kept AnxOS-Agent-2.0-build205.deb>` (or the temporary 206 package). Verified in the rehearsal: files match the 205 package exactly (`dpkg --verify` clean), `agent.env` and data preserved, FXServer MainPID unchanged.
- Operations layer only: remove `AGENT_SERVICE_STATUS_ROOTS` and the `operations` block (restore the backed-up record, verify its SHA-256), then `sudo systemctl restart anxos-agent`.
- If the Agent fails to start after the upgrade: `journalctl -u anxos-agent -n 100`, then the package rollback above. FXServer keeps running throughout because systemd owns it.

## Stop conditions

Abort and roll back the Agent package (never touch FXServer) if: `dpkg -i` fails; `agent-release.json` is not the official stamp; the instance does not list as Running with the same MainPID; `sudo -l` shows anything beyond the four pinned commands.

## Outside this upgrade

- The deployed AnxRP `playerDropped` patch must be committed to the AnxRP repo before the next AnxRP deployment.
- `main.lua` mode 666 on production is a separate hardening issue. Nothing in this plan changes it.
