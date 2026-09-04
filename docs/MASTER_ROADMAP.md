# AnxOS Master Roadmap

**Product:** AnxOS — Control Center, self-hosted server platform, and future server OS  
**Updated:** 2026-09-03  
**Edition:** 0.2 — Expanded reconstructed product roadmap  
**Planning status:** Proposed sequence; implementation and release acceptance NOT VERIFIED in this revision  
**Progression:** V1 Control Center → V2 self-hosted/server-management platform → Linux-based AnxOS server OS/appliance

## 1. Product direction

AnxOS should grow into one coherent place to operate a personal server, a homelab, game servers, self-hosted applications, and multiple machines. Control Center is the starting point and should become the native management layer of a future Linux-based AnxOS server OS/appliance.

V2 is a substantial product expansion: a useful homelab home screen, application installation and management, containers, capable game-server administration, remote agents, storage and protection of data, access control, network services, and trustworthy daily operations. The intended category includes CasaOS-style homelab experiences and hosting/game-server panels. AnxOS remains its own product, with its own workflows, architecture, and priorities.

The eventual OS must add real system ownership: installation, boot, host services, supported storage and networking, system updates, rescue, and recovery. A dashboard running on an existing Linux installation is an intermediate platform deployment, not sufficient evidence that the OS milestone is complete.

### Evidence and planning labels

- **USER DIRECTION:** The current request explicitly establishes the broad V2 tracks and eventual Linux server OS/appliance direction. This establishes intent, not implementation.
- **DIRECT — CHAT:** Content visible in the retrieved conversation. The user explicitly mentioned CasaOS and wrote “htnetwork pnael” in relation to V2. The latter name remains **UNRESOLVED**; it is not silently expanded into a specific product.
- **HISTORICAL RECORD:** Claims carried forward from the uploaded v0.1 roadmap. Its engineering summaries and original Library sources were not independently revalidated for this edit.
- **RECONSTRUCTED / PROPOSED:** All new milestone IDs, ordering, detailed capabilities, architecture proposals, acceptance criteria, and release boundaries below. They operationalize the requested direction; they are not recovered historical commitments.
- **UNKNOWN / NOT VERIFIED:** Current implementation, current release, or missing evidence. An unchecked box means outstanding work or verification, not necessarily a missing feature.

The earlier assistant named several other panel products as possible comparisons. Those suggestions do not establish the user's exact historical feature list. This roadmap makes no current competitor feature or compatibility claims.

### Product principles — proposed

- Keep the everyday experience simple: discover the machine, install a service, see whether it works, protect its data, and recover when it fails.
- Model nodes, workloads, storage, identities, and operations consistently across the product.
- Preserve existing useful Control Center work and reconcile it before replacing anything.
- Keep local management usable without a required vendor cloud account; remote access is an explicit choice.
- Display observed health, stale data, failures, and limitations honestly.
- Make permissions, isolation, backups, and recovery part of delivery rather than cleanup after V2.
- Carry forward the reported open-source direction; actual license, repository visibility, and contribution policy still require confirmation.

## 2. Release map and critical path

The labels below are **planning IDs**, not recovered Phase 12/13 numbers or promised semantic versions. V1/V2 describe product generations; exact release numbers and dates remain uncommitted. Historical Phase 11A remains separately preserved in Appendix A.

| Stage | Planning milestones | User-visible outcome | Exit decision |
| --- | --- | --- | --- |
| Baseline | B0 | Know what exists and what is accepted | Evidence map agreed |
| V1 foundation | V1-A, V1-B, V1-C | Dependable Control Center; bounded Alpha, Beta, then stable V1 | Clean installation, core operations, recovery and release gates pass |
| V2 foundation | V2-A | Shared platform model, identity and agent boundaries | Authenticated operations work across the selected support matrix |
| V2 Alpha | V2-B, V2-C, V2-D | Homelab dashboard, containers, Marketplace and runtimes | Install → operate → protect → restore one reference app |
| V2 Beta | V2-E, V2-F, V2-G | Game panels, storage/backups and multi-node operation | Multiple workloads on multiple nodes survive failure scenarios |
| V2 release candidate | V2-H, V2-I, V2-J | Controlled public access, security, observability and updates | Integrated V2 acceptance matrix passes |
| Stable V2 | V2-K | Supported self-hosted/server-management platform | Distribution, documentation and recovery evidence approved |
| OS foundation | OS-A | Headless Linux platform deployment | Management survives reboot independently of the desktop client |
| OS developer preview | OS-B | Bootable, installable AnxOS appliance image | Installer and rescue work in disposable environments |
| OS Beta | OS-C | Safe system lifecycle and qualified hardware scope | Upgrade, failed upgrade and recovery gates pass |
| OS stable | OS-D | Supported AnxOS server OS with native Control Center | Full appliance lifecycle accepted |

**Dependency spine:** B0 → V1 gates → V2-A → V2-B/C/D → V2-E/F/G → V2-H/I/J → V2-K → OS-A/B/C/D.

Security and observability start with V1 and V2-A; the later milestones are comprehensive hardening and acceptance gates. Backups needed for V2 Alpha are delivered as a thin slice before the broader V2-F track. Scoped multi-node support starts in V2-A before V2-G deepens it. OS research and documentation can proceed alongside V2, but an appliance release depends on accepted platform behavior.

## 3. How milestones become accepted

All milestones start **Planned; current acceptance UNKNOWN**. Check boxes only when their stated outcomes have evidence. Work may proceed in parallel where dependencies permit; do not silently skip a release gate or rename history.

For each milestone, maintain:

- [ ] Named owner, supported scope, dependencies, issue links, and explicit exclusions.
- [ ] Source or artifact identity and a dated implementation record.
- [ ] Relevant automated checks with actual results, including failure paths.
- [ ] Live operator acceptance on the declared environments, with screenshots/logs where useful.
- [ ] Data protection, permission, retry, interruption and recovery checks appropriate to the change.
- [ ] Known limitations, documentation, and an explicit accept/defer decision.

Automated checks, live UI acceptance, real workload behavior, and packaged release evidence are separate claims. A passing unit test does not certify a release. Do not claim a release from source changes alone. Do not claim safe upgrades from a backup file that has never been restored.

## 4. B0 — Reconcile the current product

**Outcome:** Start from the actual AnxOS state instead of rebuilding features that already exist.

- [ ] Identify the correct checkout, application version, running backend/Agent versions, and inherited changes.
- [ ] Inventory Nodes, Servers, Apps, Files, Backups, Users, Shell, Docker, Network, Settings and dependencies/runtime surfaces; record whether each is functional, partial, planned, or absent.
- [ ] Recover exact Phase 11A requirements where possible; preserve unknown earlier phase definitions.
- [ ] Recheck the historical resource operations, instance metrics, FiveM configuration and lifecycle work in Appendix A.
- [ ] Record supported operating systems, architectures, deployment modes, and game/application adapters; distinguish tested from experimental.
- [ ] Map original R0–R4 continuation tracks using Section 10; choose the smallest next incomplete milestone.
- [ ] Set initial support, performance, retention and recovery targets before testing against them.

**Acceptance gate:** A dated capability matrix links each accepted capability to implementation and live evidence. Missing history stays unknown. The next milestone has a bounded owner and scope.

## 5. V1 — A dependable Control Center

### V1-A — Core operation and state reliability

**Outcome:** Operators can trust what the Control Center says about their servers.

- [ ] Reconcile shared service/operation ownership, Docker duplication and Public Access review findings from Phase 11A.
- [ ] Preserve stable resource rows during reload/download; show real progress and distinguish stale data from failure.
- [ ] Validate create, configure, start, stop, restart, logs and metrics for each selected server adapter.
- [ ] Verify per-instance metrics without selection dependence; reject stale results after node changes.
- [ ] Handle process crashes, stale process IDs, failed starts, readiness timeouts and backend restarts accurately.
- [ ] Validate safe configuration round-trips, external-edit conflicts, backups and secret masking, including historical FiveM work.
- [ ] Make cancellation, retry and interrupted-operation recovery explicit and prevent duplicate destructive execution.

**Acceptance gate:** The chosen reference workloads complete the lifecycle on supported hosts; induced crashes and disconnections produce correct, recoverable states. Evidence includes two simultaneously running instances and a connected Agent where remote support is claimed.

### V1-B — Bounded Alpha and Beta usability

**Outcome:** A new operator can install AnxOS and operate the supported scope without development knowledge.

- [ ] Define the V1 feature set and label experimental or unsupported features in the UI.
- [ ] Provide installation, first-run configuration, connection diagnostics and clear prerequisites.
- [ ] Deliver consistent loading, empty, error, stale, offline and recovery states.
- [ ] Establish local authentication, session handling, bounded file access, credential protection and basic action audit records.
- [ ] Validate persistence across restart, configuration backup/restore and documented repair steps.
- [ ] Fix or explicitly re-evaluate the historical SSH browser confirmation-dialog smoke failure.
- [ ] Run Alpha feedback cycles and Beta regression across the selected support matrix.

**Acceptance gate:** A clean supported installation reaches a functioning reference server using only the shipped instructions. Beta additionally passes concurrent operations, reconnect, backup/restore and upgrade trials; exclusions are visible.

### V1-C — Stable V1 release and upgrade foundation

**Outcome:** A supportable Control Center release provides a reliable base for V2.

- [ ] Produce identifiable installation artifacts and verify clean install, upgrade and uninstall behavior.
- [ ] Protect user data and configuration during upgrades; document what uninstall retains or removes.
- [ ] Establish release channels, artifact integrity verification and schema compatibility rules.
- [ ] Publish supported environments, known issues, release notes and troubleshooting guidance.
- [ ] Confirm license, contribution policy and public roadmap maintenance ownership.

**Acceptance gate:** The packaged candidate passes the V1 operator flows, migration and recovery checks on supported environments. No unresolved release-blocking data-loss, privilege or core-lifecycle defect remains.

## 6. V2 — The self-hosted/server-management platform

### V2-A — Shared platform, identity and agent foundation

**Depends on:** B0 and accepted V1 foundations.

- [ ] Define consistent identities for nodes, services, game instances, containers, volumes, users and operations.
- [ ] Define management authority: the backend authorizes actions; an Agent verifies the target and bounded capability before execution.
- [ ] Introduce scoped roles for owner/admin/operator/viewer and service identities, with explicit node/workload permissions.
- [ ] Establish authenticated agent enrollment, revocation, credential rotation and compatibility negotiation.
- [ ] Define job lifecycle, audit events, cancellation and idempotency across local and remote execution.
- [ ] Publish a support matrix for Windows/Linux roles; do not imply identical host features on every platform.
- [ ] Separate desktop-client availability from persistent service ownership and prepare an authenticated browser management surface.

**Acceptance gate:** A permitted operation succeeds on the intended node; wrong-node, revoked-agent, unauthorized-user and duplicate-request cases fail safely with useful diagnostics. Restarting the client does not orphan server operations.

### V2-B — Homelab dashboard and application management

**Depends on:** V2-A; installs use V2-C/D services.

- [ ] Create a useful home dashboard with node health, storage pressure, running apps, game servers, failed jobs and actionable alerts.
- [ ] Provide app cards, categories, search, favorites and launch links with real service status.
- [ ] Guide users through installation requirements, target node, storage, resource limits, ports and access settings.
- [ ] Support start/stop/restart, configuration, logs, update and uninstall from a coherent app detail page.
- [ ] Distinguish AnxOS-managed, imported and external services; require explicit adoption before managing existing resources.
- [ ] Build accessible, responsive browser workflows alongside the desktop experience.
- [ ] Keep node context and risky action targets visible throughout navigation.

**Acceptance gate:** A first-time operator installs a reference self-hosted app, opens it, changes configuration and recovers a failed start through the UI. Dashboard status agrees with actual runtime state, including offline/stale cases.

### V2-C — Docker and container lifecycle

**Depends on:** V2-A; first app slice integrates with V2-B/D.

- [ ] Detect supported container engines and explain missing or incompatible prerequisites.
- [ ] Manage containers, images, volumes and networks with explicit ownership and target node.
- [ ] Support reproducible multi-container application definitions, validated environment settings and secret references.
- [ ] Preflight ports, disk capacity, required mounts and resource limits before creating resources.
- [ ] Show logs, health checks, resource usage, restart policy and execution failures.
- [ ] Support controlled image updates, restart and rollback where data/schema compatibility allows it.
- [ ] Protect volumes on uninstall; preview cleanup and require explicit selection for data removal.
- [ ] Gate privileged containers, host mounts and engine-socket access through policy and permissions.

**Acceptance gate:** Install and operate one single-container and one multi-container reference app. Exercise bad image, occupied port, missing volume, restart and failed update. Cleanup preserves unselected user data and leaves no unexplained managed resources.

### V2-D — Marketplace, templates and dependencies/runtimes

**Depends on:** V2-A/C; produces the repeatable V2 Alpha install experience.

- [ ] Define a versioned package/template format with provenance, compatible hosts, requirements, ports, volumes, permissions and lifecycle actions.
- [ ] Organize a curated initial catalog for self-hosted apps, game servers and required runtimes.
- [ ] Show installed versus available versions, update notes, maintenance state and unsupported combinations.
- [ ] Resolve runtime versions per workload; avoid silently changing shared dependencies required by another service.
- [ ] Validate downloads and package integrity before execution; document publisher trust and review requirements.
- [ ] Show the installation plan before changes; track progress, interruption, resume and cleanup.
- [ ] Provide a bounded extension/adaptor interface and a clear trust warning for third-party executable content.
- [ ] Support catalog export/import and document offline installation limits.

**Acceptance gate:** A catalog package installs reproducibly on a clean supported host with its declared dependencies. Corrupt downloads, missing dependencies, incompatible templates and failed installs produce safe, diagnosable outcomes. Updating one runtime does not break a pinned reference workload.

**V2 Alpha slice:** V2-B/C/D plus basic permissions, metrics and backups must demonstrate app installation → configuration → use → backup → update → restore → uninstall. Container volumes survive unless removal is explicitly chosen. Full storage functionality follows in V2-F.

### V2-E — Game-server panel capabilities

**Depends on:** V1-A and V2-A/D; integrates with V2-F/G.

- [ ] Establish a documented game-adapter contract for installation, versions, configuration, lifecycle, readiness and updates.
- [ ] Choose a bounded first-release game list based on verified support; include FiveM only after its remaining live gates pass.
- [ ] Add templates, per-instance ports, environment/runtime selection, resource controls and scheduled tasks.
- [ ] Provide scoped live console access, searchable logs, player information where the adapter supports it, and clear unsupported states.
- [ ] Support game-specific configuration, mods/plugins and version changes only through declared adapter capabilities.
- [ ] Handle license or setup requirements without exposing secret values or claiming successful startup prematurely.
- [ ] Provide maintenance windows, restart warnings where supported, and workload-aware backup/update sequencing.
- [ ] Allow delegated server operators without granting unrestricted host administration.

**Acceptance gate:** Two independently configured reference game instances run concurrently, receive console actions and survive restart. Backup/restore recovers usable game state. Permissions prevent cross-instance access, and port conflicts, broken configuration and interrupted updates are recoverable.

### V2-F — Files, storage and backups

**Depends on:** V2-A; thin backup slice is required for Alpha.

- [ ] Provide scoped file browsing, upload/download, editing, rename and move with target paths and limits visible.
- [ ] Validate traversal, links and archive extraction against authorized roots; reject writes outside them.
- [ ] Inventory disks, mounts, volumes, capacity and usage with read-only discovery before provisioning controls.
- [ ] Manage selected storage locations and quotas where supported; mark destructive disk operations separately.
- [ ] Add scheduled backups, retention, integrity checks and capacity/error reporting.
- [ ] Define workload-consistent backup hooks for databases and game servers; disclose when only crash-consistent copies are supported.
- [ ] Support chosen local and remote/off-node destinations, protected credentials and encryption/key-recovery procedures.
- [ ] Restore individual workloads and configuration into a selected target, with conflict handling and preview.
- [ ] Prevent pruning the last required recovery point and show backup age versus policy.

**Acceptance gate:** Restore a reference app and game workload to an isolated destination and verify usable data. Test full disk, missing mount, interrupted backup, corrupted archive, unauthorized path and unavailable remote destination. A backup is accepted only after a restore drill.

### V2-G — Multi-node agents and fleet operation

**Depends on:** V2-A plus relevant workload tracks.

- [ ] Enroll, name, group, inspect, disconnect and revoke nodes with explicit machine identity.
- [ ] Provide capability-aware actions and compatible Agent upgrades for the selected host matrix.
- [ ] Aggregate inventory, health and job status while keeping every action bound to its target node.
- [ ] Reconcile disconnection, timeout, reconnect, stale telemetry and incomplete remote operations.
- [ ] Add fleet filters and controlled batch actions with a per-node result and bounded concurrency.
- [ ] Define whether offline jobs expire or require renewed approval; never silently replay stale destructive actions.
- [ ] Provide explicit backup/restore-based workload transfer between compatible nodes before considering live migration.
- [ ] Document management-backend outage behavior: existing workloads, agent reconnection and recovery authority.

**Acceptance gate:** Operate two nodes concurrently, interrupt one connection and restart management services. The healthy node remains usable, results never cross node boundaries, revocation takes effect, and reconnect does not duplicate work. Validate each host OS claimed in the release matrix.

### V2-H — Shell, networking and public access

**Depends on:** V2-A/G; public exposure also requires V2-I security gates.

- [ ] Provide permission-scoped shell/terminal sessions, timeouts and attributable audit metadata without logging secrets unnecessarily.
- [ ] Inventory interfaces, addresses, ports, listeners and conflicts on supported hosts.
- [ ] Manage a bounded initial set of network/firewall rules with previews and a recovery path for loss of access.
- [ ] Add service domains, reverse proxy routes and certificate lifecycle for supported web workloads.
- [ ] Support selected tunnel/public-access providers through explicit provisioning, readiness, failure and cleanup states.
- [ ] Distinguish HTTP routing from game-server TCP/UDP requirements; show actual provider and protocol limits.
- [ ] Keep public workload exposure separate from exposing the AnxOS administration interface.
- [ ] Surface DNS/certificate/provider errors and residual billable resources where applicable; never imply provisioning succeeded from request acceptance alone.

**Acceptance gate:** Publish and revoke a test workload using the selected access method; independently verify reachability and closure. Exercise failed provisioning, expired credentials, conflicting ports and rollback after a risky network change. Administrative access remains within the chosen policy.

### V2-I — Users, permissions, security and isolation

**Depends on:** V2-A; hardens every earlier track before public multi-user release.

- [ ] Complete role and resource-scope enforcement for UI, API, file operations, console, shell, backups and Agent calls.
- [ ] Add session revocation, credential rotation, protected recovery and strong authentication for remote administration.
- [ ] Scope service/API tokens and prevent secrets appearing in routine logs, diagnostics or unrelated responses.
- [ ] Define workload trust levels, non-admin execution and container/process isolation appropriate to supported hosts.
- [ ] Enforce resource limits and restricted host mounts; clearly document residual host-level privileges.
- [ ] Review package provenance, update trust, extension execution and dependency vulnerability handling.
- [ ] Provide audit retention, access review and export with sensitive data redaction.
- [ ] Document threat model, security reporting and operator hardening guidance.

**Acceptance gate:** Test an explicit actor × resource × action matrix, including denial paths through direct APIs and Agent requests. Cross-user, cross-node and cross-workload access attempts fail. Critical findings block exposure/release until resolved or the affected capability is removed from release scope.

### V2-J — Observability, updates and recovery

**Depends on:** All implemented V2 tracks; monitoring basics start earlier.

- [ ] Unify node, application, container and game-server health with timestamps and stale/unknown states.
- [ ] Correlate user operations, backend jobs, Agent actions and workload logs through stable IDs.
- [ ] Provide alerts for disk pressure, failure, offline agents, backup age and resource exhaustion with deduplication and quiet recovery behavior.
- [ ] Add redacted diagnostic exports and documented retention/storage budgets.
- [ ] Establish controlled updates for Control Center, backend, Agents, templates and workloads with compatibility checks.
- [ ] Take and verify required recovery points before risky migrations; distinguish application rollback from data-schema rollback.
- [ ] Handle interrupted update, partial fleet upgrade, backend crash and failed migration without inventing success.
- [ ] Publish operator recovery procedures, recovery-time/data-loss targets and drill results.

**Acceptance gate:** Induced service failure raises one useful alert and later resolves correctly. Update a staged environment, interrupt an update and recover using documented procedures. Meet targets chosen in B0; record measured outcomes rather than assumed reliability.

### V2-K — Integrated platform release

- [ ] Pass the integrated acceptance matrix in Section 8 on packaged candidates.
- [ ] Publish tested host/Agent/workload combinations and explicit feature differences.
- [ ] Complete new-user setup and existing-V1-user migration without losing managed workload identity, configuration or data.
- [ ] Deliver user documentation, troubleshooting, release notes, support policy and public roadmap.
- [ ] Establish catalog maintenance, security-response and update ownership.
- [ ] Record deferred capabilities and acceptance failures; do not present experimental paths as supported.

**Acceptance gate:** An operator can install the platform, manage apps and game servers across the supported nodes, protect data, delegate access, expose selected services and recover from documented failures. Release artifacts and recovery evidence are available and reviewed.

**Deferred beyond the V2 core unless explicitly adopted:** General-purpose virtual-machine orchestration, high-availability clustering, automatic live migration, full hosting-reseller billing, complete mail hosting, arbitrary storage-pool administration and universal game support. Basic web/service/domain administration belongs in V2-H; a complete commercial hosting suite requires a separate scope decision.

## 7. AnxOS becomes a Linux server OS/appliance

All OS milestones are **RECONSTRUCTED / PROPOSED**. The destination is user-requested; distribution choice, kernel policy, hardware matrix, installer technology and version branding are undecided. A Linux-based appliance can build on an established distribution without inventing a new kernel.

### OS-A — Headless Linux platform deployment

**Depends on:** Stable V2 service and recovery contracts.

- [ ] Select a base distribution, supported architecture and package/service ownership strategy through a recorded decision.
- [ ] Run management, Agents and essential services without a logged-in desktop session.
- [ ] Provide local browser onboarding, initial owner setup and safe discovery on the local network.
- [ ] Define paths and ownership for system configuration, application data, backups and secrets.
- [ ] Verify reboot ordering, service supervision and recovery when a dependency is unavailable.
- [ ] Provide export/import from a supported V1/V2 installation and document incompatible paths/workloads.

**Acceptance gate:** A clean supported Linux host boots into functioning management services, reconnects workloads and remains manageable without Electron running. This is the platform deployment gate, not yet OS completion.

### OS-B — Bootable installer and developer preview

**Depends on:** OS-A and selected system architecture.

- [ ] Build a reproducible, identifiable bootable installation image with integrity verification.
- [ ] Show exact installation disk, data-erasure consequences and supported installation modes before writing.
- [ ] Configure boot, networking, host identity, time and first administrator through an onboarding flow.
- [ ] Provide a local recovery console and safe access when web management is unavailable.
- [ ] Keep system and workload data boundaries explicit; document partitioning and reinstall behavior.
- [ ] Include license notices, component inventory and reproducible build instructions.

**Acceptance gate:** Install, boot, onboard, reboot and reach native Control Center in disposable virtual machines. Test invalid target, insufficient disk and interrupted installation. Publish a developer preview only within its tested scope.

### OS-C — System lifecycle, hardware and recovery Beta

**Depends on:** OS-B.

- [ ] Choose and implement a recoverable system-update strategy; specify rollback limits and persistent-data compatibility.
- [ ] Support host patches, reboot scheduling and maintenance windows with workload coordination.
- [ ] Validate supported storage mounts, network interfaces and selected physical hardware.
- [ ] Recover from full root disk, missing data disk, failed boot/update and unavailable network.
- [ ] Provide system configuration backup, reinstall/import and disaster-recovery documentation.
- [ ] Define security maintenance, image signing/key rotation, support lifetime and component updates.
- [ ] Test upgrade from the previous preview and coexistence with supported remote Windows/Linux Agents.

**Acceptance gate:** Perform successful and intentionally failed system upgrades, then restore administration and reference workload data through documented recovery. Pass both VM and declared physical-hardware tests before claiming hardware support.

### OS-D — Stable AnxOS server OS/appliance

- [ ] Qualify an exact image/version and a bounded supported hardware matrix.
- [ ] Pass first boot → install workload → expose service → backup → update → reboot → restore on the candidate.
- [ ] Prove recovery when Control Center is broken or inaccessible using independent rescue access.
- [ ] Document security updates, recovery obligations, data ownership, support lifetime and known limitations.
- [ ] Provide reproducible release artifacts and a migration guide for existing Control Center users.
- [ ] Confirm operational ownership of the base system, installed platform and update/recovery pipeline.

**Acceptance gate:** A supported machine installs and boots AnxOS, uses Control Center as its native administration layer, runs real workloads and survives the tested upgrade/recovery scenarios. Only this evidence supports a stable OS/appliance claim.

## 8. Integrated acceptance matrix

Choose exact hosts, versions, workloads, limits and recovery targets before execution. Each row requires dated evidence; no row is pre-accepted by this document.

| ID | Scenario | Required result | Release gate |
| --- | --- | --- | --- |
| A01 | Clean install and onboarding | Reach a healthy managed reference workload using shipped instructions | V1, V2, OS |
| A02 | Concurrent game instances | Correct independent lifecycle, ports, logs and metrics | V1 remote scope / V2 |
| A03 | Single and multi-container app | Install, configure, operate, update and remove with data policy respected | V2 Alpha |
| A04 | App/game backup and restore | Restored isolated workload opens with expected usable data | V2 Alpha/Beta |
| A05 | Two nodes, one disconnected | Correct targeting, stale state and nonduplicating recovery | V2 Beta |
| A06 | Restricted user and revoked Agent | UI/API/Agent deny actions outside granted scope | V2 foundation/RC |
| A07 | Public access create and revoke | External reachability matches policy; cleanup verified | V2 RC |
| A08 | Resource/download failure | Accurate status, bounded retry and safe cleanup | V1/V2 |
| A09 | Full disk or missing mount | Clear failure; no silent data relocation or destructive fallback | V2 RC / OS |
| A10 | Mixed-version/failed update | Compatibility enforced; known working state recovered | V2 RC / OS |
| A11 | Failure alert and diagnostic export | Actionable alert, correct resolution, redacted evidence | V2 RC |
| A12 | V1 migration into V2 | Workload identity, settings, permissions and data preserved | V2 stable |
| A13 | Installer and first reboot | Correct selected disk and functioning native management | OS preview |
| A14 | Failed boot/update and rescue | Recover administration and declared data within chosen targets | OS Beta/stable |
| A15 | New operator usability/accessibility | Core flows usable with keyboard and supported screen sizes | Each user-facing release |

Evidence record: **candidate/version; host and Agent identity; scenario; expected result; observed result; automated evidence; live evidence; data recovery result; date; reviewer; pass/fail/deferred; issue links.** A deferred required scenario blocks that release unless scope is explicitly revised and documented.

## 9. Immediate execution queue and decisions

### Start here

- [ ] Complete B0 before assigning a current release position.
- [ ] Reconcile historical Phase 11A and V1-A reliability evidence, including the missing live Agent/two-server flow.
- [ ] Set the supported V1 release scope and close its installation/recovery gate.
- [ ] Decide V2-A service ownership and permission contracts.
- [ ] Select one self-hosted app and one game adapter for the V2 Alpha/Beta reference paths.
- [ ] Deliver the full V2 Alpha app slice before expanding catalog breadth.
- [ ] Track the remaining V2 work by milestone and acceptance evidence; start OS architectural decisions without claiming OS delivery.

### Decision register

| Decision | Needed by | Current position |
| --- | --- | --- |
| Exact meaning of “htnetwork pnael” | Historical reconciliation | Unresolved; does not block category-level planning |
| V1 current version and accepted scope | B0 / V1-C | UNKNOWN |
| Supported host/Agent operating systems and architectures | B0 / V2-A | To select and test |
| Headless backend and desktop/browser relationship | V2-A | Proposed shared management services; design pending |
| Initial games, apps and container engines | V2 Alpha/Beta | To select from verified capability |
| Public access methods and providers | V2-H | To select; no provider promised |
| Backup destinations and recovery targets | V2 Alpha / V2-F | To select and measure |
| License, distribution and contribution policy | V1-C / V2-K | Open-source direction reported; details unconfirmed |
| Base Linux distribution and update/rollback design | OS-A | Undecided |
| Dates, staffing and final release numbers | Planning review | Uncommitted; sequence is dependency-based |

## 10. Roadmap maintenance and v0.1 mapping

Retain the recovered public statuses: **Planned / In progress / Testing / Released / Paused / Reconsidering**. Track implementation and acceptance separately. Dates and target versions stay optional until committed.

| Original proposed track | Expanded placement | Preservation note |
| --- | --- | --- |
| R0 — Reconcile roadmap and current baseline | B0 and Appendix A | Same reconciliation purpose |
| R1 — Consolidate service and instance reliability | V1-A | Historical Phase 11A is not renamed |
| R2 — Define and validate Alpha scope | V1-B | Packaging continues in V1-C |
| R3 — Validate Beta readiness | V1-B/C | V2 Beta is a separate product-generation gate |
| R4 — Public roadmap/project information | V1-C, V2-K and this section | Ongoing documentation/community work |

```markdown
### <Planning ID> — <Feature name>
- Description: <Observable user outcome>
- Public status: Planned
- Target version: <Optional; no invented date>
- Owner: <Unassigned until selected>
- Dependencies: <Planning IDs and contracts>
- Original phase: <Recovered label or UNKNOWN>
- Provenance: <USER DIRECTION | DIRECT — CHAT | HISTORICAL RECORD | RECONSTRUCTED / PROPOSED>
- Implementation: <Unknown | Partial | Implemented; evidence link>
- Acceptance: <Not verified | Testing | Accepted | Failed; evidence link>
- Supported scope: <Hosts, versions, workloads and exclusions>
- [ ] Deliver the scoped outcome.
- [ ] Pass automated and live acceptance criteria.
- [ ] Verify failure, permission and recovery paths.
- [ ] Update documentation and record release evidence if applicable.
- Last verified: NOT VERIFIED
- Issues / feedback / decisions: <Actual links only>
```

Preserve recovered historical phase numbers verbatim. Do not infer Phase 1–10 completion from a Phase 11A reference. Retain old evidence dates when fresh verification changes status. Keep unrelated project conventions outside AnxOS. Release labels require actual distribution evidence.

## 11. Sources, limits and revision history

**Primary input:** Uploaded `ANXOS_MASTER_ROADMAP.md`, edition 0.1, prepared 2026-09-03. This revision edits that document; the retained historical register and source descriptions follow in Appendix A. Historical test totals are preserved as reported records, not refreshed results.

**Conversation:** [Local Qwen Comparison Restart](chatgpt-conversation://6a97d86a-915c-83e8-a1be-6cc0fefdb520), retrieved for this edit on 2026-09-03. Relevant user statements establish CasaOS/category-level V2 intent; the current request supplies the comprehensive expansion scope and eventual OS direction. Prior assistant suggestions are context, not independently confirmed commitments.

**Scope of this revision:** Document editing and planning only. No checkout, live AnxOS runtime, original engineering log, release artifacts or competitor capabilities were audited. No product features are certified as complete. The current request authorizes this roadmap edit, not execution of its future infrastructure operations.

| Date | Edition | Change |
| --- | --- | --- |
| 2026-09-03 | 0.1 | Reconstructed roadmap fragments, Phase 11A history and R0–R4 Alpha/Beta continuation. |
| 2026-09-03 | 0.2 | Expanded into V1 → V2 platform → Linux OS/appliance progression; added practical tracks, dependencies, checkboxes, release gates, integrated acceptance and decisions; retained evidence/history with explicit limits. |

## Appendix A — Preserved evidence and engineering history

The following sections are retained from the uploaded v0.1 file, with heading depth adjusted. Their statements about records being read describe the **v0.1 reconstruction**, not new verification during this edit. Source labels [S1]–[S3] retain their original meanings within this appendix. The original assertion that later official phase labels were unknown concerns historical engineering numbering, not the newly proposed product roadmap above.

### 2. Evidence-backed roadmap baseline

| Topic | What the available material establishes | Evidence and limits |
| --- | --- | --- |
| Development structure | AnxOS work was discussed in named phases. | DIRECT — CHAT [S1]. |
| Phase 11A | The chat reports an engineering log referencing Phase 11A during shared service-framework cleanup, Docker service deduplication, and Public Access provisioning review. | DIRECT — CHAT [S1]; original engineering log was not retrieved. Exact scope and completion are UNKNOWN. |
| Open-source direction | The chat describes a roadmap-related screenshot mentioning keeping AnxOS open-source. | DIRECT — CHAT [S1]; actual repository visibility and license are UNKNOWN. |
| Alpha to Beta | The same discussion describes a suggested Alpha → Beta feature roadmap with stronger security/isolation. | DIRECT — CHAT [S1]; target dates, versions, and original acceptance criteria are UNKNOWN. |
| Public roadmap | The chat reports statuses and item fields from a website planning prompt. | DIRECT — CHAT [S1]; website implementation is UNKNOWN. |
| Standalone master roadmap | The earlier assistant said it had not found a clean standalone AnxOS master roadmap. | DIRECT — CHAT [S1]; this is a search outcome reported in that conversation, not proof that no other file exists. |

**Position supported by the recovered discussion:** Phase 11A is the latest phase label identified in the roadmap exchange. It must not be interpreted as the current active phase, an accepted milestone, or proof that all earlier phases passed.


### 3. Historical phase register

| Phase | Recovered identity | Status | Required reconciliation |
| --- | --- | --- | --- |
| Earlier phases, referred to as “Phase 1–11A” in the chat's proposed search | Individual earlier phase names, boundaries, and deliverables were not recovered. | UNKNOWN | Recover the original sequence before assigning work to Phase 1–10 or any intermediate labels. |
| Phase 11 | No standalone definition recovered. | UNKNOWN | Determine whether this was a parent phase for 11A and recover its title and scope. |
| **Phase 11A** | Shared service-framework cleanup; Docker service deduplication; Public Access provisioning review, as described by the chat. | Historically referenced; completion UNKNOWN | Retrieve the original engineering log and map its actual requirements to source, tests, runtime evidence, and remaining work. |
| Later numbered phases | No later official phase labels recovered from the roadmap exchange. | UNKNOWN | Preserve any subsequently recovered numbering; do not silently replace it with the proposed tracks below. |

#### Phase 11A reconciliation checklist

**Phase identity: DIRECT — CHAT. Checklist: RECONSTRUCTED / PROPOSED.**

- [ ] Recover the source log and exact Phase 11A wording.
- [ ] Identify the intended shared operation/service framework and its ownership boundaries.
- [ ] Confirm the exact Docker deduplication problem and whether a fix was accepted.
- [ ] Confirm the intended Public Access provisioning lifecycle and outstanding review findings.
- [ ] Record tests and observed UI/runtime outcomes separately for each deliverable.
- [ ] Record unresolved failures and dependencies before declaring the phase complete.

Shared operation tracking appears in both the chat description and later engineering records. Their architectural relationship is plausible, but assigning all later lifecycle work to Phase 11A would be an inference and is intentionally left unresolved.


### 4. Historical engineering progress, phase assignment unknown

The following provides useful project history alongside the chat's roadmap fragments. Dates identify the historical records; they do not indicate a fresh audit. These workstreams are not newly numbered phases.

| Workstream | Historically reported progress | Reported validation | Remaining evidence boundary |
| --- | --- | --- | --- |
| Resource Reload/Download operations | Stable resource identity with transient operation overlays; retained last-known download state during polling failures; actual progress telemetry where available. | Resource operation lifecycle smoke reported passing on 2026-08-20. [S2] | Some implementation was already present during that session; authorship and acceptance must not be inferred. Current live behavior is unverified. |
| Instance metrics lifecycle | Per-instance, node-scoped metrics replaced selection-owned telemetry; bounded scheduling and stale-response protection; Console consumes shared telemetry. | Metrics, runtime, node-routing, renderer-safety and architecture checks reported passing; fast tier 5/5 and feature tier 13/13. [S2] | A live acceptance test with two running servers and a connected Agent was not performed in the recorded session. |
| FiveM structured configuration | FiveM adapter added to the shared configuration editor backend, with configuration discovery, comment/unknown-directive preservation, safe writes, backups, conflict detection and redacted secret results. | Configuration smoke and feature tier 13/13 reported passing on 2026-08-27. [S3] | Live create/open/edit/save/reload/start/restart/logs/metrics flow was not verified; documentation integration remained uncertain. |
| Instance lifecycle and health | Preserved failure evidence through reconciliation, handled stale process metadata, corrected Windows executable validation and readiness races. | Stale-PID, health-state and runtime smokes reported passing; feature tier 13/13. [S3] | Focused regression success does not prove completion of the broader lifecycle mission or live UI acceptance. |
| Broader platform hardening | Historical request covered persistence, metrics, logs, downloads/updates, tunnels, templates, security and full verification. | Only focused portions of the broader request were completed in the recovered record. [S3] | Treat the remaining areas as unverified until individually inspected. |

#### Historical limitations to carry forward

- The 2026-08-20 record reports a pre-existing `ui:polish:smoke` failure involving SSH browser confirmation dialogs. Its present status is UNKNOWN. [S2]
- The resource/metrics session did not produce a commit, push, release, installer, or packaged build. [S2]
- The 2026-08-27 mission ended after focused feature validation without full end-to-end completion, production build, live Electron acceptance, or a final change report. [S3]
- A recorded real FiveM setup failure indicated missing configuration/license setup; it was not evidence of a successful real server start. [S3]
- Historical worktrees contained inherited changes. A future audit must identify current changes and their ownership before attributing them to any phase. [S2, S3]


### 8. Sources and provenance

#### S1 — Retrieved ChatGPT conversation

**Title:** Local Qwen Comparison Restart  
**Conversation ID:** `6a97d86a-915c-83e8-a1be-6cc0fefdb520`  
**Relevant exchange:** The user's request to find the AnxOS roadmap, the assistant's summary of roadmap fragments and Phase 11A, and the follow-up request for a downloadable file. Retrieved for this document on 2026-09-03.

The conversation reported these original Library references:

- Roadmap-related screenshot: `1:0`.
- Engineering log: `1:3`, with cited ranges `L75–L89` and `L420–L438`.
- Website/planning prompt: `1:4`, with cited range `L268–L293`.

These are retained as retrieval clues, not working download links or independently verified citations. The original Library documents behind them were not available in the retrieved exchange. Consequently, Phase 11A and the public-roadmap schema are directly evidenced as conversation content, with underlying source verification still outstanding.

#### S2 — Historical resource operations and metrics session summary

**Date:** 2026-08-20  
**Session ID:** `01a01e19-caa9-7d33-93dc-cef906f46fb4`  
**Record:** `rollout_summaries/2026-08-20T07-36-41-TAuE-anxos_resource_operation_and_instance_metrics_lifecycle.md`

Used for historical resource operation behavior, metrics architecture, reported validation and live-acceptance limitations. This is a saved summary, not a current checkout audit.

#### S3 — Historical FiveM configuration and lifecycle session summary

**Date:** 2026-08-27  
**Session ID:** `01a043c5-5a11-7cd3-9ba2-3a0be53dbcf0`  
**Record:** `rollout_summaries/2026-08-27T15-10-02-hxIc-anxos_fivem_config_lifecycle_hardening_partial.md`

Used for historical FiveM configuration support, runtime reconciliation, reported checks and unfinished broader verification. This is a saved summary, not a current checkout audit.


