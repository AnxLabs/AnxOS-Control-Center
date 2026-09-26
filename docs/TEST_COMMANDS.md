# Tester Commands

Commands use placeholders such as `<repo>`, `<agent-url>`, and `<service-name>`. Do not paste tokens, passwords, API keys, or private URLs into bug reports.

## Windows PowerShell

Repository status:

```powershell
cd <repo>
git status --short --branch
git rev-parse HEAD
git rev-list --left-right --count origin/dev...HEAD
```

Install dependencies:

```powershell
npm install
```

Start development app:

```powershell
npm start
```

Run relevant smoke suites:

```powershell
npm run ui:polish:smoke
npm run website:smoke
npm run account:smoke
npm run marketplace:smoke
npm run marketplace:error-bridge:smoke
npm run dependencies:smoke
npm run public-access:smoke
npm run diagnostics:smoke
npm run agent-control:smoke
npm run node-health:smoke
npm run windows-runtime:smoke
```

Capture logs:

```powershell
Get-ChildItem .dev-logs -Force
Get-Content .dev-logs\latest-error.json -ErrorAction SilentlyContinue
Get-Content .dev-logs\runtime-state.json -ErrorAction SilentlyContinue
Get-Content .dev-logs\live.log -Tail 120 -ErrorAction SilentlyContinue
```

Check listening ports:

```powershell
Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalAddress,LocalPort,OwningProcess
```

Check Node.js and npm versions:

```powershell
node --version
npm --version
```

Check Git branch and commit:

```powershell
git branch --show-current
git log --oneline -5
```

## Debian Shell

Repository status:

```sh
cd <repo>
git status --short --branch
git rev-parse HEAD
git rev-list --left-right --count origin/dev...HEAD
```

Start or restart Agent. Without `AGENT_HOST` a standalone Agent binds loopback
only (`127.0.0.1`); the line below is the explicit opt-in for remote
reachability, and a concrete LAN/tailnet address is safer than `0.0.0.0` (it
also gets the strict Host allowlist):

```sh
cd <repo>/agent
# Explicit opt-in: bind every interface. Prefer a concrete address for a remote node.
AGENT_HOST=0.0.0.0 AGENT_PORT=<port> npm start
```

If using the systemd user service:

```sh
systemctl --user restart anxos-agent.service
```

Check Agent service status:

```sh
systemctl --user status anxos-agent.service --no-pager
curl -fsS http://127.0.0.1:<port>/api/v1/health
```

Tail Agent logs:

```sh
tail -n 120 <repo>/.dev-logs/agent.log
tail -n 120 <repo>/.dev-logs/live.log
```

Check listening ports:

```sh
ss -ltnp
```

Check installed dependency versions:

```sh
node --version
npm --version
python3 --version
tar --version
unzip -v | head -n 2
```

Test Java:

```sh
java -version
```

Test SteamCMD:

```sh
steamcmd +quit
```

Test dotnet:

```sh
dotnet --info
```

Test Docker or Podman:

```sh
docker --version
docker ps
podman --version
podman ps
```

Check Playit status:

```sh
playit --version
playit status
systemctl --user status playit --no-pager
```

Reboot recovery checks:

```sh
sudo reboot
```

After reconnecting:

```sh
systemctl --user status anxos-agent.service --no-pager
curl -fsS http://127.0.0.1:<port>/api/v1/health
ss -ltnp
tail -n 120 <repo>/.dev-logs/live.log
```

## Headless Agent (Linux `.deb`)

Install and pairing steps are in `docs/HEADLESS_AGENT_INSTALL.md`. These commands
use the packaged Agent's loopback default. `sudo` is required for service
control and the full status; pairing works without `sudo` via loopback.

```sh
anxos-agent --help
anxos-agent --version
anxos-agent status
sudo anxos-agent service status
sudo anxos-agent service start
sudo anxos-agent service stop
sudo anxos-agent service restart
anxos-agent pair
anxos-agent logs
anxos-agent diagnostics
anxos-agent update --check
anxos-agent unpair
```

System-level service and log checks:

```sh
sudo systemctl status anxos-agent.service --no-pager
sudo journalctl -u anxos-agent.service --since '<UTC start>' --until '<UTC end>'
ss -ltnp | grep <agent-port>
ls -la /var/log/anxos-agent
anxos-agent logs
```

Data locations: `/var/lib/anxos-agent/{config,instances,backups}` and
`/etc/anxos-agent/agent.env`.

Package upgrade restart: on upgrade the `.deb` `postinst` attempts
`systemctl try-restart anxos-agent.service` so the new payload is live
immediately; fresh installs are unchanged. Verify without restarting manually:

```sh
sudo apt install ./AnxOS-Agent-<newer>.deb
anxos-agent --version
systemctl show -p MainPID -p ActiveEnterTimestamp anxos-agent.service
```

A successful restart prints `AnxOS Agent upgraded: the running service was
restarted to load the new package.`; `MainPID` and `ActiveEnterTimestamp` must
change. On hosts without systemd the restart is a best-effort no-op.

Headless Agent smoke coverage (run them the same way as other smokes, by npm
script name):

- `agent:package:smoke` — Agent `.deb` payload closure and package contract.
- `agent:cli:smoke` — the `anxos-agent` command surface against a real,
  isolated Agent process.
- `agent:cli-pairing:smoke` — CLI pairing, single-use codes, the credential
  gate, and token provenance across restarts.
- `agent:service:smoke` — service-manager unit detection, root gates, and the
  guarantee that uninstall removes only the unit file.
- `agent:update:smoke` — `update --check` states and the no-downgrade rule.
- `agent:unpair:smoke` — unpair confirmation, revocation, credential clearing,
  data preservation, and config ownership.
- `agent:tui:smoke` — TUI rendering across terminal widths and heights.
- `agent:golden-path:smoke` — real Agent boot, Control-Center-style pairing,
  enrollment, a minimal instance lifecycle, and restart persistence.
- `add-computer:smoke` — the Add Computer two-path flow contract in the GUI.

Pairing codes are one-time, valid for 10 minutes, and must never be recorded in
test evidence. Redact codes and tokens from screenshots and logs.
