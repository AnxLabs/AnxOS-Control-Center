# Server secret store (Build 214)

A small, write-only store on each computer for the passwords a game server
needs when it starts (first case: Project Zomboid's administrator
password). It reuses the project's existing secret patterns and keeps the
existing rule that a server's ordinary environment settings may never hold
a secret.

## Why the existing rule stays

`normalizeEnvironment` (instance engine) refuses environment settings
named like a token, secret, password, credential or API key
(`SECRET_ENVIRONMENT_NOT_ALLOWED`). A server's environment is saved as plain
JSON in its own folder (`config.json`), and that folder is browsed in the
file manager, copied by backups, moved between computers, and read by
diagnostics. The rule is correct and unchanged. Secrets get their own path.

## Existing patterns reused

| Pattern | Where | Reused as |
| --- | --- | --- |
| AES-256-GCM, random 12-byte IV, auth tag | `backupDestinationService.js`, `storageConnectionService.js` | Same cipher and envelope fields |
| Key never persisted with the data, never logged; recorded only as `keyId = sha256(key)[0..16]` | `backupDestinationService.js` | Same fingerprint rule |
| Secrets from an environment value or a protected `*_FILE` | `curseforgeProxyService.js` | `AGENT_SERVER_SECRET_KEY_FILE` override |
| Device key generated once into its own file | AnxNet `anxnet-device.key` | Default key file |
| Atomic temp-file write with mode `0600`, folders `0700` | every store | Same |
| Values shown to the app only as `[configured]` | instance public view | Secret names shown, values never |

No new service, no network component, no new dependency.

## Design

- **Location:** `<instance root>/../anxos-server-secrets/`, i.e. next to the
  instances folder (`/srv/anxos/anxos-server-secrets` on a packaged Linux
  Agent), never inside a server's folder. Folder `0700`, files `0600`.
  - `secrets.json`: `{ schemaVersion, entries: { <instanceId>: { <NAME>:
    { iv, tag, data, keyId, setAt } } } }`.
  - `server-secrets.key`: 32 random bytes, created on first use with
    exclusive create. `AGENT_SERVER_SECRET_KEY_FILE` points the Agent at a
    key kept elsewhere (another disk, a systemd credential); then no key file
    is created here.
- **Binding:** each value is encrypted with additional authenticated data
  `instanceId \0 NAME`, so a value copied to another server or setting fails
  to decrypt instead of being used.
- **Write-only interface:** `createInstance` and `updateInstance` accept
  `secretEnvironment: { NAME: value }` (at most 8; names
  `^[A-Z_][A-Z0-9_]{0,63}$`; values 1-512 characters, no line breaks). The
  value is encrypted into the store; the server's `config.json` records only
  `secretEnvironmentNames`. No route returns a value. The app sees
  `secretEnvironment: [{ name, configured: true }]`.
- **Runtime delivery:** when the server process (not an installer run such
  as SteamCMD) is spawned, the values are decrypted in memory and added to
  that process's environment only. The start command refers to the name
  (`%NAME%` through `cmd.exe`, `"$NAME"` through bash), so the "Launch
  command" log line shows the name. A declared secret that cannot be
  decrypted (missing, wrong key, tampered) refuses the start with
  `SERVER_SECRET_UNAVAILABLE` rather than starting without it.
- **Output redaction:** while the server runs, each line it prints is
  scrubbed of its secret values before it is logged or shown in the console
  (defence in depth; Project Zomboid was verified not to print it).
- **Rotation of a value:** `updateInstance` with a new value replaces it
  (Project Zomboid applies `-adminpassword` on every start, so a new value
  takes effect at the next start).
- **Rotation of the key:** `rotateServerSecretKey(newKey)` re-encrypts every
  entry with the new key and then replaces the key file atomically. Entries
  that cannot be decrypted with the current key are reported, not dropped.
- **Removal:** deleting a server deletes its entries.

## Threat model

| Threat | Covered | How |
| --- | --- | --- |
| Password in the start command, process listing or "Launch command" log | Yes | Command names the setting; value only in the process environment |
| Password in the server's folder (file manager, backups, moves, support bundles) | Yes | Stored outside every server folder, encrypted |
| Password returned by the Agent API or shown in the app | Yes | Write-only; names only in responses |
| Password printed by the server itself | Mitigated | Values scrubbed from its output before logging |
| Copy of `secrets.json` alone (backup of the Agent folder, accidental share) | Yes | AES-256-GCM; the key is a separate file or kept elsewhere |
| Value swapped between servers or settings | Yes | Authenticated data binds value to server and name |
| Tampered store | Yes | GCM authentication fails; the start is refused |
| An account that can read the Agent's files (or root) | **No** | It can read both key and store. Same limit as every local secret store; use `AGENT_SERVER_SECRET_KEY_FILE` on a separate volume to raise the bar |
| Reading the running server's environment (`/proc/<pid>/environ`) by the same account or root | **No** | Inherent: the server needs the value at runtime |
| Windows file permissions | Partial | `0600` is not enforced on Windows; the store inherits the Agent folder's user-profile ACL (Local Agent under `%APPDATA%`) |

## Backup and recovery

- Server backups do not contain secrets (they are outside the server
  folder). Restoring on the same computer keeps them.
- Moving a server to another computer moves no secret. The server then
  refuses to start with `SERVER_SECRET_UNAVAILABLE` until a new value is
  set (for Project Zomboid that sets a new administrator password, applied
  at the next start).
- Losing the key file makes every stored secret unrecoverable; there is no
  escrow (same statement as backup encryption). Recovery is setting new
  values. Operators who back up the Agent folder should back up the key
  separately or use `AGENT_SERVER_SECRET_KEY_FILE`.

## Compatibility

An Agent older than Build 214 ignores `secretEnvironment` and would start
Project Zomboid with the literal `%ANXOS_PZ_ADMIN_PASSWORD%` as the
password. The desktop therefore checks that the created server reports the
secret name and otherwise removes it and stops with "needs a Build 214
Agent".
