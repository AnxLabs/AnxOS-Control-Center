# Release documentation and metadata

How the "current release" reaches every public surface, how it is checked, and
which shared AnxLabs systems take part. Audited 2026-11-16 against Build 212.

## One source, one direction

```
release.json                         (version, build, channel; set at promotion)
  └─ scripts/sync-website-release.js → website/config.js, website/release-notes.json
       └─ scripts/release-docs.js     → static HTML fallbacks, JSON-LD,
                                        README.md and Releases README managed sections
GitHub Latest release (Releases repo) ← checked against config.js by the deploy guard
```

- `website/config.js` is the release identity every generated output is derived
  from. `release-docs.js` refuses to run if config and the newest release note
  disagree on tag, build, version, channel, date or asset URLs.
- The release date is the date recorded with the release's notes, never the day
  a script runs, so every step is deterministic and safe to repeat.
- Historical entries in `release-notes.json` are never rewritten.

## What is managed

| Surface | Marker | Written by |
| --- | --- | --- |
| Release lines, tag, links, download facts, file names, summaries | the `data-release-*`, `data-config*`, `data-download-*`, `data-file` attributes that `site.js` already renders | `release-docs.js` (static), `site.js` (live) |
| Release changelog (`release-notes.html`) | `[data-release-notes]`: every release as static cards, newest six visible, older ones in a disclosure, matching `site.js` | `release-docs.js` |
| Version badges, meta descriptions, image alt text naming a build | `data-release-managed` (rewrites "Version x Build y" and release dates only) | `release-docs.js` |
| Structured data | `<script type="application/ld+json" data-release-jsonld>` (SoftwareApplication) | `release-docs.js` |
| Main README, Releases README | `<!-- anxos-release:current:start -->` … `<!-- anxos-release:current:end -->` | `release-docs.js` |

Everything outside those markers is hand-written and never touched. A page reads
correctly without JavaScript; with JavaScript, `site.js` renders the same values
from the same config.

## Commands

| Command | What it does |
| --- | --- |
| `npm run website:sync` | Regenerates config and notes from `release.json`, then every managed output. |
| `npm run release:docs` | Regenerates the managed outputs from `website/config.js` only. |
| `node scripts/release-docs.js --dry-run` / `--check` | Lists out-of-date outputs; `--check` exits 1. |
| `npm run release:docs:check` | `--check` plus the consistency check below. |
| `npm run release:docs:live-check` | Also compares with the public GitHub Latest release and its assets (one API call). |
| `npm run release:consistency:smoke` | Cases A–G against local fixtures, including a simulated future release. |
| `npm run qa:website` | The website tier: release docs, website smokes and release policy (~7 s). |
| `npm run qa:auto` | Picks the website tier when every changed file is website/docs/release-docs, otherwise the fast tier. |

`release-consistency-check.js` fails when a current-release surface names a
different build, a GitHub release link points elsewhere, JSON-LD is wrong, a
README section is stale, or any site page names another build outside the
release history.

## Promotion (unchanged gates, more outputs)

`promote-release.yml` stays an explicit, owner-dispatched workflow and still
refuses an already-stable release. It now:

1. sets the build and runs `npm run website:sync` (all managed outputs);
2. runs `release-docs.js --check` and `release-consistency-check.js` before
   pushing anything;
3. commits only generated release outputs to `dev` (no workflow runs on pushes
   to `dev`, so the bot commit cannot loop);
4. promotes the release to Latest, updates the source pointer and dispatches the
   guarded Pages deploy, as before;
5. rewrites only the managed section of the Releases repository README with
   `ANXOS_RELEASE_REPO_TOKEN`. A missing token, missing markers or a refused write
   fails the run, so an unsynchronized README is never reported as success.

The Pages deploy additionally refuses stale static HTML or README sections, and
never builds desktop or Agent artifacts. A website or documentation change can
never publish, promote or deploy an application build.

## Shared AnxLabs systems (status on 2026-11-16)

| System | Finding | Status for AnxOS release metadata |
| --- | --- | --- |
| **SAUS** (Shared AnxLabs Update Service) | Exists as a shared library/fixture used by AnxBrowse and a Release Fabric bridge (`rfab-saus-fixture/v1`). Release Fabric's checkpoint records real SAUS integration as deferred; there is no app adapter and no release catalog or API that serves version, channel, notes or artifacts. | **Blocked.** AnxOS keeps its existing updater (`update-manifest.json`, `latest*.yml`, SHA-512 checked) and website metadata. No AnxOS-specific replacement was built. |
| **Release Fabric** | Real CLI (`rfab check`, incremental branch `perf/incremental-checks-20261111`, private pre-release). Selects existing tasks by changed paths, reuses cached evidence, and never authorizes a release. | **Partially integrated.** `release-fabric.checks.yml` maps AnxOS's existing checks to their inputs (opt-in; validated with `rfab validate` and `check --plan`). `qa:auto` gives the same docs-only narrowing without Release Fabric installed. |
| **ALSP** (AnxLabs Shared Projects) | Pilot (`anxlabs-shared-project/v1` descriptors, read-only `registry.py`), on an AnxBrowse integration branch; examples are disabled and no production descriptors exist. | **Proposed.** No AnxOS descriptor added. Continuity stays in Git, `docs/HANDOFF_*.md` and `AGENTS.md`. |
| **AMDP** | Anx-Creds' credential-defense protocol. Updaters are explicitly out of scope; it is not a deployment-policy engine. | **Intact, not used.** Not modified or repurposed. |
| **Deployment policy** | No separate approved policy component exists. Today's enforcement is in the workflows (below). | **Missing → proposed** as a separately named component; not built. |
| **Sona ISTU** | Sona's interface-clarity phases (zero-confusion composer, intent routing, plain-words approvals, device sweep), not a synchronization service. | **Not reused.** Only the idea of one plain status line per surface applies; the lightweight website stays as is. |

### Release policy as enforced today

| Rule | Enforced by |
| --- | --- |
| Publication only from tags; RCs and tags publish as pre-release | `windows-release.yml` (`if: startsWith(github.ref, 'refs/tags/')`, `--prerelease`) |
| Signed Windows artifacts | `windows-release.yml` Authenticode verification step; partial signing config rejected |
| Required checks before packaging | `static-validation` and `rc-validation` jobs gate `windows` and `linux` |
| Explicit owner approval to make a build public | `promote-release.yml` is `workflow_dispatch` only, validates the tag, refuses re-promotion |
| Allowed destinations | Releases repo via `ANXOS_RELEASE_REPO_TOKEN`; source pointer via `GITHUB_TOKEN`; Pages via Cloudflare secrets |
| Website deploys only consistent, stable metadata | `cloudflare-pages-deploy.yml` (manual) + `verify-website-config-vs-stable.js` + `release-docs.js --check` + consistency check |
| Immutable releases | publish step refuses an existing release; no `--clobber` |
| Audit trail | Workflow runs, signed tags and the bot's commits |
| Branches and tags cannot be deleted or rewritten | GitHub rulesets (below) |

**Rulesets (safety-only, no bypass):**

| Repository | Ruleset | Protects | Blocks |
| --- | --- | --- | --- |
| AnxOS-Control-Center | Protect dev (safety-only) | `refs/heads/dev` | deletion, force-push |
| AnxOS-Control-Center | Protect release tags (safety-only), added 2026-11-16 | `refs/tags/v*` | deletion, force-push, moving a tag |
| AnxOS-Control-Center-Releases | Protect main (safety-only), added 2026-11-16 | `refs/heads/main` | deletion, force-push |
| AnxOS-Control-Center-Releases | Protect release tags (safety-only), added 2026-11-16 | `refs/tags/v*` | deletion, force-push, moving a tag |

They deliberately do not require pull requests or status checks: the promotion
bot commits straight to `dev`, and the README step commits to the Releases
`main` through the contents API. Creating new tags and normal pushes are
allowed. To delete or move a release tag, an owner must disable the ruleset
first.
