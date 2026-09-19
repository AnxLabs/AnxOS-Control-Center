#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-I workload trust smoke (docs/MASTER_ROADMAP.md, milestone V2-I bullets 4–5):
// "Define workload trust levels, non-admin execution and container/process
// isolation appropriate to supported hosts" and "Enforce resource limits and
// restricted host mounts; clearly document residual host-level privileges."
//
// Hermetic: every refusal in this file is decided before any Docker command or
// process can run, so no engine, no container and no child process is needed.
// The instance section drives the REAL create/update path against a temp
// instance root; the docker section drives the REAL engine boundary, which
// throws before reaching Docker.
//
// NOTE: this alias is NOT registered yet — package.json is owned by another
// lane this wave. Register `"workload:trust:smoke": "node scripts/workload-trust-smoke.js"`
// (see the lane report). Until then it is runnable directly.

const trust = require("../src/shared/workloadTrustPolicy");
const policy = require("../src/shared/dockerPolicy");
const {
  DockerServiceError,
  assertComposePolicy,
  createContainer,
  preflightContainerCreate,
} = require("../src/shared/dockerService");

const SERVICE_CORE_PATH = path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js");
const TRUST_POLICY_PATH = path.join(__dirname, "..", "src", "shared", "workloadTrustPolicy.js");

// A definition that satisfies EVERY level's contract (non-admin numeric uid +
// explicit memory/cpus), so a per-capability probe isolates the capability
// question and does not trip the contract refusals by accident.
const CONTRACT_SATISFIED = Object.freeze({ user: "1000", memory: "512m", cpus: "1" });

const EXPECTED_TABLE = Object.freeze({
  sandboxed: {
    rank: 0,
    hostMounts: false, hostNetworking: false, hostPid: false, privileged: false,
    engineSocket: false, deviceAccess: false, publishedHostPorts: false,
    requiresNonAdminExecution: true, requiredResourceLimits: ["memory", "cpus"],
  },
  standard: {
    rank: 1,
    hostMounts: false, hostNetworking: false, hostPid: false, privileged: false,
    engineSocket: false, deviceAccess: false, publishedHostPorts: false,
    requiresNonAdminExecution: false, requiredResourceLimits: ["memory"],
  },
  elevated: {
    rank: 2,
    hostMounts: true, hostNetworking: true, hostPid: false, privileged: false,
    engineSocket: false, deviceAccess: false, publishedHostPorts: true,
    requiresNonAdminExecution: false, requiredResourceLimits: ["memory"],
  },
  "host-privileged": {
    rank: 3,
    hostMounts: true, hostNetworking: true, hostPid: true, privileged: true,
    engineSocket: true, deviceAccess: false, publishedHostPorts: true,
    requiresNonAdminExecution: false, requiredResourceLimits: ["memory", "cpus"],
  },
});

// One definition per capability, each requesting exactly that capability.
const CAPABILITY_PROBES = Object.freeze({
  privileged: { privileged: true },
  hostMount: { volumes: ["/etc/passwd:/victim:ro"] },
  hostNetwork: { network: "host" },
  hostPid: { pid: "host" },
  engineSocket: { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
  deviceAccess: { devices: ["/dev/kvm"] },
  publishedHostPorts: { ports: ["8080:80"] },
});

function refusalCodes(verdict) {
  return verdict.refusals.map((item) => item.code);
}

function labelsFor(verdict) {
  return verdict.refusals.map((item) => item.message).join(" | ");
}

// ---------------------------------------------------------------------------
// 1. The tier table and its derived floors.
// ---------------------------------------------------------------------------
function assertTierTable() {
  assert.deepStrictEqual([...trust.TRUST_LEVELS], ["sandboxed", "standard", "elevated", "host-privileged"],
    "The trust ladder must be exactly the four documented levels, ascending.");
  for (const level of trust.TRUST_LEVELS) {
    const actual = trust.TRUST_LEVEL_TABLE[level];
    const expected = EXPECTED_TABLE[level];
    assert(actual, `Missing trust level '${level}'.`);
    for (const key of Object.keys(expected)) {
      const actualValue = key === "requiredResourceLimits" ? [...actual[key]] : actual[key];
      assert.deepStrictEqual(actualValue, expected[key],
        `Trust table drift: ${level}.${key} must be ${JSON.stringify(expected[key])}.`);
    }
  }
  // Floors are DERIVED from the table, so pin the derivation result.
  assert.deepStrictEqual({ ...trust.CAPABILITY_FLOORS }, {
    privileged: "host-privileged",
    hostMount: "elevated",
    hostNetwork: "elevated",
    hostPid: "host-privileged",
    engineSocket: "host-privileged",
    deviceAccess: null,
    publishedHostPorts: "elevated",
  }, "Capability floors must be derived from the table: host mounts/networking/ports are 'elevated', privileged/socket/host-PID are 'host-privileged', device access has no floor.");
}

// ---------------------------------------------------------------------------
// 2. Each level's allow/deny table is actually enforced.
// ---------------------------------------------------------------------------
function assertAllowDenyTableEnforced() {
  for (const level of trust.TRUST_LEVELS) {
    for (const capability of Object.keys(CAPABILITY_PROBES)) {
      const definition = { trustLevel: level, ...CAPABILITY_PROBES[capability], ...CONTRACT_SATISFIED };
      const verdict = trust.evaluateWorkloadTrust(definition, { kind: "container-create" });
      const allowedByTable = trust.capabilityAllowedAt(level, capability);
      const honoredByKind = trust.HONORED_CAPABILITIES["container-create"].includes(capability);
      const shouldAllow = allowedByTable && honoredByKind;

      if (shouldAllow) {
        assert.strictEqual(verdict.allowed, true,
          `[${level}] '${capability}' is permitted by the table and honored by the kind, so the workload must be allowed. Got: ${labelsFor(verdict) || "no refusals"}.`);
        continue;
      }
      assert.strictEqual(verdict.allowed, false,
        `[${level}] '${capability}' must be refused (table allows=${allowedByTable}, kind honors=${honoredByKind}).`);
      const codes = refusalCodes(verdict);
      assert(codes.includes(trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED)
        || codes.includes(trust.TRUST_REFUSAL_CODES.TIER_EXCEEDED),
        `[${level}] '${capability}' must be refused by a typed capability code, got ${codes.join(",")}.`);
    }
  }

  // The sandboxed level is reachable, but only with the whole contract held:
  // non-admin uid AND memory AND cpus AND no dangerous capability.
  const sandboxed = trust.evaluateWorkloadTrust({ trustLevel: "sandboxed", ...CONTRACT_SATISFIED }, { kind: "container-create" });
  assert.strictEqual(sandboxed.allowed, true,
    `A fully-qualified sandboxed workload must be allowed. Got: ${labelsFor(sandboxed) || "no refusals"}.`);
  assert.strictEqual(sandboxed.declaredTier, "sandboxed");
  assert.strictEqual(sandboxed.identity.nonAdmin, true, "The sandboxed positive path must rest on a provably non-admin identity.");

  // An UNDECLARED definition is derived, never refused: this is the
  // backwards-compatibility rule for every pre-existing caller.
  const undeclared = trust.evaluateWorkloadTrust({ image: "busybox" }, { kind: "container-create" });
  assert.strictEqual(undeclared.allowed, true, "An undeclared, capability-free definition must stay allowed.");
  assert.strictEqual(undeclared.requiredTier, "standard", "An undeclared, capability-free definition is 'standard'.");
  assert.strictEqual(undeclared.effectiveTier, "standard", "An undeclared definition's effective level is its derived requirement.");
}

// ---------------------------------------------------------------------------
// 3. Exceeding the declared level is refused, with the capability named.
// ---------------------------------------------------------------------------
function assertTierExceedanceNamesCapability() {
  const verdict = trust.evaluateWorkloadTrust(
    { trustLevel: "standard", ...CAPABILITY_PROBES.hostMount, ...CONTRACT_SATISFIED },
    { kind: "container-create" },
  );
  assert.strictEqual(verdict.allowed, false, "A standard workload requesting a host mount must be refused.");
  assert.strictEqual(verdict.requiredTier, "elevated", "A host mount must require 'elevated'.");
  const exceeded = verdict.refusals.find((item) => item.code === trust.TRUST_REFUSAL_CODES.TIER_EXCEEDED);
  assert(exceeded, "The refusal must be TIER_EXCEEDED.");
  assert.strictEqual(exceeded.capability, "hostMount", "The refusal must name the exceeded capability.");
  assert.match(exceeded.message, /host path mount/, "The refusal reason must name the host mount.");
  assert.match(exceeded.message, /elevated/, "The refusal reason must name the level the capability requires.");
  assert.match(exceeded.message, /never silently downgrades/, "The refusal reason must state the no-silent-downgrade rule.");

  // Through the real docker policy gate.
  const policed = policy.policeContainerRequest({
    image: "busybox",
    trustLevel: "standard",
    ...CAPABILITY_PROBES.hostMount,
    ...CONTRACT_SATISFIED,
  });
  assert.strictEqual(policed.allowed, false, "The docker gate must refuse a standard workload requesting a host mount.");
  assert(policed.denials.some((denial) => denial.trust === true && /host path mount/.test(denial.label)),
    "The docker gate's denial must name the host mount.");

  // An explicit grant can NEVER lift a trust-level refusal: the grant answers
  // "may this option ever be used?", the level answers "may THIS workload ask?".
  const granted = policy.policeContainerRequest({
    image: "busybox",
    trustLevel: "standard",
    ...CAPABILITY_PROBES.hostMount,
    policyGrant: { hostMount: true },
    ...CONTRACT_SATISFIED,
  });
  assert.strictEqual(granted.allowed, false,
    "A policyGrant must not lift a tier refusal — the stricter of the two always wins.");
}

// ---------------------------------------------------------------------------
// 4. A self-declared low level cannot smuggle in a host mount.
// ---------------------------------------------------------------------------
function assertLowTierCannotRequestHostMount() {
  const definition = {
    trustLevel: "sandboxed",
    ...CAPABILITY_PROBES.hostMount,
    user: "1000",
    memory: "512m",
    cpus: "1",
  };
  const verdict = trust.evaluateWorkloadTrust(definition, { kind: "container-create" });
  assert.strictEqual(verdict.allowed, false, "A sandboxed claim plus a host mount must be refused.");
  assert.strictEqual(verdict.declaredTier, "sandboxed");
  assert.strictEqual(verdict.requiredTier, "elevated");
  const exceeded = verdict.refusals.find((item) => item.code === trust.TRUST_REFUSAL_CODES.TIER_EXCEEDED);
  assert(exceeded && exceeded.capability === "hostMount",
    "Even with a fully satisfied sandboxed contract, the host mount must be refused as TIER_EXCEEDED on 'hostMount'.");

  const policed = policy.policeContainerRequest({
    image: "busybox",
    trustLevel: "sandboxed",
    volumes: ["C:\\Users\\shared:/shared"],
    policyGrant: { hostMount: true },
    user: "1000",
    memory: "512m",
    cpus: "1",
  });
  assert.strictEqual(policed.allowed, false, "The Windows-path variant must be refused too.");
  assert.strictEqual(policed.trust.requiredTier, "elevated");

  // An unknown level is a declaration error, not a silent fallback.
  const unknown = trust.evaluateWorkloadTrust({ trustLevel: "trusted-ish" }, { kind: "container-create" });
  assert.strictEqual(unknown.allowed, false, "An unknown level must be refused, never silently normalised.");
  assert.strictEqual(unknown.declaredTierValid, false);
  const invalid = unknown.refusals.find((item) => item.code === trust.TRUST_REFUSAL_CODES.DECLARATION_INVALID);
  assert(invalid, "An unknown level must be DECLARATION_INVALID.");
  assert.strictEqual(invalid.statusCode, 400, "An invalid declaration is a 400, not a 403.");
  assert.match(invalid.message, /Known levels are/, "The declaration error must list the known levels.");
}

// ---------------------------------------------------------------------------
// 5. Resource limits required by the declared level.
// ---------------------------------------------------------------------------
function assertResourceLimitsEnforced() {
  // standard requires memory.
  const noMemory = trust.evaluateWorkloadTrust({ trustLevel: "standard", cpus: "1" }, { kind: "container-create" });
  assert.strictEqual(noMemory.allowed, false, "A declared standard workload without a memory limit must be refused.");
  const noMemoryFailure = noMemory.refusals.find((item) => item.code === trust.TRUST_REFUSAL_CODES.RESOURCE_LIMITS_REQUIRED);
  assert(noMemoryFailure, "The refusal must be RESOURCE_LIMITS_REQUIRED.");
  assert.strictEqual(noMemoryFailure.statusCode, 400, "A missing required limit is a 400.");
  assert.match(noMemoryFailure.message, /memory/, "The reason must name the missing field.");
  assert.deepStrictEqual(noMemory.limits.missing, ["memory"], "The verdict must report the missing field.");

  // host-privileged requires memory AND cpus.
  const halfBounded = trust.evaluateWorkloadTrust(
    { trustLevel: "host-privileged", privileged: true, memory: "2g" },
    { kind: "container-create" },
  );
  assert.strictEqual(halfBounded.allowed, false, "A declared host-privileged workload without cpus must be refused.");
  assert.deepStrictEqual(halfBounded.limits.missing, ["cpus"], "The missing field must be 'cpus'.");
  assert.match(labelsFor(halfBounded), /cpus/, "The reason must name the missing cpus limit.");

  // sandboxed requires both.
  const sandboxedNoLimits = trust.evaluateWorkloadTrust(
    { trustLevel: "sandboxed", user: "1000", memory: "512m" },
    { kind: "container-create" },
  );
  assert.strictEqual(sandboxedNoLimits.allowed, false, "A sandboxed workload without cpus must be refused.");
  assert.deepStrictEqual(sandboxedNoLimits.limits.missing, ["cpus"]);

  // An UNDECLARED workload keeps the old behaviour: limits stay optional. This
  // is the regression guarantee that pre-existing callers are unaffected.
  assert.strictEqual(trust.evaluateWorkloadTrust({ image: "busybox" }, { kind: "container-create" }).allowed, true,
    "An undeclared definition without limits must remain allowed (legacy behaviour).");

  // The docker engine boundary refuses the same definition before any command.
  return (async () => {
    await assert.rejects(
      () => createContainer({ name: "trust-probe", image: "busybox", trustLevel: "standard", cpus: "1" }),
      (error) => error instanceof DockerServiceError
        && error.code === "DOCKER_POLICY_DENIED"
        && /memory/.test(error.message),
      "createContainer must refuse a declared standard workload with no memory limit, naming the field.",
    );
  })();
}

// ---------------------------------------------------------------------------
// 6. Non-admin execution fails closed.
// ---------------------------------------------------------------------------
function assertIdentityFailsClosed() {
  const cases = [
    [{}, false, "no user override is the image default (root)"],
    [{ user: "root" }, false, "explicit root"],
    [{ user: "0" }, false, "uid 0"],
    [{ user: "0:0" }, false, "uid 0 with gid"],
    [{ user: ":1000" }, false, "empty user part means root"],
    [{ user: "root:root" }, false, "root user and group"],
    [{ user: "unknown-thing" }, false, "unverifiable name fails closed"],
    [{ user: "1000" }, true, "numeric non-root uid"],
    [{ user: "1000:1000" }, true, "numeric non-root uid and gid"],
  ];
  for (const [definition, expected, reason] of cases) {
    const identity = trust.resolveExecutionIdentity(definition, "container-create");
    assert.strictEqual(identity.nonAdmin, expected,
      `Identity for ${JSON.stringify(definition)} must be nonAdmin=${expected} (${reason}).`);
  }

  // "cannot determine the identity" is NOT non-admin, and a sandboxed claim
  // resting on it is refused.
  const unverifiable = trust.evaluateWorkloadTrust(
    { trustLevel: "sandboxed", user: "nobody", memory: "512m", cpus: "1" },
    { kind: "container-create" },
  );
  assert.strictEqual(unverifiable.allowed, false, "An unverifiable identity must not satisfy a sandboxed claim.");
  const nonAdmin = unverifiable.refusals.find((item) => item.code === trust.TRUST_REFUSAL_CODES.NON_ADMIN_REQUIRED);
  assert(nonAdmin, "The refusal must be NON_ADMIN_REQUIRED.");
  assert.strictEqual(nonAdmin.statusCode, 403, "A failed non-admin guarantee is a 403.");
  assert.match(nonAdmin.message, /fails closed/, "The reason must state the fail-closed rule.");

  // Process workloads can never be non-admin: the runtime never drops privileges.
  const processIdentity = trust.resolveExecutionIdentity({ user: "1000" }, "process");
  assert.strictEqual(processIdentity.nonAdmin, false,
    "A process workload must never be reported as non-admin, even when an identity is named.");
  assert.strictEqual(processIdentity.requestedNonAdminIdentity, true,
    "A named identity on a process workload must be reported as an unhonorable request.");
  const processSandboxed = trust.evaluateWorkloadTrust(
    { trustLevel: "sandboxed", memory: "512m", cpus: "1" },
    { kind: "process" },
  );
  assert.strictEqual(processSandboxed.allowed, false, "No process workload may declare 'sandboxed'.");
  assert(refusalCodes(processSandboxed).includes(trust.TRUST_REFUSAL_CODES.NON_ADMIN_REQUIRED));
}

// ---------------------------------------------------------------------------
// 7. A process workload cannot honor container capabilities.
// ---------------------------------------------------------------------------
function assertProcessKindHonorsNothingContainerish() {
  for (const capability of ["privileged", "hostMount", "hostNetwork", "hostPid", "engineSocket", "deviceAccess"]) {
    const verdict = trust.evaluateWorkloadTrust(CAPABILITY_PROBES[capability], { kind: "process" });
    assert.strictEqual(verdict.allowed, false,
      `A process workload requesting '${capability}' must be refused instead of silently ignored.`);
    assert(refusalCodes(verdict).includes(trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED),
      `'${capability}' on a process workload must be CAPABILITY_UNSUPPORTED.`);
  }
  const runAs = trust.evaluateWorkloadTrust({ runAs: "1000" }, { kind: "process" });
  assert.strictEqual(runAs.allowed, false, "A process workload naming a non-admin identity must be refused.");
  const runAsRefusal = runAs.refusals.find((item) => item.capability === "nonAdminExecution");
  assert(runAsRefusal, "The runAs refusal must name the non-admin-execution capability.");
  assert.match(runAsRefusal.message, /does not drop privileges/, "The reason must explain why it cannot be honored.");

  // Published ports ARE honored for a process workload (the process binds them),
  // so they classify the workload upward rather than refusing it.
  const ports = trust.evaluateWorkloadTrust({ ports: [25565] }, { kind: "process" });
  assert.strictEqual(ports.allowed, true, "A process workload publishing a port is allowed (derived, not refused).");
  assert.strictEqual(ports.requiredTier, "elevated", "A published host port must classify a process workload as 'elevated'.");
}

// ---------------------------------------------------------------------------
// 8. Compose services carry the same model.
// ---------------------------------------------------------------------------
function assertComposeServicesUseTheModel() {
  // A compose service that declares a sandboxed level while asking for a host
  // mount is refused even with a grant for the mount.
  const smuggled = policy.policeComposeYaml([
    "services:",
    "  web:",
    "    image: nginx",
    "    x-anxos-trust-level: sandboxed",
    "    user: \"1000\"",
    "    mem_limit: 512m",
    "    cpus: 1",
    "    volumes:",
    "      - /etc:/victim:ro",
  ].join("\n"), { hostMount: true });
  assert.strictEqual(smuggled.allowed, false, "A compose service must not be able to smuggle a host mount past its declared level.");
  assert(smuggled.denials.some((denial) => denial.service === "web" && denial.trust === true && /host path mount/.test(denial.label)),
    "The compose denial must be attributed to the service and name the capability.");

  // A correctly declared host-privileged compose service is allowed once the
  // dangerous option is explicitly granted and the limits are supplied.
  const declared = policy.policeComposeYaml([
    "services:",
    "  root:",
    "    image: busybox",
    "    privileged: true",
    "    x-anxos-trust-level: host-privileged",
    "    mem_limit: 512m",
    "    cpus: 1",
  ].join("\n"), { privileged: true });
  assert.strictEqual(declared.allowed, true,
    `A host-privileged compose service with a grant and limits must be allowed. Got: ${declared.denials.map((d) => d.label).join(" | ")}`);

  // Compose device passthrough is refused: no level permits it.
  const devices = policy.policeComposeYaml([
    "services:",
    "  gpu:",
    "    image: busybox",
    "    x-anxos-trust-level: host-privileged",
    "    mem_limit: 512m",
    "    cpus: 1",
    "    devices:",
    "      - /dev/kvm",
  ].join("\n"), {});
  assert.strictEqual(devices.allowed, false, "Compose device passthrough must be refused at every level.");
  assert(/device access/.test(devices.denials.map((d) => d.label).join(" ")), "The device refusal must name device access.");
}

// ---------------------------------------------------------------------------
// 9. REGRESSION GUARD: the pre-existing docker policy decisions are unchanged.
//    Every assertion below is copied from docker-policy-smoke.js §1–§2 and §8.
// ---------------------------------------------------------------------------
function assertExistingDockerPolicyUnchanged() {
  assert.strictEqual(policy.policeContainerRequest({ image: "busybox" }).allowed, true);
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox" }).denials, []);
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox", privileged: true }).denials.map((f) => f.key), ["privileged"]);
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox", network: "host" }).denials.map((f) => f.key), ["hostNetwork"]);
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox", volumes: ["/etc/passwd:/victim:ro"] }).denials.map((f) => f.key), ["hostMount"]);
  assert.strictEqual(policy.policeContainerRequest({ image: "busybox", volumes: ["appdata:/var/lib/data"] }).allowed, true);
  const socket = policy.policeContainerRequest({ image: "busybox", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] });
  assert.strictEqual(socket.allowed, false);
  assert(socket.denials.some((f) => f.key === "socketAccess") && socket.denials.some((f) => f.key === "hostMount"));
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox", mounts: ["type=bind,source=/etc,target=/etc"] }).denials.map((f) => f.key), ["hostMount"]);
  assert.strictEqual(policy.policeContainerRequest({ image: "busybox", volumes: ["C:\\Users\\shared:/shared"] }).allowed, false);

  const granted = policy.policeContainerRequest({
    image: "busybox", privileged: true, network: "host",
    policyGrant: { privileged: true, hostNetwork: true },
  });
  assert.strictEqual(granted.allowed, true, "An explicit grant must still allow the granted dangerous options.");
  assert.deepStrictEqual(granted.flags.map((f) => f.key), ["privileged", "hostNetwork"],
    "The grant path's flag list must be unchanged by the trust layer.");

  const deduped = policy.policeContainerRequest({ image: "busybox", volumes: ["/etc:/a", "/etc:/b"] });
  assert.deepStrictEqual(deduped.denials.map((f) => f.key), ["hostMount"]);

  // Compose §8 of the existing smoke, byte-for-byte expectations.
  const benignCompose = policy.policeComposeYaml("services:\n  web:\n    image: nginx:stable-alpine\n    volumes:\n      - webdata:/var/www\n");
  assert.strictEqual(benignCompose.parsed && benignCompose.allowed, true);
  assert.deepStrictEqual(benignCompose.services, ["web"]);

  const dangerousCompose = policy.policeComposeYaml([
    "services:",
    "  root:",
    "    image: busybox",
    "    privileged: true",
    "    network_mode: host",
    "    pid: \"host\"",
    "  mounty:",
    "    image: busybox",
    "    volumes:",
    "      - /etc:/victim:ro",
    "      - /var/run/docker.sock:/var/run/docker.sock",
  ].join("\n"));
  assert.strictEqual(dangerousCompose.allowed, false);
  assert(dangerousCompose.denials.some((f) => f.service === "root" && f.key === "privileged"));
  assert(dangerousCompose.denials.some((f) => f.service === "root" && f.key === "hostNetwork"));
  assert(dangerousCompose.denials.some((f) => f.service === "root" && f.key === "hostPid"));
  assert(dangerousCompose.denials.some((f) => f.service === "mounty" && f.key === "socketAccess"));

  const grantedCompose = policy.policeComposeYaml("services:\n  root:\n    image: busybox\n    privileged: true\n", { privileged: true });
  assert.strictEqual(grantedCompose.allowed, true, "An explicit grant must still allow a flagged compose option.");
  const unparsable = policy.policeComposeYaml("services: [oops");
  assert.strictEqual(unparsable.parsed, false);
  assert.strictEqual(unparsable.allowed, false);
  const emptyDocument = policy.policeComposeYaml("");
  assert.strictEqual(emptyDocument.parsed && emptyDocument.allowed, true);
  const oversized = policy.policeComposeYaml(`# ${"x".repeat(policy.MAX_COMPOSE_POLICY_BYTES + 1)}\n`);
  assert.strictEqual(oversized.parsed, false);
  assert.strictEqual(oversized.allowed, false);
}

// ---------------------------------------------------------------------------
// 10. Real integration paths (still hermetic — every case throws before a
//     Docker command or a child process can run).
// ---------------------------------------------------------------------------
async function assertRealIntegrationPaths() {
  // 10a. Engine boundary: createContainer refuses the smuggle attempt.
  await assert.rejects(
    () => createContainer({
      name: "trust-probe",
      image: "busybox",
      trustLevel: "sandboxed",
      volumes: ["/etc:/victim"],
      policyGrant: { hostMount: true },
      user: "1000",
      memory: "512m",
      cpus: "1",
    }),
    (error) => error instanceof DockerServiceError
      && error.code === "DOCKER_POLICY_DENIED"
      && error.statusCode === 403
      && /host path mount/.test(error.message),
    "createContainer must refuse a sandboxed workload asking for a host mount even when the mount is granted.",
  );

  // 10b. Preflight surfaces the same trust denial as a POLICY_DENIED finding.
  const report = await preflightContainerCreate({ name: "trust-probe", image: "busybox", trustLevel: "standard", cpus: "1" });
  assert.strictEqual(report.policy.allowed, false, "Preflight must report the trust denial.");
  assert(report.findings.some((finding) => finding.severity === "error" && finding.code === "POLICY_DENIED" && /memory/.test(finding.message)),
    "Preflight must surface the missing-limit trust refusal as a POLICY_DENIED finding.");

  // 10c. Compose file gate on disk.
  const composeDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-trust-compose-"));
  try {
    fs.writeFileSync(path.join(composeDir, "compose.yaml"), [
      "services:",
      "  web:",
      "    image: nginx",
      "    x-anxos-trust-level: sandboxed",
      "    user: \"1000\"",
      "    mem_limit: 512m",
      "    cpus: 1",
      "    volumes:",
      "      - /etc:/victim:ro",
    ].join("\n"));
    await assert.rejects(
      () => assertComposePolicy({ projectDirectory: composeDir, policyGrant: { hostMount: true } }),
      (error) => error instanceof DockerServiceError && error.code === "DOCKER_POLICY_DENIED" && /host path mount/.test(error.message),
      "The on-disk compose gate must refuse a declared sandboxed service with a host mount.",
    );
  } finally {
    fs.rmSync(composeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // 10d. Real instance create/update path.
  const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-trust-instances-"));
  const previousRoot = process.env.AGENT_INSTANCE_ROOT;
  const previousRoots = process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS;
  process.env.AGENT_INSTANCE_ROOT = instanceRoot;
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  const core = require("../src/shared/instances/instanceServiceCore");
  const jobLifecycle = require("../src/shared/instances/jobLifecycle");
  core.configureInstanceService({ getConfig: () => ({ instanceRoot }) });
  jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(instanceRoot, "jobs") });
  const base = (id, overrides = {}) => ({
    id,
    displayName: `Trust ${id}`,
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    ...overrides,
  });
  try {
    const record = await core.createInstance(base("trust-benign"));
    const created = record && record.instance ? record.instance : record;
    assert.strictEqual(created.id, "trust-benign", "A benign instance must still be creatable through the real path.");

    await assert.rejects(
      () => core.createInstance(base("trust-mount", { volumes: ["/etc:/victim"] })),
      (error) => error.code === trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED
        && error.statusCode === 403
        && error.capability === "hostMount"
        && Array.isArray(error.refusals)
        && /host path mount/.test(error.refusals.map((item) => item.message).join(" ")),
      "The real instance-create path must refuse a host mount with the capability named.",
    );

    await assert.rejects(
      () => core.createInstance(base("trust-privileged", { privileged: true })),
      (error) => error.code === trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED && error.capability === "privileged",
      "The real instance-create path must refuse privileged mode.",
    );

    await assert.rejects(
      () => core.createInstance(base("trust-declared", { trustLevel: "sandboxed" })),
      (error) => error.code === trust.TRUST_REFUSAL_CODES.NON_ADMIN_REQUIRED
        || error.code === trust.TRUST_REFUSAL_CODES.RESOURCE_LIMITS_REQUIRED,
      "The real instance-create path must refuse an unjustified sandboxed declaration.",
    );

    await assert.rejects(
      () => core.updateInstance("trust-benign", { runAs: "1000" }),
      (error) => error.code === trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED && error.capability === "nonAdminExecution",
      "The real instance-update path must refuse a non-admin identity the runtime cannot honor.",
    );

    // The same allowlist guards PATCH, so a clean create cannot be loosened.
    await assert.rejects(
      () => core.updateInstance("trust-benign", { volumes: ["/etc:/victim"] }),
      (error) => error.code === trust.TRUST_REFUSAL_CODES.CAPABILITY_UNSUPPORTED,
      "An update must not smuggle in a capability that create would refuse.",
    );

    // An update with no trust-relevant fields must still succeed.
    const updated = await core.updateInstance("trust-benign", {});
    assert(updated, "A benign update must still succeed.");
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_INSTANCE_ROOT;
    else process.env.AGENT_INSTANCE_ROOT = previousRoot;
    if (previousRoots === undefined) delete process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS;
    else process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = previousRoots;
    fs.rmSync(instanceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------------------
// 11. Residual host privileges are documented, in the header and machine-readably.
// ---------------------------------------------------------------------------
function assertResidualPrivilegesDocumented() {
  const source = fs.readFileSync(TRUST_POLICY_PATH, "utf8");
  assert(/RESIDUAL HOST PRIVILEGES/.test(source), "The module header must carry a residual-host-privileges section.");
  assert(/are a policy vocabulary, not a kernel-enforced sandbox/.test(source),
    "The header must say the level names are not a kernel-enforced sandbox.");
  assert(/Windows:/.test(source) && /Linux:/.test(source) && /Shared \(both supported hosts\):/.test(source),
    "The header must state residual privileges per supported host (shared, Windows, Linux).");
  assert(/no seccomp\/AppArmor\/SELinux profile management/.test(source), "The header must enumerate the missing isolation controls.");
  assert(/Membership of the `docker` group is root-equivalent/.test(source), "The header must name the docker-group residual risk.");

  const documented = trust.RESIDUAL_HOST_PRIVILEGES;
  assert(documented && typeof documented.summary === "string" && documented.summary.length > 0, "RESIDUAL_HOST_PRIVILEGES.summary must exist.");
  assert(Array.isArray(documented.windows) && documented.windows.length > 0, "RESIDUAL_HOST_PRIVILEGES.windows must list Windows residuals.");
  assert(Array.isArray(documented.linux) && documented.linux.length > 0, "RESIDUAL_HOST_PRIVILEGES.linux must list Linux residuals.");
  assert(Array.isArray(documented.shared) && documented.shared.length > 0, "RESIDUAL_HOST_PRIVILEGES.shared must list shared residuals.");
  assert(documented.windows.some((entry) => /Job Object/.test(entry)), "Windows residuals must name the missing Job Object limits.");
  assert(documented.linux.some((entry) => /userns-remap/.test(entry)), "Linux residuals must name the unverifiable daemon isolation settings.");
  assert(documented.shared.some((entry) => /never drops privileges|never is 'sandboxed'|No process workload is ever/.test(entry)),
    "Shared residuals must state that a process workload is never sandboxed.");

  // The header documentation is not the only artefact that must exist: the
  // enforcement point must actually reference this module.
  const coreSource = fs.readFileSync(SERVICE_CORE_PATH, "utf8");
  assert(/workloadTrustPolicy/.test(coreSource), "The instance service must wire the trust policy, not merely document it.");
}

async function main() {
  assertTierTable();
  assertAllowDenyTableEnforced();
  assertTierExceedanceNamesCapability();
  assertLowTierCannotRequestHostMount();
  await assertResourceLimitsEnforced();
  assertIdentityFailsClosed();
  assertProcessKindHonorsNothingContainerish();
  assertComposeServicesUseTheModel();
  assertExistingDockerPolicyUnchanged();
  await assertRealIntegrationPaths();
  assertResidualPrivilegesDocumented();
  console.log("workload:trust:smoke passed");
}

main().catch((error) => {
  console.error("workload:trust:smoke FAILED:", error);
  process.exitCode = 1;
});