# AnxHost website domain migration

**Decision (owner, 2026-11-27):** the AnxHost website moves to
**`https://anxhost.anxlabs.net`**, a subdomain of the existing `anxlabs.net`
zone. No domain is bought. **`https://anxoscontrolcenter.org` stays registered
and serving** for installed apps (sign-in, update fallback, downloads,
release notes). Moving the app's own hard-coded references is Build 217 work;
the accepted Build 216 RC3 is not changed.

Approval gates still open (owner's words, 2026-11-27): changing authentication
policies, redirecting production traffic, and deploying the redesigned website
each need a separate approval.

## Status (2026-11-27)

| Step | State |
| --- | --- |
| Production deploys only from the guarded workflow | **Done.** The Pages project `anxos-control-center` had Git integration deploying every push to `dev` to production. `production_deployments_enabled` is now `false`, so pushes to `dev` no longer deploy production (other branches still get preview builds). Production changes only through `cloudflare-pages-deploy.yml` (`wrangler pages deploy`, which checks the site against the stable release). |
| `anxhost.anxlabs.net` on the Pages project | **Added as a custom domain, waiting for its DNS record.** Cloudflare reports `CNAME record not set`; the wrangler login used here has no DNS write scope. Owner step: in the `anxlabs.net` zone add `CNAME anxhost → anxos-control-center.pages.dev`, proxied. Cloudflare then validates the hostname and issues its certificate. |
| Download API 502s | **Fixed in the worker, not deployed.** Cause: GitHub's API answered the worker's uncached, unauthenticated lookups with 403 (shared-IP rate limit). See `website/_worker.js` and `scripts/website-download-resilience-smoke.js`. |
| Host-aware routing | **Prepared, not deployed.** `website/_worker.js` ships with the legacy host canonical: the new host serves the same pages marked `noindex` and sends sign-in pages to the legacy host. |
| Canonical switch and 301s | **Prepared, needs approval** (redirects production traffic). One command: `node scripts/website-hosts.js --switch=new`, then `node scripts/website-sitemap.js` and the website tier. |
| Sign-in on the new host | **Not started; needs approval** (authentication policy) and Build 217. |
| Search engines | **Prepared, owner accounts needed** (checklist below). |

## How the two hosts behave

`website/_worker.js` decides by host; `scripts/website-hosts.js` is the switch.

| Request | Before the switch (now) | After `--switch=new` |
| --- | --- | --- |
| `anxoscontrolcenter.org` page (`/`, `/download`, `/features/`, …) | served, indexable | **301** to the same path and query on `anxhost.anxlabs.net` |
| `anxoscontrolcenter.org` sign-in (`/account`, `/activate`, `/signin`, `/signup`, `/profile`, `/device*`, `/forgot-password`, `/reset-password`) | served | served (never redirected) |
| `anxoscontrolcenter.org` `/config.js`, `/release-notes.json`, `/api/download/*`, IndexNow key, `robots.txt`, `sitemap.xml`, assets | served | served (installed apps and tools read them) |
| `anxhost.anxlabs.net` page | served, `noindex` | served, indexable |
| `anxhost.anxlabs.net` sign-in page | **302** to the same path on the legacy host | **302** to the same path on the legacy host |
| `www.` of either host | 301 to the canonical host (sign-in and app paths to legacy) | same |
| `*.pages.dev` | `noindex` | `noindex` |

Only `GET` and `HEAD` are redirected. The sign-in redirect is a 302 because
it is temporary: it lasts until the app (Build 217) and the account service
trust the new origin.

## What `--switch=new` changes

Covered by `scripts/website-host-switch-smoke.js` (switch, check every
surface, switch back byte for byte):

- `website/_worker.js`: `CANONICAL_HOST = NEW_HOST` (turns on the 301s).
- Every page's canonical link, `og:url`, `og:image`, Twitter image and
  JSON-LD URLs; absolute sign-in links stay on the legacy host.
- `robots.txt` sitemap line, `sitemap.xml` and `sitemap-state.json`.
- `website/config.js` `siteUrl`, so the release generators
  (`sync-website-release.js`, `release-docs.js`) and the READMEs follow.
- Not changed: `website/account-config.js` (`siteUrl` stays legacy, so
  Supabase sign-in emails and redirects keep working), GitHub download URLs,
  and the app's `src/shared/officialSite.js` (frozen FI-UPD-01).

## Search engines (owner accounts)

Do these after the DNS record exists and the switch is approved and deployed.

1. **Google Search Console:** add a property for `https://anxhost.anxlabs.net/`
   (or a Domain property for `anxlabs.net`, verified by a DNS TXT record),
   submit `https://anxhost.anxlabs.net/sitemap.xml`, and keep the
   `anxoscontrolcenter.org` property. If Search Console offers Change of
   Address for this move, use it; the 301s work without it.
2. **Bing Webmaster Tools:** add the new site (or import it from Search
   Console), submit the sitemap, and use Site Move if it is offered for this
   move.
3. **IndexNow:** the key file is served on both hosts. After the deploy,
   `npm run website:indexnow -- --submit --all` submits the new host's
   sitemap URLs (the script checks the live key first).
4. **Canonicals:** before the switch every canonical names the legacy host
   and the new host is `noindex`, so nothing competes. After it, every
   canonical names the new host and the legacy pages answer 301.

## Keep forever

- Renew `anxoscontrolcenter.org` indefinitely (auto-renew on); never repoint
  or drop it while any installed build can exist.
- Never redirect `config.js`, `release-notes.json`, `/api/download/*` or the
  sign-in pages away from it.

## Build 217 (app, separate approval)

- Add `anxhost.anxlabs.net` to the sign-in host list beside the legacy host
  (a new frozen entry; FI-UPD-01 stays), and let the update fallback try the
  new origin first, then the legacy one.
- Add `https://anxhost.anxlabs.net` to Supabase `ANXOS_ALLOWED_ORIGINS` and
  the functions' built-in list (additive; never remove the legacy origin).
- Then sign-in pages can be served on the new host, and the 302s removed.

## Build 217 planning item: anxoscontrolcenter.org as optional AnxNet infrastructure

**Planning only (owner, 2026-11-27).** Nothing is designed, built or
configured yet, and each step will need its own approval.

Once the website is canonical on `anxhost.anxlabs.net`, the legacy domain
could also host optional AnxNet infrastructure: DNS names for edges, plus
relay and gateway endpoints. Today a network owner runs those on their own
reachable machine (`src/anxnet/edge.js`, `bin/anxnet-edge.js`).

Questions the plan has to answer before any work:

- **Legacy duties first.** Whatever is added must never take over, shadow or
  redirect the paths installed apps rely on: `/config.js`,
  `/release-notes.json`, `/api/download/*`, the sign-in pages, the IndexNow
  key, and the 301s for ordinary pages. New services would live on their own
  subdomains (for example `relay.` or `gw.`), never on the apex paths.
- **`.internal` names stay.** Existing `<device>.<network>.internal` addresses
  (`src/anxnet/names.js`, `dns.js`) keep working unchanged. Any public name
  under the legacy domain is an addition, not a replacement, and old members
  that never learn it keep working.
- **Opt-in and owner-controlled.** An AnxLabs-run relay or gateway must stay
  optional. Today's rules hold: relays see only ciphertext, and gateway
  routes need a grant signed by the network owner. A self-hosted edge stays
  a first-class choice.
- **Operations and cost.** Who runs and pays for the edge, abuse limits,
  per-network quotas, logging and privacy, and what happens when it is down.
- **Security review.** Exposing gateway ports under an AnxLabs domain means
  AnxLabs answers for that traffic. The plan needs an abuse policy and a
  security review before anything is exposed.

## Rollback

- Routing: `node scripts/website-hosts.js --switch=legacy` and redeploy.
- Production deploys from `dev` pushes: set `production_deployments_enabled`
  back to `true` on the Pages project (not recommended).
- The custom domain can be removed from the Pages project; the DNS record is
  the owner's.
