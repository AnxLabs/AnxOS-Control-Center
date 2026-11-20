# AnxHost CC navigation proposal (Build 216-0)

**Status: approved by the owner on 2026-11-20**, on the condition that every
existing capability stays reachable. Rendered in
`docs/anxhost/gallery/ui-patterns-dark.png` and `ui-patterns-light.png` (top
of each image). Implemented in wave A1.

## Today (Build 215)

Sidebar: Home, My Servers, Add Server, Computers, Sharing at the top; a
"More" group (Activity, Backups, Security); a "Tools" group, collapsed by
default (Console, Task details, Docker, Files, Network, SSH, Agent Control,
Maintenance); Settings pinned at the bottom; Anx Workspace for the owner.
"Add Server" opens a separate Marketplace window. At the 900x640 minimum the
sidebar becomes a top block that covers the page (see
`baseline/BASELINE_215.md`, finding 1).

## Proposed sidebar

| Group | Item | Today's page(s) (`data-page`) | Tabs or sections inside |
| --- | --- | --- | --- |
| Run | **Home** | `dashboard` | Attention, servers, computers, setup, Customize Home |
| Run | **My Servers** | `instances` | All · Game servers · Docker services; server view (Overview, Console, Files, Add-ons, Backups, Settings; Players, Performance, Network as detail views) |
| Run | **Add Server** | `marketplace` + the separate Marketplace and Create Server windows | Catalog (search, categories, favorites, Modpacks with Modrinth and CurseForge), Create Server wizard, import and export, **in the main window** |
| Infrastructure | **Computers** | `nodes`, `agent-control` | Overview · AnxNet · Agent Control (15 sections) |
| Infrastructure | **Docker** | `docker` | Containers · Images · Networks · Volumes · Compose · Cleanup |
| Infrastructure | **Network** | `playit`, `network` | Sharing (playit, public access) · Addresses and endpoints (two tabs; no functional merge) |
| Tools | **Files** | `files` + the separate Add Storage window | File manager and editor; Add Storage as an in-window dialog |
| Tools | **Terminal** | `ssh`, `console` | SSH · Server consoles |
| Tools | **Backups** | `backups` | |
| Footer | **Activity** | `notifications`, `operations`, `maintenance` | Notifications · Tasks · Maintenance |
| Footer | **Security** | `security` | 19 sections, including Phone Access |
| Footer | **Settings** | `settings` | 11 categories and search |
| Footer | **Anx Workspace** | `owner-workspace` | Owner only (shown only when signed in as Owner) |
| Footer | Computer switcher | node picker | Current computer, status, switch |
| — | Retired after verification | `amp`, `coolpals`, `minecraft` (redirects kept) | See `LEGACY_RETIREMENT.md` |

Twelve visible items (thirteen for the owner) instead of seventeen plus a
collapsed group, with nothing hidden behind "Tools". Every one of the 20
pages has a home (inventory: 0 unmapped rows).

## Behaviour

- **Title bar:** AnxHost CC mark and name, current page, global search
  (Ctrl+K) and the command palette (Ctrl+Shift+P), the selected
  computer's connection status, Assistant, and window controls. The QA and
  developer badges stay.
- **Hooks kept:** sidebar buttons keep `data-page-target="<page>"` and pages
  keep `data-page`, so `showPage`, saved last-page, deep links
  (`#settings:x`, `?settingsCategory=`) and the tests keep working. A
  merged destination opens its first tab; the old page name selects the
  matching tab (for example `operations` opens Activity › Tasks).
- **Counts:** My Servers shows the number running or needing attention;
  Activity shows unread notifications and running tasks.
- **Small windows:** below 1100 px the sidebar collapses to a 64 px icon rail
  with tooltips (`data-sidebar-collapsed="true"`); content stays visible at
  the 900x640 minimum. The user can also collapse it by hand; the choice is
  remembered with the existing sidebar storage key.
- **Keyboard:** every item reachable with Tab and arrow keys; existing
  shortcuts unchanged (inventory kind `shortcut`, 10 rows).
- **Owner and permissions:** items stay visible but explain when an action
  needs the Owner unlock; authorization remains in the main process and Agent.

## Owner decisions (2026-11-20)

Approved as proposed: Run / Infrastructure / Tools with the footer, and the
responsive icon rail below 1100 px. Condition: every existing capability
remains accessible (each wave proves it against `CAPABILITY_INVENTORY.md`).
The items as they were put to the owner:

1. The grouping and names: Run / Infrastructure / Tools and the
   footer (Activity, Security, Settings).
2. Docker as its own item (proposed) or only inside My Servers › Docker
   services. Proposed: both, because Docker images, networks, volumes and
   Compose are not "servers".
3. Merging Console into **Terminal** with SSH, and Maintenance and Task
   details into **Activity**.
4. The icon rail below 1100 px.
