# Marketplace Template Certification

Certification describes the repository contract, not live provider availability.
`Supported` means the template has an enabled automated installer contract and
deterministic repository coverage. `Experimental` requires extra user input or
has an intentionally limited startup contract. `Disabled` cannot be installed.
No current template is classified Deprecated or Unsupported.

| Template | Certification | Repository evidence | External validation |
| --- | --- | --- | --- |
| `minecraft-vanilla` | Supported | Manifest and installer fixtures | Mojang availability, real Java start |
| `minecraft-paper` | Supported | Manifest and installer fixtures | Paper API, real Java start |
| `minecraft-purpur` | Supported | Manifest and installer fixtures | Purpur API, real Java start |
| `minecraft-fabric` | Supported | Manifest and installer fixtures | Fabric metadata, real Java start |
| `minecraft-forge` | Supported | Manifest and installer fixtures | Forge metadata, real Java start |
| `minecraft-neoforge` | Supported | Manifest and installer fixtures | NeoForge metadata, real Java start |
| `velocity` | Supported | Manifest and installer fixtures | Live download and proxy start |
| `waterfall` | Supported | Manifest and installer fixtures | Live download and proxy start |
| `bungeecord` | Supported | Manifest and installer fixtures | Live download and proxy start |
| `terraria-tshock` | Supported | Archive and failure fixtures | GitHub availability, real server start |
| `valheim` | Supported | SteamCMD deterministic fixtures | Steam availability, real server start |
| `rust` | Supported | SteamCMD deterministic fixtures | Steam availability, real server start |
| `cs2` | Supported | SteamCMD deterministic fixtures | Steam availability, real server start |
| `fivem` | Experimental | Archive/configuration fixtures | Cfx.re artifact, license, real readiness |
| `palworld` | Supported | SteamCMD and startup regression fixtures | Steam availability, real readiness |
| `v-rising` | Supported | Manifest validation; launch command from the server's shipped start script (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`) |
| `enshrouded` | Supported | Manifest validation; settings from the server's shipped readme (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`) |
| `unturned` | Supported | Manifest validation; launch command from the server's shipped helper script | Real install and start on Windows passed (`marketplace-steamcmd-real-install`); Linux start not yet run |
| `satisfactory` | Supported | Manifest validation; ports and start options from a direct run of the shipped server (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`) |
| `seven-days-to-die` | Supported | Manifest validation; settings from the shipped serverconfig.xml, proven by a direct run (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`) |
| `garrys-mod` | Supported | Manifest validation; Valve srcds start options, confirmed by the server's own log (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`) |
| `project-zomboid` | Supported | Manifest validation; launch from the shipped StartServer64.bat; administrator password through the Agent server secret store (`server-secret-store-smoke`) (Windows computers only; needs a Build 214 Agent) | Real install and start on Windows passed: account created with the generated password, which is in no plain-text file |
| `factorio` | Supported | Manifest validation; public headless download from factorio.com; world created on first start (Linux computers only) | Real install and start on Linux (WSL Ubuntu 24.04) passed (`marketplace-steamcmd-real-install`) |
| `ark-survival-evolved` | Supported | Manifest validation; one `?`-separated map argument with the session named by the server id, `-server -log -NoBattlEye` (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`, 1539 s, 21 GB): bound the chosen UDP port, Running / ready, its Steam query port advertised the session AnxOS gave it; Stop freed the port |
| `dont-starve-together` | Supported | Manifest validation; launch from the shipped script; LAN port range from the server's own log (Windows computers only) | Real install and start on Windows passed (`marketplace-steamcmd-real-install`); internet play needs the owner's Klei cluster token |
| `hytale` | Experimental | Resolver, checksum, readiness and launcher fixtures (Linux nodes only) | Hytale account sign-in on first start, Java 25, UDP port forwarding |
| `docker-minecraft-bedrock` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`), Minecraft EULA gate | Real install on Docker Desktop passed (`marketplace-docker-real-install`) |
| `docker-nginx` | Supported | Docker template fixtures | Registry and Docker daemon |
| `it-tools` | Supported | Docker service fixtures (S13): pinned image, published on 127.0.0.1 only | Real install on Docker Desktop passed: served, private binding, restart and Stop/Start |
| `stirling-pdf` | Supported | Docker service fixtures (S13): pinned image, private binding, generated first-account password | Real install on Docker Desktop passed: healthy, generated password signs in, default and wrong passwords refused, password not in its logs, data kept after restart and Stop/Start |
| `jellyfin` | Supported | Docker service fixtures (`marketplace-docker-service-smoke` S12): one chosen media folder, read-only | Real install on Docker Desktop passed (`marketplace-docker-real-install`): health, read-only media, data kept after restart and Stop/Start |
| `immich` | Supported | Compose fixtures (`marketplace-docker-service-smoke` S14): shipped Compose file, generated database password, port and earlier-data checks, cleanup | Real install on Docker Desktop passed: four containers healthy, only the web app published, administrator sign-up and sign-in, account kept after restart and Stop/Start |
| `nextcloud` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Nextcloud (SQLite) reachable in a browser; data kept after restart |
| `gitea` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. First-run setup in a browser; Git over SSH on the second port |
| `uptime-kuma` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. First-run account creation in a browser |
| `grafana` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Sign-in with the generated admin password |
| `prometheus` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Web interface reachable; metrics kept after restart |
| `postgresql` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Client connection with the generated password; data kept after restart |
| `mariadb` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Client connection with the generated passwords; data kept after restart |
| `redis` | Supported | Docker service fixtures (`marketplace-docker-service-smoke`) | Registry and Docker daemon. Client connection with the generated password; data kept after restart |
| `discord-js` | Experimental | Local-import fixtures | User project and Node runtime |
| `python-discord-bot` | Experimental | Local-import fixtures | User project and Python runtime |
| `node-app` | Experimental | Local-import fixtures | User project and Node runtime |
| `python-app` | Experimental | Local-import fixtures | User project and Python runtime |
| `java-app` | Experimental | Import checks (runnable .jar with a Main-Class, at most 150 MB; runtime options refused as program arguments) and the real check `marketplace-java-app-real-install` | Real install passed: ready without a port, arguments and memory applied, data kept across Stop/Start and Restart, crash reported with its exit code; the user's own application decides the rest |

All enabled templates still require at least one exact-candidate real-machine
installation before broad claims are made. Provider outages, changed upstream
artifacts, disk pressure, host permissions, and runtime behavior are external
validation concerns.
