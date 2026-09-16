window.ANXOS_DOWNLOAD_CONFIG = {
  brandName: "AnxOS",
  appName: "AnxOS-Control-Center",
  subtitle: "A desktop control center for Minecraft servers, modpacks, remote nodes, and automation.",
  siteUrl: "https://anxoscontrolcenter.org",
  logoPath: "/assets/anxos-logo.png",
  latestVersion: "1.9",
  build: "200",
  buildNumber: "200",
  channel: "Private Alpha",
  releaseLabel: "Version 1.9 Build 200 Private Alpha",
  releaseDate: "September 15, 2026",
  releaseTag: "v1.9-build200-rc4",
  releaseRepository: {
    owner: "AnxLabs",
    repo: "AnxOS-Control-Center-Releases",
  },
  repositoryUrl: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases",
  releaseUrl: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build200-rc4",
  githubReleasesApiUrl: "https://api.github.com/repos/AnxLabs/AnxOS-Control-Center-Releases/releases?per_page=20",
  stableDownloadEndpoints: {
    windows: "/api/download/latest/windows",
    windowsPortable: "/api/download/latest/windows-portable",
    linuxAppImage: "/api/download/latest/linux-appimage",
    linuxDeb: "/api/download/latest/linux-deb",
  },
  releaseAssets: [
      {
          fileName: "AnxOS-Control-Center-Setup-1.9-build200.exe",
          url: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v1.9-build200-rc4/AnxOS-Control-Center-Setup-1.9-build200.exe"
      },
      {
          fileName: "AnxOS-Control-Center-1.9-build200-portable.exe",
          url: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v1.9-build200-rc4/AnxOS-Control-Center-1.9-build200-portable.exe"
      },
      {
          fileName: "AnxOS-Control-Center-1.9-build200.AppImage",
          url: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v1.9-build200-rc4/AnxOS-Control-Center-1.9-build200.AppImage"
      },
      {
          fileName: "AnxOS-Control-Center-1.9-build200.deb",
          url: "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v1.9-build200-rc4/AnxOS-Control-Center-1.9-build200.deb"
      }
  ],
  releaseNotes: [
      {
          "version": "1.9",
          "build": 200,
          "channel": "Private Alpha",
          "tag": "v1.9-build200-rc4",
          "date": "September 15, 2026",
          "datetime": "2026-09-16",
          "title": "AnxOS Version 1.9",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build200-rc4"
      },
      {
          "version": "1.9",
          "build": 199,
          "channel": "Private Alpha",
          "tag": "v1.9-build199",
          "date": "September 4, 2026",
          "datetime": "2026-09-04",
          "title": "AnxOS Control Center v1.9 — Build 199 (Final V1 Build)",
          "summary": "Final V1 Private Alpha build. Closes the remaining V1-B acceptance evidence gaps: the explicit V1 feature set with maturity labeling, the audit-trail decision record, and a live backup-to-restore round-trip drill on real hardware. Build 200 is reserved for V2 and is intentionally not created.",
          "sections": [
              {
                  "heading": "Highlights",
                  "items": [
                      "Documented the explicit V1 feature set: 20 features with Supported/Alpha-form maturity, the unsupported-in-V1 list, and five UI labeling rules for experimental and unsupported features.",
                      "Recorded the action-audit-trail decision: V1 relies on operation records, structured IPC logs, and confirmation dialogs; a tamper-evident audit store is deferred to V2 with explicit trigger conditions.",
                      "V1-B acceptance gate position upgraded to met (items 1, 4, and 5 closed with dated evidence; item 3 gained live state-contract evidence)."
                  ]
              },
              {
                  "heading": "Fixes",
                  "items": [
                      "Closed V1-B acceptance-record gaps for the feature-set/labeling matrix, audit-trail decision, and live backup-to-restore round trip.",
                      "Added the two new V1 records to the documentation index so current normative documents stay discoverable."
                  ]
              },
              {
                  "heading": "Validation",
                  "items": [
                      "Live backup-to-restore round trip executed 2026-09-04 on Better MC [FORGE] BMC4 via the packaged v1.9 build against the Anxlab agent: complete backup, restore with confirmation dialog, agent safety snapshot before restore, restart-after-restore verified. Custom-command instances correctly reject world backups with WORLD_PATH_NOT_FOUND.",
                      "qa:fast, qa:feature, rc:validate, docs:architecture:smoke, and onboarding:smoke executed for this build."
                  ]
              },
              {
                  "heading": "Known limitations",
                  "items": [
                      "V1-B item 7 (additional-tester feedback / multi-environment Beta regression) remains evidence-pending.",
                      "The code-signing certificate expired 2026-09-05 and must be renewed before the next signed release.",
                      "Custom-command instances (Terraria, Rust) have no world directory, so world-only backups are unavailable for them; full-instance backups still apply."
                  ]
              }
          ],
          "changes": [],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build199"
      },
      {
          "version": "1.9",
          "build": 198,
          "channel": "Private Alpha",
          "tag": "v1.9-build198",
          "date": "September 4, 2026",
          "datetime": "2026-09-04",
          "title": "AnxOS Control Center — Build 198",
          "summary": "Private Alpha Build 198 fixes stale instance-runtime state so a dead process no longer blocks updates or masquerades as a failure, and records the V1-A live two-instance acceptance drill.",
          "changes": [
              "Added instance runtime reconciliation: a stale persisted Running state with no live, identity-matching process now reconciles to Stopped (startable, updatable) instead of a blocking Unknown.",
              "Added stale-PID recovery: a dead PID is authoritative proof the runtime is gone; recovery lands on Stopped while STALE_PID survives as last-operation evidence.",
              "Fixed failed instance operations masquerading as live runtime state - the failure now surfaces as a Last-operation tooltip while the state pill shows the reconciled state (resolves the lingering RELOAD FAILED presentation on Palworld).",
              "SteamCMD marketplace and server-file updates now consult the reconciled runtime state, so a stale Running record no longer blocks updates with STEAMCMD_UPDATE_REQUIRES_STOPPED.",
              "Recorded the 2026-09-04 V1-A live drill: Terraria TShock and Better MC [FORGE] BMC4 started concurrently on the Anxlab Debian agent, with independent live metrics, console output, and a clean confirmed stop.",
              "Validation: qa:fast, qa:feature (19 suites including the new runtime-reconciliation smoke), full rc:validate, and the live two-instance drill on real hardware."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build198"
      },
      {
          "version": "1.9",
          "build": 196,
          "channel": "Private Alpha",
          "tag": "v1.9-build196",
          "date": "September 4, 2026",
          "datetime": "2026-09-04",
          "title": "AnxOS Control Center — Build 196",
          "summary": "Private Alpha Build 196 hardens resource-operation and instance-health lifecycles, adds four new lifecycle smoke suites, and establishes the master roadmap and B0 baseline capability matrix.",
          "changes": [
              "Added a resource operation lifecycle module with regression coverage for stable resource identity, transient operation overlays, cancellation, and stale-response protection.",
              "Added an instance metrics lifecycle module with bounded scheduling and node-scoped stale-response protection.",
              "Added an instance health summary module with health classification across reconciliation and failure evidence.",
              "Wired four new lifecycle smoke suites (resource operations, instance metrics, instance health summary, instance health state) into the feature validation tier.",
              "Added the master product roadmap and B0 baseline capability matrix with Phase 11A reconciliation outcomes, indexed in the documentation index.",
              "Fixed the node-switch Docker refresh finalizer so the in-flight flag is always released, preventing refresh deadlock after a mid-request node switch.",
              "Validation: fast tier passed, feature tier passed 17/17, full RC source validation, and packaging smoke against a freshly rebuilt signed Windows installer."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build196"
      },
      {
          "version": "1.9",
          "build": 194,
          "channel": "Private Alpha",
          "tag": "v1.9-build194",
          "date": "August 1, 2026",
          "datetime": "2026-08-01",
          "title": "Build 194 desktop reliability and server maintenance",
          "summary": "Private Alpha Build 194 adds one-click SteamCMD server updates, bundled Windows runtimes and CPU telemetry, tray behavior, responsive workflow polish, and reliable elevated Agent startup migration.",
          "changes": [
              "Added provider-driven one-click SteamCMD updates for supported game servers.",
              "Bundled Java and Embedded LibreHardwareMonitor runtime support on Windows.",
              "Separated the standard desktop UI from the elevated background Agent.",
              "Migrated legacy Agent scheduled tasks and prevented duplicate Agent startup.",
              "Improved Marketplace, Create Server, Instances, Files, Settings, backups, and responsive layouts."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build194"
      },
      {
          "version": "1.9",
          "build": 193,
          "channel": "Private Alpha",
          "tag": "v1.9-build193",
          "date": "July 29, 2026",
          "datetime": "2026-07-29",
          "title": "Build 193 Marketplace and productivity release",
          "summary": "Private Alpha release with reliable Marketplace deployments, unified server creation, synchronized operations and notifications, and dashboard productivity improvements.",
          "changes": [
              "Added dedicated Marketplace and Create Server windows backed by one deployment pipeline.",
              "Validated ATM10 and Minecraft Paper deployments through the signed packaged application.",
              "Synchronized Download Manager, notifications, dashboard totals, and instance registration.",
              "Repaired the Agent restart lifecycle and verified restart without PORT_IN_USE.",
              "SSH remains under stabilization and is deferred to a future build."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build193"
      },
      {
          "version": "1.9",
          "build": 192,
          "channel": "Private Alpha",
          "tag": "v1.9-build192",
          "date": "July 28, 2026",
          "datetime": "2026-07-28",
          "title": "Build 192 Unpublished Release Candidate",
          "summary": "Temporary signed release-candidate metadata for Build 191 upgrade acceptance. Not published.",
          "changes": [
              "Prepared signed Build 192 artifacts for in-place upgrade acceptance without publication."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build192"
      },
      {
          "version": "1.9",
          "build": 191,
          "channel": "Private Alpha",
          "tag": "v1.9-build191",
          "date": "July 28, 2026",
          "datetime": "2026-07-28",
          "title": "Build 191 secure session recovery hotfix",
          "summary": "Emergency hotfix for secure session recovery, protected-action authorization, and bounded recovery guidance after the v1.9 update.",
          "changes": [
              "Added a locked_recoverable authentication state after saved-session decrypt failure.",
              "Replaced raw secure-session errors with friendly Local Owner unlock guidance.",
              "Prevented repeated decrypt retries and duplicate blocked Operations.",
              "Preserved unreadable encrypted sessions and existing owner, node, and configuration data.",
              "Required fresh Local Owner verification before protected actions resume."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build191"
      },
      {
          "version": "1.9",
          "build": 190,
          "channel": "Private Alpha",
          "tag": "v1.9-build190",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 190 local login fix and v1.9 UI refresh",
          "summary": "Private Alpha v1.9 Build 190 fixes local security and account IPC startup, restores browser authentication, and introduces the first CasaOS/HTNetwork-inspired AnxOS interface refresh.",
          "changes": [
              "Fixed local security login IPC registration race.",
              "Registered account and local-security IPC before renderer creation or recovery.",
              "Made incomplete-instance recovery non-blocking.",
              "Fixed stale onboarding flags forcing upgraded installations back into First Launch.",
              "Restored owner, session, and node state before deciding whether setup is genuinely required.",
              "Fixed Continue in Browser to use canonical /signin/, /account/, and /activate/ URLs.",
              "Added safe external URL handling.",
              "Started the v1.9 CasaOS/HTNetwork-inspired UI refresh.",
              "Added a compact v1.9 dashboard launchpad.",
              "Refreshed the sidebar, page headers, status cards, Nodes, Instances, Public Access, and Marketplace surfaces.",
              "Preserved Marketplace, Share Server, Playit, NeoForge, Windows Agent, SFTP, and updater behavior."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.9-build190"
      },
      {
          "version": "1.8",
          "build": 189,
          "channel": "Private Alpha",
          "tag": "v1.8-build189",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 189 visible-window hotfix and Marketplace repair polish",
          "summary": "Private Alpha v1.8 Build 189 fixes persistent invisible-window launch after update or install and polishes Marketplace installed-state, repair, and update flows.",
          "changes": [
              "Fixed persistent invisible-window launch after update or install.",
              "Added stronger window show and focus recovery.",
              "Added saved-bounds rejection and safe-mode startup recovery.",
              "Added startup watchdog reset and recreate behavior.",
              "Improved second-instance window recovery.",
              "Added visible renderer failure diagnostics.",
              "Polished Marketplace installed-state handling.",
              "Added compact installed pack actions: Open, Start, Open Console, Share, and Repair Runtime.",
              "Added guarded SteamCMD update action.",
              "Added honest update states: update available, up to date, update unavailable, and stop-before-update.",
              "Made NeoForge repair discoverable from Marketplace without making reinstall the primary action."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build189"
      },
      {
          "version": "1.8",
          "build": 188,
          "channel": "Private Alpha",
          "tag": "v1.8-build188",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 188 Windows Agent MVP node support",
          "summary": "Private Alpha v1.8 Build 188 adds Windows Agent MVP node support, Windows capability reporting, and safer unsupported-state handling while preserving existing Linux node behavior.",
          "changes": [
              "Added Windows Agent MVP node support.",
              "Added Windows capability reporting from Agent health.",
              "Added Windows node badges and MVP messaging.",
              "Normalized Windows OS, hostname, version, and capability data into the node model.",
              "Improved Windows pairing and test connection compatibility.",
              "Marked Linux-only or deferred Windows features as unsupported instead of broken.",
              "Made Docker visibility conditional on Windows Agent capability reporting.",
              "Preserved existing Linux node behavior."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build188"
      },
      {
          "version": "1.8",
          "build": 187,
          "channel": "Private Alpha",
          "tag": "v1.8-build187",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 187 invisible window and SFTP modal hotfix",
          "summary": "Private Alpha v1.8 Build 187 fixes a launch/update path where the app process could run without a visible window and polishes the Add Storage SFTP modal layout.",
          "changes": [
              "Fixed app process running with no visible window after launch or update.",
              "Validated saved window bounds before restoring them on startup.",
              "Recovered from hidden, minimized, off-screen, or invalid saved window state.",
              "Restored or recreated the main window when the app is launched a second time.",
              "Added clearer renderer load and crash diagnostics for startup failures.",
              "Polished the Add Storage SFTP modal layout.",
              "Fixed SFTP modal footer buttons overlapping form fields.",
              "Improved SFTP modal scrolling, field spacing, and authentication-specific field layout."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build187"
      },
      {
          "version": "1.8",
          "build": 186,
          "channel": "Private Alpha",
          "tag": "v1.8-build186",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 186 Share Server access health and Public Access compatibility",
          "summary": "Private Alpha v1.8 Build 186 polishes Share Server access health, diagnostics, copy behavior, and invite text while improving NeoForge repair and Playit/Public Access compatibility with older or restarted Agents.",
          "changes": [
              "Added Share Server access health checks for instance state, local port listening, LAN availability, Playit service state, tunnel matching, public address availability, Tailscale availability, and last checked time.",
              "Added compact friend-can’t-join diagnostics for stopped or failed servers, non-listening ports, stopped Playit, missing or duplicate tunnel matches, disconnected nodes, and ready access.",
              "Improved Copy Access recommendation behavior so healthy Playit addresses are preferred, then Tailscale, then LAN, without copying placeholder or Checking values.",
              "Improved invite text templates for Minecraft, Palworld, generic servers, LAN-only sharing, Playit public sharing, and Tailscale access.",
              "Added compact instance access badges for local-only, Playit online, Tailscale available, no public access, port not listening, public access ready, multiple tunnels, node disconnected, stopped, and failed states.",
              "Fixed NeoForge Repair Runtime routing and Agent HTTP 404 handling so unsupported remote Agents show a clear update-required message instead of raw errors.",
              "Fixed Public Access cards getting stuck on Checking and preserved known provider/service configuration when selected Agent state is unavailable.",
              "Fixed Playit service and tunnel route mismatch behavior for older or still-running Agents by falling back to legacy Public Access provider/service data when new Playit Agent endpoints are unavailable.",
              "Disabled unsupported Playit controls until the selected Agent is updated or restarted.",
              "Prevented raw NOT_FOUND IPC errors and false empty tunnel states when Playit management endpoints are unavailable."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build186"
      },
      {
          "version": "1.8",
          "build": 185,
          "channel": "Private Alpha",
          "tag": "v1.8-build185",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 185 NeoForge repair, Public Access stability, and Share Server UX",
          "summary": "Private Alpha v1.8 Build 185 fixes remaining ATM10 and NeoForge runtime repair/start reporting, prevents Public Access from staying stuck on Checking when a node is unavailable, and adds a friend-ready Share Server flow.",
          "changes": [
              "Fixed NeoForge and ATM10 runtime readiness so valid script-launcher packs with unix_args.txt can start without server.jar.",
              "Added a bounded NeoForge runtime repair action that uses the bundled versioned server-pack installer in place while preserving world, config, mods, and backups.",
              "Fixed instance start reporting so immediate runtime failure is shown as a repairable failure instead of a successful start request.",
              "Fixed Public Access and Playit cards so disconnected or slow selected Agents resolve to clear unavailable states instead of staying on Checking.",
              "Disabled Playit Start, Stop, Restart, Logs, and tunnel refresh actions while the selected node is disconnected or unauthorized.",
              "Added Share Server and How Friends Join UX with copyable LAN, Playit, and Tailscale addresses.",
              "Added copyable invite text and game-specific friend instructions for Minecraft, Palworld, and generic servers.",
              "Matched Playit tunnels to instances by local port when safe and handled multiple matching tunnels without guessing."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build185"
      },
      {
          "version": "1.8",
          "build": 184,
          "channel": "Private Alpha",
          "tag": "v1.8-build184",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 184 Playit public access and runtime readiness fixes",
          "summary": "Private Alpha v1.8 Build 184 adds Playit service controls, logs, tunnels, and endpoint copy support in Public Access while fixing SSH shell readiness and existing ATM10/NeoForge runtime readiness detection.",
          "changes": [
              "Added Playit service controls in Public Access.",
              "Added Start, Stop, Restart, and Refresh status actions for Playit.",
              "Added Playit logs viewing inside the app.",
              "Added Playit tunnel list in Public Access.",
              "Added copy support for public tunnel endpoints.",
              "Added tunnel-to-instance matching by local port when available.",
              "Fixed SSH shell readiness so auth success is not treated as usable shell readiness too early.",
              "Improved SSH diagnostics for shell timeout, PTY, and command write states.",
              "Fixed existing ATM10 and NeoForge runtime readiness detection and migrated stale java-app/server.jar metadata when launcher files prove a NeoForge script runtime."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build184"
      },
      {
          "version": "1.8",
          "build": 183,
          "channel": "Private Alpha",
          "tag": "v1.8-build183",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 183 Marketplace, SSH, node editor, Docker, checklist, Palworld, and NeoForge polish",
          "summary": "Private Alpha v1.8 Build 183 stabilizes the Build 182 Marketplace UI, SSH input flow, node editor and Docker layouts, checklist readiness, Palworld log classification, and NeoForge runtime validation.",
          "changes": [
              "Restored compact Marketplace modpack cards with concise pack version, server-pack status, and provider/runtime badges.",
              "Cleaned the Marketplace install panel metadata layout so detailed Minecraft, runtime, provider file, and server-pack fields live in the install review.",
              "Fixed NeoForge and ATM10 runtime validation so script-launcher server packs do not require a generic server.jar.",
              "Fixed SSH connected state and input handling so commands are only sent when the shell is ready and failures are shown clearly.",
              "Improved the Edit Node modal layout, close-button placement, manual setup width, and action alignment.",
              "Improved Docker page layout and checkbox polish for denser container creation, compose, and cleanup panels.",
              "Fixed Public Access setup checklist readiness when public or private access services are already configured.",
              "Classified Palworld and Steam stderr noise as non-fatal when the server process remains healthy."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build183"
      },
      {
          "version": "1.8",
          "build": 182,
          "channel": "Private Alpha",
          "tag": "v1.8-build182",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "Build 182 node health, SSH, setup checklist, and storage polish",
          "summary": "Private Alpha v1.8 Build 182 stabilizes post-build-181 SSH, node health, dashboard setup, and storage modal polish.",
          "changes": [
              "Added bounded SSH connection states for connecting, authenticating, waiting for shell, timed out, and failed flows with clearer retry and cancel behavior.",
              "Clarified node health diagnostics so historical sanitized log groups do not make an otherwise healthy node look degraded unless they are current and actionable.",
              "Changed unavailable CPU temperature display to friendly bounded states such as unavailable on this system, not supported by this node, or requires sensor support.",
              "Fixed Dashboard setup checklist backup detection so Backup created becomes Ready when real managed backups exist for the selected node.",
              "Polished the Edit Node modal layout, section balance, close alignment, and manual setup readability.",
              "Polished the SFTP Add Storage modal spacing, provider selection, button placement, and scroll behavior.",
              "Restored packaged desktop config asset inclusion so marketplace templates and agent examples are present in app.asar validation."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build182"
      },
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build181"
      },
      {
          "version": "1.8",
          "build": 180,
          "channel": "Private Alpha",
          "tag": "v1.8-build180",
          "date": "July 27, 2026",
          "datetime": "2026-07-27",
          "title": "AnxOS Control Center — Build 180",
          "summary": "Private Alpha v1.8 Build 180 fixes marketplace modpack version resolution, server-pack runtime handling, and release smoke reliability.",
          "changes": [
              "Fixed CurseForge and Modrinth marketplace version resolution so selected versions are preserved through install planning.",
              "Preserved server-pack runtime metadata during marketplace installs instead of falling back to generic startup behavior.",
              "Repaired ATM10 and NeoForge runtime handling so server packs launch the repaired runtime path instead of installer artifacts.",
              "Hardened the selected-node marketplace install smoke coverage for remote-node install routing.",
              "Handled Windows hardware temperature EPIPE output safely during the disk stats smoke path."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.8-build180"
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build160"
      },
      {
          "version": "1.7",
          "build": 159,
          "channel": "Private Alpha",
          "tag": "v1.7-build159",
          "date": "July 22, 2026",
          "datetime": "2026-07-22",
          "title": "AnxOS Control Center — Build 159",
          "summary": "Private Alpha v1.7 Build 159 introduces a focused seven-step first-run setup guide and improves device-authorization pairing reliability.",
          "changes": [
              "Added a seven-step first-run setup guide covering sign-in, local ownership, Agent connection, node preparation, first-server creation, public access, and completion, with status markers and deep links.",
              "Device authorization polling now respects the server-provided interval and resumes after its bounded wait.",
              "Expired or consumed pairing codes are cleared so a new pairing attempt starts cleanly.",
              "Optimized website navigation, downloads, copy actions, and the /setup/ guide for mobile layouts."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build159"
      },
      {
          "version": "1.7",
          "build": 158,
          "channel": "Private Alpha",
          "tag": "v1.7-build158",
          "date": "July 21, 2026",
          "datetime": "2026-07-21",
          "title": "AnxOS Control Center — Build 158",
          "summary": "Private Alpha v1.7 Build 158 installer release with guided setup, pairing, upgrade, and repair guidance for existing installations.",
          "changes": [
              "Signed Windows installer and Linux package release with onboarding for new installations.",
              "Existing remote Agent guidance: pair the Agent and verify the selected node before managing instances.",
              "Upgrade guidance via updater metadata or the signed installer from the release page.",
              "Repair guidance via Agent Control and Dependencies for missing prerequisites."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build158"
      },
      {
          "version": "1.7",
          "build": 157,
          "channel": "Private Alpha",
          "tag": "v1.7-build157",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "AnxOS Control Center — Build 157",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build157"
      },
      {
          "version": "1.7",
          "build": 155,
          "channel": "Private Alpha",
          "tag": "v1.7-build155",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "AnxOS Control Center — Build 155",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build155"
      },
      {
          "version": "1.7",
          "build": 154,
          "channel": "Private Alpha",
          "tag": "v1.7-build154",
          "date": "July 19, 2026",
          "datetime": "2026-07-19",
          "title": "AnxOS Control Center — Build 154",
          "summary": "Build 154 fixes paired remote Agent status rendering.",
          "changes": [
              "Added trusted instance-scoped SteamCMD server-file updates with progress and artifact verification.",
              "Migrated supported legacy SteamCMD instances from trusted template metadata.",
              "Shows Paired instead of Waiting for Control Center after successful Agent pairing."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build154"
      },
      {
          "version": "1.7",
          "build": 152,
          "channel": "Private Alpha",
          "tag": "v1.7-build152",
          "date": "July 17, 2026",
          "datetime": "2026-07-17",
          "title": "AnxOS Control Center — Build 152",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build152"
      },
      {
          "version": "1.7",
          "build": 151,
          "channel": "Private Alpha",
          "tag": "v1.7-build151",
          "date": "July 17, 2026",
          "datetime": "2026-07-17",
          "title": "AnxOS Control Center — Build 151",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build150"
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build149"
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build148"
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
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build147"
      },
      {
          "version": "1.7",
          "build": 146,
          "channel": "Private Alpha",
          "tag": "v1.7-build146",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Control Center — Build 146",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build146"
      },
      {
          "version": "1.7",
          "build": 145,
          "channel": "Private Alpha",
          "tag": "v1.7-build145",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Control Center — Build 145",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build145"
      },
      {
          "version": "1.7",
          "build": 144,
          "channel": "Private Alpha",
          "tag": "v1.7-build144",
          "date": "July 14, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Control Center — Build 144",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      },
      {
          "version": "1.7",
          "build": 143,
          "channel": "Private Alpha",
          "tag": "v1.7-build143",
          "date": "July 13, 2026",
          "datetime": "2026-07-14",
          "title": "AnxOS Control Center — Build 143",
          "summary": "This release prepares AnxOS Control Center for packaged private-alpha validation with hardened production configuration, installer artifacts, onboarding, and broad smoke coverage.",
          "changes": [
              "Generated Windows installer, Windows portable, Linux AppImage, and Debian package artifacts for build 143 validation.",
              "Added packaged build metadata with build date, commit, release channel, public release repository, supported operating systems, and update source.",
              "Fixed Files page onboarding layout and target-state regressions so Windows and Linux paths cannot mix after profile changes.",
              "Hardened packaged account and updater configuration so production builds do not use localhost account URLs or local update metadata sources.",
              "Normalized Linux package permissions so desktop entries, icons, app.asar, and unpacked resources are readable after installation.",
              "Added private-alpha installer guidance, artifact reports, and packaged application smoke validation notes."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/v1.7-build143"
      },
      {
          "version": "1.7",
          "build": 142,
          "channel": "Private Alpha",
          "tag": "v1.7-build142",
          "date": "July 13, 2026",
          "datetime": "2026-07-13",
          "title": "AnxOS Control Center — Build 142",
          "summary": "Latest AnxOS-Control-Center release.",
          "changes": [
              "Updated application build, website metadata, and downloadable release assets."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      },
      {
          "version": "1.7",
          "build": 141,
          "channel": "Private Alpha",
          "tag": "v1.7-build141",
          "date": "July 11, 2026",
          "datetime": "2026-07-11",
          "title": "AnxOS Control Center — Build 141",
          "summary": "This release adds privacy-safe runtime diagnostics and complete in-app controls for local and remote AnxOS Agents.",
          "changes": [
              "Added structured, rotated, secret-redacted diagnostics for desktop, renderer, IPC, authentication, services, updater, and Agent failures.",
              "Added latest-error and runtime-state snapshots, a combined live log, sanitized exports, and authenticated owner-only remote diagnostic capture.",
              "Added an Agent Control Center with status, lifecycle, service startup, repair, safe configuration, diagnostics, log viewing, and first-run setup.",
              "Added Linux systemd user and Windows background-startup management through privileged main-process operations instead of terminal instructions.",
              "Improved the Add Storage dialog lifecycle and guarded asynchronous submissions against duplicate requests.",
              "Added regression coverage for redaction, rotation, snapshots, failure-safe logging, remote authorization, and real Agent start/restart/stop behavior."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      },
      {
          "version": "1.7",
          "build": 140,
          "channel": "Private Alpha",
          "tag": "v1.7-build140",
          "date": "July 10, 2026",
          "datetime": "2026-07-10",
          "title": "AnxOS Control Center — Build 140",
          "summary": "This release restores existing local Owner credentials and adds visible website password recovery actions.",
          "changes": [
              "Restored packaged-app authentication for persisted Owner accounts created with historical local credentials.",
              "Added safe discovery and migration of Owner accounts from legacy AnxOS configuration directories.",
              "Kept local Owner verification independent from Supabase cloud account authentication.",
              "Added development-only authentication diagnostics that never log passwords, hashes, or tokens.",
              "Added standalone website password recovery pages and visible Reset Password and Change Password actions.",
              "Added regression coverage for credential verification, legacy migration, and session logout account preservation."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      },
      {
          "version": "1.7",
          "build": 139,
          "channel": "Private Alpha",
          "tag": "v1.7-build139",
          "date": "July 10, 2026",
          "datetime": "2026-07-10",
          "title": "AnxOS Control Center — Build 139",
          "summary": "This release separates the desktop host, Agent nodes, and filesystem providers so Windows can reliably control local and remote machines.",
          "changes": [
              "Added stable Agent identities with duplicate-node detection and safe legacy configuration migration.",
              "Made the application host a distinct local node instead of deriving This Device from the configured Agent URL.",
              "Routed Dashboard, Monitoring, Docker, Instances, Files, SSH, Backups, Marketplace, and Security through the selected node.",
              "Separated local, Agent-native, and SFTP filesystem providers so only explicit SFTP connections create SFTP sessions.",
              "Added development routing diagnostics and regression coverage for node switching, persistence, migration, and filesystem routing."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      },
      {
          "version": "1.6",
          "build": 138,
          "channel": "Private Alpha",
          "tag": "v1.6-build138",
          "date": "July 9, 2026",
          "datetime": "2026-07-09",
          "title": "AnxOS Control Center — Build 138",
          "summary": "This release fixes Marketplace modpack runtime selection and aligns Marketplace card actions like a proper storefront.",
          "changes": [
              "Added a Server Runtime selector so modpacks no longer default to Paper.",
              "Uses provider loader metadata from CurseForge and Modrinth to preselect Fabric, Forge, NeoForge, Quilt, Paper, Purpur, or Vanilla.",
              "Added Quilt server runtime install support through the official Quilt metadata and installer flow.",
              "Stopped the installer from overwriting the selected runtime during submit.",
              "Aligned Marketplace Install buttons across card rows and clamped long descriptions.",
              "Updated smoke coverage for runtime detection, no Paper preselect, provider loader metadata, and Quilt install handling."
          ],
          "url": "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases"
      }
  ],
};
