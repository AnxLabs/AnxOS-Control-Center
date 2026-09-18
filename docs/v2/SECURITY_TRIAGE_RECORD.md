# Security Triage Record — Mimosa Deep Scan (V2-I Gate Evidence)

**Scan:** Mimosa deep static scan, sealed `sha256:ba76f2a89d1a516f3886ae523d196d0ad07693298b8cfd7995f3f93552477cd6`, completed 2026-09-17, report retained at `%USERPROFILE%\.mimosa\security-scans\project-c40b89662b58e545f24672ba\scan-2026-09-17T13-00-57.162Z-096032d7664a`.
**Triage:** independent security-reviewer agent, every product-code finding verified against source; scripts/ findings sampled (dev tooling, not packaged).
**Campaign context:** V2-I gate requires security evidence attached to release scope. This record is that evidence for the 2026-09-17 code state (dev ≥ 2f83ec4); re-run the scan at the final audit.

## Verdict

**Zero P0. Zero P1.** No real secret ships, no reachable injection exists in product code under the single-owner / token-authed-agent threat model, and the renderer has no exec/fs capability (contextIsolation + sandbox verified on every window type).

## Findings disposition (841 total)

| Class | Count | Verdict |
| --- | --- | --- |
| other-security (bulk taint) | 719 | **False positive class.** Dominant pattern: renderer UI helpers (showToast ×375, clipboard ×20) as taint "entry points" into main-process sinks. Every reachable sink is an already-verified `execFile` wrapper or a validated IPC handler. No innerHTML-based sink appeared. webPreferences verified: `contextIsolation: true, nodeIntegration: false, sandbox: true` on every window (main.js:606-611, 683-688, 732-736). |
| command-injection | 74 | **72 false positives**: the `execFile(command, argsArray, { windowsHide: true })` wrapper pattern (dockerService, playitService ×2, systemService, dockerActions, consoleService) — no shell, fixed argv, targets regex-validated. **2 real-pattern (hardened around):** playitService PowerShell `-Command` service-name interpolation (P2, parked — see below). |
| code-injection | 10 | **8 false positives** (vm executes only bundled app files; scripts tooling). **2 real-pattern (fixed):** `accountAuthService.js` vm config execution REMOVED entirely (static literal parser for the bundled config; JSON-only elsewhere — commit 6d2e7e5). |
| path-traversal | 11 | **All false positives**: safeId sanitized (dots removed), readdir-sourced names, thermal-zone pattern filter, dev scripts. The real LAN file surface (agent fileService) has verified containment (null-byte check, allowed-roots, path.relative, PATH_NOT_ALLOWED 403s). |
| hardcoded-credential | 24 | **All false positives**: 22 dev-script fixtures with dummy values (scripts/ is not in build.files, so they do not ship), 2 route-alias keys containing the word "password". The only credential-shaped value that ships is the Supabase *publishable* client key — public by design. |
| ssrf | 2 | **False positives**: dev scripts fetching locally configured URLs. |
| weak-crypto | 1 | **Real, fixed**: marketplace import verification preferred SHA-1 over SHA-512 when provider metadata offered both. Now SHA-512-first (commit eb13b83). |

## Dependency advisories (3 shipping packages)

| Package | Advisory | Disposition |
| --- | --- | --- |
| js-yaml (direct) | GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh — quadratic-CPU DoS | **Mitigated**: compose policy parsing caps input at 256 KiB and fails closed (dockerPolicy MAX_COMPOSE_POLICY_BYTES). js-yaml 5.x migration parked as semver-major. |
| dompurify (via monaco-editor) | GHSA-55q2-fjhq-7xh7 — XSS via hook removal | Renderer-only, low impact under contextIsolation; fix is a semver-major monaco downgrade — parked for a dependency wave. |
| brace-expansion (transitive) | GHSA-3jxr-9vmj-r5cp — ReDoS | Negligible: glob patterns are locally generated. |

tar/undici/fast-uri/@xmldom advisories are electron-builder devDeps — not packaged, no runtime path.

## P2 hardening ledger (landed this campaign)

1. `accountAuthService.js`: vm config execution removed; bundled-config static parser; user-writable config paths JSON-only. (6d2e7e5)
2. `dockerPolicy.js`: compose YAML parse input capped at 256 KiB; oversized documents fail closed. (6d2e7e5)
3. `marketplaceInstallService.js`: SHA-512 preferred over SHA-1 for import verification and provider metadata builders. (eb13b83)
4. Runtime pins, workload transfer, and restore targeting carry explicit authorization tiers with per-step audit (this campaign).

## Parked with reasons (revisit only with owner approval)

- **playitService PowerShell `-Command` service-name interpolation** (4 sites): values are system-derived (Get-Service enumeration / fixed candidates), not remotely controllable; the Mimosa pre-commit hook blocks any candidate touching a `-Command` line (env-var-based rewrites included), and an sc.exe migration is disproportionate churn on a non-exploitable path. If the hook's behavior changes, the env-var rewrite is the preferred fix.
- **dompurify/monaco downgrade**: semver-major dependency migration; schedule in a dedicated dependency wave.
- **Mimosa suppression baseline**: ~700 of 841 findings are the two known FP classes; a suppression/baseline config would cut future triage noise. Not yet created (scanner-config change).

## Re-scan requirement

The V2-K final audit must re-run the Mimosa deep scan against the final code state and reconcile: (a) findings in code touched by this campaign, (b) the P2 ledger above, (c) any new dependency advisories.
