// Safe image update for Docker services AnxOS installed from the catalog
// (Build 215-C). The container is recreated on the newest image of the same
// tag with the same name, ports, volumes and settings; the previous container
// is kept (stopped and renamed) until the new one has stayed up, and is
// brought back if it does not.
//
// What this does and does not protect:
//   - Data volumes are never deleted or copied: the new container mounts the
//     same volumes. Container removal here is `docker rm` without -v.
//   - If the new container does not stay up, the previous container (the old
//     image) starts again. That rolls back the image only. If the new version
//     already changed the data in its volumes (a database migration, for
//     example), the old version may not be able to read it; that is not
//     undone. Back up the volumes first when the data matters.
//   - Only containers labelled anxos.managed=true with a known catalog
//     template are updated. Compose projects and containers created
//     elsewhere are refused: their own tooling owns their definition.
//   - Only settings the template defines are carried over (its environment
//     keys, its volumes, its read-only host folder); everything else comes
//     from the new image, so an image's own defaults (PATH, versions) are
//     never pinned to the old values.

const { readContainerRunState } = require("../shared/marketplaceDockerTemplate");

const VERIFY_SECONDS = 20;
const VERIFY_STEP_MS = 4000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function updateError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function firstInspect(result) {
  const entry = Array.isArray(result?.inspect) ? result.inspect[0] : Array.isArray(result) ? result[0] : null;
  return entry && typeof entry === "object" ? entry : null;
}

function envMap(list = []) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item);
    const index = text.indexOf("=");
    if (index > 0) map.set(text.slice(0, index), text.slice(index + 1));
  }
  return map;
}

// "3000/tcp": [{ HostIp: "", HostPort: "3000" }] -> "3000:3000"
function portMappings(portBindings = {}) {
  const mappings = [];
  for (const [containerPort, bindings] of Object.entries(portBindings || {})) {
    const [port, protocol = "tcp"] = String(containerPort).split("/");
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      const hostPort = String(binding?.HostPort || "").trim();
      if (!/^\d{1,5}$/.test(hostPort) || !/^\d{1,5}$/.test(port)) continue;
      const hostIp = String(binding?.HostIp || "").trim();
      const prefix = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostIp) && hostIp !== "0.0.0.0" ? `${hostIp}:` : "";
      mappings.push(`${prefix}${hostPort}:${port}${protocol === "udp" ? "/udp" : ""}`);
    }
  }
  return [...new Set(mappings)];
}

function memoryValue(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${Math.max(4, Math.round(value / 1048576))}m`;
}

// The create request for the replacement, from the running container and
// its template. Throws when the container has something the template does
// not explain (a bind mount it did not ask for, for example).
function buildReplacementSpec(entry, template) {
  const docker = template?.docker || {};
  const labels = entry?.Config?.Labels || {};
  const name = String(entry?.Name || "").replace(/^\//, "");
  if (!SAFE_NAME.test(name)) throw updateError("The container's name cannot be used for an update.", "DOCKER_UPDATE_NAME_INVALID");
  const image = String(entry?.Config?.Image || "");
  if (!image || image.startsWith("sha256:")) throw updateError("The container does not record which image tag it runs, so AnxOS cannot look for a newer one.", "DOCKER_UPDATE_IMAGE_UNKNOWN");

  const env = envMap(entry?.Config?.Env);
  const environment = {};
  for (const key of Object.keys(docker.environment || {})) {
    if (env.has(key)) environment[key] = env.get(key);
  }

  const templateVolumeTargets = new Set((docker.volumes || []).map((volume) => volume.target));
  const volumes = [];
  const binds = [];
  for (const mount of Array.isArray(entry?.Mounts) ? entry.Mounts : []) {
    if (mount?.Type === "volume" && mount.Name && templateVolumeTargets.has(mount.Destination)) {
      volumes.push(`${mount.Name}:${mount.Destination}`);
    } else if (mount?.Type === "bind" && docker.hostFolder && mount.Destination === docker.hostFolder.target && mount.RW === false) {
      binds.push(`type=bind,source=${mount.Source},target=${mount.Destination},readonly`);
    } else if (mount?.Type === "volume" && !mount.Name) {
      // An anonymous volume the image declares; the new image declares its own.
    } else {
      throw updateError(`The container has a mount AnxOS did not create (${mount?.Destination || "unknown"}), so it was not updated. Update it on the Docker page.`, "DOCKER_UPDATE_UNEXPECTED_MOUNT", { destination: mount?.Destination || null });
    }
  }

  const keptLabels = {};
  for (const [key, value] of Object.entries(labels)) if (key.startsWith("anxos.")) keptLabels[key] = String(value);
  keptLabels["anxos.previous-image"] = String(entry?.Image || "");

  const spec = {
    name,
    image,
    ports: portMappings(entry?.HostConfig?.PortBindings),
    restartPolicy: entry?.HostConfig?.RestartPolicy?.Name || docker.restartPolicy || "unless-stopped",
    start: true,
    command: docker.command || [],
    labels: keptLabels,
  };
  const memory = memoryValue(entry?.HostConfig?.Memory);
  if (memory) spec.memory = memory;
  if (Object.keys(environment).length) spec.environment = environment;
  if (volumes.length) spec.volumes = volumes;
  if (binds.length) {
    spec.binds = binds;
    spec.policyGrant = { hostMount: true };
  }
  return spec;
}

async function waitUntilStable({ inspect, name, sleep, seconds = VERIFY_SECONDS, stepMs = VERIFY_STEP_MS }) {
  let last = null;
  let restarts = null;
  const deadline = Math.max(1, Math.ceil((seconds * 1000) / stepMs));
  for (let index = 0; index < deadline; index += 1) {
    await sleep(stepMs);
    const entry = firstInspect(await inspect(name).catch(() => null));
    last = readContainerRunState({ inspect: entry ? [entry] : [] });
    const count = Number(entry?.RestartCount);
    if (!last.known || !last.running || last.health === "unhealthy") return { stable: false, state: last };
    if (Number.isFinite(count)) {
      if (restarts !== null && count > restarts) return { stable: false, state: { ...last, restarting: true } };
      restarts = count;
    }
  }
  return { stable: Boolean(last?.running), state: last };
}

// deps: inspectContainer(name), inspectImage(image), pullImage(image),
// stopContainer(name), renameContainer(name, next), createContainer(spec),
// startContainer(name), deleteContainer(name), getLogs(name), findTemplate(id),
// sleep(ms), onStep(step), now()
async function updateDockerService(containerName, deps) {
  const steps = [];
  const step = (id, state, message) => {
    const entry = { id, state, message, at: deps.now ? deps.now() : new Date().toISOString() };
    steps.push(entry);
    try { deps.onStep?.(entry); } catch {}
  };
  const target = String(containerName || "").trim();
  if (!SAFE_NAME.test(target)) throw updateError("Choose a Docker service to update.", "DOCKER_UPDATE_TARGET_INVALID");

  step("check", "running", "Reading the service's settings.");
  const entry = firstInspect(await deps.inspectContainer(target));
  if (!entry) throw updateError("That container was not found on this computer.", "DOCKER_UPDATE_NOT_FOUND");
  const labels = entry?.Config?.Labels || {};
  if (labels["com.docker.compose.project"]) {
    throw updateError(`This container belongs to the Compose project "${labels["com.docker.compose.project"]}". Update the project instead (Docker page, Compose, Recreate after pulling).`, "DOCKER_UPDATE_COMPOSE");
  }
  if (labels["anxos.managed"] !== "true") {
    throw updateError("AnxOS did not install this container, so it does not know which of its settings are yours. Update it with the tool that created it.", "DOCKER_UPDATE_NOT_MANAGED");
  }
  const template = labels["anxos.template"] ? await deps.findTemplate(labels["anxos.template"]) : null;
  if (!template?.docker) {
    throw updateError(`The catalog entry "${labels["anxos.template"] || "unknown"}" this service came from is not available, so AnxOS cannot tell which settings to keep.`, "DOCKER_UPDATE_TEMPLATE_MISSING");
  }
  const spec = buildReplacementSpec(entry, template);
  const wasRunning = entry?.State?.Running === true;
  step("check", "complete", `${spec.name} runs ${spec.image}; its data is in ${spec.volumes?.length ? spec.volumes.map((volume) => volume.split(":")[0]).join(", ") : "no volume"}.`);

  step("download", "running", `Looking for a newer ${spec.image}.`);
  await deps.pullImage(spec.image);
  const pulled = firstInspect(await deps.inspectImage(spec.image));
  const newImageId = String(pulled?.Id || "");
  if (newImageId && newImageId === String(entry.Image || "")) {
    step("download", "complete", `${spec.image} is already the newest; nothing to update.`);
    return { ok: true, updated: false, upToDate: true, name: spec.name, image: spec.image, steps };
  }
  step("download", "complete", `Downloaded the newer ${spec.image}.`);

  const previousName = `${spec.name}-before-update`;
  // A leftover from an earlier interrupted update would block the rename.
  const leftover = firstInspect(await deps.inspectContainer(previousName).catch(() => null));
  if (leftover) {
    throw updateError(`A container named ${previousName} is left from an earlier update. Check it on the Docker page and remove it once you no longer need it, then retry.`, "DOCKER_UPDATE_LEFTOVER");
  }

  step("replace", "running", "Stopping the current container and keeping it as the fallback.");
  if (wasRunning) await deps.stopContainer(spec.name);
  await deps.renameContainer(spec.name, previousName);
  let created = false;
  try {
    await deps.createContainer({ ...spec, start: wasRunning });
    created = true;
    step("replace", "complete", `Created ${spec.name} on the new image with the same ports and volumes.`);
    if (wasRunning) {
      step("verify", "running", `Checking that it stays up for ${VERIFY_SECONDS} seconds.`);
      const check = await waitUntilStable({ inspect: deps.inspectContainer, name: spec.name, sleep: deps.sleep });
      if (!check.stable) {
        const logs = await deps.getLogs(spec.name).catch(() => null);
        throw updateError(`The new ${spec.image} did not stay up${Number.isInteger(check.state?.exitCode) ? ` (exit code ${check.state.exitCode})` : ""}.`, "DOCKER_UPDATE_UNSTABLE", { lastLines: String(logs?.logs || "").trim().split(/\r?\n/).slice(-6).join("\n") });
      }
      step("verify", "complete", "The new container is running.");
    }
  } catch (error) {
    step("rollback", "running", "Bringing back the previous container.");
    let restored = false;
    try {
      if (created) await deps.deleteContainer(spec.name);
      await deps.renameContainer(previousName, spec.name);
      if (wasRunning) await deps.startContainer(spec.name);
      restored = true;
    } catch {
      restored = false;
    }
    step("rollback", restored ? "complete" : "failed", restored
      ? `The previous container (old image) is back${wasRunning ? " and running" : ""}. Its volumes were not changed by AnxOS; if the new version already changed its data, the old version may not read it.`
      : `The previous container could not be restored automatically; it is kept as ${previousName}. Rename it back on the Docker page.`);
    throw Object.assign(error, { steps, details: { ...(error.details || {}), rolledBack: restored, previousName } });
  }

  step("cleanup", "running", "Removing the previous container (its volumes and image are kept).");
  await deps.deleteContainer(previousName).catch(() => null);
  step("cleanup", "complete", `Removed ${previousName}. The previous image stays on this computer (${String(entry.Image || "").slice(7, 19)}), recorded on the new container as anxos.previous-image.`);
  return { ok: true, updated: true, name: spec.name, image: spec.image, previousImageId: String(entry.Image || ""), newImageId, steps };
}

module.exports = {
  updateDockerService,
  _test: { buildReplacementSpec, portMappings, envMap, memoryValue, waitUntilStable },
};
