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
| `hytale` | Experimental | Resolver, checksum, readiness and launcher fixtures (Linux nodes only) | Hytale account sign-in on first start, Java 25, UDP port forwarding |
| `docker-minecraft-bedrock` | Supported | Docker template fixtures | Registry and Docker daemon |
| `docker-nginx` | Supported | Docker template fixtures | Registry and Docker daemon |
| `jellyfin` | Disabled | Disabled-template validation | Not applicable while disabled |
| `immich` | Disabled | Disabled-template validation | Not applicable while disabled |
| `nextcloud` | Disabled | Disabled-template validation | Not applicable while disabled |
| `gitea` | Disabled | Disabled-template validation | Not applicable while disabled |
| `uptime-kuma` | Disabled | Disabled-template validation | Not applicable while disabled |
| `grafana` | Disabled | Disabled-template validation | Not applicable while disabled |
| `prometheus` | Disabled | Disabled-template validation | Not applicable while disabled |
| `postgresql` | Disabled | Disabled-template validation | Not applicable while disabled |
| `mariadb` | Disabled | Disabled-template validation | Not applicable while disabled |
| `redis` | Disabled | Disabled-template validation | Not applicable while disabled |
| `discord-js` | Experimental | Local-import fixtures | User project and Node runtime |
| `python-discord-bot` | Experimental | Local-import fixtures | User project and Python runtime |
| `node-app` | Experimental | Local-import fixtures | User project and Node runtime |
| `python-app` | Experimental | Local-import fixtures | User project and Python runtime |
| `java-app` | Disabled | Disabled-template validation | Not applicable while disabled |

All enabled templates still require at least one exact-candidate real-machine
installation before broad claims are made. Provider outages, changed upstream
artifacts, disk pressure, host permissions, and runtime behavior are external
validation concerns.
