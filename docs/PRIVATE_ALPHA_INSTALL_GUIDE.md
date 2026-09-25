# AnxOS Control Center Private Alpha Install Guide

This guide is for trusted private-alpha testers. Use only the official AnxOS download page or a release link sent by the project owner.

Official download page:

https://anxoscontrolcenter.org/download

AnxOS Control Center is private-alpha software. Keep backups, avoid irreplaceable production data, and report unexpected behavior.

## Minimum Requirements

Windows:

- Windows 11 x64
- Internet connection
- Administrator access only for actions that install services or system dependencies

Linux:

- Debian or Ubuntu-compatible x64 system
- Internet connection
- A desktop session for launching the GUI
- `sudo` access only when installing the `.deb` or system dependencies

Optional tools:

- Docker, for container management
- Java, .NET, or SteamCMD, depending on Marketplace templates
- Tailscale, cloudflared, or Playit for Public Access providers
- An AnxOS Agent for remote system, server, Docker, Files, and dependency management

## Windows Installation

1. Open the official AnxOS download page.
2. Download the Windows installer:
   `AnxOS-Control-Center-Setup-1.7-build143.exe`
3. Run the installer.
4. If Windows SmartScreen appears, confirm the file came from the official AnxOS release page.
5. Click `More info`, then `Run anyway` only if the filename and source are correct.
6. Finish the installer.
7. Open `AnxOS Control Center` from the Start Menu or desktop shortcut.
8. Complete onboarding or choose `Explore on My Own`.
9. Connect an Agent only when you need server, remote system, Docker, Files, or dependency management.

Portable Windows build:

1. Download:
   `AnxOS-Control-Center-1.7-build143-portable.exe`
2. Place it in a folder you can find again.
3. Double-click it to launch AnxOS Control Center.

## Linux Installation

Debian package:

```bash
sudo apt install ./AnxOS-Control-Center-*.deb
```

Then open `AnxOS Control Center` from your application menu.

AppImage:

```bash
chmod +x AnxOS-Control-Center-*.AppImage
./AnxOS-Control-Center-*.AppImage
```

If the AppImage does not launch, confirm your desktop environment supports AppImage execution and that required Electron system libraries are installed.

## What Works Without an Agent

Without an Agent, the desktop app can still provide:

- Onboarding and setup guidance
- Local desktop identity
- Account sign-in where configured
- Owner Workspace access after owner authorization
- Settings
- Update checks
- Documentation and diagnostics views that do not require Agent data

## What Requires an Agent

An Agent is required for:

- Managing remote Windows or Linux systems
- Installing and controlling game servers
- Marketplace dependency checks on a target node
- Docker management on a target node
- Remote file browsing and editing
- Public Access provider detection and tunnel/service management
- Backups for managed server data
- Agent Control diagnostics and service management

A standalone Agent binds `127.0.0.1` (loopback) by default. To connect a remote
system, set `AGENT_HOST` on the Agent machine to its LAN or tailnet address and
restart the Agent. Prefer a concrete address over `0.0.0.0`; the Agent prints a
startup warning when it is exposed on every interface.

## First Launch

On first launch, AnxOS shows a welcome/setup experience.

You can:

- Click `Set Up AnxOS` to follow guided setup.
- Click `Explore on My Own` to skip setup and use the app directly.
- Restart the setup guide later from Settings.

## Reporting Bugs

When reporting a bug, include:

- What operating system you used
- Whether you used the installer, portable build, AppImage, or `.deb`
- The AnxOS version and build
- Exact steps to reproduce
- What you expected
- What happened instead
- Screenshots only if they do not show secrets
- Diagnostics summary or exported bundle when requested

Do not share:

- Agent tokens
- Pairing codes
- Passwords
- Supabase tokens
- Cloudflare credentials
- Tailscale auth keys
- Playit secrets
- Private SSH keys
- Full unredacted config files

## Logs

Use the in-app Diagnostics page first.

When asked for local logs:

- Windows logs are stored under the app data folder for AnxOS Control Center.
- Linux logs are stored under the user config/data folders used by AnxOS Control Center.
- Prefer `Diagnostics -> Export Bundle` because it applies AnxOS redaction.

## Safe Uninstall

Windows:

1. Open Windows Settings.
2. Go to Apps.
3. Uninstall `AnxOS Control Center`.

Linux `.deb`:

```bash
sudo apt remove anxos-control-center
```

AppImage:

Delete the AppImage file.

Uninstalling the desktop app should not be treated as a server-data cleanup step. Do not manually delete server folders unless you know the data is no longer needed.

## Known Private-Alpha Limitations

- Some features require live Agent validation on the selected system.
- Marketplace installs depend on external downloads and can be large or slow.
- SteamCMD-based installs may take several minutes.
- Provider capabilities differ between Playit, Tailscale, and Cloudflare Tunnel.
- Public reachability should be verified from another network before relying on it.
- Windows and Linux packaged launch validation must be completed on real graphical machines before broad tester rollout.

