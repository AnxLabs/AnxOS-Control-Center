# Headless Agent Install (Linux `.deb`)

The headless path installs the same AnxOS Agent runtime that Control Center uses
on a Linux server with no desktop. The Agent is one runtime with three surfaces —
the Control Center Agent Control GUI, the `anxos-agent` CLI/TUI, and the Control
Center protocol/API — so pairing, identity, authentication, and lifecycle logic
come from one authoritative implementation in the Agent runtime.

## Supported platforms

| Platform | Package | Notes |
| --- | --- | --- |
| Debian 11+ x64 | `AnxOS-Agent-<version>.deb` | glibc >= 2.28 |
| Ubuntu 22.04+ x64 | `AnxOS-Agent-<version>.deb` | glibc >= 2.28 |
| Windows 11 x64 | AnxOS Control Center installer | The signed installer includes and sets up the Agent. To connect a second Windows computer, use **Agent Control → Connect this computer** and paste its full pairing code under **Add Computer** in Control Center. |
| Other distributions or architectures | — | Not supported. Do not force-install a package built for a different architecture. |

## Verification status

This document matches the frozen Build 205 contract, and Build 205 package behavior was verified end to end on a real Linux host.

- **Verified on WSL2 Ubuntu 24.04 (systemd):** the Build 205 `.deb` installs, the
  `anxos-agent.service` system unit runs, the TUI and CLI work, and the remote
  pairing flow was verified end to end: a fresh packaged Agent stays unenrolled
  across service restarts and a VM reboot (`tokenOrigin: "generated"`); a
  Control-Center-style remote pairing completes `200` (previously `403`); an
  enrolled node still returns `403` without the credential; a replayed pairing
  request returns `401`; and health/stats answer with the token. `apt remove`
  (including `purge`) keeps `/var/lib/anxos-agent`, and reinstalling preserves
  identity and enrollment. `anxos-agent update --check` was verified against a
  local test release endpoint for the `update-available`, `current`, and
  `unknown` states and the no-downgrade rule.
- **Fixed and verified during acceptance:** the packaged Agent no longer
  self-enrolls on restart; `unpair` preserves the config file ownership so the
  service user keeps access (a root-run CLI no longer breaks it); the CLI
  resolves packaged config and log paths from a plain root shell; and
  re-pairing a revoked node recovers its enrollment instead of dead-ending at
  `410 REVOKED`.
- **Honest limits:** WSL2 is representative of Debian and Ubuntu but uses a
  WSL2 kernel — this is not bare-metal acceptance. arm64 packaging is
  mechanism-only (no arm64 hardware was used). Linux artifacts are not
  code-signed; the published SHA-256 is the integrity check. The CI/release
  workflow wiring that produces and publishes the Agent `.deb` is
  approval-gated and has not been run, so until the releases page lists the
  artifact and its `AnxOS-Agent-<version>.deb.sha256` checksum file, treat the
  package as pending and do not present it as available.

Run the commands below only after the releases page lists the Build 205 package.

## 1. Download and verify

Open the Agent releases page:

```text
https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/latest
```

Download `AnxOS-Agent-<version>.deb` (for example
`AnxOS-Agent-2.0-build205.deb`) and its checksum file
`AnxOS-Agent-<version>.deb.sha256` from the same release into one directory,
then verify the checksum before installing:

```sh
cd ~/Downloads
sha256sum -c AnxOS-Agent-<version>.deb.sha256
```

Expected: `AnxOS-Agent-...deb: OK`. The checksum file holds the package hash and
file name in the standard `sha256sum` format, so the command verifies the exact
package you downloaded. If the check fails, delete the file and download it
again; never install a package whose checksum does not match.

## 2. Install

```sh
sudo apt install ./AnxOS-Agent-<version>.deb
```

`apt` resolves dependencies from your configured repositories. If `apt` cannot
run, the `dpkg` fallback is:

```sh
sudo dpkg -i ./AnxOS-Agent-<version>.deb || sudo apt-get -f install
```

Confirm the installed version:

```sh
anxos-agent --version
```

The sudo password is entered by the operator and is never captured or recorded.

## 3. Check the service

The package installs a systemd **system** unit named `anxos-agent.service`.

```sh
sudo systemctl status anxos-agent.service --no-pager
sudo anxos-agent service status
anxos-agent status
```

- `sudo` is required for service control and for the full status output.
- Without `sudo`, `anxos-agent status` reports what it can read and states what
  needs elevated access.
- `anxos-agent status` always exits `0` by contract: it reports reachability,
  service state, and enrollment in its output (and in the `--json` fields)
  instead of failing the command. Scripts must gate on those fields, not on the
  exit code.
- On first read of a config written by an older Agent, `status` may perform a
  one-time config-schema migration write (a verified pre-migration backup is
  taken first). This is a normal, once-per-install upgrade step.
- Pairing works without `sudo` over loopback.

Service commands:

```sh
sudo anxos-agent service start
sudo anxos-agent service stop
sudo anxos-agent service restart
```

Storage layout:

| Path | Contents |
| --- | --- |
| `/var/lib/anxos-agent/config` | Agent configuration and identity state |
| `/var/lib/anxos-agent/instances` | Managed server instances |
| `/var/lib/anxos-agent/backups` | Backups |
| `/var/log/anxos-agent` | Logs |
| `/etc/anxos-agent/agent.env` | Network override file (explicit opt-in bind changes) |

## 4. Walk through the TUI (status → network opt-in → pair → connected)

Run `anxos-agent` with no arguments to open the TUI. The TUI and the CLI
subcommands drive the same runtime actions; use whichever surface is available.

1. **Status.** The TUI opens on service and Agent status. Confirm the service is
   running, the bind address is loopback by default, and the device identity is
   present. The same data is available non-interactively with
   `anxos-agent status` (add `sudo` for the full view).
2. **Allow network access — only when another computer will connect.** The
   default loopback bind means the code the CLI prints can be used only on the
   server itself. If Control Center on another computer will pair with this
   server, open the TUI with `sudo anxos-agent`, choose **Pair**, and press
   **n** to allow network access for your network. You can instead pin the bind
   in `/etc/anxos-agent/agent.env` with
   `AGENT_HOST=<LAN-or-tailnet-IP>` and restart the service. Read the risk in
   section 6 before opening the Agent to the network.
3. **Pair.** Choose Pair in the TUI, or run:

   ```sh
   anxos-agent pair
   ```

   If the Agent is still loopback-only, `pair` prints a notice with this remedy
   before showing the code, because a code minted over loopback advertises
   `127.0.0.1` and another computer cannot redeem it.

   The Agent displays a one-time pairing code that is valid for 10 minutes.
   Copy the **full pairing code** — the long value printed under
   `Pairing code (paste into Add Computer):` — and not just the short
   `ANX-XXXX-XXXX-XXXX` **Reference code**. The full code may wrap across lines
   in the terminal; Control Center ignores whitespace in the pasted code, so
   wrapped fragments are accepted. The short reference code identifies this
   session on screen (and for support); it is not what Control Center accepts
   on its own.

   The code is temporary sensitive material: do not record it, screenshot it,
   or paste it into a bug report.
4. **Connected.** In AnxOS Control Center, open **Add Computer** and choose
   **Connect a headless server**, then paste the full pairing code and confirm
   the Agent identity the app shows. After the Control Center confirms the
   pairing, `anxos-agent status` reports the node as paired. The permanent
   credential is created by pairing and is never displayed.

## 5. Pair from Control Center

**Add Computer** offers both paths with instructions:

- **This computer (desktop)** — for a computer where Control Center is
  installed or will be installed.
- **Headless server** — for a Linux server with the `AnxOS-Agent` package.

For a headless server:

1. Allow network access on the server if Control Center runs on another
   computer (section 6), then generate the code (`anxos-agent pair`, or Pair in
   the TUI). Copy the **full pairing code** (the long value under
   `Pairing code (paste into Add Computer):`); the short
   `ANX-XXXX-XXXX-XXXX` reference code only identifies the session on screen.
2. In Control Center, open **Add Computer → Connect a headless server**.
3. Paste the full pairing code (it may wrap across lines; whitespace is
   ignored) and confirm the Agent identity and capability summary the app
   shows before accepting.
4. Wait for the node to come online.

On Windows, installing AnxOS Control Center includes and sets up the Agent. To
connect a second Windows computer, open **Agent Control → Connect this computer**
on that computer, turn on **Another computer will connect to this one**, and
choose **Generate Pairing Code**; then paste the full code into Control Center
under **Add Computer**. Both computers must be on the same network or tailnet,
and the short reference code alone is not accepted there.

## 6. Network opt-in and its risk

The packaged Agent binds `127.0.0.1` (loopback) by default. Only the server
itself can reach it until you opt in.

Enabling another computer to connect is an explicit opt-in from the TUI. On
Windows, the same opt-in is the **Another computer will connect to this one**
choice in **Agent Control → Connect this computer**: when it is on, the code
advertises this machine's network address; when it is off, the code advertises
loopback and works only on that computer.

The bind address can also be pinned in `/etc/anxos-agent/agent.env` (for
example, `AGENT_HOST=<LAN-or-tailnet-IP>`). A concrete LAN or tailnet address is
safer than `0.0.0.0`: a wildcard bind exposes the Agent on every interface and
loses the strict Host allowlist.

> **Risk:** while the Agent is network-reachable and not yet paired, anyone who
> can reach it could claim it. Pair promptly after enabling network access, and
> prefer a private LAN or tailnet address over a public one.

## 7. Check for updates

```sh
anxos-agent update --check
```

The check is read-only: it never downloads or installs anything, and reports
one of three states. `anxos-agent update --check` always exits `0` by contract,
including for `unknown`; gate scripts on the `state` field (and the printed
reason), not on the exit code.

- `update-available` — a newer package is published. The output includes the
  download URL, the checksum URL, and the install command.
- `current` — the installed package is the latest release. If the installed
  package is newer than the latest release (for example, a locally built
  candidate), the state stays `current` with an explanatory note: no downgrade
  is suggested.
- `unknown` — the release source could not be read (offline, rate-limited, an
  invalid URL, or a development/source install with no package identity). The
  reason is printed instead of guessing.

Follow the printed install command for an offered update, or let Control Center
coordinate the Agent update when it reports a version mismatch.

## 8. Unpair and re-pair

`unpair` revokes this node's enrollment and clears the stored credential while
preserving servers (instances), backups, and configuration.

```sh
sudo anxos-agent unpair        # prompts for confirmation; use --yes in a script
```

- `sudo` is needed because the stored credential lives in the packaged config.
  The CLI preserves the config file's ownership, so the service user keeps
  access after the write.
- The running Agent keeps its in-memory credential until it restarts.
- After unpair the node is revoked: authenticated requests answer
  `410 REVOKED` until it is enrolled again.

Re-pairing is the recovery path. When pairing completes against a revoked
record, the Agent restores the enrollment from the new credential instead of
leaving the node dead-ended:

1. On the server, run `anxos-agent pair` (or choose Pair in the TUI) for a
   fresh one-time code.
2. In Control Center, open **Add Computer → Connect a headless server** and
   paste the full pairing code (not only its short reference code).
3. Pairing reports the recovered enrollment, and `anxos-agent status` reports
   the node as paired again.

## 9. Uninstall (data is kept)

```sh
sudo apt remove anxos-agent
```

Uninstalling keeps all data. Servers (instances), settings, and backups remain
in `/var/lib/anxos-agent`. The package also leaves `/var/log/anxos-agent` and
`/etc/anxos-agent/agent.env` in place. Delete those only when you are sure the
data is no longer needed.

## Troubleshooting

**Automatic dependency installation and sudo.** When a template needs packages
that are missing on the node (for example Java 21 for Minecraft), the Agent can
install them automatically on Debian/Ubuntu, but that path may require
non-interactive sudo (passwordless `sudo -n`) for the Agent's service account on
the node. Without it, the Agent reports the dependency as a manual action and
Control Center shows the package to install instead of installing it
automatically; install the listed package with your normal `sudo` session and
retry.

| Symptom | Checks | Fix |
| --- | --- | --- |
| Service not running | `sudo systemctl status anxos-agent.service --no-pager`; `sudo anxos-agent service status` | Start it with `sudo anxos-agent service start`; if it stops again, read `anxos-agent logs` and `/var/log/anxos-agent` for the first error |
| Port in use | `ss -ltnp` | Stop the process holding the port, or change the Agent port, then restart the service |
| Pairing code expired | Codes are one-time and valid for 10 minutes | Run `anxos-agent pair` again for a fresh code |
| Control Center reports `Pairing code is invalid` | The short `ANX-XXXX-XXXX-XXXX` reference code alone is not accepted by Add Computer | Copy the full long pairing code printed under `Pairing code (paste into Add Computer):` and paste it whole; whitespace and wrapped newlines are ignored |
| Agent unreachable from Control Center | Service state; bind address; firewall | Confirm the service is running and network opt-in is enabled; verify from the server first (`curl -fsS http://<host>:<agent-port>/api/v1/health`), then check the firewall or cloud security group |
| Unsupported OS or architecture | `uname -m`; `cat /etc/os-release` | Supported: Debian 11+/Ubuntu 22.04+, x64, glibc >= 2.28. Do not force-install on another architecture |
| Node answers `410 REVOKED` after unpair | `anxos-agent status`; enrollment state | Pair again (`anxos-agent pair` for a fresh code, then **Add Computer → Connect a headless server**); re-pairing restores the enrollment |

## Security notes

- The Agent binds loopback by default; remote reachability is an explicit
  opt-in.
- Pairing codes are one-time and valid for 10 minutes.
- Full tokens never appear in the TUI, CLI output, logs, or diagnostics.
  Diagnostics may show fingerprints only when needed for troubleshooting.
- `sudo` is needed only for service control and the full status; pairing itself
  works without `sudo` over loopback.
- Do not paste pairing codes, tokens, or unredacted diagnostics into bug
  reports. Use `anxos-agent diagnostics` and the app's sanitized export instead.

## Related documentation

- `docs/LOCAL_AGENT_ARCHITECTURE.md` — one runtime, three surfaces, packaging,
  and the permission-profile contract.
- `docs/LOCAL_AGENT_SECURITY.md` — local Agent security rules.
- `docs/NEW_USER_GUIDE.md` — first-run and daily-use guidance.
- `docs/DEBIAN_ACCEPTANCE_PROCEDURE.md` — the real-host `.deb` acceptance
  procedure, including the Agent package appendix.
