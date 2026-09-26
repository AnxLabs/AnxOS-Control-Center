# Test Matrix

| Area | Primary commands |
| --- | --- |
| Shared operations | `npm run operations:framework:smoke`, `npm run operations:domain-cancellation:smoke` |
| Node selection/races | `npm run node:switch:smoke`, `npm run node:application-host-identity:smoke`, `npm run node:stale-response:smoke`, `npm run cross-page:selected-target:smoke` |
| Node migration | `npm run node:legacy-migration:smoke`, `npm run node:startup-selection:smoke` |
| Agent authentication and live recovery | `npm run agent:token:smoke`, `npm run agent-errors:smoke`, `npm run node:agent-pairing:smoke`, `npm run agent-control:canonical-credential:smoke` |
| Multi-node health isolation | `npm run node:independent-health:smoke` |
| Agent API authorization | `npm run agent:api-authorization:smoke` |
| Marketplace | `npm run marketplace:smoke`, `npm run marketplace:error-bridge:smoke`, `npm run marketplace:install-selected-node:smoke`, `npm run curseforge:server-pack-resolution:smoke` |
| Marketplace certification | `npm run marketplace:certification:smoke` |
| Instances | `npm run instances:runtime:smoke`, `npm run instances:deletion:smoke`, `npm run instances:file-security:smoke` |
| Instance metadata migration | `npm run instances:config-migration:smoke` |
| Instance shutdown ownership | `npm run instances:shutdown:smoke` |
| Renderer resource cleanup | `npm run renderer:resource-cleanup:smoke` |
| Dependency cancellation listener cleanup | `npm run dependencies:abort-listener:smoke` |
| Filesystem | `npm run agent:files-root:smoke`, `npm run files:smoke` |
| Files IPC authorization | `npm run files:ipc-authorization:smoke` |
| Files IPC error contract | `npm run files:ipc-error-contract:smoke` |
| SSH IPC error contract | `npm run ssh:ipc-error-contract:smoke` |
| Operational read authorization | `npm run operational-reads:ipc-authorization:smoke` |
| Public Access mutation authorization | `npm run public-access:ipc-authorization:smoke` |
| AMP/Playit IPC error contract | `npm run compatibility:ipc-error-contract:smoke` |
| AMP native API client | `npm run amp:api-client:smoke` |
| Expected Agent read contract | `npm run agent:expected-error-contract:smoke` |
| Backup/security | `node scripts/security-backup-smoke.js`, `npm run backups:transfer-safety:smoke`, `npm run security:page:smoke` |
| Diagnostics authorization | `npm run diagnostics:ipc-authorization:smoke` |
| Diagnostics IPC error contract | `npm run diagnostics:ipc-error-contract:smoke` |
| Update IPC authorization/error contract | `npm run updates:ipc-authorization:smoke` |
| Agent Control authorization/error contract | `npm run agent-control:ipc-authorization:smoke`, `npm run agent-control:ipc-error-contract:smoke` |
| Storage child-window authorization | `npm run storage-window:ipc-authorization:smoke` |
| Maintenance IPC contract | `npm run maintenance:ipc-contract:smoke` |
| Settings IPC error contract | `npm run settings:ipc-error-contract:smoke` |
| Settings IPC authorization | `npm run settings:ipc-authorization:smoke` |
| Generic action authorization | `npm run action:ipc-authorization:smoke` |
| Generic action IPC error contract | `npm run action:ipc-error-contract:smoke` |
| Agent Control IPC error contract | `npm run agent-control:ipc-error-contract:smoke` |
| Backup IPC authorization | `npm run backups:ipc-authorization:smoke` |
| IPC error contract | `npm run ipc:error-contract:smoke` |
| Node IPC error contract | `npm run nodes:ipc-error-contract:smoke` |
| Node IPC authorization | `npm run nodes:ipc-authorization:smoke` |
| Instance IPC error contract | `npm run instances:ipc-error-contract:smoke` |
| Docker IPC error contract | `npm run docker:ipc-error-contract:smoke` |
| Docker IPC authorization | `npm run docker:ipc-authorization:smoke` |
| Security IPC error contract | `npm run security:ipc-error-contract:smoke` |
| Account IPC error contract | `npm run account:ipc-error-contract:smoke` |
| Owner Workspace IPC error contract | `npm run owner:ipc-error-contract:smoke` |
| Marketplace IPC error contract | `npm run marketplace:ipc-error-contract:smoke` |
| Marketplace IPC authorization | `npm run marketplace:ipc-authorization:smoke` |
| Dependency IPC error contract | `npm run dependencies:ipc-error-contract:smoke` |
| Renderer safety/UI | `npm run renderer-safety:smoke`, `npm run ui:polish:smoke` |
| Modal keyboard/focus behavior | `npm run ui:modal-behavior:smoke` |
| Architecture documentation | `npm run docs:architecture:smoke` |
| Packaging source/fixture | `npm run packaging:smoke`, `npm run release:artifacts:smoke`, `npm run versioning:smoke`, `npm run updates:download-safety:smoke` |
| Headless Agent packaging | `npm run agent:package:smoke` |
| Agent package upgrade restart | `npm run agent:package:smoke`; on-node after `sudo apt install ./AnxOS-Agent-<newer>.deb`: `systemctl show -p MainPID -p ActiveEnterTimestamp anxos-agent.service` |
| Headless Agent CLI/TUI | `npm run agent:cli:smoke`, `npm run agent:cli-pairing:smoke`, `npm run agent:tui:smoke`, `npm run agent:golden-path:smoke` |
| Headless Agent service/update/unpair | `npm run agent:service:smoke`, `npm run agent:update:smoke`, `npm run agent:unpair:smoke` |
| Add Computer flow | `npm run add-computer:smoke` |
| Exact candidate artifacts | `npm run artifacts:validate` (requires built artifacts; absence is `PRECONDITION_NOT_MET`) |
| Full source-tree RC gate | `npm run rc:validate` |
| Agent-focused gate | `npm run agent:validate` |

Adversarial fixtures cover missing targets, delayed node responses, offline and
unauthorized Agents, incompatible versions, symlink escape, malformed archives,
concurrent backups, failed instance stop before restore, rollback recovery,
crash-loop backoff, pending restart cancellation, and clean Agent SIGTERM.
The Agent Control credential fixture specifically holds an unauthorized registry
probe open, repairs the protected node credential, records a successful
authenticated Agent Control probe, and proves that Nodes/global-shell state stays
online after the delayed failure completes.

`rc:validate` runs every repository `*:smoke` command and stops at the first
failure. Artifact and real-machine validation are separate gates because source
tests cannot prove a generated installer, operating-system integration, signing,
SmartScreen, or external reachability.
