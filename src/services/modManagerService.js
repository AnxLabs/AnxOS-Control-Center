// Mod Manager: list, install, enable/disable, remove and update Minecraft
// server mods (Fabric, Forge, NeoForge, Quilt) or plugins (Paper, Purpur)
// from Modrinth. Files go through the normal instance file API on the
// instance's node, so every path is confined to the instance data directory
// by the Agent. Downloads come only from Modrinth's CDN and are checked
// against Modrinth's SHA-512 before they are written. What AnxOS installed is
// recorded in a small manifest next to the files, which is what makes
// "update" possible; files dropped in by hand are listed as manual.

const crypto = require("crypto");
const path = require("path");

const serviceRouter = require("./serviceRouter");
const modrinth = require("./providers/modrinthProvider");

const MANIFEST_NAME = ".anxos-mods.json";
const MAX_MOD_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_UPDATES = 60;
const MOD_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+()\[\]-]{0,200}\.jar(?:\.disabled)?$/;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["cdn.modrinth.com"]);

const LOADERS = Object.freeze({
  fabric: { folder: "mods", projectType: "mod", loaders: ["fabric"] },
  quilt: { folder: "mods", projectType: "mod", loaders: ["quilt", "fabric"] },
  forge: { folder: "mods", projectType: "mod", loaders: ["forge"] },
  neoforge: { folder: "mods", projectType: "mod", loaders: ["neoforge"] },
  paper: { folder: "plugins", projectType: "plugin", loaders: ["paper", "spigot", "bukkit"] },
  purpur: { folder: "plugins", projectType: "plugin", loaders: ["purpur", "paper", "spigot", "bukkit"] },
});

let provider = modrinth;
let files = {
  list: (instanceId, folder, options) => serviceRouter.listInstanceFiles(instanceId, folder, options),
  read: (instanceId, filePath, options) => serviceRouter.readInstanceFile(instanceId, filePath, options),
  write: (instanceId, filePath, content, options) => serviceRouter.writeInstanceFile(instanceId, filePath, content, options),
  remove: (instanceId, filePath, options) => serviceRouter.deleteInstanceFile(instanceId, filePath, options),
  rename: (instanceId, oldPath, newPath, options) => serviceRouter.renameInstanceFile(instanceId, oldPath, newPath, options),
  status: (instanceId, options) => serviceRouter.getInstanceStatus(instanceId, options),
};

function createModError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Test seams: a fake provider and file API (no network, no Agent).
function configureModManager(overrides = {}) {
  if (overrides.provider) provider = overrides.provider;
  if (overrides.files) files = { ...files, ...overrides.files };
}

function getModContext(instance = {}) {
  const software = String(instance.serverSoftware || "").trim().toLowerCase();
  const loader = LOADERS[software];
  const minecraftVersion = String(instance.minecraftVersion || "").trim();
  if (!loader || !/^[0-9][0-9A-Za-z.-]{0,31}$/.test(minecraftVersion)) return null;
  // The server root is the instance working directory, relative to its data
  // directory (the root of the instance file API).
  const workingDirectory = String(instance.workingDirectory || "data").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const relativeRoot = workingDirectory === "data" || workingDirectory === "." ? "" : workingDirectory.startsWith("data/") ? workingDirectory.slice(5) : "";
  if (relativeRoot && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(relativeRoot) || relativeRoot.includes("..")) return null;
  return {
    software,
    minecraftVersion,
    projectType: loader.projectType,
    loaders: loader.loaders,
    folder: relativeRoot ? `${relativeRoot}/${loader.folder}` : loader.folder,
  };
}

async function loadContext(payload = {}) {
  const status = await files.status(payload.instanceId, payload);
  const instance = status?.instance || status;
  const context = getModContext(instance);
  if (!context) throw createModError("Mods are supported for Fabric, Forge, NeoForge, Quilt, Paper and Purpur servers with a known Minecraft version.", "MODS_UNSUPPORTED", 409);
  return { instance, context };
}

function assertModFileName(fileName) {
  const name = String(fileName || "");
  if (!MOD_FILE_PATTERN.test(name) || name.includes("/") || name.includes("\\")) throw createModError("That is not a mod file name AnxOS manages.", "MOD_FILE_INVALID");
  return name;
}

async function readManifest(instanceId, context, options) {
  try {
    const file = await files.read(instanceId, `${context.folder}/${MANIFEST_NAME}`, options);
    const parsed = JSON.parse(file?.content || "{}");
    return parsed && typeof parsed.mods === "object" && !Array.isArray(parsed.mods) ? parsed : { schemaVersion: 1, mods: {} };
  } catch {
    return { schemaVersion: 1, mods: {} };
  }
}

async function writeManifest(instanceId, context, manifest, options) {
  await files.write(instanceId, `${context.folder}/${MANIFEST_NAME}`, `${JSON.stringify({ schemaVersion: 1, mods: manifest.mods }, null, 2)}\n`, options);
}

async function listMods(payload = {}) {
  const { instance, context } = await loadContext(payload);
  let entries = [];
  try {
    const listing = await files.list(instance.id, context.folder, payload);
    entries = Array.isArray(listing?.entries) ? listing.entries : Array.isArray(listing?.files) ? listing.files : [];
  } catch (error) {
    if (!/NOT_FOUND|ENOENT|PATH_UNAVAILABLE/.test(String(error?.code || ""))) throw error;
  }
  const manifest = await readManifest(instance.id, context, payload);
  const mods = entries
    .filter((entry) => entry && entry.type !== "directory" && MOD_FILE_PATTERN.test(String(entry.name || "")))
    .map((entry) => {
      const enabled = !String(entry.name).endsWith(".disabled");
      const fileName = enabled ? entry.name : entry.name.replace(/\.disabled$/, "");
      const record = manifest.mods[fileName] || null;
      return {
        fileName,
        enabled,
        size: entry.size ?? null,
        modifiedAt: entry.modifiedAt || null,
        source: record ? "modrinth" : "manual",
        title: record?.title || fileName,
        projectId: record?.projectId || null,
        versionId: record?.versionId || null,
        versionNumber: record?.versionNumber || null,
        projectUrl: record?.projectUrl || null,
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
  return { instanceId: instance.id, ...context, mods };
}

async function searchMods(payload = {}) {
  const { context } = await loadContext(payload);
  return {
    ...context,
    ...(await provider.searchServerProjects({
      query: payload.query,
      projectType: context.projectType,
      minecraftVersion: context.minecraftVersion,
      loaders: context.loaders,
      limit: payload.limit,
      offset: payload.offset,
    })),
  };
}

function selectCompatibleVersion(versions, context) {
  const accepted = new Set(context.loaders);
  const rank = { release: 0, beta: 1, alpha: 2 };
  return (Array.isArray(versions) ? versions : [])
    .filter((version) => (version.minecraftVersions || []).includes(context.minecraftVersion)
      && (version.loaders || []).some((loader) => accepted.has(String(loader).toLowerCase())))
    .sort((left, right) => (rank[left.type] ?? 3) - (rank[right.type] ?? 3)
      || String(right.datePublished || "").localeCompare(String(left.datePublished || "")))[0] || null;
}

async function resolveCompatibleVersion(projectId, context) {
  const version = selectCompatibleVersion(await provider.getVersions(projectId, context.minecraftVersion, ""), context);
  if (!version) throw createModError(`No version of this project supports Minecraft ${context.minecraftVersion} on ${context.software}.`, "MOD_VERSION_NOT_FOUND", 404);
  return version;
}

async function downloadVerified(version) {
  const file = version.primaryFile || (version.files || [])[0];
  if (!file?.url) throw createModError("This version has no downloadable file.", "MOD_FILE_MISSING", 404);
  let host;
  try {
    host = new URL(file.url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) throw createModError("The mod file is not hosted on Modrinth's CDN, so AnxOS will not download it.", "MOD_DOWNLOAD_HOST_NOT_ALLOWED", 422);
  const fileName = assertModFileName(file.filename || path.basename(new URL(file.url).pathname));
  if (Number(file.size) > MAX_MOD_BYTES) throw createModError("The mod file is larger than 64 MB.", "MOD_FILE_TOO_LARGE", 413);
  const [download] = await provider.downloadVersionFiles({ files: [file] }, null, { primaryOnly: true });
  const buffer = download?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_MOD_BYTES) throw createModError("The mod download failed or was too large.", "MOD_DOWNLOAD_FAILED", 502);
  const expected = String(file.hashes?.sha512 || "").toLowerCase();
  const actual = crypto.createHash("sha512").update(buffer).digest("hex");
  if (!/^[a-f0-9]{128}$/.test(expected) || expected !== actual) throw createModError("The downloaded file does not match Modrinth's checksum, so it was not installed.", "MOD_CHECKSUM_MISMATCH", 422);
  return { fileName, buffer, sha512: actual };
}

async function installVersion(instanceId, context, manifest, project, version, options) {
  const { fileName, buffer, sha512 } = await downloadVerified(version);
  await files.write(instanceId, `${context.folder}/${fileName}`, buffer.toString("base64"), { ...options, encoding: "base64" });
  manifest.mods[fileName] = {
    provider: "modrinth",
    projectId: project.id || version.projectId,
    title: project.name || project.title || fileName,
    projectUrl: project.projectUrl || null,
    versionId: version.id,
    versionNumber: version.versionNumber || version.name || version.id,
    sha512,
    installedAt: new Date().toISOString(),
  };
  return fileName;
}

async function installMod(payload = {}) {
  const projectId = String(payload.projectId || "").trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(projectId)) throw createModError("Choose a Modrinth project to install.", "MOD_PROJECT_INVALID");
  const { instance, context } = await loadContext(payload);
  const manifest = await readManifest(instance.id, context, payload);
  const installedProjects = new Set(Object.values(manifest.mods).map((record) => record.projectId));
  if (installedProjects.has(projectId)) throw createModError("That project is already installed. Use Update instead.", "MOD_ALREADY_INSTALLED", 409);
  const installed = [];
  const queue = [projectId];
  // Required dependencies come along (not optional ones), each once.
  while (queue.length && installed.length < 16) {
    const nextId = queue.shift();
    if (installedProjects.has(nextId)) continue;
    installedProjects.add(nextId);
    const project = await provider.getProject(nextId);
    const version = await resolveCompatibleVersion(nextId, context);
    installed.push(await installVersion(instance.id, context, manifest, project, version, payload));
    for (const dependency of version.dependencies || []) {
      if (dependency?.dependency_type === "required" && dependency.project_id && !installedProjects.has(dependency.project_id)) queue.push(dependency.project_id);
    }
  }
  await writeManifest(instance.id, context, manifest, payload);
  return { installed, restartRequired: true };
}

async function setModEnabled(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const { instance, context } = await loadContext(payload);
  const from = payload.enabled ? `${context.folder}/${fileName}.disabled` : `${context.folder}/${fileName}`;
  const to = payload.enabled ? `${context.folder}/${fileName}` : `${context.folder}/${fileName}.disabled`;
  await files.rename(instance.id, from, to, payload);
  return { fileName, enabled: payload.enabled === true, restartRequired: true };
}

async function removeMod(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const { instance, context } = await loadContext(payload);
  const manifest = await readManifest(instance.id, context, payload);
  const target = payload.enabled === false ? `${fileName}.disabled` : fileName;
  await files.remove(instance.id, `${context.folder}/${target}`, payload);
  if (manifest.mods[fileName]) {
    delete manifest.mods[fileName];
    await writeManifest(instance.id, context, manifest, payload);
  }
  return { fileName, removed: true, restartRequired: true };
}

async function checkModUpdates(payload = {}) {
  const { instance, context } = await loadContext(payload);
  const manifest = await readManifest(instance.id, context, payload);
  const updates = [];
  for (const [fileName, record] of Object.entries(manifest.mods).slice(0, MAX_TRACKED_UPDATES)) {
    try {
      const latest = await resolveCompatibleVersion(record.projectId, context);
      if (latest.id !== record.versionId) updates.push({ fileName, title: record.title, currentVersion: record.versionNumber, latestVersion: latest.versionNumber || latest.id, latestVersionId: latest.id });
    } catch {}
  }
  return { instanceId: instance.id, updates };
}

async function updateMod(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const { instance, context } = await loadContext(payload);
  const manifest = await readManifest(instance.id, context, payload);
  const record = manifest.mods[fileName];
  if (!record) throw createModError("Only mods installed by AnxOS can be updated here.", "MOD_NOT_TRACKED", 409);
  const latest = await resolveCompatibleVersion(record.projectId, context);
  if (latest.id === record.versionId) return { fileName, updated: false };
  const project = await provider.getProject(record.projectId);
  // The new file is written before the old one is removed, so a failed
  // download never leaves the server without the mod.
  delete manifest.mods[fileName];
  const newFileName = await installVersion(instance.id, context, manifest, project, latest, payload);
  if (newFileName !== fileName) await files.remove(instance.id, `${context.folder}/${fileName}`, payload).catch(() => {});
  await writeManifest(instance.id, context, manifest, payload);
  return { fileName: newFileName, previousFileName: fileName, updated: true, restartRequired: true };
}

module.exports = {
  MANIFEST_NAME,
  checkModUpdates,
  configureModManager,
  getModContext,
  installMod,
  listMods,
  removeMod,
  searchMods,
  setModEnabled,
  updateMod,
};
