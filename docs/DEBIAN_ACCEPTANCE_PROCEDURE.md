# Debian 12 x64 Acceptance Procedure

Ready-to-execute acceptance procedure for the AnxOS Control Center `.deb` on a
real Debian 12 x64 host. It is derived from
`docs/PRIVATE_ALPHA_RC_REAL_MACHINE_TEST_SHEET.md` (the PA-RC test IDs),
`docs/PRIVATE_ALPHA_INSTALL_GUIDE.md`, and the `linux` job in
`.github/workflows/windows-release.yml`.

Markers used throughout:

- `[AJ-HW]` — needs AJ's hardware. Every execution step below runs on AJ's real
  Debian 12 host (build host or second machine for the drills), so the marker is
  placed on the steps that additionally need a build host or a second machine.
- `[AJ-CRED]` — needs AJ's credentials or manual approval (sudo password,
  desktop owner unlock, SSH key material). The operator completes these steps
  manually; credentials are never captured, requested, or recorded.

Do not record tokens, passwords, pairing codes, authorization headers, private
keys, `.env` values, or unredacted diagnostic output. Scan every evidence
artifact for secrets before attaching it to a report. Completing this procedure
collects acceptance evidence only; it does not authorize a tag, release, or
publication.

## Step 0 — Candidate and environment record

The `.deb` is produced by the `linux` job in
`.github/workflows/windows-release.yml` (`npm run dist:linux -- --publish never
--no-increment-build`, ubuntu-latest, Node 22) or by `npm run dist:linux` on a
Linux build host `[AJ-HW]`. Linux artifacts are not code-signed by the pipeline;
the SHA-256 below is the identity that matters. No 2.0 Linux artifact exists at
HEAD `184491e`, so this stream starts by building or downloading a candidate
`[AJ-HW]`.

```bash
git rev-parse dev                                   # RC commit (where the candidate was built)
sha256sum AnxOS-Control-Center-*.deb                # artifact SHA-256
dpkg-deb -f ./AnxOS-Control-Center-*.deb Package Version Architecture
cat /etc/os-release; uname -m                       # Debian version and architecture
node --version                                      # only for a source checkout used in steps 3-4
```

Record in the candidate table: RC commit, RC version/build (from the artifact
filename), `.deb` filename and SHA-256, Debian version/architecture, desktop
tester and UTC window. Expected: the SHA-256 matches the approved checksum and
the architecture is `amd64`.

**Evidence:** command outputs, artifact checksum, `/etc/os-release`.

## Step 1 — Install

```bash
sha256sum AnxOS-Control-Center-*.deb                # verify once more against the approved checksum
sudo apt install ./AnxOS-Control-Center-*.deb       # resolves dependencies
# dpkg fallback when apt is unavailable:
sudo dpkg -i ./AnxOS-Control-Center-*.deb || sudo apt-get -f install
dpkg-query -W -f='${Package} ${Version} ${Architecture} ${Status}\n' anxos-control-center
dpkg -l anxos-control-center | tail -n +6           # same line, classic output
```

`[AJ-CRED]` The sudo password is entered by the operator and never captured.

Expected: one install attempt completes without missing-asset errors, manual
directory creation, or additional runtime dependencies. `dpkg-query` reports
`install ok installed` with the expected version.

**Evidence:** command output, `dpkg-query` line, approved/actual checksum.

## Step 2 — First run

Launch from the application menu, or:

```bash
anxos-control-center
```

Walk the first-run experience: the welcome screen is visible; **Set Up AnxOS**
opens the guided wizard and every step renders a title and a non-empty body; or
choose **Explore on My Own**. Visit Dashboard, Nodes, Settings, and Diagnostics
and confirm empty/offline states are honest (no fabricated values, no raw stack
traces, no secret material). Resize the window once and confirm the layout
holds.

Export diagnostics: **Diagnostics → Export Bundle** (AnxOS redaction is applied
by the app), then confirm where user data lives:

```bash
ls -la ~/.config/"AnxOS Control Center"
```

**Evidence:** screenshots of the welcome screen, one wizard step, and one empty
page; diagnostics bundle; the user-data directory listing.

## Step 3 — Local Agent setup (`AGENT_HOST`)

Install the managed startup from **Agent Control → Install background
startup**, or run a source checkout with `./AnxAgent.sh`. The default bind is
loopback `127.0.0.1:47131` (`agent/src/config.js` `DEFAULT_HOST`/`DEFAULT_PORT`).

To let another machine's desktop reach this Agent, set `AGENT_HOST` to a
concrete LAN or tailnet address and restart the Agent. Prefer a concrete address
over `0.0.0.0`/`::`: a wildcard bind exposes the Agent on every interface, loses
the strict Host allowlist, and prints a loud startup warning. Use a wildcard
only as a deliberate opt-in.

Managed systemd user unit:

```bash
systemctl --user edit anxos-agent.service           # add: [Service] Environment=AGENT_HOST=<LAN-or-tailnet-IP>
systemctl --user daemon-reload
systemctl --user restart anxos-agent.service
```

The app writes the base unit when **Install background startup** runs, so if the
service is reinstalled from Agent Control, re-apply the drop-in or set the host
in Agent Control's Agent configuration first.

Source-checkout Agent:

```bash
AGENT_HOST=<LAN-or-tailnet-IP> ./AnxAgent.sh
# or persist it for a source Agent (env files only fill variables that are not
# already set, so the managed unit's own AGENT_HOST wins for the managed path):
printf 'AGENT_HOST=%s\n' '<LAN-or-tailnet-IP>' >> ~/.config/anxos-control-center/agent.env
```

Verify the unit, the bind, and health:

```bash
systemctl --user status anxos-agent.service --no-pager
systemctl --user is-active anxos-agent.service
ss -ltnp | grep 47131
curl -fsS http://127.0.0.1:47131/api/v1/health
curl -fsS http://<LAN-or-tailnet-IP>:47131/api/v1/health   # run on the Debian host; confirms the concrete bind
journalctl --user -u anxos-agent.service --since '<UTC start>' --until '<UTC end>'
```

Record from the health JSON: `identity.agentVersion`, `mode`,
`tokenConfigured`, and `capabilities.agentUpdate` (`{"supported":true,
"mechanism":"linux-systemd"}` on a systemd host).

**Evidence:** redacted unit file, `ss -ltnp` output, both health JSON responses,
startup journal.

## Step 4 — Pairing

On the Debian host (source checkout):

```bash
npm run agent:pair                                   # prints agentUrl and a temporary pairing code
# from another machine, against the bound address:
AGENT_URL=http://<LAN-or-tailnet-IP>:47131 npm run agent:pair
```

In the managing desktop: **Agent Control → Agent Connection** → paste the code →
**Pair Agent** → **Test Connection** → confirm the displayed identity and
capability summary before accepting → wait for the node to become online.
`[AJ-CRED]` Unlock the local owner account in **Security** if the desktop asks
(the same unlock required after every restart). The pairing code is temporary
sensitive material: never record or screenshot it.

Restart the Agent service and the desktop, then verify durable, identity-bound
reconnection:

```bash
systemctl --user restart anxos-agent.service
```

Expected: the same node identity reconnects with no repeated pairing prompt and
no duplicate node; a blocked network produces an honest offline state and
automatic recovery when connectivity returns (PA-RC-05).

**Evidence:** pairing screens (code redacted), node identity/capability summary,
desktop diagnostics bundle, Agent journal around the restart and recovery.

## Step 5 — Server create / start / stop

In the desktop: **Dashboard → Create a Server** (or **Marketplace**) → select
the Debian node → run the dependency preflight → install once (a duplicate
submission during the operation must not create duplicate work) → **Instances →
Start** → wait for the real readiness signal, not merely "process running" →
**Stop** → confirm the intended stop and port release.

Corroborate on the host:

```bash
ss -ltnp | grep <server-port>                        # listener present while ready, gone after stop
journalctl --user -u anxos-agent.service --since '<UTC start>'   # Agent-side operation log
```

**Evidence:** template/provider/version, operation ID and state timeline,
readiness screenshot, PID/port before and after stop, instance logs.

## Step 6 — Backup

In the desktop: **Backups → Create backup** for the disposable stopped instance.
The archive must be listed only after completion and validation. Confirm on the
host:

```bash
ls -la ~/.config/"AnxOS Control Center"/agent/backups
du -sh ~/.config/"AnxOS Control Center"/agent/backups/*
```

Record the operation ID, archive path and size, and the integrity result.
Retention must not remove the newest valid recovery copy. Where a restore drill
is in scope (PA-RC-10), restore to marker `A`, verify the pre-restore safety
snapshot, and confirm the restored instance reaches readiness.

**Evidence:** operation ID, integrity result, backup inventory, marker evidence
if the restore leg is run.

## Step 7 — Update check

In the desktop: **Settings → Updates → Check for Updates**. Expected: a truthful
result — "up to date" when the installed build is at or ahead of the published
manifest, otherwise the offered target version. Record the manifest
URL/channel/version and the before/after app version. Do **not** install from
this check, do not modify any public channel, and do not create a tag
(PA-RC-14's checksum-rejection legs are separate and need a controlled fixture).

**Evidence:** screenshot, recorded manifest identity, unchanged installed
version.

## Step 8 — Uninstall with data-preservation verification

Record the inventory before removing anything:

```bash
du -sh ~/.config/"AnxOS Control Center"
find ~/.config/"AnxOS Control Center" -maxdepth 2 | head -n 40
```

Uninstall the application:

```bash
sudo apt remove anxos-control-center
# AppImage runs instead delete the AppImage file.
```

`[AJ-CRED]` The sudo password is entered by the operator and never captured.

Verify the application is gone but user data remains:

```bash
dpkg-query -W -f='${Status}\n' anxos-control-center 2>&1   # expect: not installed
command -v anxos-control-center || true
ls /opt | grep -i anxos || true
ls -la ~/.config/"AnxOS Control Center"
du -sh ~/.config/"AnxOS Control Center"                     # must match the recorded inventory
```

Agent removal is a separate, explicit choice — the default uninstall must not
silently delete server data, configuration, or backups:

```bash
systemctl --user status anxos-agent.service
# only when background-startup removal is intended:
systemctl --user disable --now anxos-agent.service
rm ~/.config/systemd/user/anxos-agent.service
systemctl --user daemon-reload
```

Where in scope, reinstall the same verified `.deb` and confirm preserved nodes,
settings, instances, and backups (PA-RC-17 analog).

**Evidence:** before/after inventory and checksums, `dpkg-query` status,
preserved-data listing, uninstall screenshots.

## Step 9 — Linux self-update swap drill

Two real swap paths exist. The canonical ordered plan is `verify → stage →
schedule-swap → swap → restart → record`
(`src/shared/linuxAgentSelfUpdate.js`); the hermetic proof of the ordering and
rollback is `npm run agent:self-update:smoke`
(`scripts/agent-self-update-smoke.js`).

Paths on a packaged `.deb` install:

- packaged runtime root: `/opt/AnxOS Control Center/resources/local-agent-runtime`
- update directory (`<updateDir>`): `~/.config/AnxOS Control Center/agent/updates`
- staged tree: `<runtimeRoot>.update-<stamp>`; backup: `<runtimeRoot>.backup-<stamp>`
- swap script: `<updateDir>/swap-<stamp>.sh`; result marker: `<updateDir>/swap-<stamp>.result`
- update record: `<updateDir>/last-linux-update.json`

### Drill A — desktop-local (Agent Control on the Debian host)

`[AJ-HW]` needs a real Debian host with a desktop session and systemd;
`[AJ-CRED]` desktop owner unlock.

Preconditions: the managed systemd user unit is installed and running
(otherwise the flow refuses with `LINUX_AGENT_UNIT_NOT_INSTALLED`); the desktop
reports an Agent version mismatch (X → Y) — for example install an older build,
install the Local Agent so health reports X, then install the newer build and
trigger **Agent Control → Update Agent**.

Observe the artifacts and outcome:

```bash
UPD="$HOME/.config/AnxOS Control Center/agent/updates"
ls -la "$UPD"
cat "$UPD/last-linux-update.json"
cat "$UPD"/swap-*.result
systemctl --user is-active anxos-agent.service
curl -fsS http://127.0.0.1:47131/api/v1/health        # identity.agentVersion
ls -d "/opt/AnxOS Control Center/resources/local-agent-runtime".backup-* 2>/dev/null
ls -d "/opt/AnxOS Control Center/resources/local-agent-runtime".update-* 2>/dev/null
journalctl --user --since '<UTC start>' --until '<UTC end>' | grep -i swap
journalctl --user -u "anxos-agent-update-<stamp>.service"   # transient unit; the app's own message cites 'journalctl --user -u anxos-agent-update'
```

Success markers (smoke-pinned): the result marker is `complete`; the record has
`status: "complete"`, `mechanism: "linux-systemd"`, and `fromVersion X` →
`toVersion Y`; all six plan steps complete; exactly one `.backup-<stamp>`
sibling is preserved; no `.update-` leftovers remain; `systemctl --user` reports
the unit `active` after the restart; the Agent answers health with the new
version.

Failure markers: result markers `failed-missing-staged`, `failed-backup`,
`failed-publish`, `failed-rolled-back`, `failed-rollback-failed`,
`failed-restart`; error codes `LINUX_AGENT_SWAP_FAILED` (with
`details.rolledBack`), `LINUX_AGENT_SWAP_SCHEDULE_FAILED` (staged tree retained
for retry), `LINUX_AGENT_SWAP_TIMEOUT`, `LINUX_AGENT_SWAP_OUTCOME_UNKNOWN`,
`LINUX_AGENT_RESTART_VERIFY_FAILED`, `LINUX_AGENT_STAGE_FAILED`,
`LINUX_AGENT_RUNTIME_ROOT_NOT_WRITABLE`, and the refusal
`AGENT_NEWER_THAN_DESKTOP`.

Honest limit to record with the result: production passes
`sourceRoot == runtimeRoot` (`agentControlService.js:925-933`), so the staged
bytes are the current bundled tree — the live systemd swap and restart are
provable on the real host, but a genuine content version delta is not. Do not
claim a URL/version content swap from this drill.

**Evidence:** `last-linux-update.json`, `swap-*.result`, swap journal excerpt,
`systemctl --user is-active` output, health JSON before/after, directory listing
of the backup/staged siblings.

### Drill B — remote SSH push (`nodes:updateAgent`)

`[AJ-HW]` needs the Windows desktop and the Debian node together; `[AJ-CRED]`
the node's SSH key profile is handled by the operator and never captured.

Preconditions from `src/services/remoteAgentUpdateService.js`: a Linux node
(not the application host) with an assigned SSH profile using **private key**
auth (`REMOTE_AGENT_UPDATE_SSH_PROFILE_MISSING` /
`REMOTE_AGENT_UPDATE_SSH_KEY_REQUIRED` otherwise); the node healthy before the
update (`REMOTE_AGENT_UPDATE_NODE_UNHEALTHY`); the bundled Agent not older than
the node's (`AGENT_DOWNGRADE_REFUSED`). This variant can carry a real version
delta when the desktop's bundled Agent version differs from the node's.

On the node, staging is `<runtimeRoot>/.anxos-agent-update/<stamp>/staged` with
`backup/` beside it. The swap script emits `STAGE_OK`, `BACKUP_OK`, `STOP_OK`,
`PUBLISH_OK`, then `SWAP_OK`; a failed start emits `START_FAILED` and then
`SWAP_ROLLED_BACK` after restoring the backup. The rollback script emits
`ROLLBACK_PUBLISHED` / `ROLLBACK_OK`.

Verify: the update dialog reports completion; the verify loop needs health
**and** network inventory to pass; failures roll back, restart the previous
runtime, and say so. The record is written on the Windows desktop at:

```text
%APPDATA%\AnxOS Control Center\agent-updates\remote-last-update.json
```

Expected: no half-published tree, the previous runtime preserved under the
stage directory, and the record's `status` reflecting `complete` or
`rolled-back` honestly (`REMOTE_AGENT_UPDATE_SWAP_FAILED` /
`REMOTE_AGENT_UPDATE_SWAP_UNCONFIRMED` for failures).

**Evidence:** update dialog screenshots, node-side directory listing of the
stage and backup paths (redacted), desktop record JSON, node Agent journal,
health and network-inventory results from the verify loop.

## Step 10 — Evidence-return template

Copy, fill, and return with the artifact hashes and screenshots attached:

```text
ANXOS DEBIAN 12 x64 ACCEPTANCE RESULT
commit: <git rev-parse dev>              version/build: <x.y-buildNNN>
deb: <filename>  sha256: <hash>  dpkg version: <dpkg-deb -f Version>
host: <Debian version> x64   desktopAgentVersion: X   nodeAgentVersion: Y
tester / UTC window: <name> / <start>-<end>

step              result (PASS/FAIL/BLOCKED/NOT RUN)   evidence file(s)                       notes
0 identity        ...                                  sha256sum, dpkg-deb output
1 install         ...                                  apt output, dpkg-query line
2 first run       ...                                  welcome/wizard screenshots, exported bundle
3 agent setup     ...                                  unit status, ss -ltnp, health JSON, journal
4 pairing         ...                                  pairing screens (code redacted), journal
5 server          ...                                  template, operation ID, timeline, port checks
6 backup          ...                                  operation ID, integrity, inventory
7 update check    ...                                  screenshot, manifest identity, version unchanged
8 uninstall       ...                                  dpkg status, preserved-data listing, inventory
9 self-update A   ...                                  last-linux-update.json, swap-*.result, journal
9 self-update B   ...                                  remote-last-update.json, node listing, health/inventory
defects: <ID / severity / actual behavior>
self-update honest limit recorded: <yes/no + note>
secret-exposure review done by: <name / UTC>
```

## Mapping to the RC test sheet

| Procedure step | PA-RC IDs (Debian half unless noted) |
| --- | --- |
| 1-2 install/first run | PA-RC-02 analog (Windows-only in the sheet) |
| 3-4 Agent setup/pairing | PA-RC-05; PA-RC-06 needs a second node as well |
| 5 server lifecycle | PA-RC-07, PA-RC-09 |
| 6 backup | PA-RC-10 |
| 7 update check | PA-RC-14 (check only) |
| 8 uninstall/data preservation | PA-RC-17 analog |
| 9 self-update drill | The recorded `KNOWN_LIMITATIONS` item "Linux Agent self-update is validated hermetically only" |
