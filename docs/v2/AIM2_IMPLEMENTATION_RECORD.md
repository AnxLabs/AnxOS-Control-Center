# AIM-2 Implementation Record — functional contracts & dual health

| Field | Value |
| --- | --- |
| Milestone | AIM-2 (plan `V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md` §4.2, §AIM-2) |
| Authorized by | AIM-0 sign-off, signed by the Owner 2026-10-30 (`AIM0_SIGNOFF.md` §5): hermetic implementation only; every live run deferred |
| Status | **Increment 1 of 3 — hermetic core.** No live probes, no UI yet |

## Increment 1 — hermetic core (this change)

- `src/shared/functionalProbeModel.js` — the closed result vocabulary
  (`pass`, `degraded:<code>`, `fail:<code>`, `not-evaluated:<reason>`).
  - **Health + Functional:** `combineHealthAndFunctional()` reports liveness and function separately, with an overall state.
  - **Mapping:** `not-evaluated` maps to healthModel's `unknown`, and the overall state comes from healthModel's `combineStates`. An unchecked service therefore can never render green.
- `src/shared/functionalProbeAdapters.js` — declarative adapters for Open WebUI, Qdrant, Ollama, Infinity, Tika and Open Terminal.
  - **Each adapter declares:** its liveness request, bounded read-only probe requests, and a pure `evaluate()` over `{ status, body }` responses.
  - **Open Terminal** is the only stateful adapter (session open/close).
  - `evaluateConfigReferences()` is the C4 check (`DANGLING_DEPENDENCY`).
  - `evaluateDeclaredDependencies()` is the C6 check (`not-in-use` renders neutral).
- `planProbeRun()` — the authorization gate a future executor must call first. It encodes AIM-0:
  - `LIVE_RUNS_DEFERRED` unless the Owner approved the exact scope;
  - production scopes are on demand only (no scheduled opt-ins granted);
  - stateful probes need a per-scope opt-in;
  - adapters whose probe paths are unverified are refused.

### Acceptance evidence (hermetic)

`scripts/functional-contracts-smoke.js` (8 checks). Each incident is replayed with liveness **healthy**:

| Incident | Fixture | Result |
| --- | --- | --- |
| C1 | Open WebUI with a new owner and missing objects | `fail:IDENTITY_CHANGED` and `WORKSPACE_OBJECTS_MISSING`; overall failed |
| C3 | Qdrant | `AUTH_INVALID`, `AUTH_REQUIRED`, `COLLECTION_MISSING`, `NOT_WIRED` and `EMPTY` each distinguished; `degraded:POINTS_BELOW_BASELINE` |
| C4 | A tool-server reference to a removed stack | `fail:DANGLING_DEPENDENCY` |
| C6 | Unused failing dependencies | `not-in-use`, and the service stays green; a used dependency that is down fails |

- **No fake green:** `not-evaluated`, missing and malformed functional states never render green. This is also pinned in `connectivity-no-fake-green-smoke.js`.

## Not done (deferred, with reason)

| Item | Why |
| --- | --- |
| Executor performing real HTTP probes | Increment 2; still blocked from live targets by `planProbeRun` |
| `functionalProbes` in `SERVICE_CAPABILITY_IDS` and the inventory wiring | Increment 2 |
| Health vs Functional UI | Increment 3 |
| Live read-only run against ANX-CorTex | AIM-0 §5: needs a separate Owner approval naming one identity-verified, confirmed non-production scope, plus a user-created read-only account. Recorded as **deferred**; never run against production |
| Open WebUI / Open Terminal probe paths | `pathsVerified: false`; must be pinned against the deployed versions during that approved live run |
