#!/usr/bin/env bash
# End-to-end proof for service-managed instances on REAL systemd.
#
# Runs the real agent server (non-root user, sudoers-pinned control) against a
# stand-in FXServer systemd unit and proves:
#   * the Agent never launches the workload (exactly one process, always),
#   * status mirrors systemd and never adopts a PID,
#   * start on a running service is refused and changes nothing,
#   * start/stop/restart go through systemctl only,
#   * killing the Agent never touches the service,
#   * the sudoers rule is least-privilege,
#   * the port-conflict check fails closed on a socket owned by another user.
#
# DISPOSABLE LINUX VM ONLY. It creates users, a unit and a sudoers file.
#   ANX_E2E_DISPOSABLE=1 NODE=/path/to/node APP=/path/to/repo bash tools/service-managed/linux-systemd-e2e.sh
#   Optional: BASELINE=/path/to/original/tree  (re-runs the port check on the old code)

set -uo pipefail

[ "${ANX_E2E_DISPOSABLE:-}" = "1" ] || { echo "refusing: set ANX_E2E_DISPOSABLE=1 (disposable Linux VM only)"; exit 2; }
[ "$(id -u)" = "0" ] || { echo "refusing: must run as root in the disposable VM"; exit 2; }
[ ! -e /etc/anxos-agent ] || { echo "refusing: /etc/anxos-agent exists, this looks like a real AnxOS node"; exit 2; }
[ ! -e /usr/lib/anxos-agent ] || { echo "refusing: /usr/lib/anxos-agent exists, this looks like a real AnxOS node"; exit 2; }
case "$(hostname)" in vps-*|ovh*|anxlab*) echo "refusing: hostname $(hostname) looks like a real node"; exit 2 ;; esac

NODE="${NODE:-/opt/anxtest/node/bin/node}"
APP="${APP:-/opt/anxtest/app}"
BASELINE="${BASELINE:-}"
UNIT="anxrp-fxtest.service"
PORT=30120
API_PORT=47199
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WORK=/var/lib/anxtest
INSTANCE_ID=fivem-fxserver
PASS=0
FAIL=0
AGENT_PID=""

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1  ${2:-}"; }
expect() { # description, expected, actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(expected '$2', got '$3')"; fi
}

jget() { "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:(Array.isArray(a)&&/^\d+$/.test(k)?a[+k]:a[k]),o);console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)))}catch(e){console.log("")}})' "$1"; }
api() { # METHOD PATH
  curl -sS -m 120 -X "$1" -H "x-agent-token: $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$API_PORT$2" -w '\n%{http_code}'
}
body() { sed '$d'; }
# state/field of an instance response, whether or not it is wrapped in {instance:...}
ifield() { local j; j="$(cat)"; local v; v="$(echo "$j" | jget "instance.$1")"; [ -n "$v" ] && echo "$v" || echo "$j" | jget "$1"; }
agent_pid() { pgrep -u agenttest -f "$APP/agent/src/server.js" | head -1; }
stop_agent() { pkill -u agenttest -f "$APP/agent/src/server.js" 2>/dev/null; for _ in $(seq 1 50); do [ -z "$(agent_pid)" ] && return 0; sleep 0.1; done; return 1; }
code() { tail -n1; }
mainpid() { systemctl show "$UNIT" -p MainPID --value; }
active() { systemctl show "$UNIT" -p ActiveState --value; }
procs() { pgrep -fc "fake-fxserver.py" || true; }
wait_for() { # seconds, command...
  local limit="$1"; shift
  for _ in $(seq 1 $((limit * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done
  return 1
}

cleanup() {
  stop_agent
  systemctl stop "$UNIT" 2>/dev/null
  rm -f "/etc/systemd/system/$UNIT" /etc/sudoers.d/anxos-agent-test
  systemctl daemon-reload 2>/dev/null
  rm -rf "$WORK" /opt/anxtest/fake-fxserver.py
  userdel -r agenttest 2>/dev/null
  userdel -r fxtest 2>/dev/null
}
trap cleanup EXIT

start_agent() { # allowlist elevation
  stop_agent || echo "WARN: previous agent did not exit"
  runuser -u agenttest -- env \
    AGENT_HOST=127.0.0.1 AGENT_PORT=$API_PORT AGENT_TOKEN="$TOKEN" AGENT_API_PERMISSIONS='*' \
    ANXHUB_CONFIG_DIR=$WORK/config AGENT_INSTANCE_ROOT=$WORK/instances AGENT_BACKUP_ROOT=$WORK/backups ANXOS_LOG_DIR=$WORK/log \
    AGENT_SYSTEMD_UNIT_ALLOWLIST="$1" AGENT_SYSTEMD_ELEVATION="$2" NODE_ENV=production HOME=$WORK/home \
    "$NODE" "$APP/agent/src/server.js" >"$WORK/agent.log" 2>&1 &
  wait_for 15 curl -sf -m 2 -H "x-agent-token: $TOKEN" "http://127.0.0.1:$API_PORT/api/v1/health"
}

echo "== setup (users, stand-in FXServer unit, sudoers)"
id fxtest >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin fxtest
id agenttest >/dev/null 2>&1 || useradd -r -m -s /bin/bash agenttest
mkdir -p "$WORK"/{config,instances,backups,log,home} /opt/anxtest
chown -R agenttest:agenttest "$WORK"
chmod 700 "$WORK/config"

cat > /opt/anxtest/fake-fxserver.py <<'PY'
import socket, sys, time, os
t = socket.socket(socket.AF_INET, socket.SOCK_STREAM); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
t.bind(("0.0.0.0", 30120)); t.listen(8)
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("0.0.0.0", 30120))
print("fake-fxserver READY pid=%d api_key=hunter2secretvalue" % os.getpid(), flush=True)
while True:
    time.sleep(5); print("fake-fxserver heartbeat", flush=True)
PY
cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=AnxRP FXServer stand-in (TEST)
[Service]
User=fxtest
ExecStart=/usr/bin/python3 /opt/anxtest/fake-fxserver.py
Restart=on-failure
RestartSec=2
KillSignal=SIGINT
StandardOutput=journal
SyslogIdentifier=anxrp-fxtest
EOF
cat > /etc/sudoers.d/anxos-agent-test <<EOF
agenttest ALL=(root) NOPASSWD: /usr/bin/systemctl start $UNIT, /usr/bin/systemctl stop $UNIT, /usr/bin/systemctl restart $UNIT, /usr/bin/journalctl -u $UNIT -n 200 -o short-iso --no-pager -q
EOF
chmod 440 /etc/sudoers.d/anxos-agent-test
visudo -cf /etc/sudoers.d/anxos-agent-test >/dev/null && ok "sudoers drop-in validates (visudo -cf)" || bad "sudoers drop-in invalid"
systemctl daemon-reload
systemctl start "$UNIT"
wait_for 10 test "$(active)" = "active" && ok "stand-in service active under systemd" || bad "stand-in service did not start"
MAIN0="$(mainpid)"
expect "exactly one workload process before the Agent exists" 1 "$(procs)"

cat > "$WORK/instances/.record.json" <<EOF
{ "id": "$INSTANCE_ID", "type": "systemd-service", "templateId": "fivem", "displayName": "AnxRP (test)",
  "serverSoftware": "FiveM FXServer", "schemaVersion": 2, "installationState": "active", "workingDirectory": "data",
  "ports": [$PORT], "autoStart": false, "restartPolicy": "never",
  "serviceManager": { "kind": "systemd", "unit": "$UNIT" } }
EOF
mkdir -p "$WORK/instances/$INSTANCE_ID/data" "$WORK/instances/$INSTANCE_ID/logs"
mv "$WORK/instances/.record.json" "$WORK/instances/$INSTANCE_ID/config.json"
# Production ownership model: the instance record and tree are root-owned and
# read-only to the Agent; only logs/ and the shared jobs/ dir are Agent-writable.
mkdir -p "$WORK/instances/jobs"
chown agenttest:agenttest "$WORK/instances" "$WORK/instances/jobs" "$WORK/instances/$INSTANCE_ID/logs"
chown root:agenttest "$WORK/instances/$INSTANCE_ID" "$WORK/instances/$INSTANCE_ID/data" "$WORK/instances/$INSTANCE_ID/config.json"
chmod 750 "$WORK/instances/$INSTANCE_ID" "$WORK/instances/$INSTANCE_ID/data" "$WORK/instances/$INSTANCE_ID/logs"
chmod 640 "$WORK/instances/$INSTANCE_ID/config.json"
runuser -u agenttest -- sh -c "echo tamper >> $WORK/instances/$INSTANCE_ID/config.json" 2>/dev/null && bad "agent could modify its own instance record" || ok "agent cannot modify the root-owned instance record"
RECORD_SHA="$(sha256sum "$WORK/instances/$INSTANCE_ID/config.json" | cut -d' ' -f1)"

echo "== agent up (non-root user, sudo elevation, allowlist=$UNIT)"
start_agent "$UNIT" sudo && ok "agent API healthy as non-root user" || { bad "agent did not start"; cat "$WORK/agent.log"; exit 1; }
AGENT_PID="$(agent_pid)"
expect "agent runs as agenttest, not root" agenttest "$(ps -o user= -p "$AGENT_PID" | tr -d ' ')"

echo "== observe"
R="$(api GET /api/v1/instances)"
LIST="$(echo "$R" | body)"
INST="$(echo "$LIST" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify((JSON.parse(d).instances||[]).find(i=>i.id==="'$INSTANCE_ID'")||{})))')"
expect "list: instance Running per systemd" Running "$(echo "$INST" | jget state)"
expect "list: Agent holds no PID" "" "$(echo "$INST" | jget pid)"
expect "list: no runtimeProcess" "" "$(echo "$INST" | jget runtimeProcess)"
expect "list: systemd MainPID is reported as informational" "$MAIN0" "$(echo "$INST" | jget serviceStatus.externalMainPid)"
expect "observing does not rewrite the record" "$RECORD_SHA" "$(sha256sum "$WORK/instances/$INSTANCE_ID/config.json" | cut -d' ' -f1)"
expect "observing leaves exactly one process and the same MainPID" "1:$MAIN0" "$(procs):$(mainpid)"

echo "== start on a running service must NOT launch a second copy"
R="$(api POST /api/v1/instances/$INSTANCE_ID/start '{}')"
expect "start while running -> 409" 409 "$(echo "$R" | code)"
expect "start while running -> INSTANCE_ALREADY_RUNNING" INSTANCE_ALREADY_RUNNING "$(echo "$R" | body | jget error.code)"
expect "still exactly one process, MainPID unchanged" "1:$MAIN0" "$(procs):$(mainpid)"

echo "== operations that need an owned process are refused"
for op in "POST command {\"command\":\"refresh\"}" "POST force-kill {}"; do
  set -- $op
  R="$(api "$1" "/api/v1/instances/$INSTANCE_ID/$2" "$3")"
  expect "$2 -> 409" 409 "$(echo "$R" | code)"
done
R="$(api DELETE /api/v1/instances/$INSTANCE_ID)"
expect "delete -> refused (not 2xx)" 1 "$([ "$(echo "$R" | code)" -ge 400 ] && echo 1 || echo 0)"
[ -d "$WORK/instances/$INSTANCE_ID" ] && ok "delete left the instance tree in place" || bad "delete removed the tree"
expect "refusals left exactly one process, MainPID unchanged" "1:$MAIN0" "$(procs):$(mainpid)"

R="$(api POST /api/v1/instances/$INSTANCE_ID/forget '{}')"
[ -f "$WORK/instances/$INSTANCE_ID/config.json" ] && ok "agent cannot forget (delete) the root-owned record; unit untouched" || bad "record was removed by the agent"

echo "== logs come from the journal (sudo-pinned argv), redacted"
R="$(api GET "/api/v1/instances/$INSTANCE_ID/logs?limit=50")"
LOGS="$(echo "$R" | body)"
echo "$LOGS" | grep -q "fake-fxserver READY" && ok "journal lines served" || bad "no journal lines" "$(echo "$LOGS" | head -c 300)"
echo "$LOGS" | grep -q "hunter2secretvalue" && bad "secret leaked in logs" || ok "api_key value redacted from served logs"

echo "== killing the Agent never touches the service"
kill -9 "$(agent_pid)"; sleep 1
expect "agent process is gone" "" "$(agent_pid)"
expect "service still active after agent SIGKILL, same MainPID" "active:$MAIN0:1" "$(active):$(mainpid):$(procs)"
start_agent "$UNIT" sudo || bad "agent restart failed"
AGENT_PID="$(agent_pid)"
expect "agent restart: still exactly one process, same MainPID" "1:$MAIN0" "$(procs):$(mainpid)"

echo "== stop via systemd"
R="$(api POST /api/v1/instances/$INSTANCE_ID/stop '{}')"
expect "stop -> 2xx" 1 "$([ "$(echo "$R" | code)" -lt 300 ] && echo 1 || echo 0)"
expect "service inactive, zero processes, port released" "inactive:0" "$(active):$(procs)"
R="$(api GET /api/v1/instances/$INSTANCE_ID/status)"
expect "status Stopped" Stopped "$(echo "$R" | body | ifield state)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/stop '{}')"
expect "stop again is a no-op (2xx)" 1 "$([ "$(echo "$R" | code)" -lt 300 ] && echo 1 || echo 0)"

echo "== start via systemd (the only launcher)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/start '{}')"
expect "start -> 2xx" 1 "$([ "$(echo "$R" | code)" -lt 300 ] && echo 1 || echo 0)"
wait_for 10 test "$(active)" = "active"
MAIN1="$(mainpid)"
expect "exactly one process after start" 1 "$(procs)"
expect "new MainPID differs (a real systemd start)" 1 "$([ "$MAIN1" != "$MAIN0" ] && echo 1 || echo 0)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/start '{}')"
expect "second start -> 409" 409 "$(echo "$R" | code)"
expect "second start left one process, same MainPID" "1:$MAIN1" "$(procs):$(mainpid)"
expect "the Agent's own child list is empty (Agent PID has no workload child)" 0 "$(pgrep -P "$AGENT_PID" | wc -l | tr -d ' ')"

echo "== restart is one systemd restart"
R="$(api POST /api/v1/instances/$INSTANCE_ID/restart '{}')"
expect "restart -> 2xx" 1 "$([ "$(echo "$R" | code)" -lt 300 ] && echo 1 || echo 0)"
wait_for 10 test "$(active)" = "active"
MAIN2="$(mainpid)"
expect "exactly one process after restart" 1 "$(procs)"
expect "MainPID changed on restart" 1 "$([ "$MAIN2" != "$MAIN1" ] && echo 1 || echo 0)"

echo "== external crash: systemd (not the Agent) restarts it"
kill -9 "$MAIN2"
wait_for 15 sh -c "[ \"\$(systemctl show $UNIT -p MainPID --value)\" != \"$MAIN2\" ] && [ \"\$(systemctl show $UNIT -p ActiveState --value)\" = active ]"
MAIN3="$(mainpid)"
expect "systemd auto-restarted it: one process, new PID" 1 "$([ "$MAIN3" != "$MAIN2" ] && [ "$(procs)" = 1 ] && echo 1 || echo 0)"
R="$(api GET /api/v1/instances/$INSTANCE_ID/status)"
expect "agent reports the systemd-restarted service as Running" Running "$(echo "$R" | body | ifield state)"
expect "agent reports systemd's new PID only as informational" "$MAIN3" "$(echo "$R" | body | ifield serviceStatus.externalMainPid)"

echo "== sudoers is least-privilege"
runuser -u agenttest -- sudo -n /usr/bin/systemctl restart ssh.service >/dev/null 2>&1 && bad "agent could restart ssh.service" || ok "agent cannot control other units"
runuser -u agenttest -- sudo -n /usr/bin/systemctl disable "$UNIT" >/dev/null 2>&1 && bad "agent could disable the unit" || ok "agent cannot disable/mask the unit"
runuser -u agenttest -- sudo -n /usr/bin/systemctl kill "$UNIT" >/dev/null 2>&1 && bad "agent could kill the unit" || ok "agent cannot systemctl kill the unit"
runuser -u agenttest -- sudo -n /usr/bin/journalctl -u ssh.service -n 5 >/dev/null 2>&1 && bad "agent could read other journals" || ok "agent cannot read other units' journals"
runuser -u agenttest -- sudo -n /usr/bin/journalctl -u "$UNIT" -n 200 -o short-iso --no-pager -q >/dev/null 2>&1 && ok "agent can read exactly the pinned journal command" || bad "pinned journal command denied"

echo "== port check fails closed on a socket owned by another user (real /proc, non-root agent)"
portcheck() { # source tree
  cat > "$WORK/portcheck.js" <<JS
process.env.AGENT_INSTANCE_ROOT = "$WORK/instances";
const core = require("$1/src/shared/instances/instanceServiceCore");
core._test.findUnrelatedPortConflicts({ id: "web", type: "custom-command", ports: [$PORT] })
  .then((c) => console.log(JSON.stringify(c)), (e) => console.log(JSON.stringify({ threw: e.code })));
JS
  chmod 644 "$WORK/portcheck.js"
  runuser -u agenttest -- "$NODE" "$WORK/portcheck.js" 2>&1 | tail -1
}
PC="$(portcheck "$APP")"
echo "      new code, as agenttest: $PC"
echo "$PC" | grep -q '"ownerUnknown":true' && ok "NEW code: another user's socket is an unknown-owner conflict" || bad "new code did not flag the unknown owner" "$PC"
if [ -n "$BASELINE" ]; then
  PCB="$(portcheck "$BASELINE")"
  echo "      ORIGINAL code, as agenttest: $PCB"
  [ "$PCB" = "[]" ] && ok "ORIGINAL code: reported NO conflict (the fail-open this change fixes)" || bad "baseline comparison unexpected" "$PCB"
fi

echo "== allowlist is enforced by the Agent"
start_agent "" sudo || bad "agent restart failed"
R="$(api GET /api/v1/instances/$INSTANCE_ID/status)"
expect "empty allowlist -> state Unknown" Unknown "$(echo "$R" | body | ifield state)"
expect "empty allowlist -> SERVICE_UNIT_NOT_ALLOWED" SERVICE_UNIT_NOT_ALLOWED "$(echo "$R" | body | ifield failureReason)"
R="$(api POST /api/v1/instances/$INSTANCE_ID/restart '{}')"
expect "restart refused while unverified" 1 "$([ "$(echo "$R" | code)" -ge 400 ] && echo 1 || echo 0)"
expect "service untouched by refused restart" "$MAIN3" "$(mainpid)"

echo "== no privilege -> control denied, service untouched"
start_agent "$UNIT" none || bad "agent restart failed"
R="$(api POST /api/v1/instances/$INSTANCE_ID/restart '{}')"
expect "restart without sudo/polkit -> SERVICE_CONTROL_DENIED" SERVICE_CONTROL_DENIED "$(echo "$R" | body | jget error.code)"
expect "service untouched by denied restart" "$MAIN3" "$(mainpid)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
