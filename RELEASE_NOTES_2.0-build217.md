# AnxHost Control Center v2.0 — Build 217

Build 217 is a refinement release: the app is ready sooner, uses less memory and does less work in the background, updates install without cutting anything off, the phone app is easier to tap, and the last "AnxOS" wording on screen now says AnxHost. Your servers, computers, settings, backups, SSH profiles and paired phones carry over when you update.

## Added

- **Add Server search matches every word.** "paper minecraft" or "valheim server" now finds the card even when the words are in a different order on it. A one-word search works as before.

## Changed

- **The app is ready sooner.** The startup screen now lasts at least 0.9 s instead of 4.2 s, and it no longer waits for readings that cannot arrive while the app is locked. In our measurements the main window appeared about 65% sooner (8.7 s to 3.1 s). Startup times you chose yourself in Settings are kept.
- **The startup sound is off for new installs.** Playing it keeps Chromium's audio service (about 84 MB) running for the whole session. Turn it on in Settings › Startup. An update keeps the setting you have now, on or off.
- **Installing an update closes AnxHost properly first.** Servers this app runs are stopped with their own stop command, so worlds are saved, and pending changes are written before the installer opens. Servers run by an Agent, Docker containers and your other computers keep running. Until now the installer forced the app closed. If a file transfer, a server install or another task is still running, Install asks you to wait for it, and it asks before discarding unsaved edits.
- **The AnxHost website is now `anxhost.anxlabs.net`.** Account pages open there and update checks read it first. `anxoscontrolcenter.org` keeps working for every installed version.
- **Phone Access is easier to tap.** Every button, tab and breadcrumb is at least 44 px tall, and the phone says at once when it loses its connection.
- **The remaining "AnxOS" wording on screen now says AnxHost**, in messages, dialogs, tooltips, notifications and the phone app. File, folder, package, task and service names keep "AnxOS" so updates stay in place.

## Fixed

- **My Servers rebuilt every row's buttons every 5 seconds**, so Start and Stop flickered and the page did extra work when nothing had changed. Rows now change only when a server does.
- **Home asked the Agent for AMP every 2 seconds** even when AMP was not set up on that computer. It now checks once a minute until AMP is configured, and Home makes about a quarter fewer requests while idle.
- **In the light theme, the health chips in Computer details** ("Checked", "Issues", "Workspace") were too faint to read comfortably. They now meet contrast guidelines.
- **Temp files from a save that was cut off** (for example by a forced close) were left in the settings folder for good. AnxHost now moves them aside at startup.
- **An update that was cut off before its installer opened** now shows the same guidance as an unconfirmed install, instead of looking as if it was still in progress.

## Known limitations

- With the startup sound on, memory use is about the same as Build 216. With it off (the new default), AnxHost used about 20% less memory while idle on Home in our measurement.
- Sign-up confirmation and password-reset emails still open pages on `anxoscontrolcenter.org`. Sign-in and activation pages are served on both addresses.
- Package, file and folder names keep "AnxOS" (`AnxOS-Agent-*.deb`, the `AnxHub` data folder, the `AnxOSAgent` task) so updates stay in place.
- See `docs/KNOWN_LIMITATIONS.md` for the full list.

## QA

- Startup and idle work were measured the same day against Build 216 with `npm run perf:baseline`, comparing medians.
- Every one of the 1,573 mapped features is still in the capability inventory and still mapped to the UI.
- The light and dark themes were checked over 69 views with no text below WCAG AA contrast.
- The phone app was checked on an emulated phone, in portrait and landscape.
- New regression checks cover the startup screen, AMP polling, the server list, search, the primary website, the update handoff and orphan temp files, and phone tap targets.
