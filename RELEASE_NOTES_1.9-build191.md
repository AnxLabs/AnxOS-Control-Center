# AnxOS Control Center v1.9-build191 - Private Alpha

Build 191 is an emergency hotfix for secure session recovery and protected actions after the v1.9 update.

## Fixed

- Fixed secure session recovery after the v1.9 update.
- Replaced raw secure-session decrypt errors with friendly unlock guidance.
- Prevented broken encrypted sessions from being retried on every protected action.
- Re-enabled protected actions after successful Local Owner unlock.
- Blocked Node, Local Agent, Agent Control, and Security actions while recovery is locked.
- Prevented repeated Operations entries from repeated clicks while locked.
- Ensured successful unlock safely supersedes only the broken saved session.

## Added

- Added the `locked_recoverable` authentication state.
- Preserved unreadable encrypted sessions and all owner, node, and configuration data.
- Required fresh Local Owner verification after decrypt failure.
- Preserved the v1.9 UI, onboarding migration, Windows Agent MVP, Marketplace, Public Access, Playit, NeoForge, and SFTP fixes.

## QA

- Verify an affected Build 190 installation upgrades without showing First Launch.
- Verify recovery guidance appears without raw decrypt or IPC errors.
- Verify Local Owner unlock restores Node, Local Agent, Agent Control, and Security actions.
- Verify existing nodes, instances, storage, Public Access configuration, and settings remain intact.
- Verify signed Windows artifacts, release checksums, and updater manifests before publishing.
