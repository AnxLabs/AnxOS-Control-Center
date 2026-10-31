# Hytale Dedicated Server

How AnxOS installs and runs the official Hytale dedicated server. Source of
truth for the server itself: Hypixel Studios' "Hytale Server Manual"
(support.hytale.com).

## What gets installed

- **Server JAR.** AnxOS downloads `HytaleServer.jar` from Hypixel Studios' official Maven repository, `maven.hytale.com`, `release` patchline.
  - The version comes from the repository's own `maven-metadata.xml`.
  - The JAR is checked against the published `.sha1` and is never written to the node if it doesn't match (`DOWNLOAD_CHECKSUM_MISMATCH`).
- **Generated files** in the instance's `data/server/`:
  - `anxos-hytale-start.sh`, the launcher;
  - `jvm.options`, which holds `-Xmx` from the install's memory setting and is read by the official `start.sh`.
- **Requirements:**
  - Linux nodes only; the Windows variant is refused with a clear reason.
  - Java 25 or newer.
  - UDP port forwarding, because Hytale uses QUIC over UDP (default 5520).

## First start (one-time sign-in)

The server files and assets need a Hytale account, so the first start runs Hytale's own bootstrap:

1. Start the instance. The console shows Hytale's sign-in link (`oauth.accounts.hytale.com/oauth2/device/verify`) and a short code.
2. Open the link and approve the server with your Hytale account. AnxOS never sees or stores account credentials; Hytale keeps its own encrypted `auth.enc`.
3. When the console shows "Authentication successful", AnxOS sends `update download`. Hytale then downloads the server, assets and `start.sh` (several GB).
4. The launcher then starts the real server through the official `start.sh`. Every later start goes straight there.

**Sign in button.** While the server needs a sign-in, its instance page shows a **Sign in** button in the Power group:
- It opens Hytale's sign-in page, with the code already filled in, in your default browser.
- If no code is pending, it first runs Hytale's own `auth login device`.
- Only links on `oauth.accounts.hytale.com` are opened. The link comes from the Agent's reading of the server's output, never from the page.
- If your Hytale account has several game profiles, Hytale asks which one the server runs as. The button then reads **Choose profile** and lists them by name; AnxOS sends `auth select <number>` for the one you pick.
- Once the running server is signed in and ready, the button stays as a dimmed **✓ Signed in**, and a notification says the server is signed in.
- After a console `auth logout`, the server shows as needing sign-in again.

Other behaviour:

- **Stopping during setup** stops cleanly and leaves no Java process behind.
- **If setup ends without the files** (for example, the sign-in wasn't approved within 10 minutes), the console says so and the next start retries.

## Running

- **Layout:** `data/server/Server/` contains `config.json`, `permissions.json`, `whitelist.json`, `bans.json`, `mods/` and `universe/` (worlds and player data).
- **Config edits:** Hytale rewrites its config files while it runs, so stop the server before editing them.
- **Readiness** comes from Hytale's log lines, because the TCP port probe can't see a UDP server:
  - "Hytale Server Booted!" means ready, but only once the official `Server/` layout exists. The bootstrap prints the same line without serving players.
  - "Authentication successful" means ready only on a server that has already booted. When a stored session is restored, Hytale prints that line before it binds its port.
  - "No server tokens configured" means degraded, with `HYTALE_AUTH_REQUIRED`: players can't join until the server is signed in (`/auth login device` in the console).
- **World backups** cover `server/Server/universe`.
- **Updates** use Hytale's built-in updater (`/update check`, `/update download`, `/update apply --confirm`).
  - The official `start.sh` applies staged files on its exit code 8 and keeps config, saves and mods.
  - AnxOS has no separate update path for Hytale.
- **Java:**
  - The launcher picks the first Java 25+ from the instance environment variable `ANXOS_HYTALE_JAVA`, `/usr/lib/jvm/temurin-25*`, `/usr/lib/jvm/java-25*`, `/srv/anxos/runtimes/*`, `/opt/java/*`, then `PATH`.
  - Without one it exits with a clear message instead of a JVM error.

## Known Hytale behaviour

- **Bootstrap and `permissions.json`:** Hytale 0.7.5's bootstrap mode crashes if `permissions.json` is missing. The JSON writer's stream is already closed: "Failed to syncLoad() … permissions.json … Stream closed". The launcher provides an empty one for the bootstrap only.
- **Sign-in doesn't block boot commands:** the device sign-in runs asynchronously, so `--boot-command "update download"` would run before the sign-in finishes. That is why the launcher waits for "Authentication successful".
