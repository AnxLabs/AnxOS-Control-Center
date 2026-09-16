# Configuration Migrations

## Build 200 instance records

Build 200 upgrades Build 199 instance schema 1 records to schema 2 on first
read. The original JSON is preserved once as `config.json.schema-v1.backup`,
then the migrated record is atomically replaced. The migration adds only the
durable failed-install fields, preserves unknown metadata and instance data,
and is safe to rerun. Future schema versions and malformed JSON fail explicitly
without rewriting the source. This is the complete Build 200 instance migration
contract; it is not a generalized V2 migration framework.

For packaged Windows acceptance, seed the record under the root used by the
selected node, not under a directory inferred from the product's display name.
Build 200 keeps the compatibility `userData` identity `AnxHub`. The canonical
scheduled-task Local Agent therefore receives:

- `ANXHUB_CONFIG_DIR=%APPDATA%\AnxHub\config`
- `AGENT_INSTANCE_ROOT=%APPDATA%\AnxHub\agent\instances`

The Desktop fallback root is `%APPDATA%\AnxHub\instances`, but the **This PC**
agent-kind node lists instances through the Agent REST API and does not read
that fallback root. A reliable acceptance probe should read the public health
response, derive `userData` from the parent of its `configPath`, seed
`<userData>\agent\instances\<id>\config.json` as UTF-8 without a BOM, and then
make an authenticated `GET /api/v1/instances`. The request must return the
fixture, rewrite it to schema 2 with `installationState`, and create exactly one
schema-v1 backup. Merely observing a successful `instances:list` IPC completion
does not prove the REST result was an instance list because expected Agent read
errors may be returned as successful IPC payloads.

Persisted formats with explicit schema versions include the node registry,
node credential store, settings preferences, forgotten-instance state, public
access registry, and long-operation records.

`nodes.json` currently uses schema version 3. Reading an older schema:

1. Preserves `nodes.json.schema-v<version>.backup` once.
2. Normalizes legacy node shape and selection.
3. Moves Agent tokens to the protected credential store.
4. Atomically writes schema version 3.

Repeated reads are idempotent. A future schema returns
`NODE_SCHEMA_UNSUPPORTED` without changing the file. Invalid JSON is preserved
as `nodes.json.corrupt.backup` and returns `NODE_CONFIG_CORRUPT`.

`node-agent-credentials.json` uses schema version 2. Legacy plaintext tokens
are migrated to an encrypted payload using the shared secure-storage
implementation; the one-time migration safety copy is independently encrypted
so it does not leave plaintext secrets at rest. Future schemas return
`NODE_CREDENTIAL_SCHEMA_UNSUPPORTED` without changing the file. Invalid JSON is
preserved in a timestamped copy; payloads that cannot be decrypted fail with
`NODE_CREDENTIAL_DECRYPT_FAILED` rather than silently dropping credentials.

`preferences.json` uses schema version 1. Legacy direct-key preferences are
backed up once, normalized, and atomically migrated. Invalid JSON returns
`SETTINGS_STORE_CORRUPT` after preserving a timestamped copy; future schemas
return `SETTINGS_SCHEMA_UNSUPPORTED` without modifying the file.

`forgotten-instances.json` uses schema version 1 and atomic writes. Legacy
state is backed up once before migration. Corrupt state returns
`FORGOTTEN_INSTANCE_STORE_CORRUPT`; future schemas return
`FORGOTTEN_INSTANCE_SCHEMA_UNSUPPORTED` without clearing tombstones.

`public-access-services.json` uses schema version 1 and atomic writes. Legacy
records are normalized after a one-time backup. Corrupt state returns
`PUBLIC_ACCESS_REGISTRY_CORRUPT`; future schemas return
`PUBLIC_ACCESS_SCHEMA_UNSUPPORTED` without changing provider records.

`updates.json` uses schema version 1 and atomic writes. Legacy skipped-version
preferences are backed up once and migrated. Corrupt or future-version state is
preserved and blocks persistence writes with `UPDATE_STORE_CORRUPT` or
`UPDATE_STORE_SCHEMA_UNSUPPORTED`; update checks can still run.

`marketplace.json` uses schema version 2 with an encrypted provider payload.
Legacy CurseForge keys migrate atomically and the safety copy is independently
encrypted. Corrupt, undecryptable, and future-version state fails explicitly
without replacing provider credentials.

Agent backup metadata and `schedules.json` use schema version 1 and atomic
writes. Legacy records are backed up before migration. Corrupt and future
schedule state fails explicitly; corrupt or future backup metadata is reported
through backup diagnostics and is never rewritten as an older schema.

Each instance `config.json` uses schema version 1 through the shared Desktop
and Agent instance core. Legacy metadata is backed up once beside the instance
before an atomic migration. Invalid schemas and unknown future versions fail
with an explicit instance-config error and remain unchanged; new and updated
instances always persist the current schema version.

Agent `agent.json` and `device-identity.json` use schema version 1. Legacy files
are backed up and migrated atomically. Corrupt or future state fails without
rotating the Agent token or generating a replacement device identity, avoiding
unauthorized clients and duplicate node registration.

Desktop `application-host.json` uses schema version 1 and atomic writes. Legacy
identity is backed up and migrated without changing `hostId`. Corrupt or future
state fails without generating a replacement desktop identity.

`agent-runtime.json` uses schema version 1 through the same dependency-free
store in the Desktop main process, node registry, and packaged Agent. Legacy
configuration is backed up once and migrated atomically. Corrupt, invalid, or
future-version state fails explicitly instead of silently starting the Agent
with default ports or storage roots. Saves retain the prior valid file as
`.backup`; restore validates that backup, snapshots the replaced state, and
atomically activates the restored configuration.

`security.json` uses schema version 1 and atomic writes. Legacy security state
is backed up before migration. Corrupt or future state fails closed with
`SECURITY_STORE_CORRUPT` or `SECURITY_SCHEMA_UNSUPPORTED`; it is never treated
as an unauthenticated first run.

Owner Workspace `workspace.json` uses version 1 and atomic writes. Its contents
include feature-flag overrides. Corrupt or future state is preserved and fails
explicitly, so flags and private workspace content are never replaced by
defaults after a read failure.

`owner-accounts.json` uses schema version 1 and atomic writes. Legacy owner
allowlists are preserved before migration. Corrupt or future state fails
closed instead of silently removing trusted owner authorization.

`storage-connections.json` uses schema version 1 and atomic writes. Legacy
connection metadata and encrypted SFTP credentials are preserved before
migration. Corrupt or future state fails explicitly instead of appearing as an
empty connection list.

Encrypted account sessions and Local Agent credential snapshots use secure
session envelope schema version 1 and atomic writes. Legacy encrypted records
are backed up and migrated without decrypting them to disk. Corrupt,
undecryptable, invalid-schema, and future-version records are preserved and
fail explicitly; subsequent writes cannot silently replace them.

Local Owner remembered-session `session.dat` envelopes use schema version 1
and atomic writes. Startup treats invalid or future state as signed out while
preserving the encrypted artifact. Legacy envelopes migrate with an encrypted
backup, and corrupt or future records cannot be replaced without an explicit
security reset.

`ssh-profiles.json` uses schema version 1 and atomic writes. Legacy connection
profiles are backed up before migration. Corrupt, invalid-schema, and future
state fails explicitly and cannot be replaced by built-in example profiles or
a subsequent profile save.

Long-operation state uses schema version 1 and atomic writes. Active records
recover as `interrupted`; runtime handlers are not persisted. Corrupt input is
preserved in a timestamped diagnostic copy and returns
`OPERATION_STATE_CORRUPT`. Future schemas return
`OPERATION_SCHEMA_UNSUPPORTED` without changing the file. Other stores must not
be described as migration-safe until their readers implement equivalent
future-version rejection and backup behavior.
