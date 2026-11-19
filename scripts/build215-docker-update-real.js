#!/usr/bin/env node
"use strict";

// Build 215 real Docker service image update on THIS computer's Docker
// engine. It installs the catalog "docker-nginx" service the way the
// Marketplace does (same request builder, same container create with the
// Docker policy gate), but on an OLDER image placed under the template's tag,
// writes a file into its data volume, then runs the shipped update service
// against the real engine and checks: a newer image was pulled, the service
// answers on the same port, the file in the volume survived, the previous
// container is gone and the volume is kept. A second update must report
// "already newest". Everything it creates is removed at the end.
//
//   node scripts/build215-docker-update-real.js
//
// Downloads nginx:1.26-alpine (older) and nginx:stable-alpine (current).
// Touches only the container anx215-nginx-test and its volume.

const assert = require("assert");
const http = require("http");
const { execFileSync } = require("child_process");
const docker = require("../src/shared/dockerService");
const { buildDockerInstallRequest } = require("../src/shared/marketplaceDockerTemplate");
const { findTemplate } = require("../src/services/marketplaceService");
const { updateDockerService } = require("../src/services/dockerServiceUpdateService");

const NAME = "anx215-nginx-test";
const PORT = 18080;
const OLD_IMAGE = "nginx:1.26-alpine";

function run(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function get(port) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/marker.txt", timeout: 5000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

function cleanup() {
  for (const args of [["rm", "-f", NAME], ["rm", "-f", `${NAME}-before-update`], ["volume", "rm", "-f", `${NAME}-site`]]) {
    try { run(args); } catch {}
  }
}

(async () => {
  const template = findTemplate("docker-nginx");
  assert(template?.docker, "catalog template docker-nginx");
  cleanup();
  const started = Date.now();
  const results = [];
  try {
    // Install the service on an older image under the template's own tag.
    run(["pull", "-q", OLD_IMAGE]);
    run(["tag", OLD_IMAGE, template.docker.image]);
    const oldId = run(["image", "inspect", template.docker.image, "--format", "{{.Id}}"]);
    const { payload } = buildDockerInstallRequest(template, { containerName: NAME, hostPorts: [PORT], portMappings: [`${PORT}:80`], start: true });
    await docker.createContainer(payload);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    run(["exec", NAME, "sh", "-c", "echo anx215-kept-data > /usr/share/nginx/html/marker.txt"]);
    const before = await get(PORT);
    assert.strictEqual(before.body.trim(), "anx215-kept-data", "the service serves the marker before the update");
    const versionBefore = run(["exec", NAME, "nginx", "-v"]).trim() || execFileSync("docker", ["exec", NAME, "nginx", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    results.push(`installed on ${oldId.slice(7, 19)}`);

    const deps = {
      inspectContainer: (name) => docker.inspectContainer(name),
      inspectImage: (image) => docker.inspectImage(image),
      pullImage: (image) => docker.pullImage(image),
      stopContainer: (name) => docker.stopContainer(name),
      startContainer: (name) => docker.startContainer(name),
      renameContainer: (name, next) => docker.renameContainer(name, next),
      createContainer: (spec) => docker.createContainer(spec),
      deleteContainer: (name) => docker.deleteContainer(name),
      getLogs: (name) => docker.getContainerLogs(name, { tail: 30 }),
      findTemplate: async (id) => findTemplate(id),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onStep: (step) => console.log(`  [${step.id}] ${step.state}: ${step.message}`),
    };
    const t0 = Date.now();
    const result = await updateDockerService(NAME, deps);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const newId = run(["inspect", NAME, "--format", "{{.Image}}"]);
    const after = await get(PORT);
    const previousGone = (() => { try { run(["inspect", `${NAME}-before-update`]); return false; } catch { return true; } })();
    const volumeKept = run(["volume", "ls", "-q", "--filter", `name=^${NAME}-site$`]) === `${NAME}-site`;
    const label = run(["inspect", NAME, "--format", "{{index .Config.Labels \"anxos.previous-image\"}}"]);
    let versionAfter = "";
    try { versionAfter = execFileSync("docker", ["exec", NAME, "nginx", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { versionAfter = String(error.stderr || "").trim(); }
    assert.strictEqual(result.updated, true, "updated");
    assert.notStrictEqual(newId, oldId, "runs a different image");
    assert.strictEqual(after.body.trim(), "anx215-kept-data", "same port, data in the volume survived");
    assert(previousGone, "previous container removed");
    assert(volumeKept, "volume kept");
    assert.strictEqual(label, oldId, "previous image recorded");
    results.push(`updated in ${seconds} s: ${oldId.slice(7, 19)} -> ${newId.slice(7, 19)}; data kept; port ${PORT} answers; previous container removed; volume kept`);
    void versionBefore;
    void versionAfter;

    const again = await updateDockerService(NAME, deps);
    assert.strictEqual(again.upToDate, true, "second update reports already newest");
    results.push("second update: already newest, untouched");
    console.log(`PASS Docker service image update on the real engine (${Math.round((Date.now() - started) / 1000)} s)\n  ${results.join("\n  ")}`);
  } catch (error) {
    console.error(`FAIL ${error.code || ""} ${error.message}`);
    if (error.steps) console.error(JSON.stringify(error.steps, null, 2));
    process.exitCode = 1;
  } finally {
    cleanup();
    try { run(["rmi", OLD_IMAGE]); } catch {}
  }
})();
