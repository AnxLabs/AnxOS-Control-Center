# AnxOS Control Center v2.0 — Build 213

Build 213 is about running more than one computer. You can see every computer's servers in one list, keep Agents up to date from the app, move a server between computers, and run AnxNet's relay and gateway on a server you own.

## Added

- **All computers in My Servers.** One list of every server on every computer, with the computer each one runs on. Start, stop or restart several at once; stop and restart ask first. A computer that is offline keeps its servers listed as "last known".
- **Update Agents from the app.** Agent Control can update Linux computers whose Agent was installed from the `anxos-agent` package, one at a time or all together. Each package is checked against the release's checksums first, and if the new Agent doesn't come up, the previous one is put back. An update is refused while that computer's servers are running.
- **Automatic Agent updates (off by default).** Settings > Updates > Automatic Agent updates: choose which computers, which days and what time window, and whether AnxOS only tells you or installs the update. Every update is listed in its history. It never restarts an Agent while its servers are running.
- **Safer moves between computers.** Before a server moves, AnxOS checks that the target is online, the server is stopped, the platform matches and there is room (ports, memory, disk, size). It won't start while a check fails. The backup is verified before it is sent and checked again when it arrives. After a clean move, AnxOS offers to switch over to the new copy.
- **Modpack updates.** Servers installed from a Modrinth or CurseForge modpack say when a newer version of the pack exists for the same Minecraft version and loader. AnxOS tells you; it doesn't apply the update yet.
- **Download server files from your phone.** Phone Access can download any file in a server's folder, byte for byte.
- **AnxNet edge on your own server.** The AnxNet panel has **Copy edge config**, the edge checks its settings before it starts, and a step-by-step guide covers running it as a service (`docs/ANXNET_EDGE_DEPLOYMENT.md`).
- **A colourful Agent screen** on Linux computers without a desktop.

## Fixed

- **Cancelling a server update before SteamCMD starts now stops it.** Before, a Cancel during the pre-update backup, or while the update waited for another SteamCMD task, was acknowledged but the update could still run afterwards. With an Agent older than Build 213, the app offers Cancel only once SteamCMD is running and says why.
- **The phone no longer opens binary files as text.** Tapping a `.jar` or an image opened it in the editor, where saving could have damaged it.
- **The AnxNet edge refuses unsafe settings**, such as a public port range that includes SSH or the Agent's port, or a gateway without a public address.
- **The Download Manager no longer shows "cancelled"** for an operation it couldn't stop.

## Known limitations

- **Agents older than Build 213** can't serve phone downloads, and they can't cancel a server update before SteamCMD starts. Update them from Agent Control.
- **Updating a package-installed Agent from the app** has been tested with simulated systems and real package checks, but not yet as a real upgrade from one build to the next on a Linux computer.
- **Moving a server between two computers** has been tested between two Agents on one PC, not between two machines.
- **Modpack updates are detected, not applied.** Back up, then update from the pack's page.
- **AnxNet over the internet** has not been tested on a public server yet. Running the edge opens public ports on your server; see the guide first.
- **Phone Access** has been tested with phone emulation in a desktop browser, not on a real iPhone or Android phone.

## QA

- New regression suites for every Build 213 feature and fix, including real-app checks for the server fleet, the automatic Agent update switch, the move checks, Phone Access downloads, the AnxNet edge config and update Cancel. The Cancel fix for issue #53 is covered by tests that failed on the old code.
- Repository validation: all 410 smoke suites and the release tier (130 checks, including the real-app UI tests) passed.
- The AnxNet edge was run as its own process from the panel's config on one PC (relay, TCP and UDP through the gateway, ports closed on stop). It has not run on a public server.
- Phone Access passed 19 checks in the real app with phone emulation; no physical phone was used.
- The signed release candidate is tested by installing it over Build 212 and checking each new feature in the installed app.
