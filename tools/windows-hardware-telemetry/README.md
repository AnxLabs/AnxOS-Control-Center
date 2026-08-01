# Windows hardware telemetry helper

This read-only helper embeds `LibreHardwareMonitorLib` and emits one JSON sensor
snapshot. Release builds publish it self-contained for `win-x64`; users do not
need the LibreHardwareMonitor GUI or a separate .NET installation.

The embedded helper is the primary Windows provider. If it cannot access a
trustworthy CPU sensor, AnxOS may read the `root\LibreHardwareMonitor` or
`root\OpenHardwareMonitor` namespace exposed by an already-running compatible
monitor. AnxOS does not query ACPI/WMI thermal-zone values, download monitoring
software, install hardware drivers, or launch third-party monitoring tools.

Windows builds of AnxOS Control Center request administrator elevation at
launch because some processor sensors require privileged low-level hardware
access. The telemetry helper is bundled with the app; users do not download or
launch LibreHardwareMonitor separately.

LibreHardwareMonitor 0.9.6 uses PawnIO for low-level access on supported
systems. PawnIO is a separately licensed kernel component. AnxOS must not
redistribute it until the GPL exception and source-code obligations, binary
provenance, and Microsoft driver signature have been reviewed for the release.
Without a compatible signed PawnIO installation, AnxOS reports the temperature
as unavailable without treating it as an application failure.

LibreHardwareMonitor is licensed under MPL-2.0. See `THIRD-PARTY-NOTICES.txt`
and the upstream notices included beside packaged helper files.
