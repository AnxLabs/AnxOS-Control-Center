#!/usr/bin/env node
// Moving a server to another computer: the checks that run before anything is
// copied (migrationPreflightService.evaluateMigration / checkMigration).
//   P1 a stopped server to an online Linux computer with room passes
//   P2 blockers: offline target, same computer, running server, unknown server
//   P3 operating system: Hytale needs Linux, a .exe needs Windows
//   P4 the same server ID on the target blocks (no silent overwrite);
//      the same name only warns
//   P5 a port another target server uses blocks
//   P6 memory: more than the target has blocks, most of it warns
//   P7 disk and size: too little free space blocks, over the move limit blocks
//   P8 checkMigration reads through the injected routes and passes ids through
const assert = require("assert");
const { WORKLOAD_IMPORT_LIMIT_BYTES, checkMigration, evaluateMigration } = require("../src/services/migrationPreflightService");

const GiB = 1024 ** 3;
const source = { id: "pc", displayName: "Gaming PC", platform: "win32", connection: { status: "online" } };
const target = { id: "lab", displayName: "Anxlab", platform: "linux", connection: { status: "online" } };
const server = { id: "smp", displayName: "SMP", state: "stopped", gameAdapter: "minecraft", ports: [25565], memory: "4G" };
const stats = { memory: { total: 16 * GiB }, disk: { free: 200 * GiB } };
const codes = (result, level) => result.items.filter((item) => item.level === level).map((item) => item.id);

(async () => {
  // P1
  {
    const result = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetInstances: [], targetStats: stats, latestBackupBytes: 100 * 1024 * 1024 });
    assert.strictEqual(result.ok, true, JSON.stringify(result.blockers));
    assert.deepStrictEqual(codes(result, "block"), []);
    console.log("  ok P1 a clean move passes");
  }
  // P2
  {
    assert(codes(evaluateMigration({ sourceNode: source, targetNode: { ...target, connection: { status: "offline" } }, instance: server }), "block").includes("target"));
    assert(codes(evaluateMigration({ sourceNode: source, targetNode: source, instance: server }), "block").includes("target"));
    const running = evaluateMigration({ sourceNode: source, targetNode: target, instance: { ...server, state: "running" }, targetStats: stats });
    assert(codes(running, "block").includes("stopped"));
    assert(/Stop SMP first/.test(running.blockers.find((item) => item.id === "stopped").title));
    assert.strictEqual(evaluateMigration({ sourceNode: source, targetNode: target, instance: null }).ok, false);
    console.log("  ok P2 offline, same computer, running and missing servers block");
  }
  // P3
  {
    const hytale = evaluateMigration({ sourceNode: target, targetNode: { ...source, id: "pc2" }, instance: { ...server, gameAdapter: "hytale" }, targetStats: stats });
    assert(codes(hytale, "block").includes("platform"));
    const exe = evaluateMigration({ sourceNode: source, targetNode: target, instance: { ...server, gameAdapter: "custom", command: "C:\\games\\Server.exe" }, targetStats: stats });
    assert(codes(exe, "block").includes("platform"));
    assert(!codes(evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetStats: stats }), "block").includes("platform"));
    console.log("  ok P3 operating system requirements");
  }
  // P4
  {
    const sameId = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetInstances: [{ id: "smp", displayName: "Old SMP" }], targetStats: stats });
    assert(codes(sameId, "block").includes("identity"));
    assert(/replace "Old SMP"/.test(sameId.blockers.find((item) => item.id === "identity").detail));
    const renamed = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetInstanceId: "smp-2", targetInstances: [{ id: "smp", displayName: "SMP" }], targetStats: stats });
    assert(!codes(renamed, "block").includes("identity"), "a different target ID avoids the overwrite");
    assert(codes(renamed, "warn").includes("name"), "the same display name only warns");
    console.log("  ok P4 same ID blocks, same name warns");
  }
  // P5
  {
    const clash = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetInstances: [{ id: "other", displayName: "Creative", ports: [25565, 25575] }], targetStats: stats });
    assert(codes(clash, "block").includes("ports"));
    assert(/Creative \(25565\)/.test(clash.blockers.find((item) => item.id === "ports").detail));
    console.log("  ok P5 port clash blocks");
  }
  // P6
  {
    assert(codes(evaluateMigration({ sourceNode: source, targetNode: target, instance: { ...server, memory: "32G" }, targetStats: stats }), "block").includes("memory"));
    assert(codes(evaluateMigration({ sourceNode: source, targetNode: target, instance: { ...server, memory: "14G" }, targetStats: stats }), "warn").includes("memory"));
    console.log("  ok P6 memory");
  }
  // P7
  {
    const tight = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetStats: { ...stats, disk: { free: 200 * 1024 * 1024 } }, latestBackupBytes: 100 * 1024 * 1024 });
    assert(codes(tight, "block").includes("disk"));
    const huge = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetStats: stats, latestBackupBytes: WORKLOAD_IMPORT_LIMIT_BYTES + 1 });
    assert(codes(huge, "block").includes("size"));
    const unknown = evaluateMigration({ sourceNode: source, targetNode: target, instance: server, targetStats: stats, latestBackupBytes: null });
    assert(codes(unknown, "warn").includes("disk"), "an unknown size is said, not guessed");
    console.log("  ok P7 disk and size");
  }
  // P8
  {
    const calls = [];
    const result = await checkMigration({
      sourceNodeId: "pc",
      targetNodeId: "lab",
      instanceId: "smp",
      targetInstanceId: "smp",
      deps: {
        listNodes: async () => [source, target],
        listInstances: async ({ nodeId }) => { calls.push(`instances:${nodeId}`); return nodeId === "pc" ? { instances: [server] } : [{ id: "other", ports: [27015] }]; },
        listBackups: async ({ nodeId }) => { calls.push(`backups:${nodeId}`); return { backups: [{ instanceId: "smp", type: "full", size: 50 * 1024 * 1024, createdAt: "2026-11-16T00:00:00Z" }, { instanceId: "smp", type: "world", size: 9 }] }; },
        getStats: async ({ nodeId }) => { calls.push(`stats:${nodeId}`); return stats; },
      },
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.blockers));
    assert.deepStrictEqual(calls.sort(), ["backups:pc", "instances:lab", "instances:pc", "stats:lab"]);
    assert(result.items.some((item) => item.id === "disk" && item.level === "ok"), "the latest full backup's size is used for the disk check");
    console.log("  ok P8 reads through the routes it is given");
  }
  console.log("Migration preflight smoke passed (8 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
