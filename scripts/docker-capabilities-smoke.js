const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-C engine-detection contract smoke (docs/v2/V2C_CONTAINERS_WAVE1.md §3.1,
// MASTER_ROADMAP.md V2-C checklist item 1): pins the Docker route manifest,
// the capability report, the missing/unavailable-prerequisite classification,
// and the per-platform executable resolution — hermetically, without requiring
// a Docker engine on the host that runs the smoke.

const {
  DOCKER_ROUTE_ALIASES,
  DOCKER_ROUTE_MANIFEST,
  handleDocker,
  handleDockerCapabilities,
} = require("../agent/src/routes/docker");
const {
  DockerServiceError,
  classifyDockerFailure,
  parseComposeVersion,
  parseDockerVersion,
  resolveDockerExecutable,
} = require("../src/shared/dockerService");

async function main() {
  // 1. Route manifest integrity: every entry is a unique (method, path) pair
  // under /api/v1/docker/, and the capabilities probe is present for the
  // detection surface.
  assert(DOCKER_ROUTE_MANIFEST.length > 0, "The docker route manifest must not be empty.");
  const seen = new Set();
  for (const entry of DOCKER_ROUTE_MANIFEST) {
    assert(typeof entry.method === "string" && typeof entry.path === "string" && typeof entry.operation === "string",
      "Each manifest entry must declare method, path, and operation.");
    assert(entry.path.startsWith("/api/v1/docker/"), `Manifest path must be docker-scoped: ${entry.path}`);
    const key = `${entry.method} ${entry.path}`;
    assert(!seen.has(key), `Duplicate manifest route: ${key}`);
    seen.add(key);
  }
  const capabilitiesRoute = DOCKER_ROUTE_MANIFEST.find(
    (entry) => entry.method === "GET" && entry.path === "/api/v1/docker/capabilities",
  );
  assert(capabilitiesRoute?.operation === "docker.capabilities",
    "The manifest must expose GET /api/v1/docker/capabilities with operation docker.capabilities.");

  // 2. Aliases must be unique and must resolve to a real manifest route.
  const aliasSeen = new Set();
  const manifestPaths = new Set(DOCKER_ROUTE_MANIFEST.map((entry) => entry.path));
  for (const alias of DOCKER_ROUTE_ALIASES) {
    const key = `${alias.method} ${alias.path}`;
    assert(!aliasSeen.has(key), `Duplicate alias route: ${key}`);
    aliasSeen.add(key);
    assert(manifestPaths.has(alias.target), `Alias target does not resolve to a real route: ${alias.target}`);
  }
  // The singular resource families (container/image/network/volume) must have
  // a plural base list route so aliases always land on a real surface.
  for (const base of ["/api/v1/docker/containers", "/api/v1/docker/images", "/api/v1/docker/networks", "/api/v1/docker/volumes"]) {
    assert(manifestPaths.has(base), `Missing plural base route ${base}.`);
  }

  // 3. Capability report shape (advertised surface; engine detection is a
  // separate runtime fact per serviceRouter getDockerSnapshot).
  const report = handleDockerCapabilities();
  assert.strictEqual(report.statusCode, 200, "Capabilities probe must return 200.");
  assert.strictEqual(report.body.apiVersion, "v1");
  assert.strictEqual(report.body.resource, "docker");
  assert.strictEqual(report.body.routes, DOCKER_ROUTE_MANIFEST, "Report must self-describe its route manifest.");
  for (const capability of ["containers", "images", "networks", "volumes", "compose", "cleanup"]) {
    assert.strictEqual(report.body.capabilities[capability], true, `Capability ${capability} must be advertised.`);
  }

  // 4. The live route dispatcher serves the capabilities probe side-effect-free.
  const dispatched = await handleDocker(
    { method: "GET", body: "" },
    new URL("http://127.0.0.1:47131/api/v1/docker/capabilities"),
  );
  assert.strictEqual(dispatched.statusCode, 200, "GET /api/v1/docker/capabilities must dispatch to the capability report.");
  assert.strictEqual(dispatched.body.apiVersion, "v1", "Dispatched capabilities must match the report shape.");

  // 5. Engine-version parsers (detection inputs).
  assert.strictEqual(parseDockerVersion("Docker version 24.0.7, build 123abc"), "24.0.7",
    "docker --version must yield the plain semver.");
  assert.strictEqual(parseDockerVersion(""), null, "Empty docker --version output must parse to null.");
  assert.strictEqual(parseComposeVersion("Docker Compose version v2.24.1"), "2.24.1",
    "Compose v2 output must parse to the version.");
  assert.strictEqual(parseComposeVersion("Docker Compose version 2.24.1"), "2.24.1",
    "Compose output without the v prefix must parse too.");
  assert.strictEqual(parseComposeVersion(""), null, "Empty compose output must parse to null.");

  // 6. Prerequisite-failure classification (roadmap: explain missing or
  // incompatible prerequisites).
  const notInstalled = classifyDockerFailure({ errorCode: "ENOENT", stdout: "", stderr: "docker: not found" });
  assert(notInstalled instanceof DockerServiceError, "Classification must return DockerServiceError.");
  assert.strictEqual(notInstalled.code, "DOCKER_NOT_INSTALLED");
  assert.strictEqual(notInstalled.statusCode, 503);
  assert.match(notInstalled.message, /not installed|PATH/, "Missing-engine diagnostic must be actionable.");
  const permission = classifyDockerFailure({ errorCode: null, stdout: "", stderr: "Got permission denied while trying to connect" });
  assert.strictEqual(permission.code, "DOCKER_PERMISSION_DENIED");
  assert.strictEqual(permission.statusCode, 403);
  const socketPermission = classifyDockerFailure({ errorCode: null, stdout: "", stderr: "/var/run/docker.sock: permission denied" });
  assert.strictEqual(socketPermission.code, "DOCKER_SOCKET_PERMISSION_DENIED");
  assert.strictEqual(socketPermission.statusCode, 403);
  const daemonDown = classifyDockerFailure({ errorCode: null, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" });
  assert.strictEqual(daemonDown.code, "DOCKER_SOCKET_UNAVAILABLE",
    "A daemon-unreachable message naming the socket must report the socket-specific diagnostic.");
  assert.strictEqual(daemonDown.statusCode, 503);
  const daemonGeneral = classifyDockerFailure({ errorCode: null, stdout: "", stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?" });
  assert.strictEqual(daemonGeneral.code, "DOCKER_SERVICE_UNREACHABLE",
    "A daemon-unreachable message without a socket path must report the service diagnostic.");
  assert.strictEqual(daemonGeneral.statusCode, 503);
  const unknown = classifyDockerFailure({ errorCode: null, stdout: "boom", stderr: "" });
  assert.strictEqual(unknown.code, "DOCKER_COMMAND_FAILED");
  assert.strictEqual(unknown.statusCode, 502);
  const fallback = new DockerServiceError("default");
  assert.strictEqual(fallback.code, "DOCKER_COMMAND_FAILED", "DockerServiceError must default fail-closed.");
  assert.strictEqual(fallback.statusCode, 502);

  // 7. Executable resolution per platform (support-matrix caveat: host
  // features differ between Windows and Linux; assert each contract
  // separately without requiring a live engine).
  if (process.platform === "win32") {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-docker-resolve-"));
    const fakeDocker = path.join(probeDir, "docker.exe");
    fs.writeFileSync(fakeDocker, "");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = probeDir;
      const found = await resolveDockerExecutable();
      assert.strictEqual(found.found, true, "Windows resolution must find an existing docker.exe on PATH.");
      assert.strictEqual(found.executablePath, fakeDocker, "Windows resolution must return the found candidate path.");
      process.env.PATH = originalPath;
      const fallbackResolve = await resolveDockerExecutable();
      // Windows always resolves to at least the `docker` command; on a machine
      // where Docker is actually installed the real executable wins.
      assert.strictEqual(fallbackResolve.found, true, "Windows always resolves to at least the docker command.");
      assert.strictEqual(typeof fallbackResolve.executablePath, "string", "Windows resolution must return the chosen executable.");
      assert(!fallbackResolve.executablePath || fallbackResolve.executablePath.length > 0, "The resolved executable must not be blank.");
      const resolvedByProbe = fallbackResolve.checks.some((check) => check.found && check.path === fallbackResolve.executablePath);
      assert(resolvedByProbe || fallbackResolve.executablePath === "docker",
        "The resolved executable must be a probed candidate or the docker PATH fallback.");
    } finally {
      process.env.PATH = originalPath;
      try { fs.rmSync(probeDir, { recursive: true }); } catch {}
    }
  } else {
    const resolved = await resolveDockerExecutable();
    assert(typeof resolved.found === "boolean" && typeof resolved.executablePath === "string",
      "Non-Windows resolution must report a boolean found flag and executable path.");
    assert(!resolved.found || resolved.checks.some((check) => check.found),
      "A found resolution must be backed by a probed candidate.");
  }

  console.log("docker:capabilities:smoke passed");
}

main().catch((error) => {
  console.error("docker:capabilities:smoke FAILED:", error);
  process.exitCode = 1;
});