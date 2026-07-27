# AnxOS Control Center v1.9-build190 - Private Alpha

Build 190 fixes local unlock and browser-authentication startup paths, then begins the v1.9 CasaOS/HTNetwork-inspired interface refresh while preserving the established AnxOS purple-black identity.

## Fixed

- Fixed the local security login IPC registration race.
- Registered account and local-security IPC before renderer creation or recovery.
- Made incomplete-instance recovery non-blocking.
- Fixed Continue in Browser to use the canonical `/signin/`, `/account/`, and `/activate/` URLs.
- Added allowlisted external URL handling so browser authentication cannot silently fail or open an unsafe destination.

## Added

- Added the compact v1.9 dashboard launchpad.
- Refreshed the sidebar, page headers, status cards, Nodes, Instances, Public Access, and Marketplace surfaces.
- Preserved Marketplace install, repair, and update actions.
- Preserved Share Server, Playit, NeoForge, Windows Agent, SFTP, and updater behavior.

## QA

- Validate local owner unlock with valid and invalid credentials.
- Validate Continue in Browser opens the expected AnxOS authentication URL.
- Verify Dashboard, Instances, Public Access, Marketplace, and Nodes in the packaged Electron application.
- Verify Build 189 to Build 190 updater behavior.
- Verify release checksums and Windows Authenticode signatures before installation.
