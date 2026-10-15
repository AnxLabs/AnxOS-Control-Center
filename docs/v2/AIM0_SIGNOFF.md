# AIM-0 Sign-off Record (prepared, awaiting Owner signature)

| Field | Value |
| --- | --- |
| Prepared | 2026-10-14 |
| Plan | `V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md` revision 3.1 (frozen) + `V2_AUTONOMOUS_INFRASTRUCTURE_PLAN_R3_2_ADDENDUM.md` (in PR #4) |
| Status | **PREPARED — NOT SIGNED.** Nothing here takes effect until the Owner signs §5. |
| Policy | Conservative defaults as directed by the Owner on 2026-10-14: unverified contracts are marked unverified; the AnxGraph writer stays blocked until AIM-7; every unconfirmed staging candidate stays `production`. |

Status words: **VERIFIED** (checked in source or by an executed test), **RECORDED** (pinned
from a read-only source snapshot, not exercised), **UNVERIFIED** (not checked), **NOT
AVAILABLE** (checked; the capability does not exist today).

## 1. Contract documents (plan AIM-0 items 1–6)

| # | Contract | Status | Evidence | Gates | Default if signed |
| --- | --- | --- | --- | --- | --- |
| 1 | Agent Office: `/api/mcp`, `/api/snapshot`, **caller authentication** | **UNVERIFIED** | Schemas reported from an earlier live probe; authentication model never checked | AIM-6 only | AIM-6 adapter stays **disabled** until authentication is verified both ways |
| 2 | AnxGraph read actor (precedent reads) | **PARTIALLY VERIFIED** | Bounded consumer delivery API and capability-scoped actors verified in the ANX-CorTex M5 handoff (403s for wrong user/project). No CC-specific consumer exists or is granted | AIM-7 only | Not requested until AIM-7; the M5 consumer is never reused |
| 3 | AnxGraph writer actor (append-only decision records) | **UNVERIFIED** | No append-only, project-scoped writer actor is known to exist | AIM-7 | **AIM-7 BLOCKED** until AnxGraph supports it and the Owner grants it (plan §4.3) |
| 4 | AnxLabs Sentinel v0.1 rule set | **RECORDED** | Read-only clone at `fa896d5`: SAFE/REVIEW/BLOCK model, sensitive-path rules | AIM-4 (pattern source) | Accepted as a **pattern source only**; no runtime coupling |
| 5 | AnxLabs HQ ports (`ports.ts`, `execution@1`, `TaskSyncPort`) | **RECORDED** | Read-only clone at `2d3c9e4`; no server-side authenticated intake exists | AIM-6b only | Recorded; re-checked when AIM-6b is scheduled |
| 6 | Target identity (§5.7) | **VERIFIED, with one gap** | See §2 | AIM-1 (done), AIM-4/5 | Gap stays a hard refusal (below) |

## 2. Target identity components (contract 6)

| Component | Status | Evidence |
| --- | --- | --- |
| Host `deviceId` + `agentInstallationId` + `agentIdentityGeneration` | **VERIFIED** | `agent/src/services/deviceIdentityService.js`; AIM-1 keys hosts by all three (PR #4 `a73bdb5`), rotation test |
| Full 64-hex container ID | **VERIFIED** | Docker inspect route; AIM-1 real-Agent smoke |
| Volume name + creation timestamp + driver | **VERIFIED, attached volumes only** | Name and driver from the container inspect's mounts, creation time from the bounded volume inspect; AIM-1 recreation and driver tests (PR #4 `08de53c`). Volumes not attached to any container are not inventoried: the Agent's volume list route is unbounded and is not called |
| Docker network: full network ID + name | **RECORDED, attached networks only, not actionable** | From the container inspect's `NetworkSettings`; networks stay unverified for action purposes |
| Service-managed instance: host + instance id + unit | **VERIFIED** | Build 206 instance list; AIM-1 real-Agent smoke (zero control calls) |
| Managed instance: host + instance id | **VERIFIED** | Instance list |
| Non-container process: executable path + start time | **NOT AVAILABLE** | Listener inventory reports only process ID and name. Such processes (e.g. AMP, host Ollama) stay **unverified and read-only**: no plan above R0 may target them |
| Agent-side expected-identity guard (`docker.restart`, instance restart, Safe Restart) | **DESIGN ONLY** | Plan §5.4; to be built and tested in AIM-5 |

## 3. Live verification and production scopes

Executed 2026-10-14, read-only, token-free (health route is public), 11 GET requests:

| Target | Result |
| --- | --- |
| `Anxlab` (`192.168.1.134:47131`) | Host identity **verified** against its registered device; not yet a Build 206 Agent (no `serviceManagedInstances` capability) |
| `127.0.0.1:47132` | Unreachable |
| Installed local Agent `127.0.0.1:47131` (`DESKTOP-TJ50GSE`) | Host identity **verified** |

Not done: an authenticated live inventory. Node credentials are encrypted to the Owner's
app profile and were not decrypted outside the app.

| Accepted production scope (plan §5.6) | Identity mapped? |
| --- | --- |
| Debian ANX-CorTex (`8090`) and `anx-cortex-m5` volume | **No.** Needs an authenticated read on the Debian host. Port `8090`/`8080` assignment is corroborated only by the tunnel config, not by a live listener read. Stays `production` |
| Recovery Open Terminal (`:18000`), recovery Qdrant volume | No. Stays `production` |
| Original Windows Qdrant volume and backups | No. Stays `production` |
| AnxGraph production runtime | No. Stays `production` |
| AI-BOX volumes, both Ollama nodes, AMP (`8080`), Cloudflare tunnel | No. Stay `production` |
| Installed AnxOS application | No. Stays `production` |
| AnxOS Agent on every node | Hosts of `Anxlab` and the local Agent verified (above); others not. All stay `production` |

Every gap is recorded; per plan §5.6 an unmapped scope stays `production`.

| Proposed non-production candidate | Decision under these defaults |
| --- | --- |
| M5/M6 staging (`:8081`, AnxGraph `:7385`) | **Remains `production`** (unverified) |
| AnxOS AgentOS prototype (`:4871`) | **Remains `production`** |
| QA fixture roots | **Remains `production`** |
| Disposable AIM test stacks | **Remains `production`** until created, identity-recorded and Owner-confirmed |

## 4. Roadmap gates (plan §7.0)

| Gate | Needed for | Recommendation |
| --- | --- | --- |
| P4 — V2-J health/alerts (partial, acceptance not verified) | AIM-2 | **Accept for AIM-2**: AIM-2 adds read-only probes and reuses existing health vocabulary; no V2-J acceptance item is weakened |
| P1 — V2-A | AIM-4 | Not needed for AIM-2; decide before AIM-4 |
| P2 — V2-I | AIM-5 | Not needed for AIM-2; decide before AIM-5 |
| P3 — V2-C | AIM-5 | Not needed for AIM-2; decide before AIM-5 |

## 5. What signing authorizes (and what it does not)

If the Owner signs below:

- **Authorized:** AIM-2 implementation with hermetic fixtures (cases C1, C3, C4, C6),
  service adapters and the dual Health/Functional UI, under gate P4 as accepted above.
- **Still deferred:** every AIM-2 live run. It requires a separate Owner approval naming one
  specific ANX-CorTex staging scope (identity-verified and confirmed non-production) and a
  user-created read-only ANX-CorTex account.
- **Still on-demand only:** probes against `production` scopes; no per-scope scheduled
  opt-ins are granted.
- **Not authorized:** AIM-4 and later, any Agent Office or AnxGraph integration, any
  production change.

| Item | Owner decision |
| --- | --- |
| Contracts 1–6 accepted with the statuses and defaults above | ☐ Sign / ☐ Change |
| Production scopes stay `production`, gaps recorded | ☐ Sign / ☐ Change |
| All non-production candidates remain `production` | ☐ Sign / ☐ Change |
| Gate P4 accepted for AIM-2 | ☐ Sign / ☐ Change |
| AIM-2 hermetic implementation authorized; live runs deferred | ☐ Sign / ☐ Change |

Signed: ________________________  Date: ____________
