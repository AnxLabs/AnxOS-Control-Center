# Phase 4 status: computer agents and dashboard

Handover for the next development agent, 2026-11-12, branch
`claude/anxos-control-center-simplify-8080f1`. No AI features were added.

## Commits

| Commit | What |
| --- | --- |
| `e4142963` | Honest CPU, network and GPU metrics with shared samples (Agent) |
| `3a5f5959` | Live Home dashboard and Computers details on one reading store |
| `673a76b4` | One shared sampler for the Agent and this PC (no PowerShell per poll) |

## 4.1 Agent metrics: audit and fixes

| Measurement | Before | Now |
| --- | --- | --- |
| CPU total | One global baseline; a second client reset it and got noise | Shared sample reused within 900 ms; null + `warming_up` until two samples exist |
| CPU per core | Missing | `cpu.perCore` |
| RAM used / available / total | Present | Unchanged |
| Disk | Present | Unchanged |
| Network throughput | Linux only; **a made-up `0 B/s`** on Windows and on every first reading | Linux `/proc/net/dev`, Windows `netstat -e`; null with a reason when unmeasured; a counter wrap gives no rate |
| CPU / GPU temperature | Present (Windows sensors, Linux thermal zones, Forge) | Unchanged |
| GPU utilization and VRAM | Missing | NVIDIA through `nvidia-smi` (cached 10 s); other vendors report `no_supported_gpu_tool`, never a guess |
| Uptime, OS | Present | Unchanged |
| Managed server process usage | Present (instance metrics) | Unchanged |
| Agent version, capabilities, health | Present (compatibility report, health checks) | Shown on the Computers page |

Measured read-only on the development Windows PC:
- **CPU:** `warming_up` first, then a real percentage across 12 cores.
- **Network:** `netstat_e` rates.
- **GPU:** `no_supported_gpu_tool` (no `nvidia-smi` installed).

## 4.2 Connectivity

Existing and kept unchanged:
- states: connected, connecting, degraded, authentication required, offline
- a reconnect grace window
- automatic credential repair
- tunnel reconnect with backoff
- compatibility checks
- service lifecycle

Added: the same Agent registered twice under different addresses (same
`deviceId`) is shown in Needs attention. Adding the same URL twice was
already refused. Pairing, credentials, SSH restrictions and permissions were
not changed.

## 4.3 – 4.7 Home, Computers, telemetry, alerts, personalization

- **Home:**
  - Overview tiles.
  - Needs attention, which also carries the setup "next step".
  - My Servers, with players where reported and a Start/Stop button.
  - Computers, with live meters, freshness and hosted servers.
  - The setup checklist.
  - The old summary grid and quick actions moved into the collapsed details.
- **Computers page:**
  - A chip per computer, with the viewed computer remembered.
  - Resource cards, per-core bars and the GPU where reported.
  - A CPU/memory graph from a bounded in-memory history (180 readings).
  - OS, processor, uptime, Agent version and address.
  - Servers and alerts.
  - Long-term history stays with the existing Telemetry service and its
    settings.
- **One reading store:**
  - The selected computer's existing poll records into it (every 2 s on
    Home, previously 1 s).
  - Other computers are read every 10 s, one at a time, only while Home or
    Computers is visible and the window is not hidden.
  - The fleet summary refreshes every 30 s.
- **Freshness:**
  - Live, "Last reading N ago", or unavailable.
  - A disconnected computer, and the servers last seen on it, are never
    shown as live or running.
- **Alerts:**
  - Memory above 90% for 1 minute, or CPU above 90% for 2 minutes. Spikes
    never alert.
  - Disk uses the alert engine's 85% / 95% / 2 GB thresholds.
  - Sustained pressure is the one condition the alert engine lacks, so it
    is posted to Activity through the existing notification store.
    Offline and disk alerts stay with the alert engine and are not posted
    twice.
- **Customize:**
  - Show, hide and reorder sections. Needs attention cannot be hidden.
  - The existing density setting.
  - Stored per viewer in `localStorage`.
- **Code layout:**
  - Logic: `src/shared/homeDashboardModel.js`
  - Rendering and polling: `src/renderer/homeDashboard.js`
  - `app.js` gained only small hooks.

## Evidence

- `scripts/agent-metrics-sampler-smoke.js`: injected readers. Covers
  warming up, shared sample, per core, Linux and Windows counters, wraps,
  unsupported platforms and GPU parsing.
- `scripts/home-dashboard-model-smoke.js`: synthetic readings. Covers
  freshness, sustained versus spike, attention items, disk thresholds,
  duplicates, overview and preferences.
- `scripts/marketplace-smoke.js`: an unmeasured rate stays null in the
  desktop normalizer.
- `scripts/simple-ui-screenshots-qa.js` (Electron, isolated QA app):
  - S1: Home layout, and no live numbers for a disconnected computer.
  - S7: Customize.
  - S8: Computers detail panel.
- Simulated screenshots: the QA app runs locked, so its test computers are
  never connected. To review the live design, synthetic readings were
  injected in memory, and those images are labeled SIMULATED. They are not
  measurements.

## Blocked: needs real hardware or owner approval

- **Live readings from real Agents** on Windows, Linux and AnxOS, including:
  - sustained-pressure alerts under a real load
  - the duplicate-registration warning on a real double registration
  - NVIDIA GPU usage on a machine with `nvidia-smi`
- **The Agent changes reach computers only with the next Agent build.**
  Building, signing and deploying need approval.
- **`agent-package-closure-smoke`** must run in a checkout with its own
  `node_modules`. It can't run in a worktree.

## Known limits

- Server lists, and therefore players and crash detection, are only loaded
  for the selected computer. Other computers show their server counts from
  the fleet summary.
- Sustained-pressure notifications are evaluated while Home is open, because
  that is when the selected computer is polled every 2 s.
- GPU usage covers NVIDIA only. AMD and Intel GPUs report "not available"
  instead of an estimate.
