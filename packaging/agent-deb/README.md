# AnxOS Agent Debian package

Official packaging for the standalone AnxOS Agent: a headless Debian/Ubuntu
install that needs no git, no npm, and no source checkout. The artifact bundles
the Agent sources, their staged Node dependency closure, and an official Node
22 LTS Linux runtime.

## Artifact

| Platform | Artifact |
| --- | --- |
| amd64 (default) | `dist/AnxOS-Agent-<artifactVersion>.deb` + `.sha256` |
| arm64 (`--arch arm64`) | `dist/AnxOS-Agent-<artifactVersion>-arm64.deb` + `.sha256` |

`<artifactVersion>` comes from `release.json` through
`src/shared/releaseConfig.js` (for example `2.0-build205`). The `.sha256` file
is the standard `sha256sum` format (`<hash>  <filename>`).

## Install layout

| Path | Mode | Owner | Purpose |
| --- | --- | --- | --- |
| `/usr/lib/anxos-agent/agent/**` | 0644/0755 | root:root | Agent sources (`agent/src/**`, `agent/package.json`) |
| `/usr/lib/anxos-agent/src/shared/**`, `src/services/**` | 0644 | root:root | Shared modules required by the Agent graph |
| `/usr/lib/anxos-agent/node_modules/**` | 0644 | root:root | Staged runtime dependency closure |
| `/usr/lib/anxos-agent/config/agent.example.json` | 0644 | root:root | Config template |
| `/usr/lib/anxos-agent/config/local-agent-runtime.json` | 0644 | root:root | Runtime manifest |
| `/usr/lib/anxos-agent/config/marketplace-templates.json` | 0644 | root:root | Catalog data shipped with the runtime |
| `/usr/lib/anxos-agent/agent-release.json` | 0644 | root:root | Release identity stamped at build time (`artifactVersion`, `releaseTag`, `builtAt`) |
| `/usr/lib/anxos-agent/node/bin/node` | 0755 | root:root | Bundled official Node 22 LTS binary |
| `/usr/bin/anxos-agent` | 0755 | root:root | POSIX sh wrapper for `agent/src/cli.js` |
| `/lib/systemd/system/anxos-agent.service` | 0644 | root:root | systemd unit |
| `/etc/anxos-agent/agent.env.example` | 0644 | root:root | Documented override template |

The wrappers `src/shared` and `src/services` are copied whole (`.js` only, no
source maps), mirroring the desktop `extraResources` selection. Test trees,
`.env*`, logs, identity/enrollment/nodes state, `.map` files and tooling state
(`.mimosa`) are never staged.

## Runtime data (never removed by the package)

| Path | Mode | Owner | Purpose |
| --- | --- | --- | --- |
| `/var/lib/anxos-agent/config` | 0700 | anxos-agent | Agent configuration and identity |
| `/var/lib/anxos-agent/instances` | 0750 | anxos-agent | Managed instance roots |
| `/var/lib/anxos-agent/backups` | 0750 | anxos-agent | Backup payloads |
| `/var/log/anxos-agent` | 0750 | anxos-agent | Agent logs |
| `/etc/anxos-agent` | 0750 | root:anxos-agent | Operator override directory |

`postinst` only creates/adjusts these directories; `prerm` and `postrm` never
delete them. `remove` and `purge` print the exact preserved paths.

## Service unit

`anxos-agent.service` runs `Type=simple`, `User=Group=anxos-agent`,
`WorkingDirectory=/var/lib/anxos-agent`, and starts the Agent directly with the
bundled runtime:

```
ExecStart=/usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/server.js
```

Defaults include `ANXHUB_CONFIG_DIR=/var/lib/anxos-agent/config`,
`AGENT_HOST=127.0.0.1`, `AGENT_PORT=47131`,
`AGENT_INSTANCE_ROOT=/var/lib/anxos-agent/instances`,
`AGENT_BACKUP_ROOT=/var/lib/anxos-agent/backups`,
`ANXOS_LOG_DIR=/var/log/anxos-agent`, `NODE_ENV=production`.

`EnvironmentFile=-/etc/anxos-agent/agent.env` is read after those defaults, so
an operator file overrides any of them. The leading `-` keeps the unit valid
when the file does not exist yet.

## Build

The package is assembled on any platform; only `dpkg-deb` (Linux) can turn the
staged tree into a real `.deb`.

```sh
# Windows / macOS (staged tree only, placeholder Node runtime):
node scripts/build-agent-deb.js --stage-only

# Linux with dpkg-deb, official Node fetched and SHA-256 verified:
node scripts/build-agent-deb.js --download-node

# Linux with a Node runtime already extracted from nodejs.org:
node scripts/build-agent-deb.js --node-dir /opt/node-v22.14.0-linux-x64

# arm64 target (mechanism only; see Architecture support):
node scripts/build-agent-deb.js --arch arm64 --download-node

# npm script
npm run agent:deb:build -- --download-node
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--arch amd64\|arm64` | Target architecture. Default `amd64`. Any other value fails. |
| `--download-node` | Download `node-<ver>-linux-<arch>.tar.gz` + `SHASUMS256.txt` from nodejs.org, verify SHA-256, extract only `bin/node`. |
| `--node-dir <path>` | Use an already-extracted Node tree (`<path>/bin/node` or `<path>/node`). The binary must be a Linux ELF of the target architecture. |
| `--stage-only` | Assemble the tree without a Node runtime (placeholder at `node/bin/node` marks it non-runnable) and never invoke `dpkg-deb`. |
| `--stage-dir <path>` | Stage location (default `dist/agent-deb/stage-<arch>`). |
| `--output-dir <path>` | Artifact location (default `dist`). |
| `--no-refresh-deps` | Reuse `resources/agent-runtime-node-modules` as-is instead of re-running `scripts/prepare-agent-runtime-dependencies.js`. |
| `--keep-stage` | Keep the staged tree after a successful build. |
| `--node-version <ver>` | Override the pinned Node version (default `22.14.0`, or `ANXOS_AGENT_NODE_VERSION`). |

When `dpkg-deb` is unavailable the script stages the tree and prints
`STAGED-ONLY` together with the exact two commands to finish on Linux. The real
build invokes:

```
dpkg-deb --build --root-owner-group <stage-dir> <artifact>
sha256sum <artifact> > <artifact>.sha256
```

The dependency closure is staged by the existing
`scripts/prepare-agent-runtime-dependencies.js`; the build script never
duplicates that resolver.

Every build stamps `usr/lib/anxos-agent/agent-release.json` (installed at
`/usr/lib/anxos-agent/agent-release.json`) with the package's release identity:
`schemaVersion`, `product`, `artifactVersion`, `releaseTag` and `builtAt`,
derived from `release.json` through `src/shared/releaseConfig.js`. The identity
contains release provenance only (no secrets) and lets `anxos-agent update
--check` compare the installed package against release artifacts instead of the
placeholder version in `agent/package.json`.

## Verify

```sh
npm run agent:package:smoke
```

The smoke stages a tree, proves the hermetic require-graph closure resolves
from the staged runtime root, rejects forbidden files (`agent/config/**`,
`.env*`, logs, identity/enrollment/nodes state, `.map`, test trees), validates
control fields, unit/ExecStart targets, wrapper content/mode, POSIX `sh`
syntax, token-looking literals, and provably never removes
`/var/lib/anxos-agent` or `/var/log/anxos-agent`. Where `dpkg-deb` exists it
also builds, inspects (`-I`, `-c`, `-e`), and extracts (`-x`) a real `.deb` into
a temporary directory.

Manual verification of a built artifact:

```sh
dpkg-deb -I dist/AnxOS-Agent-<artifactVersion>.deb
dpkg-deb -c dist/AnxOS-Agent-<artifactVersion>.deb
sha256sum -c dist/AnxOS-Agent-<artifactVersion>.deb.sha256
```

## Update and downgrade behavior

There are two distinct update paths, and they must not be mixed:

- **Local package update (the supported path for this install).** Run
  `sudo anxos-agent update --check` on the node to see whether a newer release
  exists, then install it with `sudo apt install ./AnxOS-Agent-<newer>.deb` (or
  `sudo dpkg -i AnxOS-Agent-<newer>.deb`). The CLI compares the package's
  stamped `agent-release.json` `artifactVersion` (for example `2.0-build205`)
  against the `.deb` asset of the latest release, so it never mistakes the
  runtime's placeholder `agent/package.json` version for a package version. A
  source checkout has no release identity: `update --check` reports the state
  as `unknown` with a "development or source install" reason instead of
  claiming an update is available. `ANXOS_AGENT_RELEASE_PATH` can override the
  identity file location.
- **Desktop push update (Control Center → Remote Agent update).** This path
  ships the Desktop's bundled runtime over SSH and restarts the node's systemd
  **user** unit. It applies only to desktop-managed nodes. A node whose Agent
  runs from the package's systemd **system** unit is refused with
  `REMOTE_AGENT_UPDATE_PACKAGE_MANAGED` before any stage/swap/backup command
  runs; update that node locally with the package path above, or reinstall the
  package. Do not point Desktop push updates at a .deb-installed node: dpkg
  owns `/usr/lib/anxos-agent`, so out-of-band file replacement would break
  package integrity and the next `apt`/`dpkg` operation could revert it.

Package lifecycle behavior:

- **Upgrade:** `dpkg -i AnxOS-Agent-<newer>.deb` (or `apt install ./…deb`)
  replaces `/usr/lib/anxos-agent`, the wrapper, and the unit. `postinst` re-runs,
  re-enables the service, and — because dpkg reports the previously installed
  version — best-effort `systemctl try-restart`s an active unit so the new
  payload takes effect immediately instead of waiting for a manual restart. The
  running Agent service is gracefully stopped and restarted by systemd; the
  Agent's own shutdown path stops running instances before it exits. A fresh
  install has no previous version and only runs `enable --now`. `/etc/anxos-agent/agent.env`
  and all runtime data survive because the package does not own them.
- **Downgrade:** APT will not downgrade a package automatically, but `dpkg -i
  AnxOS-Agent-<older>.deb` installs the older build (dpkg warns about the
  downgrade). Unit/wrapper/sources revert; runtime data is untouched. A
  downgrade that jumps across incompatible Agent data migrations is the
  operator's risk; take a backup of `/var/lib/anxos-agent` first.
- **Remove:** `apt remove anxos-agent` stops and disables the service and
  removes package files. Data and `/etc/anxos-agent` contents are preserved.
- **Purge:** `apt purge anxos-agent` behaves the same for data: the package
  prints the exact preserved paths instead of deleting them. Removing those
  paths stays a manual, deliberate operator action.

## Security posture

- **Loopback by default.** The Agent binds `127.0.0.1:47131`. Reaching it from
  another machine requires an explicit override in `/etc/anxos-agent/agent.env`
  (`AGENT_HOST`), which is the documented network opt-in.
- **Permission profile.** The unit deliberately sets `ANXHUB_CONFIG_DIR`. Per
  `agent/src/permissions.js:50-62`, that variable is the existing spawn contract
  that selects the `local-owner` profile. It is intentional for this
  single-owner package, and it means a deployment exposed to a network should
  pin `AGENT_PERMISSION_PROFILE=restricted` (fail-closed) unless the wildcard
  local-owner grant is truly wanted.
- **Docker group.** `postinst` best-effort adds `anxos-agent` to the `docker`
  group only when that group exists; docker group membership is effectively
  root-equivalent and is required for container workloads.
- **Least privilege.** The service runs as the unprivileged system account
  `anxos-agent` with `/usr/sbin/nologin`, and data is owned by that account with
  `0700` config.
- **Secrets.** Staging never copies `agent/.env`, `agent/config/**`,
  `config/device-identity.json`, `config/enrollment.json`, `config/nodes.json`
  or any `*.log`; the smoke re-asserts this and scans staged text for
  token-looking literals.
- **Unsigned artifacts.** This build path does not produce a signed `.deb` or a
  signed APT repository. Distribution is manual-install with SHA-256 checksum
  verification only.

## Architecture support

`amd64` is the supported and verified target. `arm64` is supported by the build
flags (control `Architecture: arm64`, Node `arm64` binary, `-arm64` artifact
suffix) but has never been built or booted on real arm64 hardware, so it is
mechanism-only / unverified.
