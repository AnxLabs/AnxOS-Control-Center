const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertWebsiteAccountUi() {
  const index = read("website/index.html");
  const activate = read("website/activate/index.html");
  const forgotPassword = read("website/forgot-password/index.html");
  const resetPassword = read("website/reset-password/index.html");
  const signinPage = read("website/signin/index.html");
  const signupPage = read("website/signup/index.html");
  const accountPage = read("website/account/index.html");
  const profilePage = read("website/profile/index.html");
  const profileIndex = read("website/profile/index.html");
  const site = read("website/site.js");
  const accountConfig = read("website/account-config.js");
  const profileRepairMigration = read("supabase/migrations/202607120001_profiles_profile_fields_repair.sql");

  assert(signinPage.includes('data-auth-form="signin"'), "Website should include a real sign-in form.");
  assert(signupPage.includes('data-auth-form="signup"'), "Website should include a real sign-up form.");
  assert(signinPage.includes('data-auth-message="signin-loading"'), "Sign-in route should keep a visible loading state during auth initialization.");
  assert(signinPage.includes('Already signed in') && signinPage.includes('Go to Account'), "Sign-in route should show a signed-in card instead of blanking the form.");
  assert(profilePage.includes('id="profile"') && profilePage.includes('data-account-route="profile"'), "Website should include a dedicated Profile route.");
  assert(profilePage.includes('href="/account?section=devices"') && profileIndex.includes('href="/account?section=devices"'), "Website should provide static /profile route content.");
  assert(accountPage.includes('href="/profile"'), "Account navigation should link to the Profile route.");
  assert(profilePage.includes('data-profile-completion'), "Profile page should show completion status.");
  assert(profilePage.includes('name="bio"') && profilePage.includes('name="timeZone"') && profilePage.includes('name="preferredPlatform"'), "Profile page should expose supported profile preference fields.");
  assert(profilePage.includes('data-profile-action="remove-avatar"'), "Profile page should support removing an avatar URL.");
  assert(!accountPage.includes('data-auth-form="profile">\n              <label>Username'), "Account overview should not contain the old inline profile editor.");
  assert(forgotPassword.includes('data-auth-form="forgot"'), "Website should include forgot-password form.");
  assert(resetPassword.includes('data-auth-form="reset"'), "Website should include reset-password form.");
  assert(accountPage.includes('href="/forgot-password">Reset Password</a>'), "Signed-out account UI should expose password recovery.");
  assert(accountPage.includes('href="/forgot-password">Change Password</a>'), "Signed-in account UI should expose password recovery.");
  assert(forgotPassword.includes('data-auth-form="forgot"'), "Website should provide a standalone forgot-password page.");
  assert(resetPassword.includes('data-auth-form="reset"'), "Website should provide a standalone reset-password page.");
  assert(resetPassword.includes('name="passwordConfirm"'), "Password reset should require password confirmation.");
  assert(activate.includes('data-device-action="approve"'), "Dedicated activation page should include device approval action.");
  assert(activate.includes('data-device-login-form'), "Dedicated activation page should include device lookup form.");
  assert(accountPage.includes('data-account-devices'), "Website should include account devices list.");
  assert(accountPage.includes('data-account-sessions'), "Website should include account sessions list.");
  assert(accountPage.includes('data-account-events'), "Website should include security history list.");
  assert(accountPage.includes('data-auth-action="clear-revoked-devices"'), "Devices card should include a Clear Revoked action.");
  assert(accountPage.includes('data-auth-action="clear-expired-sessions"'), "Sessions card should include a Clear Expired action.");
  assert(accountPage.includes("Account Data Cleanup") && accountPage.includes('data-auth-action="cleanup-inactive-records"'), "Account page should include compact account data cleanup controls.");
  assert(accountPage.includes('data-security-filter="device"') && accountPage.includes('data-security-filter="cleanup"'), "Security history should include compact audit filters.");
  assert(accountPage.includes("data-security-hide-old"), "Security history should support hiding older audit records.");
  assert(accountPage.includes("data-confirm-modal") && accountPage.includes("data-cleanup-modal"), "Cleanup and security actions should use the shared confirmation modal.");
  assert(accountPage.includes("data-toast-region"), "Cleanup actions should have a toast notification region.");
  assert(!accountPage.includes("Account service unavailable"), "Placeholder unavailable panel should be removed.");
  assert(!signupPage.includes("Sign up is not live yet"), "Placeholder signup panel should be removed.");
  assert(!activate.includes("Approval requires backend setup"), "Placeholder device backend panel should be removed.");
  assert(site.includes("supabase.createClient"), "Website should initialize Supabase Auth.");
  assert(site.includes("signInWithPassword"), "Website should implement email/password sign-in.");
  assert(site.includes("getSignInUrlForActivation") && site.includes("returnTo"), "Website should preserve device activation codes through sign-in.");
  assert(site.includes("redirectToCanonicalSiteOrigin") && accountConfig.includes("https://anxoscontrolcenter.org"), "Website should use the configured official account origin.");
  assert(site.includes("isAccountApiConfigured") && site.includes("ACCOUNT_API_NOT_CONFIGURED"), "Website should allow Supabase sign-in to load separately from account API availability.");
  assert(site.includes("apikey: accountConfig.supabaseAnonKey") && site.includes('authorization: `Bearer ${accessToken}`'), "Protected website account requests must include the current Supabase session bearer token and anon key.");
  assert(site.includes("const requireAuth = options.requireAuth !== false") && site.includes("waitForAuthRestoration"), "Website account requests must separate public/protected calls and wait for auth restoration.");
  assert(site.includes("ACCOUNT_API_KEY_NOT_CONFIGURED"), "Website account requests must report a missing Supabase anon key distinctly.");
  assert(site.includes("friendlyAccountDataError") && site.includes("ACCOUNT_NETWORK_OR_CORS") && site.includes("ACCOUNT_ENDPOINT_NOT_FOUND"), "Website account sections should classify fetch, CORS, auth, endpoint, and server errors.");
  assert(site.includes("latestAccountSectionErrors") && site.includes("refreshAccountSection"), "Website account sections should degrade and refresh independently.");
  assert(accountPage.includes('data-auth-action="refresh-devices"') && accountPage.includes('data-auth-action="refresh-sessions"') && accountPage.includes('data-auth-action="refresh-security"'), "Account overview should expose independent refresh controls.");
  assert(site.includes("auth.signUp"), "Website should implement sign-up.");
  assert(site.includes("resetPasswordForEmail"), "Website should implement forgot-password.");
  assert(site.includes("/reset-password"), "Recovery emails should redirect to the standalone reset page.");
  assert(site.includes("updateUser({ password"), "Website should implement password reset.");
  assert(site.includes("PASSWORD_RECOVERY_SESSION_REQUIRED") && site.includes("Open the latest password reset link from your email"), "Password reset should require a restored recovery session before updating the password.");
  assert(site.includes("loadProfile().catch") && site.includes("currentProfile = null"), "Website profile loading should not block signed-in account state.");
  assert(site.includes(".from(\"profiles\").upsert"), "Website profile saves should repair missing profile rows.");
  assert(site.includes('authState = "loading"') && site.includes("applyAuthVisibility"), "Website auth rendering should have an explicit loading state and scoped visibility.");
  assert(site.includes("function applyAuthNavigation") && site.includes("[data-auth-nav]") && site.includes('window.location.replace("/profile")'), "Website navigation should be auth-aware and redirect signed-in users away from sign-in routes.");
  assert(site.includes("AUTH_RESTORE_TIMEOUT_MS") && site.includes("withTimeout(client.auth.getSession()") && site.includes("initialize-timeout-fallback"), "Website auth navigation must resolve from loading even if session restore stalls.");
  assert(site.includes("authStateSubscription") && site.includes("if (!authStateSubscription)"), "Website should avoid duplicate auth state listeners.");
  assert(signinPage.includes('data-auth-nav="signed-out" hidden') && signinPage.includes('data-auth-nav="signed-in"') && signinPage.includes('data-auth-action="signout"'), "Website header must hide auth-dependent nav until session state resolves.");
  assert(site.includes('window.location.assign("/")'), "Website sign-out should clear auth UI and return to the homepage.");
  assert(site.includes("fallbackState") && site.includes("selectedState"), "Scoped auth rendering should avoid hiding every auth state.");
  assert(site.includes("signinDisplays") && site.includes("logAuthVisibility") && site.includes("WEBSITE_DEBUG"), "Website should support opt-in sanitized auth visibility diagnostics.");
  assert(site.includes("redirectToSignInForCurrentRoute") && site.includes("returnTo"), "Unauthenticated routes should preserve return destination through sign-in.");
  assert(site.includes("profileSnapshotFromForm") && site.includes("beforeunload"), "Profile page should detect dirty edits and warn before navigation.");
  assert(site.includes("validateProfileData"), "Profile saves should validate username and URL fields.");
  assert(site.includes("renderProfileDeviceList"), "Profile page should show connected AnxOS apps.");
  assert(site.includes("renderDeviceList") && site.includes("revokedDevicesExpanded"), "Website should group active devices and collapse revoked history.");
  assert(site.includes("Clear Revoked") && site.includes("Clear Expired"), "Website should show cleanup counts in card actions.");
  assert(site.includes("clearSafeStorageEntries") && site.includes("supabase|sb-|auth|token|session|profile|preferences"), "Local cache cleanup should preserve auth tokens, profile data, and preferences.");
  assert(site.includes("runAccountCleanup") && site.includes("confirmCleanup"), "Inactive account cleanup should require confirmation before deletion.");
  assert(profileRepairMigration.includes("add column if not exists bio text") && profileRepairMigration.includes("profiles_bio_length"), "Profile schema repair migration must align the bio UI field with Supabase.");
  assert(site.includes("renderSecurityEvents") && site.includes("getSecurityEventCategory"), "Security history should filter audit records without deleting them.");
  assert(site.includes("securityHistoryHideOld") && !site.includes("/api/account/security-events/clear"), "Security history cleanup should hide/filter audit records instead of deleting them.");
  assert(site.includes("/api/auth/device/lookup") && site.includes("requireAuth: false"), "Website should look up device authorization requests without requiring a website session.");
  assert(site.includes('/api/auth/device/${action}') && site.includes('approveOrDenyDevice("approve")'), "Website should approve device authorization requests.");
  assert(site.includes('/api/auth/device/${action}') && site.includes('approveOrDenyDevice("deny")'), "Website should deny device authorization requests.");
  assert(site.includes("requireSignedInForDeviceAction"), "Website should require sign-in only for approving or denying a reviewed device.");
  assert(site.includes("redactSecret"), "Website should redact secrets from messages.");
  assert(accountConfig.includes("supabaseAnonKey") && !/service[_-]?role/i.test(accountConfig), "Public account config must not mention service-role secrets.");
}

function assertSupabaseBackend() {
  const migration = read("supabase/migrations/202607100001_anxos_accounts.sql");
  const fn = read("supabase/functions/anxos-account/index.ts");

  [
    "create table if not exists public.profiles",
    "bio text",
    "time_zone text",
    "preferred_platform text",
    "website_url text",
    "github_url text",
    "create table if not exists public.device_authorization_requests",
    "create table if not exists public.registered_devices",
    "create table if not exists public.account_sessions",
    "create table if not exists public.security_events",
    "alter table public.profiles enable row level security",
    "alter table public.device_authorization_requests enable row level security",
    "profiles_update_own_safe_fields",
    "profiles_insert_own_safe_fields",
    "'user'",
    "cleanup_expired_device_authorizations",
  ].forEach((needle) => assert(migration.includes(needle), `Migration missing ${needle}`));

  [
    "/api/auth/device/start",
    "/api/auth/device/poll",
    "/api/auth/device/lookup",
    "/api/auth/device/approve",
    "/api/auth/device/deny",
    "/api/auth/refresh",
    "/api/auth/logout",
    "/api/account/devices",
    "/api/account/devices/clear-revoked",
    "/api/account/sessions",
    "/api/account/sessions/clear-expired",
    "/api/account/cleanup-inactive",
    "/api/account/security-events",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANXOS_DESKTOP_TOKEN_SECRET",
    "ANXOS_ALLOWED_ORIGINS",
    "slow_down",
    "consumed_at",
    "refresh_token_hash",
    "timingSafeEqual",
  ].forEach((needle) => assert(fn.includes(needle), `Edge Function missing ${needle}`));

  assert(!fn.includes("access-control-allow-origin\": \"*\""), "Production CORS must not be wildcard.");
  assert(fn.includes("sanitizeMessage") && fn.includes("[redacted]"), "Edge Function should redact secret-like values.");
  assert(fn.includes("deleteRevokedDevicesForUser") && fn.includes(".eq(\"user_id\", userId)"), "Cleanup endpoints must enforce ownership server-side.");
  assert(fn.includes("revoked_devices_cleared") && fn.includes("inactive_account_records_cleared"), "Cleanup endpoints should audit cleanup actions.");
  assert(fn.includes("DEFAULT_ALLOWED_ORIGINS") && fn.includes("new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredAllowedOrigins])"), "Edge Function CORS must always include official default origins even when env origins are configured.");
  assert(fn.includes("normalizeWebsiteBaseUrl") && fn.includes("OFFICIAL_WEBSITE_BASE_URL"), "Edge Function activation links should canonicalize stale website base URL settings.");
  const lookupBody = fn.slice(fn.indexOf("async function lookupDevice"), fn.indexOf("async function approveDevice"));
  assert(!lookupBody.includes("requireWebsiteUser") && !lookupBody.includes("accountId"), "Edge Function device lookup must be public and must not expose account IDs.");
}

function assertDesktopIntegration() {
  const app = read("app.js");
  const service = read("src/services/accountAuthService.js");
  const ipc = read("src/ipc/accountAuthIpc.js");
  const preload = read("preload.js");
  const packageJson = read("package.json");

  assert(service.includes("ANXOS_SUPABASE_ACCOUNT_FUNCTION_URL"), "Desktop should support Supabase function URL env alias.");
  assert(service.includes("loginWithPassword") && service.includes("grant_type=password"), "Desktop should support Supabase email/password sign-in.");
  assert(service.includes("ANXOS_SUPABASE_ANON_KEY") && service.includes("SUPABASE_ANON_KEY"), "Desktop should use public Supabase anon key configuration.");
  assert(service.includes("getBundledAccountConfigPath") && service.includes("website\", \"account-config.js"), "Desktop should load bundled website/account-config.js when env config is absent.");
  assert(service.includes("ACCOUNT_CONFIG_LOAD_FAILED"), "Desktop should report account configuration load failures explicitly.");
  assert(service.includes("configSource"), "Desktop account status should expose sanitized config source metadata.");
  assert(service.includes("LEGACY_ACCOUNT_HOSTS") && service.includes("anxos-control-center.pages.dev"), "Desktop should recognize the legacy account website host for safe canonicalization.");
  assert(service.includes("canonicalizeAccountWebsiteUrl") && service.includes("OFFICIAL_SITE_ORIGIN"), "Desktop should canonicalize stale account website URLs to the official origin.");
  assert(service.includes("verificationUrl: canonicalizeAccountWebsiteUrl"), "Desktop should canonicalize remote device verification URLs before exposing them.");
  assert(service.includes("LOCAL_ACCOUNT_HOSTS") && service.includes("app?.isPackaged !== true") && service.includes("ACCOUNT_LOCALHOST_NOT_ALLOWED"), "Packaged desktop account/device flows must reject localhost URLs while preserving local development.");
  assert(packageJson.includes("\"website/account-config.js\""), "Packaged Electron builds should include public account configuration.");
  assert(service.includes("/api/auth/device/start") && service.includes("/api/auth/device/poll"), "Desktop should use device authorization endpoints.");
  assert(app.includes("accountState.pending?.intervalMs") && app.includes("accountPollTimer = setTimeout"), "Desktop device polling should reschedule with the server-adjusted interval.");
  assert(/if \(accountState\.pending\) \{\r?\n\s+startAccountPolling\(accountState\.pending\.intervalMs\);/.test(app), "Desktop should resume a pending device login after the renderer refreshes.");
  assert(service.includes("/api/auth/refresh") && service.includes("/api/auth/logout"), "Desktop should refresh and revoke account sessions.");
  assert(service.includes("/api/account/devices/revoke"), "Desktop should support current-device revocation.");
  assert(service.includes("SecureSessionStore"), "Desktop should store account tokens through secure session storage.");
  assert(service.includes("redactSecret"), "Desktop should redact account secrets.");
  assert(!service.includes(["bungopam-byte", "github.io"].join(".")), "Desktop must not open the old GitHub Pages account URLs.");
  assert(ipc.includes("account:listDevices") && ipc.includes("account:revokeCurrentDevice"), "IPC should expose account device operations.");
  assert(preload.includes("listDevices") && preload.includes("revokeCurrentDevice"), "Preload should expose account device operations.");
}

function assertDocsAndEnv() {
  const env = read(".env.example");
  const docs = read("docs/anxos-account-production.md");
  const readme = read("website/README.md");

  assert(env.includes("ANXOS_ACCOUNT_API_URL"), ".env.example should document desktop account API URL.");
  assert(env.includes("SUPABASE_SERVICE_ROLE_KEY"), ".env.example should document server-only service role key.");
  assert(docs.includes("Supabase Auth") && docs.includes("Edge Function"), "Production docs should cover Supabase Auth and Edge Functions.");
  assert(docs.includes("Never put") && docs.includes("SUPABASE_SERVICE_ROLE_KEY"), "Production docs should warn about server-only secrets.");
  assert(docs.includes("trusted local owner allowlist"), "Docs should explain trusted owner account allowlist.");
  assert(docs.includes("https://anxoscontrolcenter.org") && docs.includes("stale `ANXOS_ALLOWED_ORIGINS`") && docs.includes("stale `ANXOS_WEBSITE_BASE_URL`"), "Docs should cover official account origin and stale function deployment failures.");
  assert(env.includes("ANXOS_ALLOWED_ORIGINS=https://anxoscontrolcenter.org"), ".env.example should default account CORS to the official domain.");
  assert(readme.includes("account-config.js") && readme.includes("public browser-safe values"), "Website README should document public account config.");
}

// Regression: the website Sign out used supabase-js signOut() with its v2
// default scope "global", which revoked refresh tokens on every device and
// signed the desktop app out ("account.refresh revoked HTTP_400" in its audit).
function assertWebsiteSignOutIsLocal() {
  const site = read("website/site.js");
  const calls = site.match(/auth\.signOut\([^)]*\)/g) || [];
  assert(calls.length > 0, "the website should have a Sign out action");
  for (const call of calls) {
    assert(/scope:\s*["']local["']/.test(call), `website sign-out must not revoke other devices' sessions: ${call}`);
  }
}

assertWebsiteAccountUi();
assertWebsiteSignOutIsLocal();
assertSupabaseBackend();
assertDesktopIntegration();
assertDocsAndEnv();

console.log("Account system smoke checks passed.");
