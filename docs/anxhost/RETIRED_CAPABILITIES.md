# Retired capabilities (Build 216)

Retired with the owner's approval on 2026-11-25 ("Approve all deletions", naming each target below). Each row was removed from `CAPABILITY_INVENTORY.md` because its UI hook no longer exists. The previous inventory, with every row, is in git history at `8f23e704`.

## AMP page (hidden; `amp` still redirects to Home)

Replacement: Home AMP card and the AMP backend, unchanged.

- `CAP-AMP-CTL-amp-panel-link`
- `CAP-AMP-PAGE-page-amp`

## Coolpals page (hidden, all actions disabled; `coolpals` still redirects to Home)

Replacement: None needed: the page had no backend.

- `CAP-COOLPALS-ACT-coolpals-action-deploy`
- `CAP-COOLPALS-ACT-coolpals-action-logs`
- `CAP-COOLPALS-ACT-coolpals-action-reload`
- `CAP-COOLPALS-ACT-coolpals-action-restart`
- `CAP-COOLPALS-ACT-coolpals-action-start`
- `CAP-COOLPALS-ACT-coolpals-action-stop`
- `CAP-COOLPALS-ACT-coolpals-action-sync`
- `CAP-COOLPALS-IN-coolpals-search`
- `CAP-COOLPALS-PAGE-page-coolpals`

## Dormant inline Create Instance form (unreachable since Build 215)

Replacement: Add Server › Create Server in the main window.

- `CAP-SRV-ACT-instance-action-cancel-create`
- `CAP-SRV-CTL-instance-create-submit`
- `CAP-SRV-CTL-instance-template-custom-command`
- `CAP-SRV-CTL-instance-template-java-app`
- `CAP-SRV-CTL-instance-template-minecraft-paper`
- `CAP-SRV-IN-instance-form-accepteula`
- `CAP-SRV-IN-instance-form-args`
- `CAP-SRV-IN-instance-form-displayname`
- `CAP-SRV-IN-instance-form-entrypoint`
- `CAP-SRV-IN-instance-form-environment`
- `CAP-SRV-IN-instance-form-executable`
- `CAP-SRV-IN-instance-form-id`
- `CAP-SRV-IN-instance-form-memorylimit`
- `CAP-SRV-IN-instance-form-playittunnel`
- `CAP-SRV-IN-instance-form-ports`
- `CAP-SRV-IN-instance-form-tags`
- `CAP-SRV-IN-instance-form-type`
- `CAP-SRV-IN-instance-form-workingdirectory`

## Separate Marketplace and Create Server windows, their IPC and window-only navigation

Replacement: Add Server in the main window (216-A4).

- `CAP-TITLE-IPC-anxwindow-focusmain`
- `CAP-TITLE-IPC-anxwindow-getworkspacecontext`
- `CAP-TITLE-IPC-anxwindow-onnavigate`
- `CAP-TITLE-IPC-anxwindow-onworkspaceinit`
- `CAP-TITLE-IPC-anxwindow-openworkspace`
- `CAP-TITLE-IPC-window-focusmain`
- `CAP-TITLE-IPC-window-getworkspacecontext`
- `CAP-TITLE-IPC-window-onnavigate`
- `CAP-TITLE-IPC-window-onworkspaceinit`
- `CAP-TITLE-IPC-window-openworkspace`
- `CAP-MKT-CTL-workspace-nav-back`
- `CAP-MKT-CTL-workspace-nav-dashboard`
- `CAP-WIN-WIN-window-workspace`

## Separate Add Storage window and its `storageWindow:*` IPC (could never save)

Replacement: Files › Add Storage dialog in the main window (216-A8).

- `CAP-WIN-IPC-storagewindow-close`
- `CAP-WIN-IPC-storagewindow-oninit`
- `CAP-WIN-IPC-storagewindow-onsaved`
- `CAP-WIN-IPC-storagewindow-open`
- `CAP-WIN-IPC-storagewindow-saved`
- `CAP-WIN-WIN-window-add-storage`

## Expo "Pair Mobile Device" and "Copy Mobile Claim" in Agent Control

Replacement: Security › Phone Access (the IPC, service and claim page stay until a later approved removal).

- `CAP-AGENT-ACT-agent-control-action-copymobileclaim`
- `CAP-AGENT-ACT-agent-control-action-pairmobiledevice`

## Backups page search box (disabled, never wired)

Replacement: None: Backups lists every backup with its server and date.

- `CAP-BACKUP-IN-search-backup-name-or-source`

**51 rows retired** (1,624 → 1,573).
