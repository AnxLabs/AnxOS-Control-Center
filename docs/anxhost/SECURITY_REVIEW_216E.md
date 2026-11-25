# 216-E Security Review — Secure Session Persistence

Status: **approved by the owner on 2026-11-25** ("i approved anything", in
chat, after this review was prepared), with the recommended answer to every
decision in section 4 (D1–D6). PLANS.md section 8 required this approval
before any 216-E code was written.

Scope: the Local Owner session in the desktop app (`securityService.js`,
`session.dat`, `security.json`, `securityIpc.js`, the lock screen and the
Security page). Out of scope: Account sign-in (`accountAuthService`,
`secureSessionStore`), Agent tokens, node credentials, and the phone.

## 1. What exists today (verified in the source, Build 216-A10 tree)

| Area | Current behaviour | Source |
| --- | --- | --- |
| Remembered session | "Stay signed in" on the lock screen creates a remembered session: a random 48-byte token, stored bcrypt-hashed (12 rounds) in `security.json` and in clear inside the encrypted `session.dat`. | `createPersistentSession` |
| Lifetime | Absolute expiry, 30 days (`PERSISTENT_SESSION_TTL_MS`), set at sign-in and never extended by a restore. A session without "Stay signed in" lasts 8 hours in memory only. | `SESSION_TTL_MS`, `restorePersistentSession` |
| Encryption at rest | `safeStorage` (DPAPI on Windows) when available. **Otherwise AES-256-GCM with a key derived from the user name, host name and config path**, all of which are readable by anyone with the file system. | `encryptLocalSession`, `getFallbackEncryptionKey` |
| Restore | On first use after launch, `getCurrentUser()` restores the session if the record exists, has not expired, the user exists, the password has not changed (password-hash digest) and the token matches. | `restorePersistentSession` |
| Token rotation | **None.** The same remembered token is reused for 30 days; only the in-memory runtime token is new. | `restorePersistentSession` |
| Device binding | The session records `deviceId`, but **restore never compares it** with the current device. A device marked "removed" on the Security page is **not checked** at restore either. | `getCurrentDeviceId`, `removeTrustedDevice` |
| Device ID | First 16 hex characters of SHA-256 of host name, platform, architecture and config path. It is an identifier, not a secret. | `getCurrentDeviceId` |
| Logout | Deletes this session's record and `session.dat`. Password required next time. | `logout` |
| Revoke | Revoke one, revoke others, log out everywhere: records are removed from `security.json`, so a later restore of that record fails. | `revokePersistentSession`, `revokeOtherSessions`, `logoutAllSessions` |
| "Lock Owner Workspace" | **Audit entry plus renderer hiding only.** The main-process session stays authenticated, so nothing actually requires the password again. | `lockOwnerWorkspace`, app.js `lock-owner-workspace` |
| Idle settings | `inactiveSessionExpirationMs` (Never, 1, 7, 30, 90 days) and "Lock after inactivity" are saved and shown, but **nothing enforces them**. | `updateSessionSecuritySettings` |
| Account vs Local Owner | Account sign-in does not set the Local Owner session. All 61 `requireLocalOwnerAuthenticated(` calls check the Local Owner session only. | `accountSessionToSecurityUser`, grep |

## 2. Threat model

| # | Threat | Today | After 216-E |
| --- | --- | --- | --- |
| T1 | Someone copies `session.dat` and `security.json` to another computer or account. | Protected only if `safeStorage` was used (DPAPI is per user). With the fallback key, the copy decrypts anywhere the user name, host name and path can be reproduced. | Refused: no persistence without `safeStorage`; device ID checked at restore. |
| T2 | A copied or leaked remembered token is replayed later. | Valid for up to 30 days. | Rotated on every restore, so a stale copy stops working at the next real launch (the old token is invalid once rotated). |
| T3 | The owner walks away from an unlocked PC. | No idle lock. | Idle lock enforced in the main process. |
| T4 | The owner locks, logs out or revokes, and expects the password to be required. | Logout and revoke: yes. Manual lock: **no** (renderer only). | All three require the password. |
| T5 | A device removed on the Security page keeps signing in. | It does (removal is not checked). | Its sessions are revoked and restore refuses it. |
| T6 | Account sign-in is used to unlock local owner credentials. | Not possible. | Unchanged; tested. |
| T7 | Malware running as the same Windows user. | Can read DPAPI-protected data and drive the app. | Same. **Out of scope**: no user-mode design defends against it; documented, not claimed. |

## 3. Proposed policy (each item needs approval)

1. **Trusted device = this Windows user on this computer, with OS-backed
   secure storage.** A session is remembered only when
   `safeStorage.isEncryptionAvailable()` is true. The fallback key is never
   used for the Local Owner session. Existing fallback-encrypted `session.dat`
   files are deleted on first launch (the owner signs in once), and the event
   is audited.
2. **"Trust this device"** replaces "Stay signed in" on the lock screen (same
   control, clearer words), plus a Security page preference "Remember me on
   this device" (default **on** for the owner's own PC, opt-out turns it off
   and immediately deletes the remembered session). When secure storage is
   unavailable the control is disabled with the reason shown.
3. **Absolute expiry 30 days** from the password sign-in, never extended by a
   restore. (Alternative for decision: 14 days.)
4. **Token rotation on every restore.** Restore verifies the token, writes a
   new token hash to `security.json` and the new token to `session.dat`
   (write-then-rename for both, the current atomic writer), then accepts the
   session. If either write fails, the restore fails closed (password
   prompt) and the old record is removed.
5. **Device binding.** Restore requires `session.deviceId` to equal the
   current device ID, and the device not to be marked removed. A mismatch
   removes the record and prompts. Removing a device on the Security page
   also revokes every remembered session for that device.
6. **Idle lock, enforced in the main process.** "Lock after inactivity"
   uses `powerMonitor.getSystemIdleTime()` and the `lock-screen` /
   `suspend` events. Proposed options: 5, 15 (default), 30, 60 minutes, or
   Never. On idle: the runtime session is cleared, the app shows the lock
   screen, and the password is required. A remembered session is **not**
   used to come back from an idle lock (otherwise the lock means nothing);
   it is kept for the next app launch only.
7. **Remembered-session inactivity expiry** (`inactiveSessionExpirationMs`,
   the existing 1/7/30/90 days or Never): restore refuses a session whose
   `lastUsedAt` is older than the setting.
8. **Manual lock** ("Lock now", title-bar lock, Owner Workspace lock) clears
   the main-process session like idle lock. **Logout** additionally deletes
   the remembered session. **Revoke** keeps its current behaviour.
9. **Upgrades.** The `session.dat` and `security.json` schema versions are
   unchanged. A Build 215 remembered session protected by `safeStorage` is
   restored after the upgrade (finish line "restore after upgrade"); its
   bcrypt token hash is accepted once and replaced at that first rotation.
   Implementation note: rotated tokens are hashed with SHA-256 (the token is
   48 random bytes, so bcrypt's slowness adds no protection and would cost
   about 0.3 s of blocking work at every launch). A downgrade to Build 215
   therefore cannot verify the rotated token and asks for the password once.
10. **Unchanged:** Account sign-in never unlocks Local Owner credentials; all
    61 `requireLocalOwnerAuthenticated` sites stay as they are; password
    change still invalidates remembered sessions (password-hash digest).

## 4. Decisions needed from the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Approve the policy in section 3 as a whole, or name the items to change. | Approve. |
| D2 | Absolute lifetime of a remembered session. | 30 days. |
| D3 | Default idle-lock time. | 15 minutes, owner can choose Never. |
| D4 | Does an idle lock (not a relaunch) require the password even on a trusted device? | Yes. |
| D5 | Delete fallback-encrypted remembered sessions on upgrade (one extra sign-in on machines without secure storage)? | Yes. |
| D6 | Wording: "Trust this device" on the lock screen. | Yes. |

## 5. Tests that will prove it (finish lines, PLANS.md 216-E)

New `scripts/secure-session-persistence-smoke.js`, with `safeStorage`,
`powerMonitor` and the clock faked and every case failing first on the
current code where the current code is wrong:

- Restore **without** a prompt: after a simulated restart; after an upgrade
  from a Build 215-format `session.dat` and `security.json`.
- Prompt **required** after: logout; manual lock; revoke (one, others, all);
  absolute expiry; idle timeout; remembered-session inactivity expiry; device
  ID mismatch; device removed; opt-out; secure storage unavailable (including
  a fallback-encrypted file from an older build).
- The remembered token changes on every restore, and the previous token is
  refused afterwards.
- A failed write during rotation fails closed.
- Account sign-in alone leaves `requireLocalOwnerAuthenticated` refusing.

A real-app check (`secure-session-ui-qa`) covers the lock screen control,
the Security page preference, "Lock now" and idle lock with a short test
interval. Existing smokes must stay green: `account-session-restore`,
`persistent-session-store`, `secure-session-store`, `local-owner-auth`,
`auth-recovery`, `bootstrap-auth-order`, `auth-ipc-startup`,
`permission-matrix`.

## 6. Residual risks

- Same-user malware (T7) can read DPAPI data and drive the unlocked app.
- The device ID is derived from public values; it stops copying between
  computers together with DPAPI, not on its own.
- On machines without OS secure storage, the owner signs in at every launch.
- Idle detection uses system idle time, so input to another app counts as
  activity (intended: the PC is in use).
