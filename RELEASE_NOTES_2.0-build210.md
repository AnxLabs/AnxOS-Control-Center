# AnxOS Control Center v2.0 — Build 210

Build 210 is in development. These notes are updated as changes land and are finalized before the release candidate is built.

## Added

## Changed

- **Faster searching in Settings and Diagnostics.**
  - **Settings:** search reads the settings page once when you start typing, instead of on every keystroke.
  - **Diagnostics:** search prepares each entry's text once, and skips it entirely when the search box is empty.
- **Less background work while you use the app.**
  - **Docker page:** the images, volumes, networks and Compose lists refresh every 30 seconds instead of every 5. Refresh buttons and actions such as removing an image still update the list at once.
  - **Server installs:** the install log redraws at most about five times a second, instead of on every progress message.
  - **Instances page:** the summary tiles redraw once per screen frame while server metrics update, instead of twice for every running server.
- **Clearer app description.** Installers and the Linux app menu now describe the app as managing home servers, game servers, and the computers that run them.

## Fixed

- **Palworld cards showed "0.0" as the game version.** Servers installed before Build 209 kept a "0.0" placeholder written by older version detection. "0.0" is no longer accepted as a version, and saved records are detected again once, so the placeholder is dropped. The Steam build number is kept.

## Known issues

- None recorded yet.

## QA

- Not yet run. Release-candidate validation and acceptance results are recorded here before publication.
