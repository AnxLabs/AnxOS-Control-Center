# AnxOS Control Center v2.0 — Build 209

Build 209 adds a **Sign in** button for game servers that need an account sign-in and fixes Hytale's status reporting. It also adds automatic server update checks with backups and rollback, Discord/webhook alerts, and a Mod Manager for Minecraft servers.

## Added

- **Sign in for game servers (Hytale first).** While a running server needs an account sign-in, its instance page shows **Sign in**.
  - **Opening the page:** it opens the publisher's sign-in page, with the code already filled in, in your default browser. If no code is pending, it first runs the game's own sign-in command.
  - **Safety:** only links on the publisher's own sign-in site are opened, and Control Center never sees your account credentials.
  - **Several game profiles:** if your account has more than one, the button becomes **Choose profile** and lists them by name.
  - **Once signed in:** the button stays as a dimmed **✓ Signed in**, and a notification confirms the server is ready for players.
- **Server updates.**
  - **SteamCMD servers:** an **Update available** badge, on the instance and in the list, compares the installed Steam build with the latest public one. **Check for Update** refreshes it. You can choose a Steam beta branch per instance, and only one SteamCMD job runs per node at a time.
  - **Other Marketplace servers:** check-only update badges for Paper, Vanilla, FiveM and Hytale. Applying those updates stays manual.
  - **Scheduled restarts:** they can update SteamCMD servers (opt-in). Their progress appears in the Download Manager.
  - **Backups and rollback:** a backup can run before every SteamCMD update. **Roll Back Update** restores it.
  - **Fleet view:** the Nodes page has a **Server Updates** panel to check every node and update stopped servers one at a time.
- **Restart schedules** use a single dialog and can be edited.
- **Server alerts:** each node can post crashes, scheduled restarts and updates to a Discord or HTTPS webhook. The webhook URL stays on the Agent and is never shown again.
- **Mod Manager for Minecraft.** A **Mods** tab (**Plugins** on Paper/Purpur) searches Modrinth for the server's version and loader.
  - It installs mods with their required dependencies, and can update, disable and remove AnxOS-installed mods.
  - Downloads come only from Modrinth's CDN and are checked against Modrinth's SHA-512.

## Fixed

- **Hytale showed "ready" about 6 seconds early on restarts.** When it restores a saved sign-in, Hytale reports success before it opens its port. "Ready" now waits for the server to finish booting.
- **Hytale stayed "ready" after a console `auth logout`.** It now shows as needing sign-in again.
- **A sign-in code could be saved without its expiry time,** because two status updates finished out of order. They now happen in order.
- **Hytale showed a false "Update available".** Version detection read the Minecraft-style "version" from Hytale's logs and recorded 0.7.5 as "1.0". Hytale's version now comes from its own boot line, which also stays correct after Hytale updates itself. Other non-Minecraft games no longer get a Minecraft version at all. That parsing was also the source of labels like "Minecraft 0.0 - Palworld".
- **The instance header said "Ready" after any finished action,** including a successful Stop. It now shows the server's real state.

## Upgrade

An in-place upgrade keeps all settings, nodes, credentials, instances and worlds.

- **Agents:** update node Agents (Agent `.deb` for packaged nodes, Update Agent for desktop-installed user services). Sign-in, Hytale status, update checks and alerts run in the Agent.
- **Updating or restarting an Agent stops every server it runs.** Stop them first and back up worlds, then start them again afterwards.

## QA

Release-candidate acceptance is pending. This section is completed after the signed RC passes:
- **Repository validation:** `npm run rc:validate`.
- **Signed CI build:** Authenticode signature, SHA-256 checksum and update manifest.
- **In-place upgrade and acceptance on real nodes:** includes the Hytale Sign in, profile choice and Signed in flow.
