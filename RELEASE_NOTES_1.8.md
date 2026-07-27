# AnxOS Control Center v1.8

This release focuses on stability, acceptance fixes, and the new Minecraft server.properties configuration editor.

## Added

- Added Minecraft server.properties configuration editor.
- Added category navigation for Minecraft settings.
- Added dirty-state tracking, reset support, save support, and restart-required indicators for Minecraft config changes.

## Fixed

- Fixed authenticated device activation polling and refresh resume behavior.
- Fixed onboarding, local setup, and login-required recovery edge cases.
- Improved Security Center unavailable/loading states.
- Fixed SSH console timeout, cancel, and retry behavior.
- Improved instance action error handling and authorization coverage.
- Fixed Minecraft config editor layout so sparse fields no longer float or get cramped.
- Fixed Auto Start placement in instance settings.

## QA

- Expanded smoke, acceptance, and stabilization coverage.
- Verified Minecraft config editor behavior, Reset Current dirty-state behavior, SSH lifecycle behavior, account session restore, device activation, Security Center, and IPC authorization checks.
