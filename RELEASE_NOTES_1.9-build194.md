# AnxOS Control Center v1.9 Build 194 — Private Alpha

Build 194 focuses on desktop reliability, one-click server maintenance, bundled runtime support, and responsive workflow polish.

## Added

- One-click SteamCMD updates for supported stopped game-server instances, with structured progress, validation, and optional restart.
- Bundled Windows runtime architecture for Java and the embedded LibreHardwareMonitor CPU-temperature provider.
- Windows administrator launch configuration and close-to-tray lifecycle behavior.
- Back and Dashboard navigation for the dedicated Marketplace and Create Server workflows.
- Regression coverage for bundled runtimes, SteamCMD updates, Windows telemetry, elevation, tray behavior, responsive layouts, and backup safety.

## Fixed

- Restored Marketplace Agent configuration resolution used by provider-backed installation workflows.
- Repaired world-only backup restores that could incorrectly exceed the source-size limit because unrelated instance files were included in the safety snapshot.
- Prevented overlapping or leaked Windows hardware-telemetry helpers and reduced provider initialization to CPU-only sensors.
- Improved responsive behavior for Instances, Files, Settings Connections, Marketplace, Create Server, and related management surfaces.
- Kept instance cards bounded and scrollable instead of allowing the page to expand indefinitely.

## QA

- Validated the Windows CPU-temperature path in an elevated development launch with repeated successful readings and no provider timeout.
- Revalidated SteamCMD update security boundaries, backup restore safety, bundled-runtime preparation, tray lifecycle, dashboard presentation, and responsive UI behavior.
- Confirmed private SSH profiles, local diagnostics, generated runtimes, and machine-specific configuration are excluded from release source.

## Known Issues

- SSH connectivity remains under stabilization. Some SSH scenarios may not function correctly and will be addressed in a future build.
