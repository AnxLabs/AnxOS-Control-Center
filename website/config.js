window.ANXOS_DOWNLOAD_CONFIG = {
  brandName: "AnxOS",
  appName: "AnxOS-Control-Center",
  subtitle: "A desktop control center for Minecraft servers, modpacks, remote nodes, and automation.",
  siteUrl: "https://anxoscontrolcenter.org",
  logoPath: "/assets/anxos-logo.png",
  latestVersion: "1.8",
  build: "181",
  buildNumber: "181",
  channel: "Private Alpha",
  releaseLabel: "Version 1.8 Build 181 Private Alpha",
  releaseDate: "July 27, 2026",
  releaseTag: "v1.8-build181",
  releaseRepository: {
    owner: "bungopam-byte",
    repo: "AnxOS-Control-Center-Releases",
  },
  repositoryUrl: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases",
  releaseUrl: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.8-build181",
  githubReleasesApiUrl: "https://api.github.com/repos/bungopam-byte/AnxOS-Control-Center-Releases/releases?per_page=20",
  stableDownloadEndpoints: {
    windows: "/api/download/latest/windows",
    windowsPortable: "/api/download/latest/windows-portable",
    linuxAppImage: "/api/download/latest/linux-appimage",
    linuxDeb: "/api/download/latest/linux-deb",
  },
  releaseAssets: [
      {
          fileName: "AnxOS-Control-Center-Setup-1.8-build181.exe",
          url: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.8-build181/AnxOS-Control-Center-Setup-1.8-build181.exe"
      },
      {
          fileName: "AnxOS-Control-Center-1.8-build181-portable.exe",
          url: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.8-build181/AnxOS-Control-Center-1.8-build181-portable.exe"
      },
      {
          fileName: "AnxOS-Control-Center-1.8-build181.AppImage",
          url: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.8-build181/AnxOS-Control-Center-1.8-build181.AppImage"
      },
      {
          fileName: "AnxOS-Control-Center-1.8-build181.deb",
          url: "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.8-build181/AnxOS-Control-Center-1.8-build181.deb"
      }
  ],
  releaseNotes: [
      {
          "version": "1.8",
          "build": 181,
          "channel": "Private Alpha",
          "tag": "v1.8-build181",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 181 packaged UI font and Marketplace display hotfix",
          "summary": "Private Alpha v1.8 Build 181 fixes packaged UI font rendering and clarifies Marketplace modpack version metadata after build 180.",
          "changes": [
              "Fixed the packaged app global font regression.",
              "Fixed splash, dashboard, sidebar, buttons, and cards font rendering so normal UI text uses the intended readable sans font.",
              "Fixed Marketplace version labels to distinguish Minecraft version from runtime, provider, and server-pack metadata.",
              "Fixed the ATM10 and CurseForge install panel display so Minecraft 1.21.1 is not shown as a generic runtime or server-pack version.",
              "Includes the previous build 180 Marketplace and runtime fixes for CurseForge and Modrinth version resolution, server-pack runtime preservation, ATM10 and NeoForge runtime repair, selected-node marketplace install smoke hardening, and Windows disk stats EPIPE handling."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.8-build181"
      },
      {
          "version": "1.8",
          "build": 180,
          "channel": "Private Alpha",
          "tag": "v1.8-build180",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "AnxOS Version 1.8",
          "summary": "Private Alpha v1.8 Build 180 fixes marketplace modpack version resolution, server-pack runtime handling, and release smoke reliability.",
          "changes": [
              "Fixed CurseForge and Modrinth marketplace version resolution so selected versions are preserved through install planning.",
              "Preserved server-pack runtime metadata during marketplace installs instead of falling back to generic startup behavior.",
              "Repaired ATM10 and NeoForge runtime handling so server packs launch the repaired runtime path instead of installer artifacts.",
              "Hardened the selected-node marketplace install smoke coverage for remote-node install routing.",
              "Handled Windows hardware temperature EPIPE output safely during the disk stats smoke path."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.8-build180"
      },
      {
          "version": "1.7",
          "build": 160,
          "channel": "Private Alpha",
          "tag": "v1.7-build160",
          "date": "July 22, 2026",
          "datetime": "2026-07-22",
          "title": "Build 160 updater reliability maintenance release",
          "summary": "Maintenance release for GitHub prerelease updater checksum compatibility.",
          "changes": [
              "Fixed compatibility with GitHub prerelease SHA-256 digest metadata.",
              "Updater now accepts GitHub API sha256:<digest> values.",
              "Updater now fails before download when required checksum metadata is unavailable.",
              "Existing post-download and install-time SHA-256 verification remain unchanged."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build160"
      },
      {
          "version": "1.7",
          "build": 159,
          "channel": "Private Alpha",
          "tag": "v1.7-build159",
          "date": "July 21, 2026",
          "datetime": "2026-07-21",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build159"
      },
      {
          "version": "1.7",
          "build": 157,
          "channel": "Private Alpha",
          "tag": "v1.7-build157",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build157"
      },
      {
          "version": "1.7",
          "build": 155,
          "channel": "Private Alpha",
          "tag": "v1.7-build155",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build155"
      },
      {
          "version": "1.7",
          "build": 154,
          "channel": "Private Alpha",
          "tag": "v1.7-build154",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "Trusted SteamCMD updates and Agent pairing reliability",
          "summary": "Build 154 fixes paired remote Agent status rendering.",
          "changes": [
              "Added trusted instance-scoped SteamCMD server-file updates with progress and artifact verification.",
              "Migrated supported legacy SteamCMD instances from trusted template metadata.",
              "Shows Paired instead of Waiting for Control Center after successful Agent pairing."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build154"
      },
      {
          "version": "1.7",
          "build": 152,
          "channel": "Private Alpha",
          "tag": "v1.7-build152",
          "date": "July 17, 2026",
          "datetime": "2026-07-17",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build152"
      },
      {
          "version": "1.7",
          "build": 151,
          "channel": "Private Alpha",
          "tag": "v1.7-build151",
          "date": "July 17, 2026",
          "datetime": "2026-07-17",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build151"
      },
      {
          "version": "1.7",
          "build": 150,
          "channel": "Private Alpha",
          "tag": "v1.7-build150",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "Build 150 Private Alpha release polish",
          "summary": "Private Alpha release candidate with startup-command safety fixes, bounded restart behavior, Public Access modal creation, and desktop/website polish.",
          "changes": [
              "Preserved shell-wrapped startup commands as structured executable arguments so Palworld keeps the full bash -lc script intact.",
              "Added bounded restart/backoff handling so immediately crashing instances stop instead of restarting every second forever.",
              "Replaced the Public Access Create Access Service browser prompt with an in-app modal that validates service name, host, port, and protocol.",
              "Polished desktop navigation, dashboard, instances, marketplace, Public Access, files, console, Docker, backups, settings, security, owner tools, node status, empty/error states, accessibility, and copy.",
              "Polished website design, navigation, home, authentication, profile, download, release notes, responsive behavior, accessibility, metadata, and production route readiness.",
              "Bumped the Electron updater package version to 1.0.52 so Private Alpha build 150 updates can be detected."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build150"
      },
      {
          "version": "1.7",
          "build": 149,
          "channel": "Private Alpha",
          "tag": "v1.7-build149",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "Build 149 Private Alpha hotfix",
          "summary": "Private Alpha hotfix for an empty packaged Marketplace and generic CurseForge Agent diagnostics.",
          "changes": [
              "Fixed packaged Marketplace loading by injecting config/marketplace-templates.json into app.asar.",
              "Added config/agent.example.json to the same packaging verification path.",
              "Added artifact smoke assertions so Windows and Linux packages must include the Marketplace template catalog.",
              "Preserved the build 148 shared-module packaging fix.",
              "Preserved CurseForge API and CDN diagnostic results instead of collapsing them to AGENT_HTTP_ERROR.",
              "Updated CurseForge Settings feedback to distinguish Agent reachability, missing configuration, API probe failures, and CDN authentication probe failures.",
              "Bumped the Electron updater package version to 1.0.51 so Private Alpha hotfix updates can be detected."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build149"
      },
      {
          "version": "1.7",
          "build": 148,
          "channel": "Private Alpha",
          "tag": "v1.7-build148",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "Build 148 Private Alpha hotfix",
          "summary": "Private Alpha hotfix for a packaged startup crash caused by shared desktop modules missing from app.asar.",
          "changes": [
              "Fixed a main-process startup crash where diagnostics could not load src/shared/redaction.js from the packaged app.",
              "Added explicit packaging coverage for shared desktop modules used by diagnostics, logging, and release metadata.",
              "Added artifact smoke assertions so Windows and Linux packages must include required shared modules in app.asar.",
              "Preserved the build 147 Local Agent metadata resolver fix.",
              "Bumped the Electron updater package version to 1.0.50 so Private Alpha hotfix updates can be detected."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build148"
      },
      {
          "version": "1.7",
          "build": 147,
          "channel": "Private Alpha",
          "tag": "v1.7-build147",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "Build 147 Private Alpha hotfix",
          "summary": "Private Alpha hotfix for a packaged Windows startup crash caused by Local Agent metadata resolving from the wrong packaged path.",
          "changes": [
              "Fixed a main-process startup crash where diagnostics tried to load Local Agent package metadata from inside app.asar.",
              "Resolved bundled Local Agent version metadata from the packaged local-agent-runtime resource with a safe fallback.",
              "Kept Agent Control update and diagnostics screens working when bundled runtime metadata is unavailable.",
              "Added smoke coverage to prevent diagnostics and Agent Control from hard-loading agent/package.json from app.asar.",
              "Bumped the Electron updater package version to 1.0.49 so Private Alpha hotfix updates can be detected."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build147"
      },
      {
          "version": "1.7",
          "build": 146,
          "channel": "Private Alpha",
          "tag": "v1.7-build146",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build146"
      },
      {
          "version": "1.7",
          "build": 145,
          "channel": "Private Alpha",
          "tag": "v1.7-build145",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build145"
      },
      {
          "version": "1.7",
          "build": 144,
          "channel": "Private Alpha",
          "tag": "v1.7-build144",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build144"
      },
      {
          "version": "1.7",
          "build": 143,
          "channel": "Private Alpha",
          "tag": "v1.7-build143",
          "date": "July 13, 2026",
          "datetime": "2026-07-14",
          "title": "Private Alpha packaged release candidate",
          "summary": "This release prepares AnxOS Control Center for packaged private-alpha validation with hardened production configuration, installer artifacts, onboarding, and broad smoke coverage.",
          "changes": [
              "Generated Windows installer, Windows portable, Linux AppImage, and Debian package artifacts for build 143 validation.",
              "Added packaged build metadata with build date, commit, release channel, public release repository, supported operating systems, and update source.",
              "Fixed Files page onboarding layout and target-state regressions so Windows and Linux paths cannot mix after profile changes.",
              "Hardened packaged account and updater configuration so production builds do not use localhost account URLs or local update metadata sources.",
              "Normalized Linux package permissions so desktop entries, icons, app.asar, and unpacked resources are readable after installation.",
              "Added private-alpha installer guidance, artifact reports, and packaged application smoke validation notes."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build143"
      },
      {
          "version": "1.7",
          "build": 142,
          "channel": "Private Alpha",
          "tag": "v1.7-build142",
          "date": "July 13, 2026",
          "datetime": "2026-07-13",
          "title": "AnxOS Version 1.7",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build142"
      },
      {
          "version": "1.7",
          "build": 141,
          "channel": "Private Alpha",
          "tag": "v1.7-build141",
          "date": "July 11, 2026",
          "datetime": "2026-07-11",
          "title": "Secure diagnostics and Agent Control Center",
          "summary": "This release adds privacy-safe runtime diagnostics and complete in-app controls for local and remote AnxOS Agents.",
          "changes": [
              "Added structured, rotated, secret-redacted diagnostics for desktop, renderer, IPC, authentication, services, updater, and Agent failures.",
              "Added latest-error and runtime-state snapshots, a combined live log, sanitized exports, and authenticated owner-only remote diagnostic capture.",
              "Added an Agent Control Center with status, lifecycle, service startup, repair, safe configuration, diagnostics, log viewing, and first-run setup.",
              "Added Linux systemd user and Windows background-startup management through privileged main-process operations instead of terminal instructions.",
              "Improved the Add Storage dialog lifecycle and guarded asynchronous submissions against duplicate requests.",
              "Added regression coverage for redaction, rotation, snapshots, failure-safe logging, remote authorization, and real Agent start/restart/stop behavior."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build141"
      },
      {
          "version": "1.7",
          "build": 140,
          "channel": "Private Alpha",
          "tag": "v1.7-build140",
          "date": "July 10, 2026",
          "datetime": "2026-07-10",
          "title": "Local Owner authentication recovery",
          "summary": "This release restores existing local Owner credentials and adds visible website password recovery actions.",
          "changes": [
              "Restored packaged-app authentication for persisted Owner accounts created with historical local credentials.",
              "Added safe discovery and migration of Owner accounts from legacy AnxOS configuration directories.",
              "Kept local Owner verification independent from Supabase cloud account authentication.",
              "Added development-only authentication diagnostics that never log passwords, hashes, or tokens.",
              "Added standalone website password recovery pages and visible Reset Password and Change Password actions.",
              "Added regression coverage for credential verification, legacy migration, and session logout account preservation."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build140"
      },
      {
          "version": "1.7",
          "build": 139,
          "channel": "Private Alpha",
          "tag": "v1.7-build139",
          "date": "July 10, 2026",
          "datetime": "2026-07-10",
          "title": "Explicit device identity and workspace routing",
          "summary": "This release separates the desktop host, Agent nodes, and filesystem providers so Windows can reliably control local and remote machines.",
          "changes": [
              "Added stable Agent identities with duplicate-node detection and safe legacy configuration migration.",
              "Made the application host a distinct local node instead of deriving This Device from the configured Agent URL.",
              "Routed Dashboard, Monitoring, Docker, Instances, Files, SSH, Backups, Marketplace, and Security through the selected node.",
              "Separated local, Agent-native, and SFTP filesystem providers so only explicit SFTP connections create SFTP sessions.",
              "Added development routing diagnostics and regression coverage for node switching, persistence, migration, and filesystem routing."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.7-build139"
      },
      {
          "version": "1.6",
          "build": 138,
          "channel": "Private Alpha",
          "tag": "v1.6-build138",
          "date": "July 9, 2026",
          "datetime": "2026-07-09",
          "title": "Marketplace runtime selector and storefront polish",
          "summary": "This release fixes Marketplace modpack runtime selection and aligns Marketplace card actions like a proper storefront.",
          "changes": [
              "Added a Server Runtime selector so modpacks no longer default to Paper.",
              "Uses provider loader metadata from CurseForge and Modrinth to preselect Fabric, Forge, NeoForge, Quilt, Paper, Purpur, or Vanilla.",
              "Added Quilt server runtime install support through the official Quilt metadata and installer flow.",
              "Stopped the installer from overwriting the selected runtime during submit.",
              "Aligned Marketplace Install buttons across card rows and clamped long descriptions.",
              "Updated smoke coverage for runtime detection, no Paper preselect, provider loader metadata, and Quilt install handling."
          ],
          "url": "https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/tag/v1.6-build138"
      }
  ],
};
