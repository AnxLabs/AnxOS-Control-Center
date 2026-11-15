# AnxOS Control Center v2.0 — Build 211

Build 211 is the first public build since Build 209. It adds an **optional AI assistant** (off by default) and a **signed, branded Windows installer that works with Smart App Control on**. It also includes every Build 210 improvement; Build 210 was never published.

## Added

- **Optional AI assistant (Phase X).** An Owner can turn it on in **Settings › AI Assistant**; until then nothing about it runs.
  - **Ask in plain English**, for example: "Which computer is using the most RAM?", "Why won't my Minecraft server start?", "Which Docker containers are unhealthy?", "Is AnxNet working?", "Can Anxlab run another Minecraft server?"
  - **Answers come from real measurements.** Each reading is labelled Live, Recent, Stale or Unavailable. Problems are shown with the console lines they came from, a suggested fix, its impact and how to check it.
  - **It never guesses the target.** If two servers match, it asks which one. If a computer is offline, it says so and does not switch to another.
  - **Changes need your approval.** It can prepare a start, stop, restart, backup or container restart. Each proposal is for one exact server and runs only after you approve it. It uses your permissions and appears in Activity, and the result is checked afterwards (a start counts only when the server reports ready).
  - **It never deletes, restores, exposes or updates anything.** For those it points you to the page that already asks for its own confirmation.
  - **Model optional.** It works without any AI model. You can connect a model you run yourself with Ollama; models on other computers or Ollama "cloud" models need a separate Owner opt-in. Sona is listed but not connectable yet.
  - **Server planning.** "Make a Minecraft server for ten friends with plugins" prepares a plan (Paper, memory, a computer with room) and opens Create Server. You still accept the EULA there yourself.
- **Branded AnxLabs installer.** A dark AnxLabs installer that explains each choice, including whether to set up the background Helper. Add/Remove Programs lists the publisher as AnxLabs.
- **Status explanations and remembered filters.** Hover a server's status to see what it means and what to do next. The Instances status filter is remembered.

## Changed

- **Works with Smart App Control on.** Every program file Windows checks is now signed, including the installer's own helper files and native modules. The signed release candidate installed, ran, reinstalled and uninstalled in a clean Windows with Smart App Control on, with no blocks.
- **Updates are checked before they open.** A downloaded update installer must carry a valid signature from the AnxOS publisher, or it is not opened. Settings › Updates shows what was verified, and why an install was refused.
- **Errors stay up long enough to read**, and the Docker page, installs, consoles, Instances, Dashboard and Files do much less background work.

## Fixed

- **Docker start, stop and restart from the Agent** failed because the Docker path was passed incorrectly.
- **Palworld cards showed "0.0" as the game version.**
- **Restoring an imported world backup could delete the whole server folder.** World restores now touch only the world folders and refuse archives that hold anything else.

## Known limitations

- **New downloads may show a SmartScreen prompt** until this release builds download reputation. The installer is validly signed; choose **More info › Run anyway** only if the publisher shown is Anjo ROSIMO.
- **Upgrading from Build 209 with Smart App Control on** was not tested in a clean machine; fresh installs, reinstalls and uninstalls were.
- **AI assistant:** off by default. Player ping, server TPS and internet reachability are not measured, and it says so. It does not change ports. Sona is not available yet. Its fixes for comparing computers and matching partial computer names were verified in tests and in the app, not yet re-run against a real remote fleet.
- ASRE integration work (SAUS, ALSP, AMDP) is still incomplete and is not part of this release.
- See [Known Limitations](docs/KNOWN_LIMITATIONS.md) for the full list.

## QA

- **Signed release candidate (Phase 9):** CI run 43509375484 on the Phase 9 code. 651 shipped files covered by the signature check. In Windows Sandbox with Smart App Control on: install, first launch, reinstall (data kept), uninstall (data kept), 0 Windows blocks and 625 installed files all validly signed. Defender found no threats.
- **Phase X:** 19 assistant checks (including approval replay, tampering, wrong target, Viewer permissions and malicious log text); 12 checks in the real app, including approved actions on disposable local servers and a local Ollama model; a read-only check against real computers.
- **Repository validation:** every smoke suite (378) run before release, with the one failure (missing permission rows for the assistant) fixed. The Build 211 signed build, signatures and installation are verified before publication.
