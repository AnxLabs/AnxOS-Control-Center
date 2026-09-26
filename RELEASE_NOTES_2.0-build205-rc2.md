# Release Notes — AnxOS Control Center v2.0 build 205 (release candidate v2.0-build205-rc2)

**Channel:** Private Alpha
**Status:** Release candidate — headless Agent, official Agent Debian package, and Add Computer redesign

This candidate supersedes `v2.0-build205-rc1`. The only change is a
deterministic fix to the RC validation gate's marketplace installer-role start
assertion (test-only; no product behavior change).

This file is the release body for the tagged release candidate
`v2.0-build205-rc2`. The product identity is Build 205 of AnxOS Control Center
v2.0 (Private Alpha); the canonical untagged notes live in
`RELEASE_NOTES_2.0-build205.md`.

Build 205 makes the Agent usable on a headless server and brings the same
Agent runtime to every surface: the Control Center Agent Control GUI, the
`anxos-agent` CLI/TUI, and the Control Center protocol/API. Pairing, identity,
authentication, and lifecycle logic keep one authoritative implementation, and
the safety defaults that protect a reachable Agent are unchanged. This remains
a Private Alpha release candidate, not a public-ready release.

## Highlights

- **Headless Agent CLI/TUI.** A Linux server with no desktop can install the
  Agent and manage it from the terminal: `anxos-agent` opens the TUI, with
  subcommands for `status`, `pair`, `service status|start|stop|restart`,
  `logs`, `diagnostics`, `update --check`, `unpair`, `--help`, and `--version`.
- **Official Agent Debian package.** `AnxOS-Agent-2.0-build205.deb` for
  Debian 11+/Ubuntu 22.04+ x64 (glibc >= 2.28) installs the standalone Agent
  as the `anxos-agent.service` systemd unit, with an
  `AnxOS-Agent-2.0-build205.deb.sha256` checksum file published alongside it
  in `sha256sum -c` format.
- **Add Computer, redesigned.** Adding a computer now offers both paths — a
  desktop computer or a headless server — with the instructions and pairing
  steps for each, instead of a single ambiguous flow.
- **Pairing fixes.** The headless path no longer requires a source checkout
  or developer commands; the CLI/TUI shows the full pasteable pairing code
  exactly as Control Center redeems it; and re-pairing a revoked node
  recovers enrollment instead of dead-ending.
- **Minecraft defaults and honest install outcomes.** Minecraft templates
  default to a Java-21-compatible version (1.21.11); the Paper/Vanilla
  pre-flight refuses a version that needs a newer Java with a clear
  required-vs-available message; and an install whose started process
  crash-loops fails honestly (`START_FAILED`) instead of reporting Complete.

## Install

**Control Center (desktop).** Download and run the Control Center installer
for your platform from this release (Windows Setup or portable `.exe`, Linux
`.deb` or AppImage). In-place upgrades keep your servers, settings,
credentials, and backups.

**Headless Agent (Debian/Ubuntu x64).**

1. Download `AnxOS-Agent-2.0-build205.deb` and its checksum file from this
   release.
2. Verify the package:
   `sha256sum -c AnxOS-Agent-2.0-build205.deb.sha256`
3. Install it: `sudo apt install ./AnxOS-Agent-2.0-build205.deb`
4. Run and pair it (Add Computer → headless server in Control Center):
   `sudo anxos-agent`

Agent data lives in `/var/lib/anxos-agent`; removing the package keeps the
data in place.

## Notes

- **Safety defaults are unchanged.** The Agent binds loopback (`127.0.0.1`)
  by default; enabling another computer to connect is an explicit opt-in.
  While a reachable Agent is not yet paired, anyone who can reach it could
  claim it, so pair promptly. Pairing codes are one-time and valid for
  10 minutes.
- Supported headless platforms: Debian 11+ and Ubuntu 22.04+ x64 with
  glibc >= 2.28. Other distributions and architectures are not supported.
- The CI/release wiring that builds and attaches the Agent `.deb` is present
  in `.github/workflows/windows-release.yml` and is exercised by this
  `v2.0-build205-rc2` build; it does not publish a stable release.

## Known limitations

- The headless Agent acceptance ran on WSL2 Ubuntu 24.04: representative of
  Debian and Ubuntu, but a WSL2 kernel rather than bare metal.
- arm64 packaging is mechanism-only; no arm64 hardware was used.
- Linux artifacts are not code-signed. SHA-256 integrity is the only
  verification available; verify the published SHA-256 before installing.
- Minecraft client join was not tested.
- This remains a Private Alpha release candidate and is not a public-ready
  release.