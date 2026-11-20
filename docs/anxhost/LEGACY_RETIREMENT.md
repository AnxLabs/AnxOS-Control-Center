# Legacy pages and Expo pairing: investigation and retirement plan (Build 216-0)

Read-only investigation at `13825d70` (Build 215). **Nothing was deleted or
changed.** Removal happens only in the waves named below, after the listed
checks, and only with the owner's explicit approval naming each target
(`PLANS.md` section 8).

## Summary

| Path | Reachable today? | Live backend? | Useful function elsewhere? | Plan |
| --- | --- | --- | --- | --- |
| AMP page (`data-page="amp"`) | No: `getSafePageName` redirects `amp` to Home (`app.js:3246`); not in the sidebar | Yes: `amp:getSnapshot` IPC, `ampService`, Agent route `agent/src/routes/amp.js`, actions `amp.start/stop/restart` | Partly: an **AMP status card on Home** uses the same snapshot | A10: retire the page; decide the Home AMP card in A2 |
| Coolpals page (`data-page="coolpals"`) | No: redirected to Home (`app.js:3246`) | **None**: all 7 buttons are `disabled`, no IPC, no handler | Discord bots are covered by the `python-discord-bot` template (disabled, "coming soon") and the Discord Bot workspace profile (`app.js:1507`) | A10: retire the page (static markup only) |
| `minecraft` page name | No page section exists; `getSafePageName` maps it to My Servers (`app.js:3242`) | Indirect: refreshes the AMP snapshot (`app.js:4983`, `51754`) | Yes: Minecraft servers live in My Servers; a **Minecraft (AMP) card on Home** uses the AMP snapshot | A10: keep the redirect for saved settings; drop the AMP refresh trigger with the AMP decision |
| Expo "Pair Mobile Device" | Yes: Agent Control › Pairing button (`index.html:4558`) | Yes: `nodes:createMobilePairing`, `mobilePairingService`, Agent claim page | Yes: **Phone Access** (Security › Phone Access) replaced it with a LAN PWA that never sees the Agent token | A5: remove from normal UI; keep backend until a later approved removal |

## AMP

**What exists**

- Page markup `index.html:886-947`: AMP connection, status, instances, usage,
  runtime, version, panel URL.
- Home also shows two AMP-backed cards inside the dashboard page
  (`index.html:837-880`): "AMP" (`ampDashboardConnection/Status/Instances/Usage`)
  and "Minecraft" with an AMP pill (`minecraftDashboardSelection/Players/Runtime/Version`).
- Renderer: `refreshAmpDashboard` (`app.js:32872`) and `renderAmpSnapshot`
  (`app.js:32801`). It runs when Home, `amp` or `minecraft` is shown and the
  last refresh is older than `AMP_REFRESH_INTERVAL_MS` (`app.js:4983`), on the
  background poll when those pages are active (`app.js:51754`), and on reload
  (`app.js:40066-40072`). Title bar label "AMP: Connected/Disconnected" for
  those pages (`app.js:4329`).
- Backend: preload `amp.getSnapshot` (`preload.js:197`), IPC `src/ipc/ampIpc.js`
  (permission `instance:read`, node scoped), `src/services/ampService.js`,
  `src/services/ampApiClient.js`, `serviceRouter.js`, Agent
  `agent/src/routes/amp.js` and `agent/src/services/ampService.js`. Action IPC
  maps `amp.start/stop/restart` to `instance:lifecycle` (`src/ipc/actionIpc.js:11-13`).
- When AMP is not configured the UI shows "Set AMP_URL, AMP_USERNAME, and
  AMP_PASSWORD in .env" (`app.js:32820`), a developer-only setup.
- The `general.defaultPage` preference still accepts `"amp"` and `"minecraft"`
  (`src/services/settingsPreferenceService.js:20`); a user who saved those is
  redirected today.

**Dependencies to keep**: the AMP backend (IPC, services, Agent route) is not
part of the UI and stays in 216. The preference values stay accepted so saved
settings keep loading.

**Retirement plan**

1. A2 (Home): the owner decides whether the AMP and Minecraft (AMP) status
   cards survive on the new Home. Recommendation: show them only when AMP is
   configured (snapshot `configured: true`), otherwise hide them, because the
   "set .env" message is developer-facing.
2. A10: delete the hidden `amp` page section and its renderer-only fields
   (approval naming the section and functions). Keep `getSafePageName`'s
   `amp` → Home redirect and the preference value.
3. Checks before removal: inventory rows `CAP-AMP-PAGE-page-amp` and
   `CAP-AMP-CTL-amp-panel-link` (wave A10) accounted for, and
   `CAP-HOME-IPC-amp-getsnapshot` (wave A2, kept with the Home card); `amp:getSnapshot` still reachable if the Home card stays;
   no test drives the page directly (the generator lists `none` for the page
   row); `qa:feature` passes.

## Coolpals

**What exists**: a static page (`index.html:1202-1349`) titled "CoolPals —
Discord bot operations" with summary cards and seven buttons
(`data-coolpals-action` start, stop, restart, reload, sync, deploy, logs), all
`disabled`. There is no IPC, preload method or handler; `coolpals` appears in
code only in `LEGACY_PRIMARY_PAGES` (`app.js:1490`), the redirect
(`app.js:3246`) and as a default instance hint name in
`src/services/ampService.js:1534` (`Coolpals01`, an AMP instance name, not this page).

**Retirement plan**: A10, delete the page section (approval naming it). Keep
the redirect so a saved `coolpals` page name lands on Home. No backend or
data is affected. Discord bot hosting remains a Marketplace template decision
(`python-discord-bot`, currently disabled), outside 216.

## `minecraft` page name

There is no Minecraft page. The name survives as a redirect to My Servers
(`app.js:3242`), as an AMP refresh trigger and in the default-page preference
values. Minecraft functionality (workspace profile `app.js:1494-1505`,
server.properties, players, add-ons, backups) lives in My Servers and the
server view and is inventoried under wave A3.

**Plan**: keep the redirect and the preference value permanently (cheap, and
saved settings depend on it). Remove the AMP refresh trigger together with
the A2 AMP decision.

## Expo "Pair Mobile Device"

**What it does** (`src/services/mobilePairingService.js`): a deliberate
**credential handoff** for the abandoned Expo mobile app. With the Local Owner
unlocked (`requireLocalOwnerAuthenticated`, `settings:write`, audited as
`node.create-mobile-pairing`, `src/ipc/nodesIpc.js:333-339`), the desktop:

1. opens an Agent pairing session using the credential it already holds;
2. mints a new 36-byte token and completes pairing with it
   (`postPairingComplete`);
3. **writes the new token to the desktop's credential store before
   verifying** (`mobilePairingService.js:149`), then probes Agent health;
4. on failure reinstalls the previous token (and if that also fails, keeps the
   token the node actually accepted);
5. returns a claim string `anxos://pair?url=…&token=…` (plus an adapter URL on
   port 8001) as a QR code for the phone.

So every use **rotates the node's permanent Agent token** and hands the new
one to a phone app that no longer exists (the sibling
`AnxOS-Control-Center-Mobile` is a recovered bytecode-only export,
`docs/PHASE7_MOBILE_PLAN.md:9` says "Not reused"). After a successful run the
previous Agent token is retired, which also breaks any other client still
using it (for example a second desktop that was given the old token).

**Entry points**

- UI: Agent Control › Pairing, `data-agent-control-action="pairMobileDevice"`
  (`index.html:4558`), handled at `app.js:6086`, `6113`, `7570`, `7645-7651`.
  Inventory row `CAP-AGENT-ACT-agent-control-action-pairmobiledevice` (A5).
- Preload `nodes.createMobilePairing` (`preload.js:511`) → IPC
  `nodes:createMobilePairing`.
- Agent side: the pre-auth claim page `agent/src/routes/mobileClaimPage.js`.
- Tests: `scripts/mobile-pairing-smoke.js` (handoff ordering and restore) and
  `scripts/mobile-claim-page-smoke.js` (claim page escaping), both in
  `rc:validate`.

**Not related**: Phone Access (`src/mobile/*`, Security › Phone Access) never
receives the Agent token; it uses its own pairing codes, roles and session
cookie. Nothing in Phone Access depends on `mobilePairingService`.

**Retirement plan**

1. A5 (approval needed): remove the "Pair Mobile Device" button from Agent
   Control and the `pairMobileDevice` UI handlers, and point users to
   Security › Phone Access. The IPC, service, claim page and their smokes stay
   in 216, so nothing outside the UI changes and the tests keep passing.
2. Later build (separate approval): remove `nodes:createMobilePairing`,
   `mobilePairingService`, the Agent claim page and their smokes together,
   with a permission-matrix update.
3. Checks before A5 removal: Phone Access pairing, roles and revocation pass
   (`mobile-gateway`, `mobile-pairing`, `mobile-ui-qa`); the inventory row is
   marked retired with this document as the reason.
