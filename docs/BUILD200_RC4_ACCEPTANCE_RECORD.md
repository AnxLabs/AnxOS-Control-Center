# Build 200 RC4 Acceptance Record

Recorded 2026-09-15 for tag `v1.9-build200-rc4`, commit
`c1b48def1987ce4d2d4c42fe66e35731419b60d4`, Desktop Release run
`35048324278`, and Windows installer SHA-256
`ed08edfda3536bf9edcc5954218c7b75404f30e3634b3c9ccd27b5ece75027cc`.
Build 199 remains the stable release. This record does not authorize promotion
or publication.

## Accepted results

- The Desktop Release workflow completed successfully, including 183/183 RC
  validation checks and Windows Authenticode validation.
- A disposable Windows Sandbox in-place upgrade from Build 199 to RC4 preserved
  the application data exercised by the harness and preserved close/reopen
  state.
- The downloaded installer hash matched the recorded RC4 checksum.

## Corrected migration verdict

The reported live result, "schema-v1 to v2 migration never fires," was an
**invalid test-harness result**, not evidence of a product migration failure.
The harness seeded these roots:

1. `%APPDATA%\AnxOS Control Center\instances`
2. `%APPDATA%\AnxOS Control Center\agent\instances`
3. `C:\srv\anxos\instances`

The running scheduled-task Agent used `%APPDATA%\AnxHub\config\agent.json`, as
confirmed by its health response. Build 200 intentionally configures Electron
`userData` as `%APPDATA%\AnxHub`; its canonical `--agent` startup derives
`AGENT_INSTANCE_ROOT` from that same base. The live Agent root was therefore
`%APPDATA%\AnxHub\agent\instances`, which the harness never seeded. The fixture
could not be discovered, loaded, or migrated.

The exact RC4 installer payload was inspected without installation. Its
embedded Local Agent migration file has SHA-256
`3b2b9497f54d769c3a5be9d12838735ca5e97ee54a717877a49685ddbb2c2c73`,
identical to the source file at RC4 HEAD, and contains schema version 2, the
schema-v1 exclusive backup, atomic rewrite, and `installationState` migration.
This disproves the stale-runtime-bundle hypothesis for RC4.

## Corrected targeted procedure

Do not repeat the full upgrade acceptance. In a disposable sandbox with RC4
and its Local Agent already running:

1. Read `GET http://127.0.0.1:47131/api/v1/health` and parse `configPath`.
2. Derive `userData` as the parent of the `config` directory containing that
   file; for RC4 this is `%APPDATA%\AnxHub`.
3. Set the target root to `<userData>\agent\instances`.
4. Write the schema-v1 fixture with `.NET UTF8Encoding($false)` so the file is
   UTF-8 without a BOM. Refuse to overwrite an existing fixture.
5. Read the Agent token from the health-reported `agent.json` without logging
   or serializing it, then call authenticated `GET /api/v1/instances`.
6. Require the response to contain the fixture ID.
7. Require `config.json` to contain `schemaVersion: 2`, preserve the display
   name, and contain a non-null `installationState`.
8. Require `config.json.schema-v1.backup` to exist, remain schema 1, and retain
   the original fixture fields.
9. Call the list endpoint again and require the same backup bytes and exactly
   one schema-v1 backup for the fixture.

## Current gate position

The RC4 upgrade and persistence acceptance remains **passed**. The previous
migration failure is reclassified as **invalid because it did not test the live
root**.

The corrected targeted procedure was executed inside the disposable sandbox at
`2026-09-16T04:38:43.3835871Z` and **passed** against the packaged RC4 Agent. It
derived `%APPDATA%\AnxHub\agent\instances` from the health-reported config path,
returned the fixture on two authenticated Agent REST reads, migrated the record
to schema 2, added `installationState`, preserved the display name, retained the
schema-v1 content in its backup, and kept exactly one byte-stable backup across
the second read.

The Build 200 schema-v1 to schema-v2 packaged migration acceptance item is
therefore **passed**. No product change or new release candidate is justified
by the invalid original result.

Two separate product-hardening findings remain suitable for future tickets:
per-instance list failures are silently omitted from inventory, and Windows
health/config surfaces still expose the legacy `AnxHub` compatibility identity,
which can mislead operators and test harnesses. Neither finding caused the
schema migration to malfunction.
