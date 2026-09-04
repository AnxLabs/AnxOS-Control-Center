# V1 Feature Set and UI Labeling Matrix

**Milestone:** V1-B item 1 (docs/MASTER_ROADMAP.md Section 5)
**Recorded:** 2026-09-04
**Application version at recording:** v1.9 build 198, Private Alpha

This document names the explicit V1 feature set and where each feature's maturity
(Supported / Alpha-form / Unsupported) is visible in the UI. It closes V1-B checklist
item 1 ("Define the V1 feature set and label experimental/unsupported features in the
UI"). Evidence rule: every UI-location claim below corresponds to shipped code checked
in this repository at the version above.

## V1 feature set

| # | Feature | V1 maturity | Where the UI communicates it |
| --- | --- | --- | --- |
| 1 | Nodes/agents: pairing, enrollment, health, node routing | Supported | Nodes page; node header pill "Connected · Linux … · Agent 0.1.0"; connectivity toasts |
| 2 | Instances: create/start/stop/reload/delete lifecycle | Supported | Instances page; per-row Start/Stop/Reload actions with security-confirmation dialogs for stop/restart |
| 3 | Instances: per-instance live metrics (CPU/RAM/uptime) and health summary | Supported | Instances page per-row CPU/RAM/UPTIME columns + header totals; "Unavailable" shown when metrics are not live (honest empty state) |
| 4 | Instances: console/logs with search, wrap, pause, auto-scroll, download | Supported | Instance Console tab |
| 5 | Instance files browsing/management | Supported | Files tab (bounded to instance workspace) |
| 6 | Backups: list/create/restore of instance backups | Alpha-form | Backups tab; no retention/schedule UI; restore requires stop (see KNOWN_LIMITATIONS.md) |
| 7 | Game adapters: Minecraft (java app), SteamCMD apps (Palworld/Rust), custom command | Supported | Create Server flow; instance detail TYPE/APP fields |
| 8 | CurseForge modpack/server-pack install via hosted proxy | Alpha-form | Marketplace; tester guide documents proxy dependency |
| 9 | Marketplace: browse/install templates to a selected node | Alpha-form | Marketplace page; `data-state="unsupported"` summary items render an explicit unsupported state (styles.css `.marketplace-summary-item[data-state="unsupported"]`) |
| 10 | Docker containers (view/logs on agent) | Alpha-form (V2-C scope for full lifecycle) | Docker page; container actions limited by agent permissions |
| 11 | SSH shell to managed servers | Supported | SSH page; session lifecycle with confirmation dialogs (historical smoke resolved 2026-09-03) |
| 12 | Public access / tunnels (playit) | Alpha-form | Public Access page; per-instance badges "Tailscale available" / "Local only" / "No tunnel matched"; unsupported providers render `.public-access-unsupported` explainer block; **no provider-side revoke** (documented Phase 11A limit, V2-H scope) |
| 13 | Local owner authentication, session lock/unlock, Security page | Supported | Security page; "Unlock AnxOS" unlock form after restart (NEW_USER_GUIDE.md "After Restarting AnxOS") |
| 14 | Monitoring: hardware telemetry (Windows) | Alpha-form | Monitoring page; Linux hosts report without Windows-specific sensors |
| 15 | Operations: long-running operation records with cancellation | Supported | Operations page; operations.log correlation |
| 16 | Notifications with deduplication | Supported | Notifications page (badge count) |
| 17 | Diagnostics capture with redaction | Supported | Maintenance/Diagnostics flows; `redaction:smoke` |
| 18 | Backups/configuration persistence across restart and upgrade | Supported | Verified live 2026-09-04 (in-place upgrades 194→196→198 preserved data) |
| 19 | Multi-node (multiple agents) | Alpha-form | Node selector on Instances; fleet orchestration is explicitly V2-G |
| 20 | SSH profile management | Supported | SSH page profile store (`config/ssh-profiles.json`) |

## Unsupported in V1 (not shipped, not labeled as available)

- Fleet-wide multi-node orchestration (V2-G)
- Scheduled/retained backups with automatic restore points (V2 scope)
- Provider-side tunnel revocation/teardown from the app (V2-H)
- Role scoping beyond single Owner account (V2-A/V2-I)
- Controlled update/interrupted-update recovery UX (V2-J)
- Linux desktop parity claims for Windows-specific features (startup registration, elevation tray, hardware temperature) — Linux installers exist but these features are Windows-only and the UI/telemetry degrade accordingly.

## Labeling rules used by the UI

1. **Honest empty/unavailable states:** metrics and health values render "Unavailable"
   rather than zero or fabricated data when the agent cannot probe them.
2. **Capability badges on rows:** public-access reachability is stated per instance as
   "Tailscale available", "Local only", or "No tunnel matched" — never a silent guess.
3. **Explicit unsupported blocks:** unsupported providers/components render dedicated
   explainer blocks (`.public-access-unsupported`, marketplace `unsupported` state) that
   name why the feature is unavailable.
4. **Confirmation gates on destructive actions:** stop/restart/delete/reload use the
   security-confirmation dialog before acting.
5. **Channel identity:** the app title/version string always reads "Private Alpha";
   KNOWN_LIMITATIONS.md forbids presenting the build as beta/stable.

## Cross-references

- `docs/KNOWN_LIMITATIONS.md` — user-facing limitations list given to testers.
- `docs/PRIVATE_ALPHA_TESTER_GUIDE.md` — tester onboarding and expectations.
- `docs/B0_BASELINE.md` — "Existing V2-era capabilities found in alpha form" section
  records which surfaces are alpha-form.
- `docs/V1_ACCEPTANCE_RECORD.md` — dated evidence for the V1-B/V1-A gates.
