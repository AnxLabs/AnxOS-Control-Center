#!/usr/bin/env node
"use strict";

// Build 216-F finish line: a Build 216 desktop operates a computer running the
// published Build 215 Agent (mixed-version fleet). The 215 Agent comes from a
// Build 215 checkout (--base=<folder> or ANXHOST_BASE_215_DIR) and runs with a
// disposable stand-in game server; the desktop is this checkout, off screen,
// with a disposable owner signed in.
//
// K1 the computer is online and reports the Build 215 Agent
// K2 start, a console command and stop all reach the 215 Agent
// K3 files: write, list and read back a file on the server
// K4 backups: create, list and verify on the 215 Agent
// K5 no renderer errors
//
// Usage: node scripts/mixed-version-215-agent-ui-qa.js --base=<Build 215 checkout>

const fs = require("fs");
const path = require("path");
const { launchRealApp } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const BASE = (process.argv.find((arg) => arg.startsWith("--base=")) || "").slice(7) || process.env.ANXHOST_BASE_215_DIR || "";
const SERVER_ID = "mixed-survival";

const results = [];
function check(id, ok, detail) {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
}

async function main() {
  if (!BASE || !fs.existsSync(path.join(BASE, "agent", "src", "server.js"))) {
    throw new Error("Give a Build 215 checkout with --base=<folder> (or ANXHOST_BASE_215_DIR).");
  }
  const baseBuild = Number(JSON.parse(fs.readFileSync(path.join(BASE, "release.json"), "utf8")).build);
  if (baseBuild !== 215) throw new Error(`--base is Build ${baseBuild}, not 215.`);

  const real = await launchRealApp({ prefix: "anx-216f-mixed-", agentOptions: { agentRoot: BASE, initial: "stopped", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] } });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    const run = (fn, arg) => page.evaluate(fn, arg);

    // K1
    const k1 = await run(async () => {
      const nodeId = getSelectedNodeId();
      const health = await window.anxos.nodes.health(nodeId).catch((error) => ({ error: error?.message }));
      return { nodeId, health };
    });
    const build = JSON.stringify(k1.health).match(/2\.0-build(\d+)|"build":\s*"?(\d+)/);
    const reported = build ? Number(build[1] || build[2]) : null;
    check("K1", /online|connected/i.test(JSON.stringify(k1.health)) && reported === 215, `the computer is online and reports Agent build ${reported} (${JSON.stringify(k1.health).slice(0, 140)})`);

    // K2
    const state = async () => run(async (id) => {
      const list = await window.anxos.instances.list({ nodeId: getSelectedNodeId() });
      const instance = (list?.instances || list || []).find((entry) => entry.id === id);
      return String(instance?.state || instance?.status || "").toLowerCase();
    }, SERVER_ID);
    const waitState = async (wanted, label) => {
      for (let i = 0; i < 120; i += 1) {
        if ((await state()) === wanted) return true;
        await page.waitForTimeout(500);
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await run((id) => window.anxos.instances.start(id, { nodeId: getSelectedNodeId() }), SERVER_ID);
    await waitState("running", "running");
    await run((id) => window.anxos.instances.sendCommand(id, "say mixed fleet", { nodeId: getSelectedNodeId() }), SERVER_ID);
    let heard = false;
    for (let i = 0; i < 40 && !heard; i += 1) {
      const logs = await run((id) => window.anxos.instances.getLogs(id, { nodeId: getSelectedNodeId(), limit: 200 }), SERVER_ID);
      heard = JSON.stringify(logs).includes("mixed fleet");
      if (!heard) await page.waitForTimeout(500);
    }
    await run((id) => window.anxos.instances.stop(id, { nodeId: getSelectedNodeId() }), SERVER_ID);
    await waitState("stopped", "stopped");
    check("K2", heard, `start, a console command ("mixed fleet" ${heard ? "echoed in the log" : "not seen"}) and stop reached the 215 Agent`);

    // K3
    const k3 = await run(async (id) => {
      const options = { nodeId: getSelectedNodeId() };
      await window.anxos.instances.writeFile(id, "mixed-fleet.txt", "written by 216", options);
      const listing = await window.anxos.instances.listFiles(id, ".", options);
      const read = await window.anxos.instances.readFile(id, "mixed-fleet.txt", options);
      return { listed: JSON.stringify(listing).includes("mixed-fleet.txt"), content: read?.content ?? read };
    }, SERVER_ID);
    check("K3", k3.listed && k3.content === "written by 216", `a file written by 216 is listed and reads back (${JSON.stringify(k3.content)})`);

    // K4
    const k4 = await run(async (id) => {
      const nodeId = getSelectedNodeId();
      const created = await window.anxos.backups.create({ nodeId, instanceId: id, type: "full" });
      const backupId = created?.backup?.id || created?.id;
      const list = await window.anxos.backups.list({ nodeId, instanceId: id });
      const verify = await window.anxos.backups.verify(backupId, { nodeId }).catch((error) => ({ error: error?.message }));
      return { backupId, listed: (list?.backups || list || []).some((backup) => backup.id === backupId), verify };
    }, SERVER_ID);
    // The Agent's own outcome (backupService.persistVerificationOutcome).
    const verifiedState = k4.verify?.record?.verification?.state;
    const verified = verifiedState === "verified" && k4.verify?.ok === true;
    check("K4", Boolean(k4.backupId) && k4.listed && verified, `backup ${k4.backupId} created, listed and checked on the 215 Agent (verification ${verifiedState || JSON.stringify(k4.verify).slice(0, 120)})`);

    check("K5", rendererErrors.length === 0, `${rendererErrors.length} renderer errors${rendererErrors.length ? `: ${rendererErrors.slice(0, 3).join(" | ")}` : ""}`);
  } finally {
    await real.close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`Mixed fleet (216 desktop, 215 Agent): ${results.length - failed} of ${results.length} passed.`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
