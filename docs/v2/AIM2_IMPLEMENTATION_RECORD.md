# AIM-2 Implementation Record — functional contracts & dual health

| Field | Value |
| --- | --- |
| Milestone | AIM-2 (plan `V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md` §4.2, §AIM-2) |
| Authorized by | AIM-0 sign-off, signed by the Owner 2026-10-30 (`AIM0_SIGNOFF.md` §5): hermetic implementation only; every live run deferred |
| Status | **Increments 1–3 implemented (hermetic), Sona supported.** Live read-only runs deferred and off by default |

## Scope update (Owner, 2026-10-30)

- **Discontinued:** Open WebUI, Open Terminal and ANX-CorTex.
  - Their AIM-2 adapters, probes and fixtures were removed, along with the vocabulary only they used: `WORKSPACE_OBJECTS_MISSING`, `SESSION_FAILED`, `NO_CREDENTIAL`, and the stateful-probe opt-in.
  - **Nothing outside AnxOS Control Center was touched:** retired repositories, files, Docker volumes and archived research are left as they are.
  - The frozen plan (rev 3.1) and the signed AIM-0 record are historical and unchanged.
- **Sona is the officially supported AnxLabs AI application.** It is integrated into the existing AI service diagnostics (the Infrastructure Inventory's Function column), not a separate page.
- **General-purpose support is kept** for Qdrant, Ollama, Infinity and Tika.
- **Live runs:** the AIM-0 §5 live-run condition named an ANX-CorTex staging scope, which is now discontinued. Live runs stay **deferred** until the Owner approves a specific scope (for example the Sona API) in `functional-probe-scopes.json`. This change does not widen what AIM-0 authorized.

## Sona (verified architecture)

Verified read-only on the Owner's Debian host (Anxlab) against Sona 8.5.0, from its deploy files, its backend code and one call to its public health route:

| Part | Detail | How AnxOS uses it |
| --- | --- | --- |
| API | Container `sona-api`, image `anxlabs/sona-api`, Compose project `sona`, service `api`. Host network; uvicorn binds **127.0.0.1:8790** only | Recognized as **Sona**, by image **and** Compose service `api` (or, without verified labels, the container name) |
| Health | `GET /api/health`, public, returns `{ status: "ok", app: "sona", version }`. Sona's own container healthcheck uses it | Liveness and the only functional probe. Checks that the service answering is Sona (`IDENTITY_CHANGED` otherwise) and its version when the Owner records one (`degraded:VERSION_CHANGED`) |
| Sandbox / plugin host | `sona-sandbox`, `sona-plugins`: the API image, Unix sockets, no network | Dependencies (not mistaken for the API) |
| Claude Code worker | `sona-claude-code` | Dependency |
| Browser | `sona-browser`, Playwright on 127.0.0.1:18891 | Dependency |
| Web search | `sona-searxng`, SearXNG on 127.0.0.1:18890 | Dependency |
| Cloudflare tunnel | `sona-tunnel`, cloudflared, carrying traffic from the Cloudflare-hosted frontend to the API | Dependency. The public frontend itself is never probed |

- **Dependency health is read-only:** it comes from the inventory AnxOS already collects, so it needs no probe and no approval.
  - A stopped or missing stack service fails Sona (`DEPENDENCY_DOWN` / `DANGLING_DEPENDENCY`) even while live probes are off.
  - A stale inventory entry stays unknown, never "missing".
  - Healthy dependencies alone never make Sona "Works"; that still needs an approved health probe.
- **Never used:** Sona's environment files, Supabase keys, session cookies, public URL and authenticated routes. Probes send no credentials, and probe targets come only from the Owner's scope file.

## Increment 1 — hermetic core

- `src/shared/functionalProbeModel.js` — the closed vocabulary: `pass`, `degraded:<code>`, `fail:<code>`, `not-evaluated:<reason>`.
  - `combineHealthAndFunctional()` reports liveness and function separately.
  - `not-evaluated` maps to healthModel `unknown`, so an unchecked service never renders green.
- `src/shared/functionalProbeAdapters.js` — declarative, credential-free adapters for Sona, Qdrant, Ollama, Infinity and Tika.
  - C4 config-reference check (`DANGLING_DEPENDENCY`).
  - C6 declared-dependency check (`not-in-use` is neutral).
  - Sona stack recognition.
- `planProbeRun()` — the AIM-0 gate:
  - `LIVE_RUNS_DEFERRED` unless the Owner approved the exact scope;
  - production is on demand only;
  - only registered adapters with verified probe paths pass.

## Increment 2 — probe executor, vocabulary and inventory wiring

- `src/services/functionalProbeService.js`:
  - **Recognition:** services in the AIM-1 inventory, by image repository (registry and tag ignored).
  - **`describe()`:** returns Health vs Functional, including Sona's stack.
  - **`run()`:** an on-demand check.
- **Every run calls `planProbeRun()` first.** Without an approved scope it makes **zero requests**.
- **Scope approvals:** the Owner-maintained `functional-probe-scopes.json` (schema 1). There is no in-app writer. A missing, unreadable or unknown-schema file approves nothing.
- **Classification:** a service is non-production only when **both** the inventory (Owner-confirmed) and the scope entry say so.
- **Requests are bounded:** http(s) only, the scope's `baseUrl` only, no redirects followed, a timeout, and a size cap. An oversized answer counts as no answer.
- **Vocabulary:** `functionalProbes` is in the closed `SERVICE_CAPABILITY_IDS`. No managed-service family claims it.
- **IPC:**
  - `infrastructureInventory:functional`: read tier, never probes.
  - `infrastructureInventory:checkFunction`: Owner only (`settings:write`), audited.
  - Both are in the permission matrix.

## Increment 3 — Health vs Functional UI

- The Infrastructure Inventory has a **Function** column next to Health, with a **Check** button per recognized service.
- **Pill states:**

  | Pill | Colour | When |
  | --- | --- | --- |
  | Works | green | only when checked and green |
  | Works | warning | the check passed but the host is not healthy |
  | Degraded: CODE | warning | |
  | Failing: CODE | critical | |
  | Not checked | neutral | the reason shows on hover |

- **Sona's Function cell** adds a stack summary ("stack 6/6 healthy" or the first problem), with each dependency listed on hover.
- **Overview tiles:** "Functional checks failing" and "Services not checked".

## Acceptance evidence

- **`scripts/functional-contracts-smoke.js` (10 checks):**
  - **Sona contract:** pass, `IDENTITY_CHANGED`, `VERSION_CHANGED` and `PROBE_ERROR`; only `GET /api/health` is declared.
  - **Recognition:** the API, but not its sandbox or plugin host (same image); retired images are not recognized.
  - **Sona stack:** a stopped or missing service fails Sona.
  - **Incidents:** C3 (`AUTH_INVALID` / `AUTH_REQUIRED` / `COLLECTION_MISSING` / `NOT_WIRED` / `EMPTY` / drift), C4 and C6.
  - Also: no fake green, the general-purpose adapters, the gate, and contract shape (credential-free, no stateful probes).
- **`scripts/functional-probe-service-smoke.js` (9 checks), run against real local HTTP fakes:**
  - **Without approval:** zero requests.
  - **Sona stack:** a stopped dependency fails Sona with zero requests, and a stale stack stays unknown.
  - **Approved Sona check:** reads only `GET /api/health` and reports drift, a wrong app and a down dependency.
  - **Approved Qdrant check:** passes, or reports `NOT_WIRED`.
  - **Refusals:** scheduled production runs and bad scope files are refused; redirects are not followed, the size cap is enforced, and only http(s) is allowed.
  - **UI and wiring:** the real `app.js` Function pill and stack summary, the IPC wiring, and the vocabulary.
- **`connectivity-no-fake-green-smoke.js`:** includes the functional rule.
- **Real-stack check (read-only, on Anxlab):** fed the live `sona-*` containers' names, images, Compose labels and states through recognition. Only `sona-api` is recognized as Sona, and all six stack services are found healthy.
- **`scripts/infra-inventory-ui-qa.js`:** the real Electron app plus a real Agent passes with the new column.

## Not done (deferred, with reason)

| Item | Why |
| --- | --- |
| Live read-only Sona check | Off by default. Needs the Owner to approve the Sona API's scope (and a `baseUrl` reachable from this PC, for example through the node's SSH tunnel) in `functional-probe-scopes.json` |
| In-app scope approval and classification writer | Deliberately not built: approvals are rare Owner decisions (AIM-0); revisit with AIM-3 |
| Probing Sona's public Cloudflare frontend or authenticated routes | Out of scope: the frontend's health is represented by the tunnel dependency; authenticated routes would need credentials |
