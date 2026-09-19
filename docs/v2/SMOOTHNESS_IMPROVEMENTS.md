# V2 Smoothness Improvement Register

**Purpose.** A numbered, evidence-backed register of improvements that make the app
*feel* smoother. Every entry is either **measured** or **code-path-proven**; nothing
here is a hunch. Entries marked `needs measurement` say so and must not be upgraded
to a claim without one.

**Sources.** Three independent read-only audits, kept as separate id ranges so a
merged count can be audited: `SMOOTH-1xxx` (renderer response path, measured against
`.dev-logs/ipc.log` from a real 2026-09-19 session), `SMOOTH-2xxx` (static
anti-pattern scan of `app.js`/`index.html`/`styles.css`), `SMOOTH-3xxx` (desktop
main process, IPC and Agent data path).

**Overlaps are merged, not counted twice.** Two independent methods finding the same
defect is corroboration; it is not two improvements. Where entries collide, one row
carries both ids.

**Status vocabulary:** `WAVE-1` in implementation · `WAVE-2` queued ·
`NEEDS-MEASUREMENT` blocked on a measurement · `OWNER` needs a product decision ·
`CLEAN` investigated and disproved.

---

## Structural fact that frames most entries

`index.html` is a **single 342 KB document with ~4,777 elements across 19 pages**,
and pages are hidden by CSS class rather than removed (`styles.css:1340`, `:1348`).
So every "off-screen" rebuild below is real work on **live DOM nodes**, not detached
ones. That is why several entries are worse than a call-site count suggests.

---

## Wave 1 — in implementation (high-frequency path hygiene, no freshness loss)

| Id | Improvement | Evidence | Size | Which primitive |
| --- | --- | --- | --- | --- |
| SMOOTH-2003 + SMOOTH-1007 | **Keep one poller per source; remove the four duplicate registrations** (agent control 3 s + 5 s, console 2 s + 3 s, marketplace downloads 1 s + 2 s, instances 5 s + 5 s) | **measured**: `instances:getLogs` shows 261 gaps at 2.0 s **and** 73 at ~1.0 s — the two-schedule signature | small | keep the page-scoped timer; keep `refreshConsoleMetrics()` on the 3 s task |
| SMOOTH-1005 + SMOOTH-2006 | **Coalesce the marketplace scroll persist** instead of a `localStorage` write plus a forced-layout read per scroll event (`app.js:40215-40222`) | code-path-proven; scroll path exercised in the real session | trivial | `debounce` ~200 ms with an explicit flush on page change |
| SMOOTH-2002 | **Stop rebuilding the game-config panel on every keystroke** — it destroys and recreates the focused input, so the caret is lost (`app.js:12506-12675`) | code-path-proven; the cycle is explicit in source | medium | in-place field update |
| SMOOTH-2004 | **Call Monaco `layout()` once at drag end, not per mousemove** (`app.js:3446`, called from `3436` under the unthrottled `window` `mousemove` at `39803`) | code-path-proven | trivial | rAF coalescing + a single call on `mouseup` |
| SMOOTH-2005 | **Gate the `window mousemove` handler on a drag actually being in progress** before any work (`app.js:39803-39806`) | code-path-proven | trivial | one rAF per frame |
| SMOOTH-2011 | **Stop re-querying the document for the active page on every poll tick** (`app.js:4479`, 32 call sites, 15 polling timers) | code-path-proven; cadences measured per source | small | module variable maintained by `showPage`, DOM query as lazy fallback |
| SMOOTH-2014 | **Add a `rafThrottle` primitive** — only trailing-edge `debounce` exists (`app.js:3045`), so scroll/drag get a binary choice between jank and lag | code-path-proven | trivial | new helper beside `debounce` |
| SMOOTH-2013 | **Protect the 14 unthrottled hot-event handlers** (10 neighbours are already protected, which makes this an inconsistency rather than a design choice) | code-path-proven | small | rAF throttle for scroll/drag, `debounce` for input |
| SMOOTH-2015 | **Batch `updateFilesStickyOffsets`** — a layout read then a style write on every resize (`app.js:3326-3333`) | code-path-proven | trivial | resize rAF + skip when unchanged |
| SMOOTH-2017 | **Delegated listener for settings-search results** — recreated buttons and re-attached listeners per keystroke (`app.js:38277-38299`) | code-path-proven; capped at 8 results so impact is small | trivial | one delegated listener |
| SMOOTH-1008 | **Stop reading `textContent` per row for filtering when the query is empty** — `syncConsoleLogSearch` reads it for every row unconditionally, then tests `!query || ...`, so the normal case does the full extraction for a comparison that is always true (`app.js:13151`) | code-path-proven; the other three filters (`filterConsoleRows`, `filterInstanceRows`, the file-row filter) already short-circuit, so this is the odd one out | trivial | hoist the `!query` test ahead of the read |
| SMOOTH-2009 | File-row filtering does the same `textContent` pass per keystroke, on top of four listeners attached per row | code-path-proven; `size-dependent` | medium | delegation + cached haystack — **wave 2** |

## Wave 2 — queued (measured, larger, or freshness-affecting)

| Id | Improvement | Evidence | Size | Note |
| --- | --- | --- | --- | --- |
| SMOOTH-1001 | **Stop rebuilding ~150+ DOM nodes every second on the Dashboard**, including a health-category list mounted on the *hidden* Settings page, when the snapshot is unchanged (`app.js:41537-41539` → `7776-7777` → `35135`) | **measured**: `system:getSnapshot` shows 15 gaps at ~1.0 s | small | change-signature short-circuit; must include every field `renderSnapshot` writes |
| SMOOTH-1002 + SMOOTH-2001 | **Diff the log lists instead of rebuilding ~500 rows every 2 s** (`renderConsoleLogs` `app.js:29863`, `renderInstanceLogs` `14871`) — this also destroys text selection and scroll state mid-gesture | **measured**: `instances:getLogs` 261 gaps at 2.0 s, longest run 30 | medium | **needs a rotation guard** or lines are dropped; not purely behaviour-preserving |
| SMOOTH-1003 | **Diff instance rows instead of rebuilding the table and two hidden pages every 5 s** — each row rebuild creates 9 cells and 5 fresh buttons, and a mid-list click can land on a detached node (`app.js:14298-14800`) | code-path-proven; sibling 5 s cadence measured | medium | signature derived from the same object the row renderer consumes |
| SMOOTH-1006 | **Stop fetching 5 IPC payloads and rebuilding 4 off-screen lists every 5 s on the Docker page** — four sequential awaited resource fetches with **no in-flight guard** (cleared at `app.js:28150` before the render) | **measured**: all five channels show 34 consecutive gaps at exactly 5.0 s | small | gate resources on their tab being visible; prefer a slower interval over on-demand-only |
| SMOOTH-1012 | **Render instance summary/details once per cycle, not once per instance** — `renderInstanceMetricsUpdate` runs before the request *and* in its `finally`, so N instances cause ~2N summary, row and details renders (`app.js:20559`, `20577`) | code-path-proven | small | preserve the optimistic pending row state with one pre-pass |
| SMOOTH-1013 | **Do not serialise four independent bootstrap round trips** — account, security, nodes and settings are awaited in sequence, so time-to-content is the sum rather than the max (`app.js:32563-32574`) | code-path-proven | small | **medium risk**: arrival order currently carries state precedence; verify each renderer tolerates intervening states |
| SMOOTH-1004 | **Stop `JSON.stringify`-ing up to 400 diagnostic entries per keystroke** (`app.js:5951`, on an undebounced `input` at `41336`) | code-path-proven | small | precompute the searchable string on assignment |
| SMOOTH-2008 | **File rows attach four listeners each and the table is rebuilt wholesale** — `renderFileRows` attaches `click`/`dblclick`/`contextmenu`/`keydown` per row (`app.js:22299-22333`) and `filterFileRows` then reads `row.textContent` per row; directory listings are the one genuinely large list in the app | code-path-proven; `size-dependent` (a 20-entry directory is a non-issue, a 5,000-entry one is not) | medium | one delegated listener on the container + a cached haystack |
| SMOOTH-1009 | **Coalesce install-progress log rebuilds** through the 180 ms timer the same handler already uses for its sibling render (`app.js:18185` vs `18206-18220`) | code-path-proven | trivial | install logs appear ≤180 ms later |
| SMOOTH-1010 | **Memoize the settings-search haystacks** — every keystroke extracts and lowercases the text of every settings section in a 342 KB document to show at most 8 results (`app.js:38262`) | code-path-proven | trivial | memoize with an explicit invalidation point |
| SMOOTH-1011 + SMOOTH-2016 | **Coalesce the file-editor scroll read/write into one rAF** (`app.js:39979`, `21705-21712`) | code-path-proven; line counts capped at 1 MiB | trivial | ≤1 frame of gutter lag |
| SMOOTH-2012 | **Revisit two 1 Hz pollers** (dashboard snapshot, marketplace downloads) | code-path-proven; cadence measured | trivial | **OWNER**: 1 Hz → 2–3 s trades freshness for smoothness |

## Owner decisions

| Id | Decision | Why it is not mine |
| --- | --- | --- |
| SMOOTH-1014 | The startup splash holds a **fixed 2 s floor** (`STARTUP_MINIMUM_MS = 2000`, `app.js:1213`, enforced at `4210` and `4265-4268`) even when every service is ready in ~600 ms. Short-circuiting it when `systemReady` arrives early is trivial — but it changes the designed startup branding and audio choreography | deliberate design, not a slow path |
| SMOOTH-2012 | Poll cadence: 1 Hz → 2–3 s on the dashboard snapshot and download poll | a freshness trade-off, not a mechanical improvement |

---

## Investigated and DISPROVED — do not re-investigate

Both lanes independently disproved these. Recording them is how the register stays
trustworthy instead of becoming a wishlist.

| Suspicion | Verdict and evidence |
| --- | --- |
| Listener accumulation / re-registration leak | **Not a defect.** All 620 module-level element constants were checked against every `addEventListener` receiver; registrations inside renders target freshly created nodes, and all 7 modal `keydown` listeners are paired with `removeEventListener` on close. The 475/8 imbalance is listener-per-created-element, not accumulation. |
| Unthrottled `mousemove` is inherently costly | **Idle cost is nil** — both handlers return immediately unless a drag is in progress. The defect is only the drag-time work (SMOOTH-2004/2005). |
| Global `scroll` capture handler | **Minor, not a hot path** — early-returns unless the node picker is open. |
| Unbounded lists | **None found.** 20 named bound constants and 63 `slice(-N)` caps; the real defect is rebuild-every-poll, not unboundedness. |
| Full marketplace download list rebuild | **Not a full rebuild** — keyed by `data-download-id` and reused; only item content is replaced. |
| Polling lifecycle leaks | **None.** Every page-scoped poller starts and stops in `showPage`; most check `document.hidden`; all have in-flight guards. The 8 always-on refresh tasks cost a page-name comparison per tick. |
| Backup polling from the dashboard | **Not per-poll** — time-gated to 60 s with a node-id check and a re-entrancy guard. |
| Runaway backup operations (624 creates logged) | **Test-automation traffic**, not runtime polling; the only renderer call site is user-initiated. |
| `console.info` as a disk hot path | **Not a write path** — `renderer.log` contains no `console-info` operation. |
| Forced synchronous layout in render loops | **Zero.** 38 occurrences across 25 lines, none inside a render loop (the one syntactic hit is inside a per-row closure). |
| HTML-string injection | **Essentially eliminated** — exactly one `innerHTML` (sanitized release-note markdown), zero `outerHTML`/`insertAdjacentHTML`/`document.write`, and `index.html` contains zero inline handlers and zero inline `<script>` blocks. |
| Empty-query DOM text extraction | **Correct in 3 of 4 filters** — `filterConsoleRows`, `filterInstanceRows` and the file-row filter all short-circuit; only `syncConsoleLogText` (see SMOOTH-1008) does not. |

---

## `SMOOTH-3xxx` — data path (MEASURED against a real 82-minute session)

Instrument: `main.js:110-129` wraps **every** `ipcMain.handle` and logs `IPC request
completed {durationMs}`, so `.dev-logs/ipc.log` is a real per-channel timing record.
Session: 2026-09-19 09:08:32 → 10:30:31. **562 IPC requests, 187,489 ms cumulative.**

| Fact | Value |
| --- | --- |
| Worst channel by total time | `docker:getSnapshot` — 39 calls, **85,464 ms = 46 % of all IPC time** |
| Worst duty cycle measured | docker poll: **33 consecutive 5 s cycles, ~45 % of a 160 s window inside the snapshot path** |
| Slowest single call | `marketplace:searchProviderPacks` — **9,588 ms** |
| Most-called channel | `instances:getLogs` — **8 calls** in this session, 65.1 ms avg, 117 ms max |
| Main-process work before window construction | **109 ms** (app-ready → create-window) |

| Id | Improvement | Evidence | Size | Wave |
| --- | --- | --- | --- | --- |
| SMOOTH-3003 | **Tail-read instance logs instead of reading the whole file every 2 s.** `readRecentLines` does `readFile` → `split` → `slice(-limit)`, so the **entire file** is read and split to return 200 lines | **measured**: session `instances:getLogs` was **8 calls, 65.1 ms avg, 117 ms max**; cost grows with log size while payload stays fixed — this is the "app feels heavier after a while" symptom. **Corrected by the independent audit:** an earlier draft quoted *831 calls, 63 ms avg, 229 ms max* here, which is the **whole-file aggregate for 2026-09-05→19**, not this session. Post-fix tail read independently re-measured (median of 7, warmed cache): whole-file → tail read is **282.1 ms → 1.06 ms** on a 92.5 MB log. Semantic parity was also independently checked: 20 structured cases + 400 randomised fuzz cases, new vs pre-fix, **0 mismatches** | small–medium | 2 |
| SMOOTH-3001 | **Fetch the four docker resource lists in parallel** — today `await listImages` → `listVolumes` → `listNetworks` → `listComposeProjects`, ~281 ms serial vs ~116 ms if concurrent, and the whole batch is fired unconditionally from the snapshot render every 5 s | **measured**: one cycle 15:30:52.167 → :54.656, 33 cycles in 160 s, ~45 % duty | trivial (parallel) | 2 |
| SMOOTH-3002 | **Stop spawning 9–13 docker CLI processes per poll cycle.** `probeDocker` runs `--version`, `info`, `compose version` sequentially, then six more (incl. `docker stats --no-stream`) **per 5 s ≈ 156 spawns/min** | **measured**: snapshot wall 2,156 ms median; per-command split **needs-measurement** | medium | 2 |
| SMOOTH-3006 | **Stop writing the 38 KB runtime-state synchronously on periodic render paths.** `diagnostics:capture` runs `fs.writeFileSync` of a **38,655-byte** state plus a `readdirSync`+`statSync` sweep of ~35 log files, from every 5 s public-access and docker render — and it blocks the main-process event loop, delaying *every* concurrent IPC reply | **measured**: 107 calls, avg 11 ms, max 27 ms | small | 2 |
| SMOOTH-3011 | **Bound the marketplace provider enrichment fan-out.** `enrichModrinthSearchResults` does `Promise.all` over **every** search result, one provider call each | **measured**: 9,588 ms and 7,561 ms — the two slowest operations in the session | medium | 2 |
| SMOOTH-3005 | **Don't make instance start/stop wait for a full re-list before reporting success** — `instances.start` (measured 1,501 ms) then `instances:list` (267 ms) before the row settles | **measured** for both components; ordering code-path-proven | small | 2 (needs `app.js`) |
| SMOOTH-3004 | **Don't gate the dashboard on a 1.5–3.8 s public-access snapshot**, and issue its five calls together instead of in two sequential phases; there is no renderer-side timeout, so a hung agent holds it for 12 s | **measured**: avg 1,543 ms, max 3,761 ms over 10 calls | small | 2 (needs `app.js`) |
| SMOOTH-3007 | **One round trip per agent-control poll, not two sequential** — `agentControl:list` (avg 1,765 ms) then `diagnostics:read`, on a 3 s interval ⇒ ~60 % duty | **measured** cadence | small | 2 (needs `app.js`) |
| SMOOTH-3010 | **Stop the alert scheduler re-fetching the instance list the UI already has** | **measured**: `implicit-node-fallback-selected` exactly **3×/min at :31** for the whole session — the scheduler's calls, not renderer calls. **Coverage hole found by the independent audit, then closed:** the guard was load-bearing but had *no* test — setting `INSTANCE_SNAPSHOT_MAX_AGE_MS` to `-1` left all four candidate suites green. `scripts/instance-snapshot-reuse-smoke.js` now fails naming the reuse invariant (10 checks, mutation-proven, `instance-snapshot-reuse:smoke`). Residual gap: the suite covers the module's functions, **not** the `main.js` call-site wiring | medium | 2 |
| SMOOTH-3008 | **Short timeout plus one retry beats a 30 s hold on interactive reads.** `REQUEST_TIMEOUT_MS = 30000` is the default for nearly every read, and in-flight guards then suppress retries — so a slow agent becomes a 30 s stuck spinner | code-path-proven; no timeout event observed in this session | small | 2 |
| SMOOTH-3009 | **Stop serialising the Console open behind the instance list** — `showPage("console")` waits on `refreshInstances()` (267 ms) only to learn the active instance id, which is often already known | code-path-proven; component measured | small | 2 (needs `app.js`) |
| SMOOTH-3013 | **Coalesce paired diagnostics captures and tail-read on the error path.** Captures fired **in pairs 10 ms apart** (14 calls in 3 s), and every error entry does a full `readFileSync` + split of `renderer.log` (400 KB) and `live.log` (1.0 MB) | **measured** pairing; the full-file read is code-path-proven with size evidence | small | 2 |
| SMOOTH-3012 | **Resolve the agent config once per request, not twice with synchronous reads** (`requestJson` and `buildAgentUrl` each call `getAgentConfig`) — only affects the local/application-host backend, which this session did not exercise | code-path-proven; effect **needs-measurement** | trivial | 2 |

### What the data path disproved

| Suspicion | Verdict and evidence |
| --- | --- |
| Main process blocking the window paint | **Disproved** — only **109 ms** of work sits between app-ready and window construction, and `createWindow()` is called before any `await`. The remaining ~1.07 s to first paint is renderer resource load (1.8 MB `app.js`, 352 KB `styles.css`, 342 KB `index.html`). |
| Backups re-fetched on every dashboard render | **Disproved** — a 60 s TTL plus an in-flight guard; measured `backups:list` gaps are 0.5, 18.9, 65.0, 64.9, 4.8, 162 s, nowhere near 1/s. |
| The dashboard polls data the UI discards | **Disproved** — the public-access and AMP/playit snapshots feed `getSetupHealthState` and `getTitlebarConnectionState`. |
| Renderer re-resolving the selected node per request | **Disproved** — `getNodeScopedPayload` sends `nodeId`, so resolution returns early; the 3/min fallbacks are the alert scheduler (SMOOTH-3010). |
| The Docker snapshot payload being large | **Disproved** — it carries **3–5 containers**. The docker path is **round-trip- and process-spawn-bound, not byte-bound**. |
| Nodes-page 5 s poll being expensive | **Disproved** — `nodes:restore` is 22–23 ms and `refreshNodeHealth` is pure local state with no IPC. |
| A runaway recursive refresh loop | **Not found** — both candidate paths have in-flight guards. |

### The measurement gap, and the cheapest fix for it

**Payload-size instrumentation now exists — opt-in, and honest about what it does NOT measure.** `ipc.log` records durations only by default, never bytes. `main.js` now additionally records `context.payloadBytes`, **gated behind `ANXOS_IPC_BYTE_METRICS=1`** so the default path stays byte-identical to before. When enabled it measures only payloads whose size is cheap to read — strings via `Buffer.byteLength`, buffers and typed arrays via `.byteLength` — and **deliberately skips objects and arrays rather than re-serialising them**, because `JSON.stringify` on a ~10 MB payload measured **51.7 ms**, which is more than many of the calls it would be measuring.

**Two consequences to keep straight, because misreading them is easy:**
1. An **absent** `payloadBytes` means *not measured*, never *zero bytes*.
2. The **heaviest channels** — instance snapshots, docker snapshots — are exactly the object-payload channels that report **nothing**. This instrument does not cover the payloads we most want to size; it covers the cheap-to-read ones.

Measured cost of enabling it on a 10 MiB string payload: **3.95 ms/call**; the skip path on a ~10 MB object: **~0.0002 ms/call**. Locked by `scripts/ipc-payload-instrument-smoke.js` (`ipc-payload-instrument:smoke`), which extracts the shipped function text from `main.js` rather than testing a copy. The end-to-end path — a real channel emitting a real `payloadBytes` line — is **UNVERIFIED**; only the helper contract and the source wiring are proven.

**One thing this audit could not measure, and it corroborates a fix already shipped:** `nodes:select` appears **0 times** in the entire `ipc.log`, even though the session contains three node-switch attempts — because the renderer's `resetNodeScopedRendererState` threw (the `restartScheduleList` `ReferenceError`) *before* the `await nodes.select(...)` line, so the switch aborted before issuing any IPC. The switch's cost is therefore inferred from code structure, not measured. That is independent confirmation of the F2 root cause from a different instrument.

### Independent audit of the wave-2 claims — what it found

A separate read-only auditor re-tested three wave-2 claims against the code and against
generated artifacts, not against this register's narrative. It changed three statements
in this document, and recording that is the entire point of running it:

| Claim | Verdict |
| --- | --- |
| SMOOTH-3003 tail read | **Code and semantics VERIFIED** — 20 structured cases + 400 randomised fuzz cases against the pre-fix implementation, **0 mismatches**; the bounded read was confirmed by instrumenting `fs` (a 5,242,848-byte file read **65,537 bytes, zero `readFile` calls**). The cited point *timings* were **not reproduced** (282.1 ms vs the cited 199.6 ms) — the direction and order of magnitude were, not the figures. |
| SMOOTH-3010 scheduler reuse | **Fix VERIFIED as implemented and load-bearing; the implied test coverage REFUTED.** Setting the window to `-1` left four candidate suites green, and `grep` found **zero** suites referencing the guard — the invariant was uncovered. **Closed since** (see the row above); the call-site wiring in `main.js` remains uncovered. |
| D-9 Palworld dedup | **Dedup VERIFIED; the stated harm UNSUPPORTED.** The sole production consumer (`agent/src/services/backupService.js:543`) already dedups at line 553, before any per-candidate work, and the divergence table itself says *"Harmless for a backup that de-duplicates paths."* The fix is correct and cheap; only the impact wording was overstated, and it has been corrected. |

**Three evidence defects this register carried, all now corrected:** the SMOOTH-3003 row
and the "most-called channel" fact quoted a **whole-file aggregate** as though it were
this session; the SMOOTH-3010 row implied a coverage story that mutation testing
disproved; and the measurement-gap section still described the payload-byte instrument
as a *proposal* after it had already landed.

**One claim is not evidenced either way:** commit `3b3dcbc` cites "rc:validate 278/278
PASS" and a 500-case fuzz run, but no artifact in the tree records those specific runs.
The substantive parity result was independently reproduced, so the claim holds in
effect — but the cited run itself cannot be checked from the repository.

### How to read the counts

**Distinct improvements in this register: 37** (44 catalog entries from three
independent audits, minus 7 collisions where two or three methods found the same
defect — e.g. the docker resource fetch/rebuild appears as `SMOOTH-1006` and
`SMOOTH-3001`).
**Measured: 14.** Code-path-proven: 21. Owner decisions: 2. Disproved suspicions: 19.

The measured count is what it is because two of the three audits had a real
instrument: `.dev-logs/ipc.log` records per-channel `durationMs` for every
`ipcMain.handle` (wrapped at `main.js:110-129`), and `.dev-logs/*.log` carries
cadence evidence. Nothing in this register was profiled with a CPU profiler — the
measurements are **durations and frequencies**, not frame timings, so the
confirming step for every wave remains a launch of the real app.

The count moved from 24 to 25 to 37 during the campaign: 25 when an earlier draft
was found to have wrongly merged two distinct defects, and 37 when the data-path
audit landed. Both changes are recorded because the register's count is only worth
anything if its arithmetic is auditable.

`SMOOTH-3xxx` entries come from the data-path audit and are tabulated above; the two
implementation waves that acted on this register are `8afcf35` (renderer) and `3b3dcbc`
(data path).

A number in this register is a claim only when the Evidence column says
**measured**. Everything else is a proven code path plus a judgement about felt
impact, and the judgement is not evidence — the confirming step for every
implementation wave is a launch of the real app.