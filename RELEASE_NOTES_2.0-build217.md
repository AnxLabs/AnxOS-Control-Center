# AnxHost Control Center v2.0 — Build 217

Build 217 is a refinement release: a faster start, quieter background work, and the last "AnxOS" wording replaced on screen. Your servers, computers, settings, backups, SSH profiles and paired phones carry over when you update.

> Draft: completed during 217-G. Sections are filled in as each phase is finished.

## Added

- **Add Server search matches every word.** "paper minecraft" or "valheim server" now finds the card even when the words are in a different order on it. A one-word search works as before.

## Changed

- **The app is ready sooner.** The startup screen now lasts at least 0.9 s instead of 4.2 s, and it no longer waits for readings that cannot arrive while the app is locked. Startup times you chose yourself in Settings are kept.
- **The remaining "AnxOS" wording on screen now says AnxHost**, in messages, dialogs, tooltips and notifications. File, folder, package, task and service names keep "AnxOS" so updates stay in place.

## Fixed

- **My Servers rebuilt every row's buttons every 5 seconds**, so Start and Stop flickered and the page did extra work even when nothing had changed. Rows now change only when a server does.
- **Home asked the Agent for AMP every 2 seconds** even when AMP was not set up on that computer. It now checks once a minute until AMP is configured.

## Known limitations

- Package, file and folder names keep "AnxOS" (`AnxOS-Agent-*.deb`, the `AnxHub` data folder, the `AnxOSAgent` task) so updates stay in place.
- See `docs/KNOWN_LIMITATIONS.md` for the full list.

## QA

- Startup and idle work were measured the same day against Build 216 with `npm run perf:baseline` (medians; see `docs/HANDOFF_BUILD217.md`).
- Every one of the 1,573 mapped features stays in the capability inventory.
