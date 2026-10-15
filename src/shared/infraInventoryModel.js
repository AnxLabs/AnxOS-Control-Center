"use strict";

// AIM-1 infrastructure inventory model (docs/v2/V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md
// §4.1 and §5.7, revision 3.2 addendum A2/A7).
//
// Pure and dependency-free: no I/O, no clock (callers pass `now`). It turns the
// read-only payloads the Agent already returns into inventory resources with:
//   - an identity tuple and a `verified` flag (§5.7, CL9): a resource whose full
//     identity cannot be observed is still inventoried, but marked unverified;
//   - a stable `key` used for deduplication and for carrying firstSeen across
//     refreshes;
//   - ownership, source, health, capabilities and protection.
//
// Protection is fail-closed (decision D4): every resource is `production` unless
// an Owner-confirmed classification for its exact key says otherwise. AIM-1 ships
// no classification writer, so in practice everything is production.
//
// Secrets: builders copy an explicit allow-list of fields. Environment variables,
// labels other than the compose project/service labels, commands and mount sources
// are never copied (the container inspect payload contains raw Config.Env).

const INVENTORY_SCHEMA_VERSION = 1;

const RESOURCE_KINDS = Object.freeze([
  "host",
  "instance",
  "service-managed-instance",
  "container",
  "volume",
  "network",
  "compose-project",
  "listener",
]);

const HEALTH_STATES = Object.freeze(["healthy", "degraded", "failed", "stopped", "unknown"]);

const PROTECTION = Object.freeze({
  PRODUCTION: "production",
  NON_PRODUCTION: "non-production",
});

// Hard bounds so a misbehaving or very large host can never grow the inventory
// (or the persisted store) without limit.
const LIMITS = Object.freeze({
  maxResourcesPerNode: 2000,
  maxListenersPerNode: 200,
  maxInspectsPerNode: 40,
  maxNameLength: 200,
});

const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
// Identity gaps caused by this refresh not reading the object (not by the
// object itself): the previous verified record is retained instead.
const TRANSIENT_IDENTITY_GAPS = new Set(["CONTAINER_NOT_INSPECTED", "VOLUME_NOT_INSPECTED"]);
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

function text(value, max = LIMITS.maxNameLength) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  if (!result) return null;
  return result.length > max ? result.slice(0, max) : result;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Host identity (§5.7: deviceId + agentInstallationId + agentIdentityGeneration,
// all three required).
// ---------------------------------------------------------------------------
function buildHostIdentity(healthIdentity = {}, registeredIdentity = null) {
  const deviceId = text(healthIdentity?.deviceId);
  const installationId = text(healthIdentity?.agentInstallationId);
  const generation = text(healthIdentity?.agentIdentityGeneration);
  const components = { deviceId, agentInstallationId: installationId, agentIdentityGeneration: generation };
  const complete = Boolean(deviceId && installationId && generation);
  const registeredDeviceId = text(registeredIdentity?.deviceId);
  // A node registered for one device must not silently absorb another device's
  // resources (for example after a reinstall at the same URL). Decided on the
  // two device IDs alone: an incomplete tuple must not hide a definite mismatch.
  const mismatch = Boolean(deviceId && registeredDeviceId && registeredDeviceId !== deviceId);
  const verified = complete && !mismatch;
  return {
    verified,
    reason: mismatch ? "AGENT_IDENTITY_MISMATCH" : !complete ? "HOST_IDENTITY_INCOMPLETE" : null,
    components,
    // All three required components form the key (§5.7). Re-pairing or
    // credential rotation changes agentIdentityGeneration, which makes the
    // host — and every child resource keyed under it — a new identity: no
    // firstSeen or classification carries across the rotation (fail closed).
    key: complete ? `host:${deviceId}:${installationId}:${generation}` : null,
  };
}

function unverified(reason, components = {}) {
  return { verified: false, reason, components };
}

// ---------------------------------------------------------------------------
// Health mapping
// ---------------------------------------------------------------------------
function healthFromInstance(instance = {}) {
  const state = String(instance.state || instance.lifecycleState || "").toLowerCase();
  const health = String(instance.healthState || "").toLowerCase();
  if (state === "unknown" || !state) return { state: "unknown", detail: instance.failureReason || null };
  if (state.includes("crash") || state === "failed") return { state: "failed", detail: instance.failureReason || null };
  if (state === "stopped") return { state: "stopped", detail: null };
  if (state === "running") {
    if (health === "degraded" || instance.readinessState === "timeout") return { state: "degraded", detail: instance.failureReason || null };
    return { state: "healthy", detail: null };
  }
  // Starting, Stopping, Restarting: transitional, not yet healthy.
  return { state: "degraded", detail: `Transitional state: ${instance.state}` };
}

function healthFromServiceStatus(instance = {}) {
  const status = instance.serviceStatus || {};
  if (status.observed !== true) return { state: "unknown", detail: status.error || instance.failureReason || "SERVICE_QUERY_FAILED" };
  const active = String(status.activeState || "").toLowerCase();
  if (active === "active") return { state: "healthy", detail: null };
  if (active === "failed") return { state: "failed", detail: status.result || null };
  if (active === "inactive") return { state: "stopped", detail: null };
  if (active === "activating" || active === "deactivating" || active === "reloading") return { state: "degraded", detail: `systemd ${active}` };
  return { state: "unknown", detail: `systemd state ${status.activeState || "unreported"}` };
}

// The Agent passes Docker's State through when present and otherwise
// normalizes it (inferState: exited/dead/paused/restarting/removing all become
// "stopped"), so the detailed status text is evaluated as well.
function healthFromContainer(container = {}) {
  const state = String(container.state || "").toLowerCase();
  const status = String(container.status || "").toLowerCase();
  const health = String(container.health || "").toLowerCase();
  if (/restarting/.test(state) || /^restarting\b/.test(status)) return { state: "degraded", detail: "Container restarting" };
  // Docker reports a paused container as "Up ... (Paused)".
  if (/paused/.test(state) || /\(paused\)/.test(status)) return { state: "stopped", detail: container.status || null };
  if (state === "running" || /^up\b/.test(status)) {
    if (health === "unhealthy") return { state: "failed", detail: "Container health check reports unhealthy" };
    if (health === "starting") return { state: "degraded", detail: "Container health check starting" };
    return { state: "healthy", detail: null };
  }
  if (/dead/.test(state) || /^dead\b/.test(status)) return { state: "failed", detail: "Container dead" };
  if (/^(exited|created|paused|stopped|removing)$/.test(state) || /^(exited|created|paused|removing)\b/.test(status)) {
    return { state: "stopped", detail: container.status || null };
  }
  return { state: "unknown", detail: container.status || null };
}

// ---------------------------------------------------------------------------
// Resource builders. Each returns a resource or null. `ctx` carries nodeId,
// hostKey and the host verification result.
// ---------------------------------------------------------------------------
// `key` encodes the complete verified identity (§5.7), so any identity change
// yields a new key and nothing (firstSeen, classification) carries across it.
// `matchKey` is an identity-independent locator (host scope + kind + listed
// id or name) used only to recognize a transient read gap on the same object.
function baseResource(ctx, kind, key, fields) {
  return {
    key,
    matchKey: fields.matchKey || key,
    listedComponents: fields.listedComponents || null,
    kind,
    nodeId: ctx.nodeId,
    hostKey: ctx.hostKey || null,
    name: fields.name || null,
    identity: fields.identity,
    ownership: fields.ownership,
    source: fields.source,
    health: fields.health || { state: "unknown", detail: null },
    capabilities: fields.capabilities || {},
    details: fields.details || {},
  };
}

function hostScopedKey(ctx, suffix) {
  // Without a verified host identity, fall back to a node-scoped key: the
  // resource is still listed, but it can never be merged with another host.
  const scope = ctx.hostKey || `node:${ctx.nodeId}`;
  return `${scope}:${suffix}`;
}

function buildHostResource(ctx, health = {}, summary = null) {
  const identity = ctx.hostIdentity;
  const capabilities = health?.capabilities || {};
  const serviceManaged = capabilities.serviceManagedInstances || null;
  return baseResource(ctx, "host", identity.key || `node:${ctx.nodeId}:host`, {
    name: text(health?.identity?.hostname) || text(summary?.hostname) || ctx.nodeName || ctx.nodeId,
    identity: {
      verified: identity.verified,
      reason: identity.reason,
      components: identity.components,
    },
    ownership: { owner: "anxos-agent", detail: "Host reported by its AnxOS Agent" },
    source: "agent-observed",
    health: { state: "healthy", detail: null },
    capabilities: {
      os: text(capabilities.os),
      supportsDocker: capabilities.supportsDocker === null || capabilities.supportsDocker === undefined ? null : capabilities.supportsDocker === true,
      supportsSystemMetrics: capabilities.supportsSystemMetrics === true,
      supportsServiceControl: capabilities.supportsServiceControl === true,
      serviceManagedInstances: serviceManaged ? {
        supported: serviceManaged.supported === true,
        mechanism: text(serviceManaged.mechanism),
        allowedUnits: Array.isArray(serviceManaged.allowedUnits) ? serviceManaged.allowedUnits.map((unit) => text(unit)).filter(Boolean).slice(0, 50) : [],
      } : null,
      gpu: "not-reported",
    },
    details: {
      agentVersion: text(health?.identity?.agentVersion),
      platform: text(health?.identity?.platform),
      architecture: text(health?.identity?.architecture),
      operatingSystem: text(health?.identity?.operatingSystem),
      agentMode: text(health?.mode),
      cpuCount: finiteNumber(summary?.cpu?.cores ?? summary?.cpuCount),
      memoryTotalBytes: finiteNumber(summary?.memory?.total ?? summary?.memoryTotal),
    },
  });
}

function buildInstanceResource(ctx, instance = {}, allowedUnits = null) {
  const id = text(instance.id);
  if (!id) return null;
  const serviceManaged = instance.type === "systemd-service";
  if (serviceManaged) {
    const unit = text(instance.serviceManager?.unit) || text(instance.serviceStatus?.unit);
    const complete = Boolean(ctx.hostVerified && unit);
    const status = instance.serviceStatus || {};
    const allowlisted = Array.isArray(allowedUnits) ? allowedUnits.includes(unit) : null;
    return baseResource(ctx, "service-managed-instance", hostScopedKey(ctx, `svc:${id}:${unit || "unknown-unit"}`), {
      name: text(instance.displayName) || text(instance.name) || id,
      identity: complete
        ? { verified: true, reason: null, components: { host: ctx.hostKey, instanceId: id, unit } }
        : unverified(!ctx.hostVerified ? "HOST_IDENTITY_UNVERIFIED" : "SERVICE_UNIT_MISSING", { host: ctx.hostKey, instanceId: id, unit }),
      ownership: { owner: "systemd", detail: "Owned by systemd; the Agent observes and controls it but never owns the process" },
      source: "agent-observed",
      health: healthFromServiceStatus(instance),
      capabilities: {
        serviceManager: "systemd",
        unitAllowlisted: allowlisted,
        safeRestartRoute: true,
        agentOwnsProcess: false,
      },
      details: {
        unit,
        templateId: text(instance.templateId),
        activeState: text(status.activeState),
        subState: text(status.subState),
        // Informational only (addendum A2): never part of the identity.
        externalMainPid: finiteNumber(status.externalMainPid),
        uptimeSeconds: finiteNumber(status.uptimeSeconds),
        restartCount: finiteNumber(status.restartCount),
        ports: Array.isArray(instance.ports) ? instance.ports.map(finiteNumber).filter((port) => port !== null).slice(0, 20) : [],
      },
    });
  }
  return baseResource(ctx, "instance", hostScopedKey(ctx, `instance:${id}`), {
    name: text(instance.displayName) || text(instance.name) || id,
    identity: ctx.hostVerified
      ? { verified: true, reason: null, components: { host: ctx.hostKey, instanceId: id } }
      : unverified("HOST_IDENTITY_UNVERIFIED", { host: ctx.hostKey, instanceId: id }),
    ownership: { owner: "anxos-agent", detail: text(instance.ownership) || "anxos-managed" },
    source: "agent-observed",
    health: healthFromInstance(instance),
    capabilities: { agentOwnsProcess: true },
    details: {
      type: text(instance.type),
      templateId: text(instance.templateId),
      state: text(instance.state),
      ports: Array.isArray(instance.ports) ? instance.ports.map(finiteNumber).filter((port) => port !== null).slice(0, 20) : [],
    },
  });
}

// `inspect` is the first element of `docker inspect <id>` or null when the
// bounded inspect budget was exhausted or the call failed.
function buildContainerResource(ctx, container = {}, inspect = null) {
  const listedId = text(container.id);
  const fullId = typeof inspect?.Id === "string" && FULL_CONTAINER_ID.test(inspect.Id) ? inspect.Id : null;
  const idForKey = fullId || listedId;
  if (!idForKey) return null;
  const labels = inspect?.Config?.Labels && typeof inspect.Config.Labels === "object" ? inspect.Config.Labels : {};
  const project = text(labels[COMPOSE_PROJECT_LABEL]);
  const service = text(labels[COMPOSE_SERVICE_LABEL]);
  const name = text(container.name) || text(String(inspect?.Name || "").replace(/^\//, ""));
  const complete = Boolean(ctx.hostVerified && fullId);
  const reason = !ctx.hostVerified ? "HOST_IDENTITY_UNVERIFIED" : !fullId ? (inspect ? "FULL_CONTAINER_ID_UNAVAILABLE" : "CONTAINER_NOT_INSPECTED") : null;
  const shortKey = idForKey.slice(0, 12);
  // Verified key: every §5.7 component, so a rename or a move to another
  // compose project/service is a new identity even though the Docker ID stays.
  // Unverified key: the short id; a transient inspect gap on a previously
  // verified container is recognized through matchKey (mergeNodeCollection).
  const containerKey = complete
    ? `container:${fullId}:${project || ""}/${service || ""}:${name || ""}`
    : `container:${shortKey}`;
  return baseResource(ctx, "container", hostScopedKey(ctx, containerKey), {
    matchKey: hostScopedKey(ctx, `container:${shortKey}`),
    // The list response still shows the name when inspect fails.
    listedComponents: { name: text(container.name) },
    name,
    identity: complete
      ? { verified: true, reason: null, components: { host: ctx.hostKey, containerId: fullId, composeProject: project, composeService: service, name } }
      : unverified(reason, { host: ctx.hostKey, containerId: fullId, shortId: shortKey, composeProject: project, composeService: service, name }),
    ownership: project
      ? { owner: "docker-compose", detail: `Compose project ${project}${service ? ` / service ${service}` : ""}` }
      : { owner: "docker", detail: "Standalone container" },
    source: "agent-observed",
    health: healthFromContainer(container),
    capabilities: {},
    details: {
      image: text(container.image) || text(inspect?.Config?.Image),
      state: text(container.state),
      status: text(container.status),
      createdAt: isoOrNull(inspect?.Created) || text(container.createdAt),
      restartPolicy: text(inspect?.HostConfig?.RestartPolicy?.Name) || text(container.restartPolicy),
      // Volume names only; bind-mount host paths are never copied.
      volumes: Array.isArray(inspect?.Mounts)
        ? inspect.Mounts.filter((mount) => mount?.Type === "volume").map((mount) => text(mount.Name)).filter(Boolean).slice(0, 20)
        : [],
      // The Agent normalizes ports to "<port>/<protocol>" strings.
      ports: Array.isArray(container.ports) ? container.ports.map((port) => text(port, 32)).filter(Boolean).slice(0, 20) : [],
    },
  });
}

function buildVolumeResource(ctx, volume = {}, inspect = null) {
  const name = text(volume.name);
  if (!name) return null;
  const createdAt = isoOrNull(inspect?.CreatedAt);
  const driver = text(volume.driver) || text(inspect?.Driver);
  // §5.7 volume tuple: host + name + creation timestamp + driver, all required.
  const complete = Boolean(ctx.hostVerified && createdAt && driver);
  const reason = !ctx.hostVerified
    ? "HOST_IDENTITY_UNVERIFIED"
    : !inspect ? "VOLUME_NOT_INSPECTED" : !createdAt ? "VOLUME_CREATED_AT_UNAVAILABLE" : "VOLUME_DRIVER_UNAVAILABLE";
  const labels = inspect?.Labels && typeof inspect.Labels === "object" ? inspect.Labels : (volume.labels || {});
  const project = text(labels?.[COMPOSE_PROJECT_LABEL]);
  // The creation time is part of the key: a volume removed and recreated under
  // the same name is a NEW resource (§5.7) and must not inherit firstSeen or a
  // protection classification. Without an observed creation time the key falls
  // back to the name, and such a resource is unverified, so it can never carry
  // a non-production classification (applyProtection) either.
  const volumeKey = complete ? `volume:${name}:${createdAt}:${driver}` : `volume:${name}`;
  return baseResource(ctx, "volume", hostScopedKey(ctx, volumeKey), {
    matchKey: hostScopedKey(ctx, `volume:${name}`),
    // Components still visible in the list response even when inspect fails.
    listedComponents: { name, driver },
    name,
    identity: complete
      ? { verified: true, reason: null, components: { host: ctx.hostKey, name, createdAt, driver } }
      : unverified(reason, { host: ctx.hostKey, name, createdAt, driver }),
    ownership: project ? { owner: "docker-compose", detail: `Compose project ${project}` } : { owner: "docker", detail: "Named volume" },
    source: "agent-observed",
    health: { state: "unknown", detail: "Volume contents are not probed in AIM-1" },
    capabilities: {},
    details: {
      driver: text(volume.driver),
      scope: text(volume.scope),
      usedBy: Array.isArray(volume.containersUsing) ? volume.containersUsing.map((entry) => text(entry)).filter(Boolean).slice(0, 20) : [],
      // Persistent data: never automated (revision 3.1 §5.5).
      persistentData: true,
    },
  });
}

function buildNetworkResource(ctx, network = {}) {
  const name = text(network.name);
  if (!name) return null;
  const networkId = text(network.id, 64);
  // The network ID is part of the key: a network deleted and recreated under
  // the same name is a new resource. Networks have no AIM action, so they stay
  // unverified for action purposes (addendum A7) even with a full ID.
  return baseResource(ctx, "network", hostScopedKey(ctx, `network:${networkId || "no-id"}:${name}`), {
    name,
    identity: unverified(networkId ? "NETWORK_NOT_ACTIONABLE" : "NETWORK_ID_UNAVAILABLE", { host: ctx.hostKey, name, networkId }),
    ownership: { owner: "docker", detail: text(network.driver) || "network" },
    source: "agent-observed",
    health: { state: "unknown", detail: null },
    capabilities: {},
    details: {
      driver: text(network.driver),
      scope: text(network.scope),
      subnet: text(network.subnet),
      containers: Array.isArray(network.containers) ? network.containers.map((entry) => text(entry)).filter(Boolean).slice(0, 50) : [],
    },
  });
}

function buildComposeProjectResource(ctx, project = {}) {
  const name = text(project.Name || project.name);
  if (!name) return null;
  const configFiles = text(project.ConfigFiles || project.configFiles, 1000);
  const complete = Boolean(ctx.hostVerified && configFiles);
  const status = String(project.Status || project.status || "");
  // The config path is part of the verified identity and therefore the key: a
  // project that keeps its name but moves is a new identity.
  const composeKey = complete ? `compose:${name}:${configFiles}` : `compose:${name}`;
  return baseResource(ctx, "compose-project", hostScopedKey(ctx, composeKey), {
    matchKey: hostScopedKey(ctx, `compose:${name}`),
    name,
    identity: complete
      ? { verified: true, reason: null, components: { host: ctx.hostKey, name, configFiles } }
      : unverified(!ctx.hostVerified ? "HOST_IDENTITY_UNVERIFIED" : "COMPOSE_CONFIG_PATH_UNAVAILABLE", { host: ctx.hostKey, name, configFiles }),
    ownership: { owner: "docker-compose", detail: "Compose project" },
    source: "agent-observed",
    health: /running/i.test(status)
      ? (/exited|dead|restarting/i.test(status) ? { state: "degraded", detail: status } : { state: "healthy", detail: status })
      : /exited/i.test(status) ? { state: "stopped", detail: status } : { state: "unknown", detail: status || null },
    capabilities: {},
    details: { status: text(status), configFiles },
  });
}

function buildListenerResource(ctx, listener = {}) {
  const port = finiteNumber(listener.localPort);
  const protocol = text(listener.protocol);
  if (port === null || !protocol) return null;
  const address = text(listener.localAddress) || "*";
  return baseResource(ctx, "listener", hostScopedKey(ctx, `listener:${protocol}:${address}:${port}`), {
    name: `${protocol.toUpperCase()} ${address}:${port}`,
    // Executable path and process start time are not reported, so listener
    // owners stay unverified and read-only (revision 3.1 §5.7).
    identity: unverified("PROCESS_IDENTITY_NOT_REPORTED", { host: ctx.hostKey, protocol, address, port }),
    ownership: { owner: listener.processName ? "process" : "unknown", detail: text(listener.processName) || "Owning process not reported" },
    source: "agent-observed",
    health: { state: "healthy", detail: "Listening" },
    capabilities: {},
    details: {
      processName: text(listener.processName),
      pid: finiteNumber(listener.pid),
      protocol,
      address,
      port,
    },
  });
}

// ---------------------------------------------------------------------------
// Protection (D4): unclassified ⇒ production. `classifications` maps a resource
// key to an Owner-confirmed record { scope, confirmedAt }.
// ---------------------------------------------------------------------------
function applyProtection(resource, classifications = {}) {
  const entry = classifications && Object.prototype.hasOwnProperty.call(classifications, resource.key)
    ? classifications[resource.key]
    : null;
  if (entry && entry.scope === PROTECTION.NON_PRODUCTION && entry.ownerConfirmed === true && resource.identity?.verified === true) {
    return { ...resource, protection: { scope: PROTECTION.NON_PRODUCTION, reason: "OWNER_CONFIRMED", confirmedAt: entry.confirmedAt || null } };
  }
  if (entry && entry.scope === PROTECTION.PRODUCTION) {
    return { ...resource, protection: { scope: PROTECTION.PRODUCTION, reason: "OWNER_ACCEPTED_PRODUCTION", confirmedAt: entry.confirmedAt || null } };
  }
  return { ...resource, protection: { scope: PROTECTION.PRODUCTION, reason: "UNCLASSIFIED_DEFAULT_PRODUCTION", confirmedAt: null } };
}

// ---------------------------------------------------------------------------
// Deduplication within one node collection. Later duplicates merge into the
// first record; `duplicateCount` reports how many were folded.
// ---------------------------------------------------------------------------
function dedupeResources(resources) {
  const byKey = new Map();
  for (const resource of resources) {
    if (!resource || !resource.key) continue;
    const existing = byKey.get(resource.key);
    if (!existing) {
      byKey.set(resource.key, { ...resource, duplicateCount: 0 });
      continue;
    }
    existing.duplicateCount += 1;
    // Prefer the verified variant if the first one was not.
    if (!existing.identity?.verified && resource.identity?.verified) {
      byKey.set(resource.key, { ...resource, duplicateCount: existing.duplicateCount });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Merge one node's fresh collection into the previous snapshot.
//   success: replace that node's resources, carry firstSeen, set lastSeen=now.
//   failure: keep that node's previous resources, mark them stale with reason.
// Resources keyed to the same verified host but reported through two
// registered nodes are merged and annotated with both node ids.
// ---------------------------------------------------------------------------
function mergeNodeCollection(previousResources = [], collection = {}, now) {
  const at = isoOrNull(now) || new Date(0).toISOString();
  const nodeId = collection.nodeId;
  const previousByKey = new Map(previousResources.map((resource) => [resource.key, resource]));
  const others = previousResources.filter((resource) => !(resource.nodeIds || [resource.nodeId]).includes(nodeId));
  const mine = previousResources.filter((resource) => (resource.nodeIds || [resource.nodeId]).includes(nodeId));

  // A record another registration of the same Agent confirmed during this
  // refresh stays fresh (and keeps this node's association) when this node is
  // unavailable or could not read the record's section: this node's gap is
  // reported on its own node status, independent of registry order.
  const confirmedByTwin = (resource) => resource.stale === false && resource.lastSeen === at
    && (resource.nodeIds || [resource.nodeId]).some((id) => id !== nodeId);

  if (collection.ok !== true) {
    const staled = mine.map((resource) => (confirmedByTwin(resource)
      ? resource
      : { ...resource, stale: true, staleReason: collection.code || "NODE_UNAVAILABLE" }));
    return [...others, ...staled];
  }

  // A section that could not be read (permission denied, Docker unavailable,
  // timeout) says nothing about whether its resources still exist: keep the
  // previous ones of that kind, marked stale with the section's reason.
  const unreadKinds = collection.unreadKinds || {};
  const carried = mine
    .filter((resource) => Object.prototype.hasOwnProperty.call(unreadKinds, resource.kind))
    .map((resource) => (confirmedByTwin(resource) ? resource : { ...resource, stale: true, staleReason: unreadKinds[resource.kind] }));

  // A resource that is unverified only because this refresh could not inspect
  // it (inspect failed, timed out or the inspect budget ran out) is not a new
  // identity: keep the previously verified record of the same object, marked
  // stale, so its identity, firstSeen and history are not erased.
  const previousVerifiedByMatch = new Map(mine
    .filter((resource) => resource.identity?.verified === true && resource.matchKey)
    .map((resource) => [resource.matchKey, resource]));
  const fresh = (collection.resources || []).map((resource) => {
    if (resource.identity?.verified !== true && TRANSIENT_IDENTITY_GAPS.has(resource.identity?.reason)) {
      const verifiedBefore = previousVerifiedByMatch.get(resource.matchKey);
      // Only when nothing that is still observable has changed: a rename or a
      // driver change seen in the list response is an identity change, so the
      // fresh (unverified) record stands instead of the old verified one.
      const listedAgrees = Object.entries(resource.listedComponents || {})
        .every(([component, value]) => value === null || value === undefined || verifiedBefore?.identity?.components?.[component] === value);
      if (verifiedBefore && listedAgrees) {
        const otherNodeIds = (verifiedBefore.nodeIds || []).filter((id) => id !== nodeId);
        const nodeIds = [nodeId, ...otherNodeIds].sort();
        // Already confirmed by a twin registration during this refresh: this
        // node's inspect gap does not make it stale (independent of order).
        if (confirmedByTwin(verifiedBefore)) return { ...verifiedBefore, nodeIds };
        return { ...verifiedBefore, nodeIds, stale: true, staleReason: "IDENTITY_NOT_REREAD" };
      }
    }
    const previous = previousByKey.get(resource.key);
    // Other registrations of the same Agent keep their association until they
    // independently stop reporting the record (stillShared below) or are
    // removed from the registry; an unavailable twin is not a removal.
    const otherNodeIds = (previous?.nodeIds || []).filter((id) => id !== nodeId);
    return {
      ...resource,
      nodeIds: [nodeId, ...otherNodeIds].sort(),
      duplicateNodes: otherNodeIds.length > 0 || undefined,
      firstSeen: previous?.firstSeen || at,
      lastSeen: at,
      stale: false,
      staleReason: null,
    };
  });

  const freshKeys = new Set(fresh.map((resource) => resource.key));
  const carriedKeys = new Set(carried.map((resource) => resource.key));
  // A record shared with other registered nodes (the same Agent registered
  // twice) that this node no longer reports is not deleted: only this node's
  // association is removed; the other nodes confirm or stale it on their own.
  const stillShared = mine
    .filter((resource) => !freshKeys.has(resource.key) && !carriedKeys.has(resource.key))
    .filter((resource) => (resource.nodeIds || [resource.nodeId]).some((id) => id !== nodeId))
    .map((resource) => ({ ...resource, nodeIds: (resource.nodeIds || [resource.nodeId]).filter((id) => id !== nodeId) }));
  const merged = [...others, ...stillShared, ...carried.filter((resource) => !freshKeys.has(resource.key))];
  const indexByKey = new Map(merged.map((resource, index) => [resource.key, index]));
  for (const resource of fresh) {
    const index = indexByKey.get(resource.key);
    if (index === undefined) {
      indexByKey.set(resource.key, merged.length);
      merged.push(resource);
      continue;
    }
    // Same verified host reached through another registered node.
    const existing = merged[index];
    const nodeIds = [...new Set([...(existing.nodeIds || [existing.nodeId]), nodeId])].sort();
    merged[index] = {
      ...resource,
      nodeIds,
      firstSeen: existing.firstSeen && existing.firstSeen < resource.firstSeen ? existing.firstSeen : resource.firstSeen,
      duplicateNodes: true,
    };
  }
  return merged;
}

function markAllStale(resources = [], reason) {
  return resources.map((resource) => ({ ...resource, stale: true, staleReason: resource.stale ? resource.staleReason : reason }));
}

function summarize(resources = [], nodes = []) {
  const byKind = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, 0]));
  const byHealth = Object.fromEntries(HEALTH_STATES.map((state) => [state, 0]));
  let stale = 0;
  let unverifiedCount = 0;
  let production = 0;
  let duplicates = 0;
  for (const resource of resources) {
    if (byKind[resource.kind] !== undefined) byKind[resource.kind] += 1;
    const state = resource.health?.state;
    byHealth[HEALTH_STATES.includes(state) ? state : "unknown"] += 1;
    if (resource.stale) stale += 1;
    if (!resource.identity?.verified) unverifiedCount += 1;
    if (resource.protection?.scope !== PROTECTION.NON_PRODUCTION) production += 1;
    if (resource.duplicateNodes || resource.duplicateCount > 0) duplicates += 1;
  }
  return {
    resources: resources.length,
    byKind,
    byHealth,
    stale,
    unverified: unverifiedCount,
    production,
    duplicates,
    // Agent nodes only: the built-in application host is never inventoried and
    // must not make a complete inventory look incomplete.
    nodes: nodes.filter((node) => node.kind === "agent").length,
    nodesAvailable: nodes.filter((node) => node.kind === "agent" && node.status === "collected").length,
    nodesUnavailable: nodes.filter((node) => node.kind === "agent" && node.status !== "collected").length,
    // Collected, but some section was unread or rows were truncated.
    nodesPartial: nodes.filter((node) => node.kind === "agent" && node.status === "collected"
      && ((node.sections || []).some((section) => section.status !== "ok") || node.limits?.truncated === true)).length,
  };
}

module.exports = {
  INVENTORY_SCHEMA_VERSION,
  RESOURCE_KINDS,
  HEALTH_STATES,
  PROTECTION,
  LIMITS,
  buildHostIdentity,
  buildHostResource,
  buildInstanceResource,
  buildContainerResource,
  buildVolumeResource,
  buildNetworkResource,
  buildComposeProjectResource,
  buildListenerResource,
  applyProtection,
  dedupeResources,
  mergeNodeCollection,
  markAllStale,
  summarize,
};
