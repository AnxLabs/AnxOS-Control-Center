# AnxHost website launch runbook

The order of operations for putting the AnxHost website live on
`anxhost.anxlabs.net` while `anxoscontrolcenter.org` keeps serving installed
apps. Background and the host table: `DOMAIN_MIGRATION_PLAN.md`.

Every step marked **Approval** needs the owner's explicit approval at the time
it runs. The accepted Build 216 RC3 (`1212d772`) is never rebuilt for any of
this: these are website-only changes.

`node scripts/website-launch-check.js --stage=<stage>` checks the live site
read-only at each stage and exits 1 on a failure.

## State on 2026-11-27

| Item | State |
| --- | --- |
| `anxhost.anxlabs.net` DNS | Done by the owner. It resolves through Cloudflare, Pages validated it, and the certificate is from Google Trust Services, valid to 2027-02-25. `--stage=dns` passes 3 of 3. |
| Production deploy path | Only `cloudflare-pages-deploy.yml`. Git pushes no longer deploy production (`production_deployments_enabled: false`; other branches still get preview builds). It is dispatched by hand or by `promote-release.yml`. A manual `wrangler pages deploy --branch dev` with the account's credentials would also reach production; don't use it. |
| Live production | Deployment `591a93d0` (`dev` at `1212d772`, 07:22 UTC). It has the old worker: intermittent download 502s, no host routing, and `anxhost.anxlabs.net` serves the same pages, indexable, with canonicals that point to the legacy host. |
| Local commits | `52790d96` (website, download fix, routing, switch tooling) plus this runbook's commit. Not pushed. |

## Phase 1 — Deploy the redesigned website and the download fix

**Approvals:** push to `dev`, and deploy the website.
Nothing is redirected; the legacy host stays canonical.

1. Preflight, on the branch to be pushed:
   - `npm run qa:website` passes.
   - `git diff --check` is clean.
   - `node scripts/website-hosts.js` prints `anxoscontrolcenter.org`.
   - `node scripts/website-launch-check.js --stage=legacy` passes. It is the baseline: on the old worker the download API shows occasional 502s.
2. Fast-forward `dev` to the branch and push. The push does not change production. Confirm in Cloudflare Pages → Deployments that no new production deployment appeared.
3. Dispatch **Deploy Website to Cloudflare Pages** on `dev`. Its guard refuses to deploy unless `config.js` matches the public stable release (still Build 215) and the static pages agree with it. Its last step submits the changed pages to IndexNow.
4. Verify with `node scripts/website-launch-check.js --stage=deployed --samples=8`:
   - All 32 download API requests redirect to the official GitHub release, with no 502.
   - The legacy `config.js`, `release-notes.json`, sign-in pages and IndexNow key answer 200.
   - `anxhost.anxlabs.net` serves the redesign marked `noindex`.
   - Its `/signin/` and `/activate/?code=…` answer 302 to the same path on the legacy host.
5. **Rollback:** in Cloudflare Pages → Deployments, roll back production to `591a93d0`. Or redeploy the previous `dev` commit through the same workflow.

## Phase 2 — Publish Build 216

**Approval:** `🚀 publish`. This follows the ADP release workflow.

`promote-release.yml` does the following:

1. Moves `config.js` to Build 216 (`siteUrl` is still the legacy host).
2. Regenerates the release notes, static pages, JSON-LD and both READMEs.
3. Commits to `dev` and makes the release Latest.
4. Dispatches the same guarded website deploy.

After it, rerun `--stage=deployed`. Download links now resolve to Build 216, and all AnxOS-era releases stay listed on the release notes page and on GitHub.

Doing Phase 1 first means the download fix is live before Build 216 downloads start.

## Phase 3 — Make anxhost.anxlabs.net canonical

**Approvals:** redirect production traffic, then commit, push and deploy.

1. Switch the canonical host and regenerate what follows from it (rehearsed in a throwaway worktree on 2026-11-27, where the website tier passed 18 of 18 in the switched state):
   ```
   node scripts/website-hosts.js --switch=new
   node scripts/release-docs.js
   node scripts/website-sitemap.js
   npm run qa:website
   ```
   The switch changes 19 website files; `release-docs` updates `README.md` and `docs/releases-repository/README.md`.
2. Commit (`chore(website): make anxhost.anxlabs.net canonical`), push `dev` and dispatch the website deploy.
3. Verify with `node scripts/website-launch-check.js --stage=switched`:
   - Legacy pages answer 301 to the same path and query on the new host.
   - `config.js`, `release-notes.json`, the download API and the sign-in pages still answer directly on the legacy host.
   - The new host is indexable, with its own canonicals and sitemap.
4. Search engines (owner accounts):
   - Google Search Console and Bing Webmaster Tools: add `https://anxhost.anxlabs.net/`, or a Domain property for `anxlabs.net` (DNS TXT verification), and submit `https://anxhost.anxlabs.net/sitemap.xml`. Keep the legacy properties.
   - Use Change of Address or Site Move if the console offers it for this move.
   - The deploy workflow already sends the changed pages to IndexNow. Run `npm run website:indexnow -- --submit --all` once if every page should be resubmitted.
5. The Releases repository README picks up the new host at the next promotion. Until then it keeps linking to the legacy host, which redirects.
6. **Rollback:** `node scripts/website-hosts.js --switch=legacy`, then `release-docs`, `website-sitemap`, commit and the guarded deploy. Or roll back the Pages deployment.

## Phase 4 — Build 217 (app; separate approvals)

- Sign-in on the new host:
  - Add `anxhost.anxlabs.net` to the app's sign-in host list beside the legacy host. This is a new frozen entry; FI-UPD-01 stays.
  - Add `https://anxhost.anxlabs.net` to Supabase `ANXOS_ALLOWED_ORIGINS` and to the functions' built-in list. This is additive; never remove the legacy origin.
  - Then remove the worker's sign-in 302s for the new host.
- The update fallback tries the new origin first, then the legacy one.
- The remaining in-app "AnxOS" wording (see `docs/KNOWN_LIMITATIONS.md`).

## Never

- Redirect `config.js`, `release-notes.json`, `/api/download/*` or the sign-in pages away from `anxoscontrolcenter.org`.
- Let `anxoscontrolcenter.org` lapse or point it anywhere else.
- Deploy production with `wrangler` from a workstation, or turn Git production deploys back on.
- Rebuild or re-sign the app for a website change.
