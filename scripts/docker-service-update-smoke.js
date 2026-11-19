#!/usr/bin/env node
// Safe image update for AnxOS-installed Docker services
// (src/services/dockerServiceUpdateService.js, Build 215-C), against a fake
// Docker engine:
//   D1  already newest: nothing stopped or recreated
//   D2  newer image: stop, keep the old container renamed, recreate with the
//       same name, ports, volumes and template settings, verify, remove the
//       old container (never its volumes)
//   D3  the new container does not stay up: it is removed and the previous
//       container is renamed back and started; the message separates image
//       rollback from data
//   D4  Compose, unmanaged and template-less containers are refused untouched
//   D5  a mount the template does not explain is refused before any download
//   D6  a leftover "-before-update" container is refused before any stop
//   D7  a stopped service is recreated stopped, without the stability wait
//   D8  only the template's environment keys are carried; ports keep udp/IP
const assert = require("assert");
const { updateDockerService, _test } = require("../src/services/dockerServiceUpdateService");

const TEMPLATE = {
  id: "grafana",
  docker: {
    image: "grafana/grafana:latest",
    environment: { GF_SECURITY_ADMIN_USER: "admin", GF_SECURITY_ADMIN_PASSWORD: "{{secret:admin}}" },
    volumes: [{ name: "data", target: "/var/lib/grafana" }],
    restartPolicy: "unless-stopped",
  },
};

function container(overrides = {}) {
  return {
    Name: "/grafana",
    Image: "sha256:old",
    RestartCount: 0,
    State: { Running: true, Status: "running", ExitCode: 0 },
    Config: {
      Image: "grafana/grafana:latest",
      Env: ["GF_SECURITY_ADMIN_USER=admin", "GF_SECURITY_ADMIN_PASSWORD=generated-secret", "PATH=/usr/share/grafana/bin:/usr/bin", "GF_PATHS_HOME=/usr/share/grafana"],
      Labels: { "anxos.managed": "true", "anxos.template": "grafana", "anxos.template.version": "1.0.0", "org.opencontainers.image.version": "11.0" },
    },
    HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "", HostPort: "3000" }] }, RestartPolicy: { Name: "unless-stopped" }, Memory: 0 },
    Mounts: [{ Type: "volume", Name: "grafana-data", Destination: "/var/lib/grafana", RW: true }],
    ...overrides,
  };
}

function engine({ existing = container(), newImageId = "sha256:new", newStays = true, leftover = false, template = TEMPLATE } = {}) {
  const calls = [];
  const containers = new Map([[existing.Name.replace(/^\//, ""), existing]]);
  if (leftover) containers.set("grafana-before-update", container({ Name: "/grafana-before-update" }));
  let created = null;
  const deps = {
    inspectContainer: async (name) => {
      calls.push(`inspect:${name}`);
      const entry = containers.get(name);
      if (!entry) throw Object.assign(new Error(`No such container: ${name}`), { code: "DOCKER_REQUEST_FAILED" });
      return { inspect: [entry] };
    },
    inspectImage: async (image) => { calls.push(`inspectImage:${image}`); return { inspect: [{ Id: newImageId }] }; },
    pullImage: async (image) => { calls.push(`pull:${image}`); },
    stopContainer: async (name) => { calls.push(`stop:${name}`); containers.get(name).State = { Running: false, Status: "exited", ExitCode: 0 }; },
    startContainer: async (name) => { calls.push(`start:${name}`); containers.get(name).State = { Running: true, Status: "running", ExitCode: 0 }; },
    renameContainer: async (name, next) => { calls.push(`rename:${name}->${next}`); const entry = containers.get(name); containers.delete(name); containers.set(next, { ...entry, Name: `/${next}` }); },
    createContainer: async (spec) => {
      calls.push(`create:${spec.name}`);
      created = spec;
      containers.set(spec.name, { Name: `/${spec.name}`, Image: newImageId, RestartCount: 0, State: newStays ? { Running: true, Status: "running", ExitCode: 0 } : { Running: false, Status: "exited", ExitCode: 1 }, Config: { Labels: spec.labels } });
    },
    deleteContainer: async (name) => { calls.push(`delete:${name}`); containers.delete(name); },
    getLogs: async () => ({ logs: "line one\nfatal: database version mismatch" }),
    findTemplate: async (id) => (id === "grafana" ? template : null),
    sleep: async () => {},
  };
  return { deps, calls, containers, created: () => created };
}

async function expectFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

(async () => {
  // D1
  {
    const fake = engine({ newImageId: "sha256:old" });
    const result = await updateDockerService("grafana", fake.deps);
    assert.strictEqual(result.upToDate, true);
    assert(!fake.calls.some((call) => /^(stop|rename|create|delete):/.test(call)), fake.calls.join(" "));
    console.log("  ok D1 already newest: untouched");
  }

  // D2
  {
    const fake = engine();
    const result = await updateDockerService("grafana", fake.deps);
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.previousImageId, "sha256:old");
    const order = fake.calls.filter((call) => /^(pull|stop|rename|create|delete):/.test(call));
    assert.deepStrictEqual(order, ["pull:grafana/grafana:latest", "stop:grafana", "rename:grafana->grafana-before-update", "create:grafana", "delete:grafana-before-update"]);
    const spec = fake.created();
    assert.deepStrictEqual(spec.volumes, ["grafana-data:/var/lib/grafana"], "same data volume");
    assert.deepStrictEqual(spec.ports, ["3000:3000"]);
    assert.strictEqual(spec.labels["anxos.previous-image"], "sha256:old");
    assert.strictEqual(spec.labels["org.opencontainers.image.version"], undefined, "only anxos labels are carried");
    assert.strictEqual(fake.containers.has("grafana-before-update"), false);
    assert(result.steps.some((step) => step.id === "cleanup" && /volumes and image are kept/.test(step.message)));
    console.log("  ok D2 newer image: replaced, verified, previous container removed (volumes kept)");
  }

  // D3
  {
    const fake = engine({ newStays: false });
    const error = await expectFailure(updateDockerService("grafana", fake.deps));
    assert.strictEqual(error.code, "DOCKER_UPDATE_UNSTABLE");
    assert.strictEqual(error.details.rolledBack, true);
    assert(/database version mismatch/.test(error.details.lastLines));
    const order = fake.calls.filter((call) => /^(stop|rename|create|delete|start):/.test(call));
    assert.deepStrictEqual(order, ["stop:grafana", "rename:grafana->grafana-before-update", "create:grafana", "delete:grafana", "rename:grafana-before-update->grafana", "start:grafana"]);
    assert.strictEqual(fake.containers.get("grafana").Image, "sha256:old", "the previous container is back");
    const rollback = error.steps.find((step) => step.id === "rollback" && step.state === "complete");
    assert(/old image/.test(rollback.message) && /may not read it/.test(rollback.message), "image rollback is not described as data recovery");
    console.log("  ok D3 unstable new image: previous container restored");
  }

  // D4
  {
    const compose = engine({ existing: container({ Config: { ...container().Config, Labels: { "com.docker.compose.project": "immich", "anxos.managed": "true" } } }) });
    assert.strictEqual((await expectFailure(updateDockerService("grafana", compose.deps))).code, "DOCKER_UPDATE_COMPOSE");
    const unmanaged = engine({ existing: container({ Config: { ...container().Config, Labels: {} } }) });
    assert.strictEqual((await expectFailure(updateDockerService("grafana", unmanaged.deps))).code, "DOCKER_UPDATE_NOT_MANAGED");
    const noTemplate = engine({ template: null });
    assert.strictEqual((await expectFailure(updateDockerService("grafana", noTemplate.deps))).code, "DOCKER_UPDATE_TEMPLATE_MISSING");
    for (const fake of [compose, unmanaged, noTemplate]) assert(!fake.calls.some((call) => /^(pull|stop|rename|create|delete):/.test(call)));
    console.log("  ok D4 Compose, unmanaged and template-less containers refused untouched");
  }

  // D5
  {
    const fake = engine({ existing: container({ Mounts: [...container().Mounts, { Type: "bind", Source: "/etc", Destination: "/host-etc", RW: true }] }) });
    const error = await expectFailure(updateDockerService("grafana", fake.deps));
    assert.strictEqual(error.code, "DOCKER_UPDATE_UNEXPECTED_MOUNT");
    assert(!fake.calls.some((call) => /^(pull|stop):/.test(call)));
    console.log("  ok D5 unexplained mount refused before download");
  }

  // D6
  {
    const fake = engine({ leftover: true });
    const error = await expectFailure(updateDockerService("grafana", fake.deps));
    assert.strictEqual(error.code, "DOCKER_UPDATE_LEFTOVER");
    assert(!fake.calls.some((call) => /^(stop|rename|create):/.test(call)));
    console.log("  ok D6 leftover fallback container refused before any stop");
  }

  // D7
  {
    const fake = engine({ existing: container({ State: { Running: false, Status: "exited", ExitCode: 0 } }) });
    const result = await updateDockerService("grafana", fake.deps);
    assert.strictEqual(result.updated, true);
    assert.strictEqual(fake.created().start, false, "recreated stopped");
    assert(!fake.calls.some((call) => call.startsWith("stop:")));
    assert(!result.steps.some((step) => step.id === "verify"));
    console.log("  ok D7 stopped service recreated stopped");
  }

  // D8
  {
    const spec = _test.buildReplacementSpec(container({ HostConfig: { PortBindings: { "27015/udp": [{ HostIp: "127.0.0.1", HostPort: "27015" }], "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8081" }] }, RestartPolicy: { Name: "always" }, Memory: 2147483648 } }), TEMPLATE);
    assert.deepStrictEqual(Object.keys(spec.environment).sort(), ["GF_SECURITY_ADMIN_PASSWORD", "GF_SECURITY_ADMIN_USER"], "image defaults such as PATH are not pinned");
    assert.strictEqual(spec.environment.GF_SECURITY_ADMIN_PASSWORD, "generated-secret", "the generated password is kept");
    assert.deepStrictEqual(spec.ports.sort(), ["127.0.0.1:27015:27015/udp", "8081:8080"]);
    assert.strictEqual(spec.restartPolicy, "always");
    assert.strictEqual(spec.memory, "2048m");
    console.log("  ok D8 only template settings carried; ports keep protocol and address");
  }

  console.log("Docker service update smoke passed (8 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
