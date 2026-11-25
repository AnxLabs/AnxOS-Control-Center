# 216-B3 Domain migration plan (written plan only)

**Status: proposal for owner approval.** Nothing here has been done. Buying a
domain, DNS, Supabase settings and production deploys are separately approved
production steps (PLANS.md section 8), not part of 216 development.

## Goal

Serve the website from a new AnxHost domain while
`anxoscontrolcenter.org` keeps working **permanently** for existing installs:
sign-in, update fallbacks, download links and release notes.

## Where the current domain is used (verified 2026-11-25)

| Place | What it does | File |
| --- | --- | --- |
| `OFFICIAL_SITE_ORIGIN` / `OFFICIAL_SITE_HOSTNAME` | Desktop sign-in host allowlist and website base URL | `src/shared/officialSite.js` (frozen FI-UPD-01), read by `src/services/accountAuthService.js` |
| Update fallback | The updater reads `${OFFICIAL_SITE_ORIGIN}/config.js` when GitHub is unavailable | `src/services/updateManager.js` |
| Release metadata | `siteUrl` in the website config and every generated canonical, sitemap and JSON-LD URL | `scripts/sync-website-release.js`, `src/shared/releaseConfig.js`, `scripts/release-docs.js`, `scripts/website-sitemap.js` |
| Canonical host | `www.` and `*.pages.dev` redirect to the canonical host | `website/_worker.js` (`CANONICAL_HOST`) |
| Account function CORS | Built-in allowed origin plus the `ANXOS_ALLOWED_ORIGINS` secret | `supabase/functions/anxos-account/index.ts`, `anxos-marketplace-curseforge/index.ts` |
| IndexNow | Key file served at `/<key>.txt` on the site | `scripts/indexnow-submit.js`, `website/63065fedd3db1e49b0c6286f2bfa4350.txt` |

Installed Build 215 and earlier apps can only use `anxoscontrolcenter.org`.
They will never learn a new host, so the old domain must keep serving sign-in,
`config.js` and downloads for as long as those builds exist.

## Selection criteria (owner decision)

- Short, spells "AnxHost" unambiguously, no hyphen.
- `.com` preferred; `.app` or `.gg` acceptable (both HTTPS-only, which matches the site).
- Available on Cloudflare Registrar, so DNS, Pages and the Worker stay in one account.
- No trademark conflict in a basic search.

## Steps (each a separately approved production step)

1. **Register** the domain on Cloudflare (owner). Add it as a custom domain on
   the existing Pages project. Both domains serve the same deployment.
2. **App, additive, in a release:** add the new host to the sign-in allowlist
   beside the old one, by turning `OFFICIAL_SITE_HOSTNAME` into a list with
   the old host kept first until step 5. The frozen identifier FI-UPD-01 stays
   (the old origin must remain), and a new frozen entry records the new host.
   The update fallback tries the new origin, then the old one.
3. **Supabase, additive:** add the new origin to `ANXOS_ALLOWED_ORIGINS`
   (secret, no redeploy) and to the built-in list in both functions. Never
   remove the old origin.
4. **Website:** when a release carrying step 2 has been out for one update
   cycle, switch `siteUrl` and the canonical host to the new domain.
   `_worker.js` sends 301s from `anxoscontrolcenter.org/*` to the same path on
   the new host for **HTML pages only**. `config.js`, `/api/download/*`,
   `/release-notes.json`, sign-in pages and the IndexNow key keep being
   served directly on the old host, without a redirect, because old apps fetch
   them and some clients do not follow redirects on those paths.
5. **Search:** regenerate the sitemap on the new host, keep a sitemap on the
   old host listing the redirects, add the new host to Bing and Google
   consoles, and run `website:indexnow` for both hosts.
6. **Keep forever:** renew `anxoscontrolcenter.org` indefinitely (calendar
   reminder and auto-renew); never repoint or drop it.

## Tests to add with the implementation

- The sign-in allowlist accepts both hosts and nothing else (look-alike and
  subdomain cases refused).
- A Build 215 configuration (old host only) still signs in and still finds
  updates through the fallback.
- `_worker.js`: HTML paths redirect with 301 and keep the query string; the
  exempt paths return 200 on the old host.
- `release-consistency` and the website smokes pass with the new `siteUrl`.

## Rollback

Each step is additive until step 4. Rolling back step 4 means restoring the
old `siteUrl` and canonical host; the redirects are in `_worker.js` only.
