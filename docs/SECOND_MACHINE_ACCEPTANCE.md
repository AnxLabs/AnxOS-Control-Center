# Second-Machine Acceptance

## Purpose

Independent replication evidence. The three interactive Electron acceptance
harnesses (`qa:acceptance`, `qa:onboarding`, `qa:responsive`) are executed on a
second Windows machine from the same commit, and their machine-readable results
are compared against the baseline recorded on the development machine. This
proves the acceptance result is reproducible on a machine the original run did
not touch, rather than an artifact of one developer profile.

The wrapper is `scripts/second-machine-acceptance.js` (alias `qa:second-machine`).
It launches the existing harnesses exactly as their npm aliases do and does not
modify them.

## Prerequisites

- Windows 10/11 x64 with an **interactive desktop session**. The harnesses drive
  a real Electron window; headless, service, or SSH-only sessions fail.
- Node.js 22.x or newer (`node --version`).
- Dependencies installed with `npm ci` — **required**. `electron` and
  `playwright-core` are resolved from `node_modules`; a partial or stale install
  fails the harness launch. Network access is needed for this initial install
  only.
- ~3 GB free disk space (Electron runtime, dependencies, and the screenshots and
  artifacts the three harnesses write).
- No Docker and no administrator rights required.

## The one command

From the repository root, on a clean checkout of the same commit:

```powershell
npm run qa:second-machine -- --out C:\anxos-second-machine\2026-09-25 --label "second-machine"
```

Options:

| Option | Effect |
| --- | --- |
| `--out <dir>` | Required. Fresh output directory; the wrapper refuses to write into a non-empty one. Use a path outside the checkout. |
| `--label <label>` | Machine label recorded in `summary.json` (default: hostname). |
| `--executable <path>` | Test a packaged build instead of the checkout (see below). |
| `--skip-onboarding` | Skip the onboarding fresh-install harness. |
| `--skip-responsive` | Skip the responsive mobile UI harness. |

The wrapper records `git rev-parse HEAD`, `node --version`, `process.platform`
and, when `--executable` is given, the executable SHA-256. It then runs the
selected harnesses in order — `qa:acceptance`, `qa:onboarding`, `qa:responsive` —
as child processes with cwd = repository root and a 10-minute timeout per
harness. A crash or timeout is a `FAIL` entry, never a hang. Each harness's
artifact directory is copied into `<out>\<harness>\` and removed from the
checkout, captured output is redacted and saved as `runner-console.log`, and
`<out>\summary.json` is always written. The wrapper exits non-zero unless every
selected harness passed.

## Expected output

```text
C:\anxos-second-machine\2026-09-25\
  summary.json
  qa-acceptance\   results.json, summary.md, screenshots\, navigation-inventory.json, renderer-console.log, runner-console.log
  onboarding\      results.json, summary.md, onboarding-*.png, dashboard.png, renderer-console.log, renderer-page-errors.log, runner-console.log
  responsive\      results.json, 45 viewport screenshots, renderer-errors.log, runner-console.log
```

Baseline fields on a passing machine:

- `summary.json`: `"status": "PASS"`.
- `harnesses.qaAcceptance`: `"pass": true`, `failedResults: []`,
  `rendererErrors: []` (baseline: 11 launch/navigation checkpoints passed,
  0 renderer errors).
- `harnesses.onboarding`: `"status": "PASS"`, `checks: 39`, `failed: []`.
- `harnesses.responsive`: `"pass": true`, `checks: 45`, `failures: []`,
  `rendererErrors: []`.

Each of the three harness directories additionally contains the harness's own
`results.json`/`summary.md` and screenshots, so a failure can be diagnosed from
the copied artifacts without the original machine.

## Comparing against this machine's baseline

Baseline artifacts recorded on the development machine:

- `artifacts/qa/2026-09-24T23-56-50-715Z` (`qa:acceptance`)
- `artifacts/onboarding/2026-09-24T23-58-56-345Z` (`qa:onboarding`)
- `artifacts/qa/responsive-mobile-2026-09-25T00-00-45-988Z` (`qa:responsive`)

Compare, per harness:

- `qaAcceptance`: `pass`, the failed checkpoint names in `failedResults`, and
  `rendererErrors`.
- `onboarding`: `status`, `checks` total, and the failed check names in
  `failed`.
- `responsive`: `pass`, `checks` total, `failures` (viewport/page list), and
  `rendererErrors`.

Ignore: absolute paths, timestamps, the recorded `node` version (the second
machine records its own), and the responsive `smallControlCount` (informational
only; controls smaller than 36 px are recorded for review and do not fail a
run).

A second-machine run replicates the baseline when all three harnesses report the
same pass/fail verdict and the same failed names (or none). Any new failed name
is a real finding and should be reported with the copied artifact directory.

## Optional packaged-executable mode

To accept a packaged build instead of the checkout:

```powershell
npm run qa:second-machine -- --out C:\anxos-second-machine\rc-2026-09-25 --label "second-machine-rc" --executable "C:\Program Files\AnxOS Control Center\AnxOS Control Center.exe"
```

`--executable` sets `ANXOS_QA_EXECUTABLE` for `qa:acceptance` and records the
executable's SHA-256 in `summary.json` (`executableSha256`) so the tested binary
identity is provable. `qa:onboarding` and `qa:responsive` always launch the
local checkout and ignore the variable; packaged mode therefore covers the
navigation/launch acceptance suite only.

## Notes and limitations

- Run from a checkout at the exact commit under test; `summary.json` records
  `commit` so the run can be tied to it.
- The wrapper must run with an interactive desktop session, and Electron windows
  appear while the sweep runs (typically a few minutes; each harness has a
  10-minute wrapper timeout).
- If the wrapper itself is killed mid-run, a harness artifact directory may be
  left under `artifacts/` in the checkout; it can be deleted manually, or the
  run repeated with a fresh `--out` directory.