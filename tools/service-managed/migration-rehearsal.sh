#!/usr/bin/env bash
# Rehearses the production migration of a systemd-managed server into the AnxOS
# Agent, end to end, on REAL systemd and REAL .deb packages.
#
# It is the executable form of the migration plan: start from the official Agent
# package managing nothing, prepare the sudoers/env, UPGRADE the package, create the
# service-managed record, verify, then ROLL BACK by downgrading. The invariant it
# watches at every step: the service's MainPID and start time never change unless the
# rehearsal itself asks the Agent to restart it, and exactly one workload process
# exists at all times.
#
# DISPOSABLE LINUX VM ONLY. It installs packages, creates users, a unit and a sudoers file.
#   ANX_E2E_DISPOSABLE=1 OFFICIAL_DEB=/path/official.deb CANDIDATE_DEB=/path/candidate.deb \
#     bash tools/service-managed/migration-rehearsal.sh

set -uo pipefail

[ "${ANX_E2E_DISPOSABLE:-}" = "1" ] || { echo "refusing: set ANX_E2E_DISPOSABLE=1 (disposable Linux VM only)"; exit 2; }
[ "$(id -u)" = "0" ] || { echo "refusing: must run as root in the disposable VM"; exit 2; }
[ ! -e /etc/anxos-agent ] || { echo "refusing: /etc/anxos-agent exists, this looks like a real AnxOS node"; exit 2; }
[ ! -e /usr/lib/anxos-agent ] || { echo "refusing: /usr/lib/anxos-agent exists, this looks like a real AnxOS node"; exit 2; }
case "$(hostname)" in vps-*|ovh*|anxlab*) echo "refusing: hostname $(hostname) looks like a real node"; exit 2 ;; esac
OFFICIAL_DEB="${OFFICIAL_DEB:?path to the official (currently deployed) package}"
CANDIDATE_DEB="${CANDIDATE_DEB:?path to the candidate package}"

UNIT="anxrp-fxserver.service"
API_PORT=47132
INSTANCE_ID="fivem-fxserver"
INSTANCE_ROOT=/var/lib/anxos-agent/instances
TOKEN="anxos_rehearsal_$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AGENT_NODE=/usr/lib/anxos-agent/node/bin/node
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1  ${2:-}"; }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(expected '$2', got '$3')"; fi; }
jget() { "$AGENT_NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)))}catch(e){console.log("")}})' "$1"; }
api() { curl -sS -m 120 -X "$1" -H "x-agent-token: $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$API_PORT$2" -w '\n%{http_code}'; }
body() { sed '$d'; }
code() { tail -n1; }
mainpid() { systemctl show "$UNIT" -p MainPID --value; }
entered() { systemctl show "$UNIT" -p ActiveEnterTimestamp --value; }
active() { systemctl show "$UNIT" -p ActiveState --value; }
procs() { pgrep -fc "fake-fxserver.py" || true; }
agent_pid() { pgrep -u anxos-agent -f "agent/src/server.js" | head -1; }
installed_build() { "$AGENT_NODE" -e 'console.log(require("/usr/lib/anxos-agent/agent-release.json").artifactVersion)'; }
wait_for() { local limit="$1"; shift; for _ in $(seq 1 $((limit * 5))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }
healthy() { curl -sf -m 2 -H "x-agent-token: $TOKEN" "http://127.0.0.1:$API_PORT/api/v1/health"; }
fx_state() { echo "$(mainpid)|$(entered)|$(procs)"; }

cleanup() {
  systemctl stop "$UNIT" 2>/dev/null
  rm -f "/etc/systemd/system/$UNIT" /etc/sudoers.d/60-anxos-agent-fxserver
  systemctl daemon-reload 2>/dev/null
  DEBIAN_FRONTEND=noninteractive dpkg -P anxos-agent >/dev/null 2>&1
  rm -rf /opt/rehearsal-fx /var/backups/anxos-adopt-* /var/lib/anxos-agent /var/log/anxos-agent /etc/anxos-agent
  userdel -r anxrp 2>/dev/null
  userdel anxos-agent 2>/dev/null
}
trap cleanup EXIT

echo "== setup: a production-like host (service running under systemd, official agent managing nothing)"
id anxrp >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin anxrp
mkdir -p /opt/rehearsal-fx
cat > /opt/rehearsal-fx/fake-fxserver.py <<'PY'
import socket, time, os
t = socket.socket(socket.AF_INET, socket.SOCK_STREAM); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
t.bind(("0.0.0.0", 30120)); t.listen(8)
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("0.0.0.0", 30120))
print("fake-fxserver READY pid=%d api_key=hunter2secretvalue" % os.getpid(), flush=True)
while True:
    time.sleep(5); print("fake-fxserver heartbeat", flush=True)
PY
cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=AnxRP FXServer stand-in (REHEARSAL)
[Service]
User=anxrp
ExecStart=/usr/bin/python3 /opt/rehearsal-fx/fake-fxserver.py
Restart=on-failure
RestartSec=2
KillSignal=SIGINT
StandardOutput=journal
SyslogIdentifier=anxrp-fxserver
EOF
systemctl daemon-reload
systemctl start "$UNIT"
wait_for 10 test "$(active)" = "active" && ok "stand-in service active under systemd" || bad "stand-in service did not start"
export DEBIAN_FRONTEND=noninteractive
dpkg -i "$OFFICIAL_DEB" >/dev/null 2>&1 && ok "official package installed" || bad "official package failed to install"
cat > /etc/anxos-agent/agent.env <<EOF
AGENT_HOST=127.0.0.1
AGENT_PORT=$API_PORT
AGENT_TOKEN=$TOKEN
EOF
chown root:anxos-agent /etc/anxos-agent/agent.env; chmod 640 /etc/anxos-agent/agent.env
systemctl restart anxos-agent
wait_for 20 healthy && ok "official agent healthy" || { bad "official agent not healthy"; journalctl -u anxos-agent -n 20 --no-pager; exit 1; }
MODE="$(healthy | jget mode)"
if [ "$MODE" != "read-write" ]; then
  echo "NOTE: stock agent reports mode '$MODE' with this token; granting AGENT_API_PERMISSIONS=* for the rehearsal only"
  echo "AGENT_API_PERMISSIONS=*" >> /etc/anxos-agent/agent.env
  systemctl restart anxos-agent; wait_for 20 healthy
fi
expect "deployed build is the official one" "2.0-build205" "$(installed_build)"
expect "official agent manages no instances" "[]" "$(api GET /api/v1/instances | body | jget instances)"

echo "== package hygiene gate (the candidate must be buildable and installable like the official one)"
CTL="$(mktemp -d)"
dpkg-deb -e "$CANDIDATE_DEB" "$CTL" && ok "candidate control archive readable" || bad "candidate control archive unreadable"
for script in postinst prerm postrm; do
  # A CR in a maintainer script's shebang makes dpkg fail with "No such file or directory".
  # It happens when the package is built from a Windows checkout instead of a Linux git archive.
  expect "candidate $script has no CR bytes (LF endings)" 0 "$(tr -cd '\r' < "$CTL/$script" | wc -c | tr -d ' ')"
done
CONTENTS="$(mktemp)"; dpkg-deb -c "$CANDIDATE_DEB" > "$CONTENTS" 2>&1
# (not `grep -q` on a pipe: under pipefail the early exit breaks dpkg-deb's pipe and reads as a failure)
[ "$(grep -c 'usr/lib/anxos-agent/src/shared/instances/serviceManagedRuntime.js' "$CONTENTS")" = 1 ] && ok "candidate ships the service-managed runtime module" || bad "candidate lacks serviceManagedRuntime.js"
rm -f "$CONTENTS"
CAND_VER="$(dpkg-deb -f "$CANDIDATE_DEB" Version)"; OFF_VER="$(dpkg-deb -f "$OFFICIAL_DEB" Version)"
dpkg --compare-versions "$CAND_VER" gt "$OFF_VER" && ok "candidate version $CAND_VER sorts after the deployed $OFF_VER" || bad "candidate version $CAND_VER does not sort after $OFF_VER"
rm -rf "$CTL"

echo "== phase 0: preflight (read only)"
OFFICIAL_SHAS="$(cd /usr/lib/anxos-agent && sha256sum src/shared/instances/instanceServiceCore.js agent/src/routes/instances.js agent/src/routes/health.js agent/src/services/backupService.js agent/src/services/restartScheduleService.js src/services/serviceRouter.js | cut -c1-16 | tr '\n' ' ')"
echo "      deployed file hashes: $OFFICIAL_SHAS"
FX0="$(fx_state)"
echo "      service state: $FX0"
expect "exactly one workload process" 1 "$(procs)"
systemctl show "$UNIT" -p LoadState,ActiveState,SubState,Result,MainPID,ExecMainStatus,NRestarts,ActiveEnterTimestamp,UnitFileState --no-pager | grep -q "LoadState=loaded" && ok "controller's exact systemctl show works on the unit" || bad "systemctl show failed"

echo "== phase 1: backups (the rollback inputs)"
BK="/var/backups/anxos-adopt-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BK" && cp -a /etc/anxos-agent "$BK/etc-anxos-agent" && cp -a /var/lib/anxos-agent "$BK/var-lib-anxos-agent" && cp "$OFFICIAL_DEB" "$BK/" && ( cd "$BK" && find . -type f ! -name MANIFEST.sha256 -print0 | xargs -0 sha256sum > MANIFEST.sha256 )
[ -s "$BK/MANIFEST.sha256" ] && ok "backup written with a sha256 manifest" || bad "backup failed"
( cd "$BK" && sha256sum -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "backup verifies against its manifest" || bad "backup does not verify"

echo "== phase 2: prepare (additive; agent not restarted, no record yet)"
cat > /tmp/60-anxos-agent-fxserver <<EOF
anxos-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start $UNIT, /usr/bin/systemctl stop $UNIT, /usr/bin/systemctl restart $UNIT, /usr/bin/journalctl -u $UNIT -n 200 -o short-iso --no-pager -q
EOF
visudo -cf /tmp/60-anxos-agent-fxserver >/dev/null && ok "sudoers drop-in validates before installation" || bad "sudoers drop-in invalid"
install -m 0440 -o root -g root /tmp/60-anxos-agent-fxserver /etc/sudoers.d/60-anxos-agent-fxserver && rm -f /tmp/60-anxos-agent-fxserver
visudo -c >/dev/null 2>&1 && ok "whole sudoers configuration still valid" || bad "sudoers configuration broken"
printf 'AGENT_SYSTEMD_UNIT_ALLOWLIST=%s\nAGENT_SYSTEMD_ELEVATION=sudo\n' "$UNIT" >> /etc/anxos-agent/agent.env
expect "env file keeps its ownership and mode" "root:anxos-agent 640" "$(stat -c '%U:%G %a' /etc/anxos-agent/agent.env)"
expect "prepare step did not touch the service" "$FX0" "$(fx_state)"

echo "== phase 3: upgrade the package (restarts the agent only)"
AGENT_PID_BEFORE="$(agent_pid)"
OUT="$(dpkg -i "$CANDIDATE_DEB" 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "candidate package installed and configured (dpkg exit 0)" || bad "candidate package failed (dpkg exit $RC)" "$(echo "$OUT" | tail -3 | tr '\n' ' ')"
wait_for 30 healthy && ok "upgraded agent healthy" || { bad "upgraded agent not healthy"; journalctl -u anxos-agent -n 30 --no-pager; exit 1; }
[ -n "$(agent_pid)" ] && [ "$(agent_pid)" != "$AGENT_PID_BEFORE" ] && ok "the package restarted the agent (new process)" || bad "agent was not restarted by the package"
expect "installed build is the candidate" "2.0-build206" "$(installed_build)"
expect "service untouched by the package upgrade" "$FX0" "$(fx_state)"
expect "capability reports the allowed unit" "$UNIT" "$(healthy | jget capabilities.serviceManagedInstances.allowedUnits.0)"
expect "agent env and token survived the upgrade" "$TOKEN" "$(grep '^AGENT_TOKEN=' /etc/anxos-agent/agent.env | cut -d= -f2)"
expect "still no instances before the record exists" "[]" "$(api GET /api/v1/instances | body | jget instances)"
[ -f /usr/lib/anxos-agent/src/shared/instances/serviceManagedRuntime.js ] && ok "new runtime module is installed" || bad "serviceManagedRuntime.js missing from the package"

echo "== phase 4: create the record (after the patched agent is running), then verify read-only"
install -d -o root -g anxos-agent -m 0750 "$INSTANCE_ROOT/$INSTANCE_ID" "$INSTANCE_ROOT/$INSTANCE_ID/data"
install -d -o anxos-agent -g anxos-agent -m 0750 "$INSTANCE_ROOT/$INSTANCE_ID/logs"
cat > "$INSTANCE_ROOT/$INSTANCE_ID/config.json" <<EOF
{
  "id": "$INSTANCE_ID", "type": "systemd-service", "templateId": "fivem", "displayName": "AnxRP",
  "serverSoftware": "FiveM FXServer", "schemaVersion": 2, "installationState": "active",
  "serverVersion": "35805-6fd665a365f56c2582c36d8ffaf301b0b1d5764b", "workingDirectory": "data",
  "ports": [30120], "autoStart": false, "restartPolicy": "never",
  "serviceManager": { "kind": "systemd", "unit": "$UNIT" }
}
EOF
chown root:anxos-agent "$INSTANCE_ROOT/$INSTANCE_ID/config.json"; chmod 640 "$INSTANCE_ROOT/$INSTANCE_ID/config.json"
RECORD_SHA="$(sha256sum "$INSTANCE_ROOT/$INSTANCE_ID/config.json" | cut -d' ' -f1)"
LIST="$(api GET /api/v1/instances | body)"
INST="$(echo "$LIST" | "$AGENT_NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify((JSON.parse(d).instances||[]).find(i=>i.id==="'$INSTANCE_ID'")||{})))')"
expect "listed as Running per systemd" Running "$(echo "$INST" | jget state)"
expect "Agent holds no PID" "" "$(echo "$INST" | jget pid)"
expect "systemd MainPID reported (informational)" "$(mainpid)" "$(echo "$INST" | jget serviceStatus.externalMainPid)"
for _ in 1 2 3; do api GET /api/v1/instances >/dev/null; sleep 1; done
expect "record hash stable across polls" "$RECORD_SHA" "$(sha256sum "$INSTANCE_ROOT/$INSTANCE_ID/config.json" | cut -d' ' -f1)"
LOGS="$(api GET "/api/v1/instances/$INSTANCE_ID/logs?limit=50" | body)"
echo "$LOGS" | grep -q "fake-fxserver READY" && ok "journal served through the sudo-pinned command" || bad "journal not served" "$(echo "$LOGS" | head -c 200)"
echo "$LOGS" | grep -q "hunter2secretvalue" && bad "secret leaked in logs" || ok "secret redacted in served logs"
R="$(api POST /api/v1/instances/$INSTANCE_ID/start '{}')"
expect "start on the running service -> 409" 409 "$(echo "$R" | code)"
expect "start on the running service -> INSTANCE_ALREADY_RUNNING" INSTANCE_ALREADY_RUNNING "$(echo "$R" | body | jget error.code)"
for op in 'POST command {"command":"refresh"}' 'POST force-kill {}'; do set -- $op; R="$(api "$1" "/api/v1/instances/$INSTANCE_ID/$2" "$3")"; expect "$2 refused (409)" 409 "$(echo "$R" | code)"; done
R="$(api POST /api/v1/backups "{\"instanceId\":\"$INSTANCE_ID\",\"type\":\"full\"}")"
expect "backup refused (409)" 409 "$(echo "$R" | code)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/restart-schedules '{"type":"daily","time":"04:00"}')"
expect "scheduled restart refused (409)" 409 "$(echo "$R" | code)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/forget '{}')"
[ -f "$INSTANCE_ROOT/$INSTANCE_ID/config.json" ] && ok "agent cannot remove its root-owned record" || bad "record removed by the agent"
runuser -u anxos-agent -- sh -c "echo tamper >> $INSTANCE_ROOT/$INSTANCE_ID/config.json" 2>/dev/null && bad "agent could modify its record" || ok "agent cannot modify its record"
expect "phase 4 left the service untouched (same MainPID, start time, one process)" "$FX0" "$(fx_state)"

echo "== phase 5: lifecycle control (rehearsal only; production needs its own window)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/restart '{}')"
expect "agent restart -> 2xx" 1 "$([ "$(echo "$R" | code)" -lt 300 ] && echo 1 || echo 0)"
wait_for 15 test "$(active)" = "active"
expect "exactly one process after restart" 1 "$(procs)"
expect "MainPID changed (a real systemd restart)" 1 "$([ "$(mainpid)" != "${FX0%%|*}" ] && echo 1 || echo 0)"
FX1="$(fx_state)"

echo "== rollback: remove the record FIRST, then downgrade the package"
rm -rf "${INSTANCE_ROOT:?}/$INSTANCE_ID"
sed -i '/^AGENT_SYSTEMD_UNIT_ALLOWLIST=/d;/^AGENT_SYSTEMD_ELEVATION=/d' /etc/anxos-agent/agent.env
rm -f /etc/sudoers.d/60-anxos-agent-fxserver
visudo -c >/dev/null 2>&1 && ok "sudoers valid after removing the drop-in" || bad "sudoers broken after rollback"
OUT="$(dpkg -i "$OFFICIAL_DEB" 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "official package reinstalled (downgrade, dpkg exit 0)" || bad "downgrade failed (dpkg exit $RC)" "$(echo "$OUT" | tail -3 | tr '\n' ' ')"
wait_for 30 healthy && ok "agent healthy after rollback" || { bad "agent not healthy after rollback"; journalctl -u anxos-agent -n 30 --no-pager; }
expect "build is back to the official one" "2.0-build205" "$(installed_build)"
expect "deployed file hashes restored exactly" "$OFFICIAL_SHAS" "$(cd /usr/lib/anxos-agent && sha256sum src/shared/instances/instanceServiceCore.js agent/src/routes/instances.js agent/src/routes/health.js agent/src/services/backupService.js agent/src/services/restartScheduleService.js src/services/serviceRouter.js | cut -c1-16 | tr '\n' ' ')"
[ -f /usr/lib/anxos-agent/src/shared/instances/serviceManagedRuntime.js ] && bad "new module still present after rollback" || ok "new module removed by the rollback"
expect "agent token and env survived the downgrade" "$TOKEN" "$(grep '^AGENT_TOKEN=' /etc/anxos-agent/agent.env | cut -d= -f2)"
expect "rollback left the service untouched" "$FX1" "$(fx_state)"
expect "official agent manages nothing again" "[]" "$(api GET /api/v1/instances | body | jget instances)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
