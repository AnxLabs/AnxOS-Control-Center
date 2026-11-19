# Cloudflare Pages deployment

The `Deploy Website to Cloudflare Pages` workflow runs after a successful
tag-triggered `Desktop Release` workflow. It checks out the `dev` branch and
deploys only the `website/` directory.

Configure the repository with:

- Secret `CLOUDFLARE_API_TOKEN`: a scoped Cloudflare API token with Pages
  project deployment permission for the target account.
- Secret `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID that owns the Pages
  project.
- Repository variable `CLOUDFLARE_PAGES_PROJECT`: the exact Pages project name
  serving `anxoscontrolcenter.org`.

The workflow fails closed when any value is missing. It does not print token
values. The Pages project must have `website/` as its deployed output and the
production custom domain configured in Cloudflare. After deployment, verify
`/config.js`, the download page, and `/api/download/latest/windows` against the
tagged release assets.

## Search engines and AI crawlers

Crawlers read the raw HTML, the sitemap and the structured data, not what
`site.js` renders. Each of these comes from `release.json`, so a release
never needs a hand edit:

- `npm run website:sync` (run by `Promote Release to Stable`) regenerates
  `config.js` and `release-notes.json`. It then rewrites the static release text
  and the `data-release-jsonld` `SoftwareApplication` record
  (`release-docs.js`). Last, it moves a sitemap URL's `<lastmod>` only when that
  page's content changed (`website-sitemap.js`, state in
  `website/sitemap-state.json`).
- Each release page carries exactly one `SoftwareApplication` record, and it
  names the current build. A second hand-written record without a version
  competed with it on the homepage.
- `_worker.js` sends `www.anxoscontrolcenter.org` to the apex with a 301. It
  marks every `*.pages.dev` address `noindex, nofollow`: the project name and
  each deployment's frozen `<id>.<project>.pages.dev` copy. Copies that were
  already indexed fall out of results only once they are recrawled with the
  header, or once the old deployments are deleted in Cloudflare.
- HTML is served `max-age=0, must-revalidate` (`cf-cache-status: DYNAMIC`), so a
  deploy needs no cache purge.
- `npm run website:indexnow` lists the pages whose `lastmod` is the newest date
  (a dry run). `--submit` sends them to IndexNow (Bing, Yandex and others; not
  Google), but only after the live site serves the same key as
  `website/<key>.txt`. The deploy workflow runs it after each deploy, retrying
  while the deploy propagates; a failure there never fails the deploy.
- Google has no submission API for ordinary pages. Submit
  `https://anxoscontrolcenter.org/sitemap.xml` once in Search Console (Domain
  property). Google then reads `lastmod` on its own. Bing Webmaster Tools can
  import the Search Console property.

`npm run website:search-indexing:smoke` and `release-consistency-check.js`
check all of the above without network access.
