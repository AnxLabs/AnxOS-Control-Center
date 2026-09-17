const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-C policy + preflight contract smoke (docs/v2/V2C_CONTAINERS_WAVE1.md
// §3.4–3.5): dangerous container options fail closed without an explicit
// per-flag grant, persistent-data cleanup requires an explicit confirmation
// flag at the engine boundary, and the pure preflight helpers (host ports,
// resource limits) behave exactly as pinned. Hermetic — every gate in this
// smoke throws before any Docker command can run, so no engine and no
// destructive side effect is possible.

const policy = require("../src/shared/dockerPolicy");
const {
  DockerServiceError,
  assertComposePolicy,
  createContainer,
  preflightContainerCreate,
  runCleanup,
} = require("../src/shared/dockerService");

async function main() {
  // 1. Deny-by-default policy gate: dangerous options are denied without a
  // grant, across every supported option syntax.
  assert.strictEqual(policy.policeContainerRequest({ image: "busybox" }).allowed, true,
    "A benign create request must pass the policy gate.");
  assert.deepStrictEqual(policy.policeContainerRequest({ image: "busybox" }).denials, [],
    "A benign create request must produce no denials.");

  const privileged = policy.policeContainerRequest({ image: "busybox", privileged: true });
  assert.strictEqual(privileged.allowed, false, "Privileged mode must be denied without a grant.");
  assert.deepStrictEqual(privileged.denials.map((flag) => flag.key), ["privileged"]);

  const hostNetwork = policy.policeContainerRequest({ image: "busybox", network: "host" });
  assert.strictEqual(hostNetwork.allowed, false, "Host networking must be denied without a grant.");
  assert.deepStrictEqual(hostNetwork.denials.map((flag) => flag.key), ["hostNetwork"]);

  const hostBind = policy.policeContainerRequest({ image: "busybox", volumes: ["/etc/passwd:/victim:ro"] });
  assert.strictEqual(hostBind.allowed, false, "A host path bind must be denied without a grant.");
  assert.deepStrictEqual(hostBind.denials.map((flag) => flag.key), ["hostMount"]);

  const namedVolume = policy.policeContainerRequest({ image: "busybox", volumes: ["appdata:/var/lib/data"] });
  assert.strictEqual(namedVolume.allowed, true, "A named volume is not a host path and must pass.");

  const socketBind = policy.policeContainerRequest({ image: "busybox", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] });
  assert.strictEqual(socketBind.allowed, false, "An engine socket mount must be denied without a grant.");
  assert(socketBind.denials.some((flag) => flag.key === "socketAccess"), "The socket mount must report socketAccess.");
  assert(socketBind.denials.some((flag) => flag.key === "hostMount"), "The socket mount is also a host path.");

  const mountSyntax = policy.policeContainerRequest({ image: "busybox", mounts: ["type=bind,source=/etc,target=/etc"] });
  assert.strictEqual(mountSyntax.allowed, false, "A --mount type=bind host source must be denied without a grant.");
  assert.deepStrictEqual(mountSyntax.denials.map((flag) => flag.key), ["hostMount"]);

  const windowsBind = policy.policeContainerRequest({ image: "busybox", volumes: ["C:\\Users\\shared:/shared"] });
  assert.strictEqual(windowsBind.allowed, false, "A Windows drive-path bind must be denied without a grant.");

  // 2. Explicit grants overcome exactly the denied keys they name.
  const granted = policy.policeContainerRequest({
    image: "busybox",
    privileged: true,
    network: "host",
    policyGrant: { privileged: true, hostNetwork: true },
  });
  assert.strictEqual(granted.allowed, true, "Explicit grants must allow the granted dangerous options.");
  assert.deepStrictEqual(granted.flags.map((flag) => flag.key), ["privileged", "hostNetwork"],
    "Granted options must still be reported as flags.");

  // Duplicate option entries dedupe to one denial per key.
  const deduped = policy.policeContainerRequest({
    image: "busybox",
    volumes: ["/etc:/a", "/etc:/b"],
  });
  assert.deepStrictEqual(deduped.denials.map((flag) => flag.key), ["hostMount"],
    "Duplicate host mounts must dedupe to a single denial key.");

  // 3. The createContainer engine boundary enforces the gate before any
  // Docker command runs (hermetic: throws regardless of engine presence).
  await assert.rejects(
    () => createContainer({ name: "policy-probe", image: "busybox", privileged: true }),
    (error) => error instanceof DockerServiceError
      && error.code === "DOCKER_POLICY_DENIED"
      && error.statusCode === 403,
    "createContainer must fail closed on ungranted privileged mode.",
  );
  await assert.rejects(
    () => createContainer({ name: "policy-probe", image: "busybox", volumes: ["/etc:/victim"] }),
    (error) => error.code === "DOCKER_POLICY_DENIED",
    "createContainer must fail closed on ungranted host mounts.",
  );

  // 4. Resource-limit validation rejects malformed limits pre-engine.
  await assert.rejects(
    () => createContainer({ name: "policy-probe", image: "busybox", memory: "banana" }),
    (error) => error.code === "INVALID_MEMORY_LIMIT" && error.statusCode === 400,
    "A malformed memory limit must be rejected before any Docker command.",
  );
  await assert.rejects(
    () => createContainer({ name: "policy-probe", image: "busybox", cpus: "zero" }),
    (error) => error.code === "INVALID_CPU_LIMIT",
    "A malformed CPU limit must be rejected before any Docker command.",
  );

  // 5. Persistent-data cleanup requires the explicit confirmation flag at the
  // engine boundary; never-callable-with-engine paths only (the passing path
  // would run a real prune, so it is exercised through the pure helper).
  await assert.rejects(
    () => runCleanup({ kind: "volumes" }),
    (error) => error.code === "VOLUME_REMOVAL_CONFIRMATION_REQUIRED" && error.statusCode === 400,
    "Volume pruning without confirmVolumeDataRemoval must be refused.",
  );
  assert.throws(
    () => policy.assertCleanupSelection("volumes", undefined),
    (error) => error.code === "VOLUME_REMOVAL_CONFIRMATION_REQUIRED",
    "The pure helper must refuse volume pruning without the flag.",
  );
  assert.doesNotThrow(
    () => policy.assertCleanupSelection("volumes", true),
    "The pure helper must allow volume pruning with the flag.",
  );
  assert.doesNotThrow(
    () => policy.assertCleanupSelection("containers", undefined),
    "Non-persistent cleanup kinds must not require the flag.",
  );
  await assert.rejects(
    () => runCleanup({ kind: "banana" }),
    (error) => error.code === "INVALID_DOCKER_CLEANUP",
    "An unknown cleanup kind must be refused before any Docker command.",
  );
  assert.strictEqual(policy.cleanupAffectsPersistentData("volumes"), true,
    "Volumes must be classified as persistent data.");
  assert.strictEqual(policy.cleanupAffectsPersistentData("containers"), false,
    "Stopped-container pruning must not be classified as persistent data.");

  // 6. Pure preflight helpers.
  assert.strictEqual(policy.parseHostPort("8080:80"), 8080);
  assert.strictEqual(policy.parseHostPort("127.0.0.1:9000:80"), 9000);
  assert.strictEqual(policy.parseHostPort("1.2.3.4::80"), null, "An empty host port must parse to null.");
  assert.strictEqual(policy.parseHostPort("80"), 80);
  assert.strictEqual(policy.parseHostPort("notaport"), null);
  assert.deepStrictEqual(policy.normalizeHostPorts({ ports: ["8080:80", "9000:90/udp", "nope"] }), [8080, 9000]);
  assert.deepStrictEqual(policy.detectHostPortConflicts([8080, 3000], [{ hostPort: 8080 }, "5432/tcp"]), [8080],
    "Only wanted ports that are actually bound must be reported as conflicts.");
  assert.deepStrictEqual(policy.detectHostPortConflicts([7000], []), []);

  assert.deepStrictEqual(policy.validateResourceLimits({ memory: "512m" }), []);
  assert.deepStrictEqual(policy.validateResourceLimits({ cpus: "1.5" }), []);
  assert.strictEqual(policy.validateResourceLimits({ memory: "512mb" })[0]?.code, "INVALID_MEMORY_LIMIT",
    "Docker memory suffixes are single letters; multi-letter suffixes must be rejected.");
  assert.strictEqual(policy.validateResourceLimits({})?.length ?? 0, 0, "Absent limits must validate cleanly.");

  // 7. The preflight report surfaces the same denials the gate enforces,
  // without throwing and without requiring an engine.
  const report = await preflightContainerCreate({ name: "policy-probe", image: "busybox", privileged: true, ports: ["8080:80"] });
  assert.strictEqual(report.name, "policy-probe");
  assert.strictEqual(report.policy.allowed, false, "The preflight policy summary must reflect the denial.");
  assert(report.findings.some((finding) => finding.severity === "error" && finding.code === "POLICY_DENIED"),
    "Preflight must surface a POLICY_DENIED error finding.");
  assert.strictEqual(typeof report.engineAvailable, "boolean", "Preflight must report engine availability explicitly.");

  // 8. Compose project policy: services with dangerous options fail closed
  // unless granted; unparsable documents fail closed too.
  const benignCompose = policy.policeComposeYaml("services:\n  web:\n    image: nginx:stable-alpine\n    volumes:\n      - webdata:/var/www\n");
  assert.strictEqual(benignCompose.parsed, true, "Valid compose YAML must parse.");
  assert.strictEqual(benignCompose.allowed, true, "Named-volume compose services must pass the policy gate.");
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
    "  longform:",
    "    image: busybox",
    "    volumes:",
    "      - type: bind",
    "        source: /etc",
    "        target: /victim",
  ].join("\n"));
  assert.strictEqual(dangerousCompose.allowed, false, "Dangerous compose services must be denied without a grant.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "root" && flag.key === "privileged"), "privileged must be flagged per service.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "root" && flag.key === "hostNetwork"), "network_mode: host must be flagged.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "root" && flag.key === "hostPid"), "pid: host must be flagged.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "mounty" && flag.key === "hostMount"), "short-syntax host bind must be flagged.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "mounty" && flag.key === "socketAccess"), "socket mount must be flagged.");
  assert(dangerousCompose.denials.some((flag) => flag.service === "longform" && flag.key === "hostMount"), "long-syntax bind must be flagged.");

  const windowsCompose = policy.policeComposeYaml("services:\n  win:\n    image: busybox\n    volumes:\n      - C:\\Users\\shared:/shared\n");
  assert.strictEqual(windowsCompose.allowed, false, "A Windows drive-path compose bind must be denied without a grant.");

  const grantedCompose = policy.policeComposeYaml(
    "services:\n  root:\n    image: busybox\n    privileged: true\n",
    { privileged: true },
  );
  assert.strictEqual(grantedCompose.allowed, true, "An explicit grant must allow the flagged compose options.");

  const unparsable = policy.policeComposeYaml("services: [oops");
  assert.strictEqual(unparsable.parsed, false, "Broken YAML must be reported as unparsable.");
  assert.strictEqual(unparsable.allowed, false, "Unparsable compose content must fail closed.");

  const emptyDocument = policy.policeComposeYaml("");
  assert.strictEqual(emptyDocument.parsed && emptyDocument.allowed, true,
    "An empty document has no services and must not fabricate denials (the engine reports the real problem).");

  // 9. The engine-boundary compose gate: reads only whitelisted compose
  // basenames inside the validated project directory, denies dangerous
  // on-disk projects, honors grants by resolving, and passes through
  // project directories without any compose file (the engine reports that).
  const composeProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-compose-policy-"));
  try {
    fs.writeFileSync(
      path.join(composeProbeDir, "compose.yaml"),
      "services:\n  root:\n    image: busybox\n    privileged: true\n",
    );
    await assert.rejects(
      () => assertComposePolicy({ projectDirectory: composeProbeDir }),
      (error) => error instanceof DockerServiceError && error.code === "DOCKER_POLICY_DENIED" && error.statusCode === 403,
      "A compose file on disk with privileged services must be denied.",
    );
    const granted = await assertComposePolicy({ projectDirectory: composeProbeDir, policyGrant: { privileged: true } });
    assert.strictEqual(granted.allowed, true, "A granted compose project must pass the gate (no engine call happens in the gate).");

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-compose-empty-"));
    fs.rmSync(emptyDir, { recursive: true, force: true });
    const passthrough = await assertComposePolicy({ projectDirectory: emptyDir });
    assert.strictEqual(passthrough, null, "A directory without a compose file must pass through for the engine to diagnose.");
    fs.rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(composeProbeDir, { recursive: true, force: true });
  }

  console.log("docker:policy:smoke passed");
}

main().catch((error) => {
  console.error("docker:policy:smoke FAILED:", error);
  process.exitCode = 1;
});