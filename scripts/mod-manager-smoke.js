// Add-on manager (Phase 5): Modrinth and CurseForge mods/plugins for Paper,
// Purpur, Spigot, Fabric, Forge, NeoForge and Quilt servers.
// Hermetic: fake Modrinth and CurseForge providers and an in-memory instance
// file system stand in for the network and the Agent.
//   A1 context: folder, loaders, unsupported servers
//   A2 install plan: dependencies need approval, client-only and duplicates refused
//   A3 lifecycle: approved install, list, disable/enable, updates, Update All,
//      rollback, remove keeps a backup, history
//   A4 safety: checksum, CDN host, path traversal, all-or-nothing install,
//      one job at a time, incompatibility conflict, file in use
//   A5 CurseForge: sha1 verified, distribution refusal, unavailable provider
//   A6 manual import: zip check, duplicate refusal, identified by hash
//   A7 IPC and UI contract
// Run: node scripts/mod-manager-smoke.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const mods = require("../src/services/modManagerService");

const sha512 = (buffer) => crypto.createHash("sha512").update(buffer).digest("hex");
const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");
// A tiny stand-in for a .jar: zip magic plus the name.
const jar = (name) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(name)]);

function modrinthVersion(projectId, id, versionNumber, fileName, extra = {}) {
  return {
    id,
    projectId,
    versionNumber,
    type: "release",
    datePublished: extra.datePublished || "2026-09-01",
    minecraftVersions: extra.minecraftVersions || ["1.21.1"],
    loaders: extra.loaders || ["fabric"],
    dependencies: extra.dependencies || [],
    files: [{ url: extra.url || `https://cdn.modrinth.com/data/${projectId}/${fileName}`, filename: fileName, size: 10, hashes: { sha512: extra.sha512 || sha512(jar(fileName)) }, primary: true }],
  };
}

function createWorld() {
  const files = new Map();
  let instance = { id: "fabric-server", serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data", state: "Stopped" };
  const downloads = [];
  let failWritesMatching = null;
  let lockedFiles = new Set();
  let downloadGate = null;
  const versions = {
    lithium: [
      modrinthVersion("lithium", "lith-1", "0.13.0", "lithium-0.13.0.jar", { dependencies: [{ project_id: "fabricapi", dependency_type: "required" }, { project_id: "optional-thing", dependency_type: "optional" }] }),
      modrinthVersion("lithium", "lith-old-mc", "0.12.0", "lithium-0.12.0.jar", { minecraftVersions: ["1.20.4"], datePublished: "2026-10-01" }),
    ],
    fabricapi: [modrinthVersion("fabricapi", "fapi-1", "0.100.0", "fabric-api-0.100.0.jar")],
    sodium: [modrinthVersion("sodium", "sod-1", "1.0", "sodium-1.0.jar")],
    badhash: [modrinthVersion("badhash", "bad-1", "1", "bad.jar", { sha512: "0".repeat(128) })],
    offcdn: [modrinthVersion("offcdn", "off-1", "1", "x.jar", { url: "https://evil.example.com/x.jar" })],
    traversal: [modrinthVersion("traversal", "trav-1", "1", "../../config.json")],
    hater: [modrinthVersion("hater", "hate-1", "1", "hater-1.jar", { dependencies: [{ project_id: "fabricapi", dependency_type: "incompatible" }] })],
    needsmissing: [modrinthVersion("needsmissing", "nm-1", "1", "needs-1.jar", { dependencies: [{ project_id: "ghost", dependency_type: "required" }] })],
    slow: [modrinthVersion("slow", "slow-1", "1", "slow-1.jar")],
    twofiles: [modrinthVersion("twofiles", "two-1", "1", "two-1.jar", { dependencies: [{ project_id: "breaks", dependency_type: "required" }] })],
    breaks: [modrinthVersion("breaks", "brk-1", "1", "breaks-1.jar")],
  };
  const projects = { fabricapi: "Fabric API", sodium: "Sodium" };
  const modrinth = {
    searchServerProjects: async (options) => ({ hits: [{ id: "lithium", name: "Lithium", author: "Caffeine", downloads: 5 }], total: 1, received: options }),
    getProject: async (id) => ({ id, name: projects[id] || id[0].toUpperCase() + id.slice(1), projectUrl: `https://modrinth.com/mod/${id}`, serverSide: id === "sodium" ? "unsupported" : "optional" }),
    getVersions: async (id) => versions[id] || [],
    downloadVersionFiles: async (version) => {
      const file = version.files[0];
      downloads.push(file.url);
      if (downloadGate) await downloadGate;
      return [{ fileName: file.filename, buffer: jar(file.filename) }];
    },
    getVersionByHash: async (hash) => Object.values(versions).flat().find((version) => version.files[0]?.hashes.sha512 === hash) || null,
  };
  // CurseForge-shaped provider (normalized like curseforgeProvider does).
  const cfFile = (projectId, id, fileName, extra = {}) => ({ id, projectId, name: fileName, fileName, downloadUrl: extra.url === undefined ? `https://edge.forgecdn.net/files/${id}/${fileName}` : extra.url, minecraftVersions: ["1.21.1"], loaders: extra.loaders || [], releaseType: 1, dependencies: extra.dependencies || [], raw: { fileDate: "2026-09-01", fileLength: 10, hashes: [{ algo: 1, value: extra.sha1 || sha1(jar(fileName)) }] } });
  const cfFiles = {
    101: [cfFile(101, 9001, "worldedit-7.jar")],
    102: [cfFile(102, 9002, "locked-1.jar", { url: null })],
    103: [cfFile(103, 9003, "badsha-1.jar", { sha1: "0".repeat(40) })],
  };
  let curseforgeConfigured = true;
  const curseforge = {
    ensureConfigured: () => { if (!curseforgeConfigured) throw Object.assign(new Error("not configured"), { code: "CURSEFORGE_API_KEY_MISSING" }); return true; },
    searchServerProjects: async (options) => ({ results: [{ id: 101, name: "WorldEdit", author: "EngineHub" }], total: 1, offset: 0, limit: 20, received: options }),
    getMod: async (id) => ({ id, name: { 101: "WorldEdit", 102: "Locked Plugin", 103: "Bad Sha" }[id] || String(id), websiteUrl: `https://www.curseforge.com/minecraft/bukkit-plugins/${id}`, raw: { allowModDistribution: Number(id) !== 102 } }),
    getFiles: async (id) => cfFiles[id] || [],
    downloadFile: async (file) => { downloads.push(file.downloadUrl); return { buffer: jar(file.fileName) }; },
  };
  mods.configureModManager({
    providers: { modrinth: mods.createModrinthAdapter(modrinth), curseforge: mods.createCurseForgeAdapter(curseforge) },
    files: {
      status: async () => ({ instance }),
      list: async (instanceId, folder) => {
        const prefix = `${folder}/`;
        const entries = [...files.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")).map((key) => ({ name: key.slice(prefix.length), type: "file", size: files.get(key).length }));
        if (!entries.length && ![...files.keys()].some((key) => key.startsWith(prefix))) throw Object.assign(new Error("missing"), { code: "PATH_NOT_FOUND" });
        return { entries };
      },
      read: async (instanceId, filePath) => {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" });
        return { content: files.get(filePath).toString("utf8") };
      },
      write: async (instanceId, filePath, content, options = {}) => {
        if (failWritesMatching && failWritesMatching.test(filePath)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        files.set(filePath, options.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(String(content)));
      },
      remove: async (instanceId, filePath) => {
        assert(files.delete(filePath), `deleted ${filePath}`);
      },
      rename: async (instanceId, from, to) => {
        if (lockedFiles.has(from)) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
        assert(files.has(from), `rename source ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
    },
  });
  return {
    files,
    versions,
    downloads,
    setInstance: (next) => { instance = next; },
    failWrites: (pattern) => { failWritesMatching = pattern; },
    lock: (paths) => { lockedFiles = new Set(paths); },
    gateDownloads: (promise) => { downloadGate = promise; },
    setCurseForgeConfigured: (value) => { curseforgeConfigured = value; },
  };
}

const manifestOf = (world, folder = "mods") => JSON.parse(world.files.get(`${folder}/${mods.MANIFEST_NAME}`).toString("utf8"));

function contextChecks() {
  assert.deepStrictEqual(mods.getModContext({ serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data" }), { software: "fabric", minecraftVersion: "1.21.1", projectType: "mod", loaders: ["fabric"], folder: "mods", backupFolder: ".anxos-addon-backups/mods" });
  assert.strictEqual(mods.getModContext({ serverSoftware: "Paper", minecraftVersion: "1.21.4", workingDirectory: "data/server" }).folder, "server/plugins", "Plugins live next to the server jar.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Paper", minecraftVersion: "1.21.4", workingDirectory: "data/server" }).backupFolder, "server/.anxos-addon-backups/plugins", "Backups live outside the plugins folder.");
  assert.deepStrictEqual(mods.getModContext({ serverSoftware: "Quilt", minecraftVersion: "1.20.1" }).loaders, ["quilt", "fabric"], "Quilt also accepts Fabric mods.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Vanilla", minecraftVersion: "1.21.1" }), null, "Vanilla can't load add-ons.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Fabric" }), null, "A known Minecraft version is required.");
  assert.strictEqual(mods.getModContext({ serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data/../../etc" }), null, "A working directory that escapes is refused.");
  console.log("PASS A1 context: folders, loaders, unsupported servers");
}

async function planChecks() {
  const world = createWorld();
  const plan = await mods.planInstall({ instanceId: "fabric-server", projectId: "lithium" });
  assert.deepStrictEqual([plan.project.name, plan.project.versionNumber, plan.dependencies.map((dependency) => dependency.name)], ["Lithium", "0.13.0", ["Fabric API"]], "The plan lists required dependencies only, for this server's version.");
  assert.strictEqual(plan.canInstall, true);
  assert.deepStrictEqual(world.downloads, [], "Planning downloads nothing.");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "lithium" }), (error) => error.code === "MOD_DEPENDENCIES_NEED_APPROVAL" && error.details.plan.dependencies.length === 1, "Dependencies are installed only once approved.");
  assert.deepStrictEqual([...world.files.keys()], [], "An unapproved install writes nothing.");
  await assert.rejects(mods.planInstall({ instanceId: "fabric-server", projectId: "sodium" }), (error) => error.code === "MOD_CLIENT_ONLY", "Client-only projects are refused on a server.");
  const blocked = await mods.planInstall({ instanceId: "fabric-server", projectId: "needsmissing" });
  assert.strictEqual(blocked.canInstall, false, "A required dependency without a compatible version blocks the install.");
  assert.match(blocked.problems[0].reason, /1\.21\.1/);
  console.log("PASS A2 install plan: dependencies need approval, client-only refused, missing dependencies block");
  return world;
}

async function lifecycleChecks() {
  const world = createWorld();
  let listed = await mods.listMods({ instanceId: "fabric-server" });
  assert.deepStrictEqual(listed.mods, [], "An instance without a mods folder lists nothing.");
  assert.deepStrictEqual(listed.providers.map((provider) => `${provider.id}:${provider.available}`), ["modrinth:true", "curseforge:true"]);

  const search = await mods.searchMods({ instanceId: "fabric-server", query: "lith" });
  assert.deepStrictEqual(search.hits.map((hit) => `${hit.name}:${hit.provider}`), ["Lithium:modrinth"], "Search is scoped and tagged with its provider.");

  const installed = await mods.installMod({ instanceId: "fabric-server", projectId: "lithium", approvedDependencies: ["fabricapi"] });
  assert.deepStrictEqual(installed.installed, ["lithium-0.13.0.jar", "fabric-api-0.100.0.jar"], "Approved required dependencies come along; optional ones do not.");
  assert(world.files.get("mods/lithium-0.13.0.jar").equals(jar("lithium-0.13.0.jar")), "The verified bytes are written.");
  let manifest = manifestOf(world);
  assert.strictEqual(manifest.mods["lithium-0.13.0.jar"].versionId, "lith-1");
  assert.strictEqual(manifest.mods["fabric-api-0.100.0.jar"].dependencyOf, "lithium", "Dependencies remember what needed them.");
  assert.strictEqual(manifest.history[0].action, "install");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "lithium" }), (error) => error.code === "MOD_ALREADY_INSTALLED");

  world.files.set("mods/handmade.jar", jar("handmade"));
  listed = await mods.listMods({ instanceId: "fabric-server" });
  assert.deepStrictEqual(listed.mods.map((mod) => `${mod.title}:${mod.source}:${mod.enabled}`), ["Fabric API:modrinth:true", "handmade.jar:manual:true", "Lithium:modrinth:true"]);

  await mods.setModEnabled({ instanceId: "fabric-server", fileName: "handmade.jar", enabled: false });
  assert(world.files.has("mods/handmade.jar.disabled") && !world.files.has("mods/handmade.jar"), "Disabling renames the jar so the server skips it.");
  await mods.setModEnabled({ instanceId: "fabric-server", fileName: "handmade.jar", enabled: true });
  assert(world.files.has("mods/handmade.jar"));

  assert.deepStrictEqual((await mods.checkModUpdates({ instanceId: "fabric-server" })).updates, []);
  world.versions.lithium.unshift(modrinthVersion("lithium", "lith-2", "0.14.0", "lithium-0.14.0.jar", { datePublished: "2026-10-20" }));
  world.versions.fabricapi.unshift(modrinthVersion("fabricapi", "fapi-2", "0.101.0", "fabric-api-0.101.0.jar", { datePublished: "2026-10-21" }));
  const updates = (await mods.checkModUpdates({ instanceId: "fabric-server" })).updates;
  assert.deepStrictEqual(updates.map((update) => `${update.fileName}->${update.latestVersion}`).sort(), ["fabric-api-0.100.0.jar->0.101.0", "lithium-0.13.0.jar->0.14.0"], "Only AnxOS-installed add-ons with a newer compatible version are offered.");
  const updated = await mods.updateMod({ instanceId: "fabric-server", fileName: "lithium-0.13.0.jar" });
  assert.deepStrictEqual({ to: updated.fileName, from: updated.previousFileName }, { to: "lithium-0.14.0.jar", from: "lithium-0.13.0.jar" });
  assert(world.files.has("mods/lithium-0.14.0.jar") && !world.files.has("mods/lithium-0.13.0.jar"), "The new jar replaces the old one in mods/.");
  assert(world.files.has(".anxos-addon-backups/mods/lithium-0.13.0.jar.previous.bak"), "The previous jar is kept outside mods/ for rollback.");
  await assert.rejects(mods.updateMod({ instanceId: "fabric-server", fileName: "handmade.jar" }), (error) => error.code === "MOD_NOT_TRACKED");

  const all = await mods.updateAllMods({ instanceId: "fabric-server" });
  assert.deepStrictEqual(all.updated.map((entry) => entry.fileName), ["fabric-api-0.101.0.jar"], "Update All updates every compatible add-on with an update.");
  assert.deepStrictEqual(all.failed, []);

  const rolled = await mods.rollbackMod({ instanceId: "fabric-server", fileName: "lithium-0.14.0.jar" });
  assert.strictEqual(rolled.fileName, "lithium-0.13.0.jar");
  assert(world.files.has("mods/lithium-0.13.0.jar") && !world.files.has("mods/lithium-0.14.0.jar"), "Rolling back restores the previous jar.");
  assert.strictEqual(manifestOf(world).mods["lithium-0.13.0.jar"].versionId, "lith-1");
  await assert.rejects(mods.rollbackMod({ instanceId: "fabric-server", fileName: "lithium-0.13.0.jar" }), (error) => error.code === "MOD_NO_PREVIOUS_VERSION");

  const removed = await mods.removeMod({ instanceId: "fabric-server", fileName: "lithium-0.13.0.jar" });
  assert(!world.files.has("mods/lithium-0.13.0.jar"));
  assert(world.files.has(removed.backupPath), "A removed add-on is kept in the backup folder.");
  manifest = manifestOf(world);
  assert(!manifest.mods["lithium-0.13.0.jar"], "Removal clears the manifest entry.");
  assert.deepStrictEqual(manifest.history.slice(0, 4).map((entry) => entry.action), ["remove", "rollback", "update", "update"], "Every change is in the history, newest first.");

  world.setInstance({ id: "fabric-server", serverSoftware: "Fabric", minecraftVersion: "1.21.1", workingDirectory: "data", state: "Running" });
  const enabled = await mods.setModEnabled({ instanceId: "fabric-server", fileName: "handmade.jar", enabled: false });
  assert.strictEqual(enabled.restartRequired, true, "Changes on a running server say a restart is needed.");
  console.log("PASS A3 lifecycle: approved install, list, toggle, update, Update All, rollback, remove with backup, history");
  return world;
}

async function safetyChecks() {
  const world = createWorld();
  const before = new Set(world.files.keys());
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "badhash" }), (error) => error.code === "MOD_CHECKSUM_MISMATCH");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "offcdn" }), (error) => error.code === "MOD_DOWNLOAD_HOST_NOT_ALLOWED");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "traversal" }), (error) => error.code === "MOD_FILE_INVALID");
  assert.deepStrictEqual([...world.files.keys()].filter((key) => !before.has(key)), [], "A refused install writes nothing.");
  assert(!world.downloads.includes("https://evil.example.com/x.jar"), "Off-CDN files are never downloaded.");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "../x" }), (error) => error.code === "MOD_PROJECT_INVALID");
  await assert.rejects(mods.removeMod({ instanceId: "fabric-server", fileName: "../server.properties" }), (error) => error.code === "MOD_FILE_INVALID");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "nothing" }), (error) => error.code === "MOD_VERSION_NOT_FOUND");

  // All-or-nothing: the dependency's write fails, so the first file is removed again.
  world.failWrites(/breaks-1\.jar$/);
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "twofiles", approvedDependencies: ["breaks"] }), (error) => error.code === "MOD_INSTALL_FAILED");
  assert(!world.files.has("mods/two-1.jar"), "A failed install leaves no partial files.");
  world.failWrites(null);

  // One job at a time per server.
  let release;
  world.gateDownloads(new Promise((resolve) => { release = resolve; }));
  const first = mods.installMod({ instanceId: "fabric-server", projectId: "slow" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "lithium", approvedDependencies: ["fabricapi"] }), (error) => error.code === "MOD_JOB_IN_PROGRESS");
  release();
  world.gateDownloads(null);
  await first;

  // A declared incompatibility with something installed blocks the install.
  await mods.installMod({ instanceId: "fabric-server", projectId: "fabricapi" });
  const conflict = await mods.planInstall({ instanceId: "fabric-server", projectId: "hater" });
  assert.strictEqual(conflict.canInstall, false);
  assert.match(conflict.conflicts[0].reason, /Fabric API/);

  // A file the running server holds open is reported plainly, not as a crash.
  world.lock(["mods/slow-1.jar"]);
  await assert.rejects(mods.removeMod({ instanceId: "fabric-server", fileName: "slow-1.jar" }), (error) => error.code === "MOD_FILE_IN_USE");
  world.lock([]);
  assert(world.files.has("mods/slow-1.jar"), "A refused removal keeps the file.");

  world.setInstance({ id: "vanilla", serverSoftware: "Vanilla", minecraftVersion: "1.21.1" });
  await assert.rejects(mods.listMods({ instanceId: "vanilla" }), (error) => error.code === "MODS_UNSUPPORTED");
  console.log("PASS A4 safety: checksum, CDN host, traversal, all-or-nothing, one job at a time, conflicts, file in use");
}

async function curseForgeChecks() {
  const world = createWorld();
  world.setInstance({ id: "paper-server", serverSoftware: "Paper", minecraftVersion: "1.21.1", workingDirectory: "data", state: "Stopped" });
  const search = await mods.searchMods({ instanceId: "paper-server", provider: "curseforge", query: "world" });
  assert.deepStrictEqual(search.hits.map((hit) => `${hit.name}:${hit.provider}`), ["WorldEdit:curseforge"]);
  const result = await mods.installMod({ instanceId: "paper-server", provider: "curseforge", projectId: "101" });
  assert.deepStrictEqual(result.installed, ["worldedit-7.jar"], "A Bukkit plugin installs into plugins/ after its SHA-1 matches.");
  assert.strictEqual(manifestOf(world, "plugins").mods["worldedit-7.jar"].provider, "curseforge");
  await assert.rejects(mods.installMod({ instanceId: "paper-server", provider: "curseforge", projectId: "102" }), (error) => error.code === "MOD_DISTRIBUTION_NOT_ALLOWED", "Files the author keeps on CurseForge are never fetched another way.");
  await assert.rejects(mods.installMod({ instanceId: "paper-server", provider: "curseforge", projectId: "103" }), (error) => error.code === "MOD_CHECKSUM_MISMATCH");
  await assert.rejects(mods.installMod({ instanceId: "paper-server", provider: "modrinth", projectId: "lithium" }), (error) => error.code === "MOD_VERSION_NOT_FOUND", "Fabric mods never install into a Paper server.");
  world.setCurseForgeConfigured(false);
  const listed = await mods.listMods({ instanceId: "paper-server" });
  assert.deepStrictEqual(listed.providers.find((provider) => provider.id === "curseforge").available, false, "An unconfigured CurseForge is reported as unavailable.");
  await assert.rejects(mods.searchMods({ instanceId: "paper-server", provider: "curseforge", query: "x" }), (error) => error.code === "MOD_PROVIDER_UNAVAILABLE");
  assert(world.downloads.every((url) => /^https:\/\/(cdn\.modrinth\.com|edge\.forgecdn\.net)\//.test(url)), "Downloads only from provider CDNs.");
  console.log("PASS A5 CurseForge: SHA-1 verified, distribution refusal, wrong loader refused, unavailable reported");
}

async function importChecks() {
  const world = createWorld();
  await assert.rejects(mods.importModFile({ instanceId: "fabric-server", fileName: "notes.jar", contentBase64: Buffer.from("hello").toString("base64") }), (error) => error.code === "MOD_FILE_INVALID", "Only real archives are accepted.");
  const traversal = await mods.importModFile({ instanceId: "fabric-server", fileName: "../evil.jar", contentBase64: jar("x").toString("base64") });
  assert.strictEqual(traversal.fileName, "evil.jar", "A path in the chosen file name is dropped; it lands in mods/.");
  assert([...world.files.keys()].every((key) => key.startsWith("mods/")), "Imports never write outside mods/.");
  const plain = await mods.importModFile({ instanceId: "fabric-server", fileName: "my-plugin.jar", contentBase64: jar("my-plugin").toString("base64") });
  assert.strictEqual(plain.identifiedAs, null, "An unknown file stays a manual add-on.");
  assert(world.files.has("mods/my-plugin.jar") && world.files.has("mods/evil.jar"));
  const known = await mods.importModFile({ instanceId: "fabric-server", fileName: "lithium-0.13.0.jar", contentBase64: jar("lithium-0.13.0.jar").toString("base64") });
  assert.strictEqual(known.identifiedAs.name, "Lithium", "A file Modrinth knows is recorded as that project.");
  assert.strictEqual(manifestOf(world).mods["lithium-0.13.0.jar"].provider, "modrinth");
  await assert.rejects(mods.importModFile({ instanceId: "fabric-server", fileName: "copy-of-lithium.jar", contentBase64: jar("lithium-0.13.0.jar").toString("base64") }), (error) => error.code === "MOD_ALREADY_INSTALLED", "The same file under another name is a duplicate.");
  await assert.rejects(mods.installMod({ instanceId: "fabric-server", projectId: "lithium", approvedDependencies: ["fabricapi"] }), (error) => error.code === "MOD_ALREADY_INSTALLED", "An imported project is not installed twice.");
  console.log("PASS A6 manual import: archives only, identified by hash, duplicates refused");
}

function contractChecks() {
  const root = path.join(__dirname, "..");
  const ipc = fs.readFileSync(path.join(root, "src", "ipc", "instancesIpc.js"), "utf8");
  for (const channel of ["install", "setEnabled", "remove", "update", "updateAll", "rollback", "import"]) {
    assert(new RegExp(`"instances:mods:${channel}"[\\s\\S]{0,120}requirePermission\\("files:write"`).test(ipc), `instances:mods:${channel} needs files:write.`);
  }
  for (const channel of ["list", "search", "checkUpdates", "plan"]) {
    assert(new RegExp(`"instances:mods:${channel}"[\\s\\S]{0,120}requirePermission\\("instance:read"`).test(ipc), `instances:mods:${channel} is instance:read.`);
  }
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(html.includes('data-instance-tab="mods" hidden>Add-ons') && html.includes('data-instance-panel="mods"'), "The Add-ons tab exists and is hidden unless supported.");
  const ui = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert(ui.includes('} else if (activeInstanceTab === "mods") {') && ui.includes("refreshInstanceMods();"), "Opening the tab loads the list.");
  console.log("PASS A7 IPC permissions and UI contract");
}

async function main() {
  contextChecks();
  await planChecks();
  await lifecycleChecks();
  await safetyChecks();
  await curseForgeChecks();
  await importChecks();
  contractChecks();
  console.log("Add-on manager smoke passed (7 checks).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
