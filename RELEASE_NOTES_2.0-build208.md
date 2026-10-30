# AnxOS Control Center v2.0 — Build 208

Build 208 adds the official Hytale dedicated server and checks whether AI services actually work, not only whether they run. It also includes Sona as the officially supported AnxLabs AI app and keeps Palworld on the current Steam client library after updates.

## Added

- **Hytale dedicated server (Linux nodes).** The Marketplace installs Hypixel Studios' official server.
  - **Install:** the server comes from the official repository at `maven.hytale.com`. It is installed only if it matches the publisher's published SHA-1 checksum.
  - **First start:** the console shows Hytale's sign-in link and code. Once you approve the server with your Hytale account, Control Center downloads the official server files and starts the server. It never sees your account credentials.
  - **Later starts:** the server starts directly through Hytale's own launcher, so Hytale's built-in updater keeps working.
  - **Status:** a server that has not been signed in shows as degraded, because players can't join it yet.
  - **Backups:** world backups include `Server/universe`.
  - **Requirements:** Java 25 and a forwarded UDP port (default 5520). On Windows nodes the template is refused with a clear message. See `docs/HYTALE_SERVER.md`.
- **Health vs Function in the Infrastructure Inventory (AIM-2).** A new Function column shows whether an AI service actually works, next to whether it is running. A service that hasn't been checked shows "Not checked" and is never green.
  - **Checks:** run only when you click Check, and only for services you have approved in `functional-probe-scopes.json`. They are read-only, send no credentials, and are off by default.
  - **Supported services:** Sona, Qdrant, Ollama, Infinity and Tika.
- **Sona is the officially supported AnxLabs AI app.**
  - **Recognition:** Control Center finds Sona's API among a node's containers.
  - **Dependencies:** the sandbox, plugin host, Claude Code worker, browser, search and Cloudflare tunnel are listed as a stack.
  - **Failures:** a stopped or missing part of the stack fails Sona even when no live check runs.
  - **Approved check:** a live check reads only Sona's public health route and reports a version change or a different app answering.

## Changed

- **Discontinued integrations.** Open WebUI, Open Terminal and ANX-CorTex no longer appear in AI service diagnostics. Nothing on your machines was removed.

## Fixed

- **Palworld kept loading an old Steam client library after updates.** Palworld's launcher copies `steamclient.so` only when the copy is missing, so updated servers kept running an outdated library.
  - **Fix:** after a verified update, while the server is stopped, Control Center refreshes the copy safely.
  - **Messages you'll still see:** the "[S_API FAIL] … before SteamAPI_Init succeeded" lines come from Palworld's own server binary and are harmless. They stay visible.
- **Network inventory** now says when the netstat fallback could not read a protocol, instead of returning a silently incomplete list.

## Upgrade

An in-place upgrade keeps all settings, nodes, credentials, instances and worlds.

- **Agents:** update node Agents (Agent `.deb` for packaged nodes, Update Agent for desktop-installed user services). Hytale's status and Palworld's library refresh run in the Agent.
- **Functional checks:** off by default. To enable one, add an approved scope to `%APPDATA%\AnxHub\config\functional-probe-scopes.json`. See `docs/v2/AIM2_IMPLEMENTATION_RECORD.md`.

## QA

Release-candidate acceptance is pending. This section is completed after the signed RC passes:
- **Repository validation:** `npm run rc:validate`.
- **Signed CI build:** Authenticode signature, SHA-256 checksum and update manifest.
- **In-place upgrade and acceptance on real nodes:** includes a Marketplace Hytale install on a Linux node.
