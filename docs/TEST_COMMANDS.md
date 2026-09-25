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
