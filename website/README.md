# AnxOS Download Website

Static download page for `AnxOS-Control-Center`.

The page also contains the optional AnxOS account entry points:

- `/signin`
- `/signup`
- `/account`
- `/profile`
- `/forgot-password`
- `/reset-password`
- `/activate`

Account features require Supabase configuration in `account-config.js`. Without that public config, the page disables account forms and shows a setup error instead of pretending authentication works.

## Release Data

Build-time release metadata is generated into `config.js`:

- latest version
- release date
- GitHub links
- the official GitHub repository source
- release notes
- stable domain download endpoint paths

Run this after building release artifacts:

```bash
npm run website:sync
```

The normal `npm run updates:manifest` release step also runs the website sync, so the download site stays aligned with app releases.

`release.json` remains the source of truth for local application version/build/channel metadata. Publicly downloadable application binaries are not derived from `release.json`; they are discovered from the latest published GitHub Release at runtime.

## Download Page

The canonical public download route is:

```text
https://anxoscontrolcenter.org/download
```

Compatibility routes:

- `/download/`
- `/download.html`
- `/downloads` redirects to `/download`

The first-server guide is available at `/setup`. Its download calls to action lead to the canonical `/download` route.

The download page loads `release-download-service.js`, queries the public GitHub Releases API configured by `window.ANXOS_DOWNLOAD_CONFIG.releaseRepository`, ignores drafts/source archives/invalid URLs, and renders only real assets from:

```text
https://github.com/AnxLabs/AnxOS-Control-Center-Releases
```

No GitHub token or secret is used in browser code.

The application source repository can remain private. Public visitors only need access to the release-only repository, which should contain GitHub Releases, installer assets, checksum manifests, and public release notes.

### Supported Asset Patterns

The release download service classifies these asset families:

- Windows setup: `*.exe` with `Setup` in the filename, such as `AnxOS-Control-Center-Setup-1.7-build142.exe`
- Windows portable: `*.exe` with `portable` in the filename
- Windows MSI: `*.msi`
- Linux AppImage: `*.AppImage`
- Linux Debian package: `*.deb`
- Checksums: `SHA256SUMS`, `checksums.txt`, `*.sha256`, or names containing `sha256`

Architecture labels are inferred from filename tokens such as `x64`, `x86_64`, `amd64`, `arm64`, `aarch64`, `ia32`, `x86`, or `i386` when present.

Future platform packages should keep descriptive, platform-specific extensions and include the app name in the asset filename. The page does not require source edits for new versions as long as the release asset names match these patterns.

### Stable Redirect Endpoints

Cloudflare Pages Functions provide versionless domain endpoints:

- `/api/download/latest/windows`
- `/api/download/latest/windows-portable`
- `/api/download/latest/linux-appimage`
- `/api/download/latest/linux-deb`

Each endpoint queries the latest published GitHub Release, validates that the selected asset belongs to the official repository, and returns an HTTP redirect to the GitHub Release asset. If no matching artifact exists, the endpoint returns a JSON `404` response instead of redirecting to an unrelated file.

Set `ANXOS_RELEASE_REPOSITORY=owner/repo` in the Pages Functions environment only if the public release repository changes. The default is `AnxLabs/AnxOS-Control-Center-Releases`. The legacy `ANXOS_GITHUB_REPOSITORY` variable is still accepted as a fallback, but new deployments should use `ANXOS_RELEASE_REPOSITORY`.

### Publishing Release Assets

Tagged release builds run from the private source repository, generate the supported installer artifacts, write `SHA256SUMS`, and publish those public artifacts to `AnxLabs/AnxOS-Control-Center-Releases`.

Configure this GitHub Actions secret on the private source repository:

```text
ANXOS_RELEASE_REPO_TOKEN
```

The token should have only the permissions required to create/update releases and upload assets in the public release repository. It must not be added to website files, browser config, Cloudflare public variables, packaged application files, or logs.

### Caching and Reliability

The browser release service caches the last valid normalized release in `sessionStorage` for 10 minutes. The Cloudflare redirect helper sends cache-friendly JSON headers for successful metadata responses and no-store headers for error responses. The page handles GitHub API rate limits, network failures, invalid JSON, missing installers, partial releases, and unsupported visitor platforms with visible retry/unavailable states.

The page never starts a download automatically. Browser platform detection is only progressive enhancement for choosing the recommended button.

### Local Testing

Run:

```bash
npm run website:download:smoke
npm run website:smoke
python3 -m http.server 4173 --directory website
```

Open:

```text
http://localhost:4173/download
```

The smoke tests mock GitHub responses and do not require GitHub to be online.

### Troubleshooting Missing Assets

If a platform does not appear on `/download`:

1. Confirm the GitHub Release is published, not draft-only.
2. Confirm the asset was uploaded to the official repository release.
3. Confirm the filename matches one of the supported patterns above.
4. Confirm the asset has a `browser_download_url` in the GitHub Releases API response.
5. Confirm the release workflow uploaded `SHA256SUMS` if checksum information should appear.
6. Use the browser retry button after publishing or replacing release assets.

## Local Development

From the repository root:

```bash
python3 -m http.server 4173 --directory website
```

Open:

```text
http://localhost:4173
```

The page is static and has no secrets or build step.

## Deployment

Deploy the contents of `website/` to any static host, including GitHub Pages, Nginx, Caddy, or a CDN-backed bucket.

Required files:

- `index.html`
- `styles.css`
- `site.js`
- `release-download-service.js`
- `config.js`
- `account-config.js`
- `robots.txt`
- `sitemap.xml`
- `site.webmanifest`
- `_redirects`
- `favicon.ico`
- `assets/anxos-logo.png`
- `assets/favicon.svg`
- `assets/favicon-16.png`
- `assets/favicon-32.png`
- `assets/apple-touch-icon.png`
- `assets/icon-192.png`
- `assets/icon-512.png`
- `assets/social-preview.png`
- `download.html`
- `signin/index.html`
- `signup/index.html`
- `account/index.html`
- `profile/index.html`
- `forgot-password/index.html`
- `reset-password/index.html`
- `activate/index.html`
- `downloads/index.html`
- `download/index.html`
- `install/index.html`
- `release/index.html`
- `changelog/index.html`

For GitHub Pages, publish the `website/` directory as the site root or copy its contents into the configured Pages branch/folder.

For Cloudflare Pages, deploy the contents of `website/` as the output directory and configure Supabase Auth redirect URLs to the deployed domain.

`_redirects` keeps clean alias paths such as `/sign-in`, `/sign-up`, `/downloads`, `/install`, and `/changelog` on supported canonical pages without using hash fragments or a broad SPA fallback.

### Official Domain

The canonical public origin is:

```text
https://anxoscontrolcenter.org
```

Recommended Cloudflare setup for `www`:

- DNS record: `www`
- Type: `CNAME`
- Target: `anxos-control-center.pages.dev`
- Proxy status: Proxied
- Redirect Rule: permanent `301`
- Source: `https://www.anxoscontrolcenter.org/*`
- Target: `https://anxoscontrolcenter.org/$1`
- Preserve the query string so activation and reset links keep their parameters.

Do not implement this as an application-level JavaScript redirect. The root domain remains canonical.

## Account Configuration

`account-config.js` may contain only public browser-safe values:

```js
window.ANXOS_ACCOUNT_CONFIG = {
  supabaseUrl: "https://<project-ref>.supabase.co",
  supabaseAnonKey: "<public anon key>",
  accountApiUrl: "https://<project-ref>.functions.supabase.co/anxos-account",
  siteUrl: "https://anxoscontrolcenter.org",
};
```

Never put service-role keys, refresh tokens, desktop token secrets, passwords, or database credentials in this file.

See `../docs/anxos-account-production.md` for migrations, Edge Function deployment, CORS, and desktop integration.

## Validation

Run a local static server and open the page in desktop and mobile browser widths. The download buttons should resolve from `config.js`, not hardcoded values in `index.html`.
