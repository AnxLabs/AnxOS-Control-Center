# Bundled third-party runtimes

AnxOS Control Center packages selected unmodified runtimes for private,
application-scoped use. Their versions and integrity hashes are recorded in
`config/windows-runtime-bundle.json` and in the generated
`bundle-manifest.json`.

- Eclipse Temurin Java 8, 16, 17, and 21 runtimes: GPL-2.0 with
  Classpath Exception. Java 16 is the archived final Temurin 16 JDK because an
  official JRE archive is not available.
  <https://adoptium.net/about/>
- Microsoft .NET Runtime 8: MIT and associated third-party notices.
  <https://github.com/dotnet/runtime>
- Valve SteamCMD bootstrap: distributed subject to Valve's Steam and
  SteamCMD terms. SteamCMD updates itself and downloads dedicated-server
  content from Valve after launch.
  <https://developer.valvesoftware.com/wiki/SteamCMD>

The runtime archives are downloaded only during the trusted build process from
the pinned official URLs. Each archive must match its recorded checksum before
it is extracted or packaged. Generated runtime files are excluded from Git.

Docker Desktop, Tailscale, cloudflared, Playit.gg, Git, PowerShell, Python,
FFmpeg, and Microsoft Visual C++ redistributables are not embedded. AnxOS uses
their official managed installers only when a user selects a feature that
requires them.

PawnIO is not bundled. It is a separately licensed kernel driver and requires
redistribution, source-obligation, provenance, and driver-signature review
before it can be included in an AnxOS release.
