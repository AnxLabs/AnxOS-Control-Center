// Add-on manager (Phase 5): Minecraft server mods (Fabric, Forge, NeoForge,
// Quilt) and plugins (Paper, Purpur, Spigot) from Modrinth, from CurseForge
// through AnxOS's approved CurseForge route, or imported by hand.
//
// Safety rules, all enforced here in the main process:
// - Files go through the normal instance file API on the server's computer,
//   so every path is confined to the instance data directory by the Agent.
// - Only the server's own Minecraft version and loader are matched; a
//   client-only project is refused; the server runtime is never changed.
// - Downloads come only from the provider's CDN hosts and are checked
//   against the provider's hash before anything is written. CurseForge files
//   whose authors disallow third-party downloads are refused, never scraped.
// - Required dependencies are shown in an install plan and installed only
//   when the plan was approved. An install writes every file or none.
// - Updates and removals keep the previous file in a backup folder outside
//   the mods/plugins folder, so a bad update can be rolled back.
// - One add-on job runs per server at a time.
// What AnxOS installed is recorded in a small manifest next to the files;
// files dropped in by hand are listed as manual.

const crypto = require("crypto");
const path = require("path");

const serviceRouter = require("./serviceRouter");

const MANIFEST_NAME = ".anxos-mods.json";
const BACKUP_FOLDER = ".anxos-addon-backups";
const MAX_MOD_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_UPDATES = 60;
const MAX_DEPENDENCIES = 16;
const MAX_HISTORY = 50;
const MOD_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+()\[\]-]{0,200}\.jar(?:\.disabled)?$/;

const LOADERS = Object.freeze({
  fabric: { folder: "mods", projectType: "mod", loaders: ["fabric"] },
  quilt: { folder: "mods", projectType: "mod", loaders: ["quilt", "fabric"] },
  forge: { folder: "mods", projectType: "mod", loaders: ["forge"] },
  neoforge: { folder: "mods", projectType: "mod", loaders: ["neoforge"] },
  paper: { folder: "plugins", projectType: "plugin", loaders: ["paper", "spigot", "bukkit"] },
  purpur: { folder: "plugins", projectType: "plugin", loaders: ["purpur", "paper", "spigot", "bukkit"] },
  spigot: { folder: "plugins", projectType: "plugin", loaders: ["spigot", "bukkit"] },
});

function createModError(message, code, statusCode = 400, details = undefined) {
  return Object.assign(new Error(message), { code, statusCode }, details ? { details } : {});
}

// ---------------------------------------------------------------------------
// Provider adapters. Each turns its provider's data into one shape:
//   project: { id, name, author, description, iconUrl, projectUrl, downloads, clientOnly }
//   version: { id, projectId, versionNumber, type, datePublished, minecraftVersions,
//              loaders, file: { url, fileName, size, hash: { algorithm, value } },
//              dependencies: [{ projectId, kind: "required"|"optional"|"incompatible" }] }
// ---------------------------------------------------------------------------

function createModrinthAdapter(modrinth) {
  const toVersion = (version) => {
    const file = version.primaryFile || (version.files || [])[0] || null;
    return {
      id: version.id,
      projectId: version.projectId,
      versionNumber: version.versionNumber || version.name || version.id,
      type: version.type || "release",
      datePublished: version.datePublished || "",
      minecraftVersions: version.minecraftVersions || [],
      loaders: (version.loaders || []).map((loader) => String(loader).toLowerCase()),
      file: file ? {
        url: file.url,
        fileName: file.filename || (file.url ? path.basename(new URL(file.url).pathname) : ""),
        size: Number(file.size) || null,
        hash: { algorithm: "sha512", value: String(file.hashes?.sha512 || "").toLowerCase() },
      } : null,
      dependencies: (version.dependencies || [])
        .filter((dependency) => dependency && dependency.project_id)
        .map((dependency) => ({ projectId: String(dependency.project_id), kind: dependency.dependency_type === "required" ? "required" : dependency.dependency_type === "incompatible" ? "incompatible" : "optional" })),
    };
  };
  return {
    id: "modrinth",
    label: "Modrinth",
    downloadHosts: new Set(["cdn.modrinth.com"]),
    projectIdPattern: /^[A-Za-z0-9]{1,64}$/,
    available: () => ({ available: true }),
    async search(options) {
      const result = await modrinth.searchServerProjects(options);
      return { hits: (result.hits || []).map((hit) => ({ ...hit, provider: "modrinth" })), total: result.total || 0, offset: result.offset || 0, limit: result.limit || 0 };
    },
    async getProject(projectId) {
      const project = await modrinth.getProject(projectId);
      return {
        id: String(project.id || projectId),
        name: project.name || project.title || String(projectId),
        author: project.author || "",
        description: project.description || "",
        iconUrl: project.iconUrl || null,
        projectUrl: project.projectUrl || null,
        downloads: project.downloads || 0,
        clientOnly: String(project.serverSide || "").toLowerCase() === "unsupported",
      };
    },
    async getVersions(projectId, context) {
      return (await modrinth.getVersions(projectId, context.minecraftVersion, "")).map(toVersion);
    },
    async download(version) {
      const [download] = await modrinth.downloadVersionFiles({ files: [{ url: version.file.url, filename: version.file.fileName, size: version.file.size, hashes: { sha512: version.file.hash.value }, primary: true }] }, null, { primaryOnly: true });
      return download?.buffer;
    },
    async identifyByHash(sha512) {
      if (typeof modrinth.getVersionByHash !== "function") return null;
      const version = await modrinth.getVersionByHash(sha512);
      return version ? toVersion(version) : null;
    },
  };
}

// CurseForge: class 6 is Minecraft mods, class 5 Bukkit plugins.
const CURSEFORGE_RELATION = { 3: "required", 2: "optional", 5: "incompatible" };
function createCurseForgeAdapter(curseforge, options = {}) {
  const toVersion = (file) => {
    const hashes = Array.isArray(file.raw?.hashes) ? file.raw.hashes : [];
    const sha1 = hashes.find((entry) => Number(entry?.algo) === 1)?.value || "";
    return {
      id: String(file.id),
      projectId: String(file.projectId || file.raw?.modId || ""),
      versionNumber: file.name || file.fileName || String(file.id),
      type: { 1: "release", 2: "beta", 3: "alpha" }[Number(file.releaseType)] || "release",
      datePublished: file.raw?.fileDate || "",
      minecraftVersions: (file.minecraftVersions || []).map(String),
      loaders: (file.loaders || []).map((loader) => String(loader).toLowerCase()),
      file: {
        url: file.downloadUrl || null,
        fileName: file.fileName,
        size: Number(file.raw?.fileLength) || null,
        hash: { algorithm: "sha1", value: String(sha1).toLowerCase() },
      },
      dependencies: (file.dependencies || [])
        .filter((dependency) => dependency && dependency.modId)
        .map((dependency) => ({ projectId: String(dependency.modId), kind: CURSEFORGE_RELATION[Number(dependency.relationType)] || "optional" })),
    };
  };
  return {
    id: "curseforge",
    label: "CurseForge",
    downloadHosts: new Set(["edge.forgecdn.net", "mediafilez.forgecdn.net"]),
    projectIdPattern: /^\d{1,10}$/,
    available() {
      try {
        curseforge.ensureConfigured(options.config || {});
        return { available: true };
      } catch (error) {
        return { available: false, reason: "CurseForge isn't set up in this copy of AnxHost. Use Modrinth, or download the file from CurseForge yourself and import it here." , code: error?.code || "CURSEFORGE_UNAVAILABLE" };
      }
    },
    async search(searchOptions) {
      const result = await curseforge.searchServerProjects({ ...searchOptions, config: options.config || {} });
      return { hits: (result.results || []).map((project) => ({ ...project, raw: undefined, provider: "curseforge", id: String(project.id) })), total: result.total || 0, offset: result.offset || 0, limit: result.limit || 0 };
    },
    async getProject(projectId) {
      const project = await curseforge.getMod(projectId, options.config || {});
      return {
        id: String(project.id || projectId),
        name: project.name || String(projectId),
        author: project.author || "",
        description: project.description || "",
        iconUrl: project.iconUrl || null,
        projectUrl: project.websiteUrl || null,
        downloads: project.downloads || 0,
        clientOnly: false,
        distributionAllowed: project.raw?.allowModDistribution !== false,
      };
    },
    async getVersions(projectId, context) {
      const loader = context.projectType === "mod" ? context.loaders[0] : "";
      return (await curseforge.getFiles(projectId, context.minecraftVersion, loader, options.config || {})).map(toVersion);
    },
    async download(version) {
      const result = await curseforge.downloadFile({ id: version.id, projectId: version.projectId, fileName: version.file.fileName, downloadUrl: version.file.url }, "", { config: options.config || {} });
      return result?.buffer;
    },
  };
}

// ---------------------------------------------------------------------------
// Test seams: fake providers and file API (no network, no Agent).
// ---------------------------------------------------------------------------

let providers = null;
function getProviders() {
  if (!providers) {
    providers = {
      modrinth: createModrinthAdapter(require("./providers/modrinthProvider")),
      curseforge: createCurseForgeAdapter(require("./providers/curseforgeProvider")),
    };
  }
  return providers;
}

let files = {
  list: (instanceId, folder, options) => serviceRouter.listInstanceFiles(instanceId, folder, options),
  read: (instanceId, filePath, options) => serviceRouter.readInstanceFile(instanceId, filePath, options),
  write: (instanceId, filePath, content, options) => serviceRouter.writeInstanceFile(instanceId, filePath, content, options),
  remove: (instanceId, filePath, options) => serviceRouter.deleteInstanceFile(instanceId, filePath, options),
  rename: (instanceId, oldPath, newPath, options) => serviceRouter.renameInstanceFile(instanceId, oldPath, newPath, options),
  status: (instanceId, options) => serviceRouter.getInstanceStatus(instanceId, options),
};

function configureModManager(overrides = {}) {
  // `provider` (one Modrinth-shaped provider) is kept for older tests.
  if (overrides.provider) providers = { ...getProviders(), modrinth: createModrinthAdapter(overrides.provider) };
  if (overrides.providers) providers = { ...getProviders(), ...overrides.providers };
  if (overrides.files) files = { ...files, ...overrides.files };
}

function getProvider(providerId) {
  const provider = getProviders()[String(providerId || "modrinth")];
  if (!provider) throw createModError("Choose Modrinth or CurseForge.", "MOD_PROVIDER_UNKNOWN");
  return provider;
}

// ---------------------------------------------------------------------------
// Context, manifest, locks
// ---------------------------------------------------------------------------

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
  const folder = relativeRoot ? `${relativeRoot}/${loader.folder}` : loader.folder;
  return {
    software,
    minecraftVersion,
    projectType: loader.projectType,
    loaders: loader.loaders,
    folder,
    backupFolder: relativeRoot ? `${relativeRoot}/${BACKUP_FOLDER}/${loader.folder}` : `${BACKUP_FOLDER}/${loader.folder}`,
  };
}

async function loadContext(payload = {}) {
  const status = await files.status(payload.instanceId, payload);
  const instance = status?.instance || status;
  const context = getModContext(instance);
  if (!context) throw createModError("Add-ons are supported for Paper, Purpur, Spigot, Fabric, Forge, NeoForge and Quilt servers with a known Minecraft version.", "MODS_UNSUPPORTED", 409);
  return { instance, context, running: ["running", "starting", "restarting"].includes(String(instance?.state || "").toLowerCase()) };
}

function assertModFileName(fileName) {
  const name = String(fileName || "");
  if (!MOD_FILE_PATTERN.test(name) || name.includes("/") || name.includes("\\")) throw createModError("That is not an add-on file name AnxHost manages.", "MOD_FILE_INVALID");
  return name;
}

async function readManifest(instanceId, context, options) {
  try {
    const file = await files.read(instanceId, `${context.folder}/${MANIFEST_NAME}`, options);
    const parsed = JSON.parse(file?.content || "{}");
    if (!parsed || typeof parsed.mods !== "object" || Array.isArray(parsed.mods)) return { mods: {}, history: [] };
    // Records written before providers existed are Modrinth records.
    for (const record of Object.values(parsed.mods)) if (record && !record.provider) record.provider = "modrinth";
    return { mods: parsed.mods, history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY) : [] };
  } catch {
    return { mods: {}, history: [] };
  }
}

async function writeManifest(instanceId, context, manifest, options) {
  await files.write(instanceId, `${context.folder}/${MANIFEST_NAME}`, `${JSON.stringify({ schemaVersion: 2, mods: manifest.mods, history: manifest.history.slice(0, MAX_HISTORY) }, null, 2)}\n`, options);
}

function addHistory(manifest, entry) {
  manifest.history = [{ at: new Date().toISOString(), ...entry }, ...(manifest.history || [])].slice(0, MAX_HISTORY);
}

const activeJobs = new Map();
async function withJob(instanceId, label, work) {
  const key = String(instanceId || "");
  if (activeJobs.has(key)) throw createModError(`Another add-on change is still running on this server (${activeJobs.get(key)}). Wait for it to finish.`, "MOD_JOB_IN_PROGRESS", 409);
  activeJobs.set(key, label);
  try {
    return await work();
  } finally {
    activeJobs.delete(key);
  }
}

function fileInUse(error) {
  return /EBUSY|EPERM|EACCES|in use|locked/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

function normalizedTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function recordKey(record) {
  return `${record.provider || "modrinth"}:${record.projectId}`;
}

// ---------------------------------------------------------------------------
// Listing and search
// ---------------------------------------------------------------------------

async function listFolder(instanceId, folder, options) {
  try {
    const listing = await files.list(instanceId, folder, options);
    return Array.isArray(listing?.entries) ? listing.entries : Array.isArray(listing?.files) ? listing.files : [];
  } catch (error) {
    if (!/NOT_FOUND|ENOENT|PATH_UNAVAILABLE/.test(String(error?.code || ""))) throw error;
    return [];
  }
}

async function listMods(payload = {}) {
  const { instance, context, running } = await loadContext(payload);
  const entries = await listFolder(instance.id, context.folder, payload);
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
        source: record ? record.provider || "modrinth" : "manual",
        provider: record ? record.provider || "modrinth" : null,
        title: record?.title || fileName,
        iconUrl: record?.iconUrl || null,
        projectId: record?.projectId || null,
        versionId: record?.versionId || null,
        versionNumber: record?.versionNumber || null,
        projectUrl: record?.projectUrl || null,
        dependencyOf: record?.dependencyOf || null,
        canRollBack: Boolean(record?.previous?.backupPath),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
  // Dependency warnings: a required dependency recorded at install time that
  // is no longer present (removed or renamed by hand).
  const presentProjects = new Set(mods.filter((mod) => mod.enabled).map((mod) => mod.projectId).filter(Boolean));
  const warnings = [];
  for (const [fileName, record] of Object.entries(manifest.mods)) {
    for (const dependency of record.requires || []) {
      if (!presentProjects.has(dependency.projectId)) warnings.push({ fileName, title: record.title, missing: dependency.name || dependency.projectId });
    }
  }
  return { instanceId: instance.id, ...context, running, mods, warnings, history: manifest.history, providers: describeProviders() };
}

function describeProviders() {
  return Object.values(getProviders()).map((provider) => ({ id: provider.id, label: provider.label, ...provider.available() }));
}

async function searchMods(payload = {}) {
  const { context } = await loadContext(payload);
  const provider = getProvider(payload.provider);
  const availability = provider.available();
  if (!availability.available) throw createModError(availability.reason, "MOD_PROVIDER_UNAVAILABLE", 503);
  return {
    ...context,
    provider: provider.id,
    ...(await provider.search({
      query: payload.query,
      projectType: context.projectType,
      minecraftVersion: context.minecraftVersion,
      loaders: context.loaders,
      loader: context.projectType === "mod" ? context.loaders[0] : "",
      limit: payload.limit,
      offset: payload.offset,
    })),
  };
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

function selectCompatibleVersion(versions, context) {
  const accepted = new Set(context.loaders);
  const rank = { release: 0, beta: 1, alpha: 2 };
  return (Array.isArray(versions) ? versions : [])
    .filter((version) => (version.minecraftVersions || []).includes(context.minecraftVersion)
      // Plugin files on CurseForge carry no loader; their class already says Bukkit.
      && ((version.loaders || []).length === 0 ? context.projectType === "plugin" : (version.loaders || []).some((loader) => accepted.has(String(loader).toLowerCase())))
      && version.file && version.file.fileName)
    .sort((left, right) => (rank[left.type] ?? 3) - (rank[right.type] ?? 3)
      || String(right.datePublished || "").localeCompare(String(left.datePublished || "")))[0] || null;
}

async function resolveCompatibleVersion(provider, projectId, context) {
  const version = selectCompatibleVersion(await provider.getVersions(projectId, context), context);
  if (!version) throw createModError(`No version supports Minecraft ${context.minecraftVersion} on ${context.software}.`, "MOD_VERSION_NOT_FOUND", 404);
  return version;
}

function assertProjectId(provider, projectId) {
  const id = String(projectId || "").trim();
  if (!provider.projectIdPattern.test(id)) throw createModError(`Choose a ${provider.label} project to install.`, "MOD_PROJECT_INVALID");
  return id;
}

// The install plan: what would be installed, what is missing or conflicts.
async function buildPlan(payload, loaded) {
  const provider = getProvider(payload.provider);
  const availability = provider.available();
  if (!availability.available) throw createModError(availability.reason, "MOD_PROVIDER_UNAVAILABLE", 503);
  const projectId = assertProjectId(provider, payload.projectId);
  const { instance, context, running } = loaded;
  const manifest = await readManifest(instance.id, context, payload);
  const entries = await listFolder(instance.id, context.folder, payload);
  const presentFiles = new Set(entries.map((entry) => String(entry?.name || "").replace(/\.disabled$/, "")));
  const installedKeys = new Set(Object.values(manifest.mods).map(recordKey));
  const installedTitles = new Map(Object.values(manifest.mods).map((record) => [normalizedTitle(record.title), record]));

  const project = await provider.getProject(projectId);
  if (project.clientOnly) throw createModError(`${project.name} only runs on players' computers (client-side), so it can't be installed on a server.`, "MOD_CLIENT_ONLY", 422);
  if (project.distributionAllowed === false) {
    throw createModError(`${project.name}'s author doesn't allow downloads outside CurseForge. Download it from CurseForge yourself, then use Import a file.`, "MOD_DISTRIBUTION_NOT_ALLOWED", 422, { projectUrl: project.projectUrl });
  }
  if (installedKeys.has(`${provider.id}:${project.id}`)) throw createModError(`${project.name} is already installed. Use Update instead.`, "MOD_ALREADY_INSTALLED", 409);
  const sameTitle = installedTitles.get(normalizedTitle(project.name));
  if (sameTitle) throw createModError(`${project.name} looks already installed (from ${sameTitle.provider === "curseforge" ? "CurseForge" : "Modrinth"}). Remove that copy first to avoid running it twice.`, "MOD_ALREADY_INSTALLED", 409);

  const version = await resolveCompatibleVersion(provider, project.id, context);
  if (presentFiles.has(version.file.fileName)) throw createModError(`${version.file.fileName} is already in ${context.folder}/. Remove it first to install it from ${provider.label}.`, "MOD_ALREADY_INSTALLED", 409);

  const dependencies = [];
  const problems = [];
  const conflicts = [];
  const installedProjectIds = new Set(Object.values(manifest.mods).filter((record) => (record.provider || "modrinth") === provider.id).map((record) => String(record.projectId)));
  const queued = new Set([project.id]);
  const queue = [{ version, parent: project.name }];
  while (queue.length) {
    const { version: current, parent } = queue.shift();
    for (const dependency of current.dependencies) {
      if (dependency.kind === "incompatible" && installedProjectIds.has(dependency.projectId)) {
        const record = Object.values(manifest.mods).find((entry) => String(entry.projectId) === dependency.projectId);
        conflicts.push({ projectId: dependency.projectId, name: record?.title || dependency.projectId, reason: `${parent} says it doesn't work with ${record?.title || "an installed add-on"}.` });
      }
      if (dependency.kind !== "required" || installedProjectIds.has(dependency.projectId) || queued.has(dependency.projectId)) continue;
      queued.add(dependency.projectId);
      if (dependencies.length >= MAX_DEPENDENCIES) {
        problems.push({ projectId: dependency.projectId, name: dependency.projectId, reason: "Too many required add-ons to install in one step." });
        continue;
      }
      try {
        const dependencyProject = await provider.getProject(dependency.projectId);
        if (dependencyProject.clientOnly) {
          problems.push({ projectId: dependency.projectId, name: dependencyProject.name, reason: "This required add-on is client-only." });
          continue;
        }
        const dependencyVersion = await resolveCompatibleVersion(provider, dependency.projectId, context);
        dependencies.push({ project: dependencyProject, version: dependencyVersion, requiredBy: parent });
        queue.push({ version: dependencyVersion, parent: dependencyProject.name });
      } catch (error) {
        problems.push({ projectId: dependency.projectId, name: dependency.projectId, reason: error?.code === "MOD_VERSION_NOT_FOUND" ? `No version supports Minecraft ${context.minecraftVersion} on ${context.software}.` : "It could not be looked up." });
      }
    }
  }
  return { provider, instance, context, running, manifest, project, version, dependencies, problems, conflicts };
}

function summarizePlan(plan) {
  const describe = (project, version, extra = {}) => ({
    projectId: project.id,
    name: project.name,
    author: project.author,
    iconUrl: project.iconUrl,
    projectUrl: project.projectUrl,
    versionNumber: version.versionNumber,
    fileName: version.file.fileName,
    size: version.file.size,
    ...extra,
  });
  return {
    provider: plan.provider.id,
    folder: plan.context.folder,
    minecraftVersion: plan.context.minecraftVersion,
    software: plan.context.software,
    project: describe(plan.project, plan.version),
    dependencies: plan.dependencies.map((entry) => describe(entry.project, entry.version, { requiredBy: entry.requiredBy })),
    problems: plan.problems,
    conflicts: plan.conflicts,
    canInstall: plan.problems.length === 0 && plan.conflicts.length === 0,
    restartRequired: plan.running,
  };
}

async function planInstall(payload = {}) {
  return summarizePlan(await buildPlan(payload, await loadContext(payload)));
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function downloadVerified(provider, version) {
  const file = version.file;
  if (!file?.url) throw createModError("This version has no download the author allows. Download it from the project page and import it here.", "MOD_FILE_MISSING", 404);
  let host = "";
  try { host = new URL(file.url).hostname.toLowerCase(); } catch {}
  if (!provider.downloadHosts.has(host)) throw createModError(`The file is not hosted on ${provider.label}'s own download servers, so AnxHost will not download it.`, "MOD_DOWNLOAD_HOST_NOT_ALLOWED", 422);
  const fileName = assertModFileName(file.fileName);
  if (Number(file.size) > MAX_MOD_BYTES) throw createModError("The file is larger than 64 MB.", "MOD_FILE_TOO_LARGE", 413);
  const expected = String(file.hash?.value || "").toLowerCase();
  const algorithm = file.hash?.algorithm === "sha1" ? "sha1" : "sha512";
  const pattern = algorithm === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{128}$/;
  if (!pattern.test(expected)) throw createModError(`${provider.label} published no checksum for this file, so it can't be verified.`, "MOD_CHECKSUM_MISSING", 422);
  let buffer;
  try {
    buffer = await provider.download(version);
  } catch (error) {
    throw createModError(`The download from ${provider.label} failed. Check the connection and try again.`, "MOD_DOWNLOAD_FAILED", 502, { cause: error?.code || error?.message });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_MOD_BYTES) throw createModError("The download failed or was too large.", "MOD_DOWNLOAD_FAILED", 502);
  const actual = crypto.createHash(algorithm).update(buffer).digest("hex");
  if (expected !== actual) throw createModError(`The downloaded file does not match ${provider.label}'s checksum, so it was not installed.`, "MOD_CHECKSUM_MISMATCH", 422);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw createModError("The downloaded file is not a Java archive.", "MOD_FILE_INVALID", 422);
  return { fileName, buffer, hash: { algorithm, value: actual } };
}

function manifestRecord(provider, project, version, download, extra = {}) {
  return {
    provider: provider.id,
    projectId: String(project.id || version.projectId),
    title: project.name || download.fileName,
    projectUrl: project.projectUrl || null,
    iconUrl: project.iconUrl || null,
    versionId: String(version.id),
    versionNumber: version.versionNumber || String(version.id),
    [download.hash.algorithm]: download.hash.value,
    requires: (version.dependencies || []).filter((dependency) => dependency.kind === "required").map((dependency) => ({ projectId: dependency.projectId })),
    installedAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

async function installMod(payload = {}) {
  const loaded = await loadContext(payload);
  return withJob(loaded.instance.id, "install", async () => {
    const plan = await buildPlan(payload, loaded);
    const summary = summarizePlan(plan);
    if (!summary.canInstall) throw createModError("This add-on can't be installed as it is. Review the problems in the install plan.", "MOD_INSTALL_BLOCKED", 409, { plan: summary });
    const approved = new Set((Array.isArray(payload.approvedDependencies) ? payload.approvedDependencies : []).map(String));
    const unapproved = plan.dependencies.filter((entry) => !approved.has(String(entry.project.id)));
    if (unapproved.length) throw createModError(`${plan.project.name} needs ${unapproved.map((entry) => entry.project.name).join(", ")}. Approve them to continue.`, "MOD_DEPENDENCIES_NEED_APPROVAL", 409, { plan: summary });

    // Download and verify everything first; write only when all succeeded.
    const items = [{ project: plan.project, version: plan.version }, ...plan.dependencies];
    const downloads = [];
    for (const item of items) downloads.push({ ...item, download: await downloadVerified(plan.provider, item.version) });
    const written = [];
    try {
      for (const item of downloads) {
        await files.write(plan.instance.id, `${plan.context.folder}/${item.download.fileName}`, item.download.buffer.toString("base64"), { ...payload, encoding: "base64" });
        written.push(item.download.fileName);
      }
    } catch (error) {
      for (const fileName of written) await files.remove(plan.instance.id, `${plan.context.folder}/${fileName}`, payload).catch(() => {});
      throw createModError("Installing failed part-way, so nothing was installed. Try again.", "MOD_INSTALL_FAILED", 500, { cause: error?.code || error?.message });
    }
    downloads.forEach((item, index) => {
      plan.manifest.mods[item.download.fileName] = manifestRecord(plan.provider, item.project, item.version, item.download, index === 0 ? {} : { dependencyOf: String(plan.project.id) });
    });
    addHistory(plan.manifest, { action: "install", title: plan.project.name, versionNumber: plan.version.versionNumber, provider: plan.provider.id, dependencies: plan.dependencies.map((entry) => entry.project.name) });
    await writeManifest(plan.instance.id, plan.context, plan.manifest, payload);
    return { installed: written, restartRequired: plan.running, plan: summary };
  });
}

async function setModEnabled(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const { instance, context, running } = await loadContext(payload);
  return withJob(instance.id, payload.enabled ? "enable" : "disable", async () => {
    const from = payload.enabled ? `${context.folder}/${fileName}.disabled` : `${context.folder}/${fileName}`;
    const to = payload.enabled ? `${context.folder}/${fileName}` : `${context.folder}/${fileName}.disabled`;
    try {
      await files.rename(instance.id, from, to, payload);
    } catch (error) {
      if (fileInUse(error)) throw createModError("The server is using this file. Stop the server, then try again.", "MOD_FILE_IN_USE", 409);
      throw error;
    }
    const manifest = await readManifest(instance.id, context, payload);
    addHistory(manifest, { action: payload.enabled ? "enable" : "disable", title: manifest.mods[fileName]?.title || fileName });
    await writeManifest(instance.id, context, manifest, payload);
    return { fileName, enabled: payload.enabled === true, restartRequired: running };
  });
}

// Removing keeps a copy in the backup folder (outside mods/plugins, renamed
// .bak so no loader picks it up).
async function removeMod(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const { instance, context, running } = await loadContext(payload);
  return withJob(instance.id, "remove", async () => {
    const manifest = await readManifest(instance.id, context, payload);
    const target = payload.enabled === false ? `${fileName}.disabled` : fileName;
    try {
      await files.rename(instance.id, `${context.folder}/${target}`, `${context.backupFolder}/${fileName}.removed.bak`, payload);
    } catch (error) {
      if (fileInUse(error)) throw createModError("The server is using this file. Stop the server, then remove it.", "MOD_FILE_IN_USE", 409);
      throw error;
    }
    const title = manifest.mods[fileName]?.title || fileName;
    delete manifest.mods[fileName];
    addHistory(manifest, { action: "remove", title });
    await writeManifest(instance.id, context, manifest, payload);
    return { fileName, removed: true, restartRequired: running, backupPath: `${context.backupFolder}/${fileName}.removed.bak` };
  });
}

async function checkModUpdates(payload = {}) {
  const { instance, context } = await loadContext(payload);
  const manifest = await readManifest(instance.id, context, payload);
  const updates = [];
  const failed = [];
  for (const [fileName, record] of Object.entries(manifest.mods).slice(0, MAX_TRACKED_UPDATES)) {
    try {
      const provider = getProvider(record.provider);
      if (!provider.available().available) continue;
      const latest = await resolveCompatibleVersion(provider, record.projectId, context);
      if (String(latest.id) !== String(record.versionId)) updates.push({ fileName, title: record.title, provider: provider.id, currentVersion: record.versionNumber, latestVersion: latest.versionNumber || latest.id, latestVersionId: latest.id });
    } catch {
      failed.push({ fileName, title: record.title });
    }
  }
  return { instanceId: instance.id, updates, failed };
}

async function updateOne(loaded, manifest, fileName, payload) {
  const { instance, context } = loaded;
  const record = manifest.mods[fileName];
  if (!record) throw createModError("Only add-ons installed by AnxHost can be updated here.", "MOD_NOT_TRACKED", 409);
  const provider = getProvider(record.provider);
  const latest = await resolveCompatibleVersion(provider, record.projectId, context);
  if (String(latest.id) === String(record.versionId)) return { fileName, updated: false };
  const project = await provider.getProject(record.projectId);
  // Download and verify the new file before touching the old one.
  const download = await downloadVerified(provider, latest);
  const backupPath = `${context.backupFolder}/${fileName}.previous.bak`;
  try {
    await files.rename(instance.id, `${context.folder}/${fileName}`, backupPath, payload);
  } catch (error) {
    if (fileInUse(error)) throw createModError("The server is using this file. Stop the server, then update.", "MOD_FILE_IN_USE", 409);
    throw error;
  }
  try {
    await files.write(instance.id, `${context.folder}/${download.fileName}`, download.buffer.toString("base64"), { ...payload, encoding: "base64" });
  } catch (error) {
    // Put the old file back so a failed update never leaves the server without it.
    await files.rename(instance.id, backupPath, `${context.folder}/${fileName}`, payload).catch(() => {});
    throw createModError("The update could not be written, so the previous version was kept.", "MOD_UPDATE_FAILED", 500, { cause: error?.code || error?.message });
  }
  delete manifest.mods[fileName];
  manifest.mods[download.fileName] = manifestRecord(provider, project, latest, download, {
    dependencyOf: record.dependencyOf || undefined,
    previous: { fileName, versionId: record.versionId, versionNumber: record.versionNumber, backupPath, sha512: record.sha512, sha1: record.sha1 },
  });
  addHistory(manifest, { action: "update", title: record.title, from: record.versionNumber, versionNumber: latest.versionNumber, provider: provider.id });
  return { fileName: download.fileName, previousFileName: fileName, updated: true };
}

async function updateMod(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const loaded = await loadContext(payload);
  return withJob(loaded.instance.id, "update", async () => {
    const manifest = await readManifest(loaded.instance.id, loaded.context, payload);
    const result = await updateOne(loaded, manifest, fileName, payload);
    if (result.updated) await writeManifest(loaded.instance.id, loaded.context, manifest, payload);
    return { ...result, restartRequired: result.updated && loaded.running };
  });
}

// Update All Compatible: each add-on on its own; one failure never stops or
// undoes the others.
async function updateAllMods(payload = {}) {
  const loaded = await loadContext(payload);
  return withJob(loaded.instance.id, "update all", async () => {
    const manifest = await readManifest(loaded.instance.id, loaded.context, payload);
    const updated = [];
    const failed = [];
    for (const fileName of Object.keys(manifest.mods).slice(0, MAX_TRACKED_UPDATES)) {
      try {
        const result = await updateOne(loaded, manifest, fileName, payload);
        if (result.updated) updated.push({ fileName: result.fileName, title: manifest.mods[result.fileName]?.title || fileName });
      } catch (error) {
        failed.push({ fileName, title: manifest.mods[fileName]?.title || fileName, message: error?.message || "Update failed." });
      }
    }
    if (updated.length) await writeManifest(loaded.instance.id, loaded.context, manifest, payload);
    return { updated, failed, restartRequired: updated.length > 0 && loaded.running };
  });
}

// Roll back an update: the kept previous file comes back, the newer one goes
// to the backup folder.
async function rollbackMod(payload = {}) {
  const fileName = assertModFileName(payload.fileName).replace(/\.disabled$/, "");
  const loaded = await loadContext(payload);
  const { instance, context, running } = loaded;
  return withJob(instance.id, "roll back", async () => {
    const manifest = await readManifest(instance.id, context, payload);
    const record = manifest.mods[fileName];
    const previous = record?.previous;
    if (!previous?.backupPath || !String(previous.backupPath).startsWith(`${context.backupFolder}/`)) throw createModError("There is no earlier version of this add-on to go back to.", "MOD_NO_PREVIOUS_VERSION", 409);
    const previousName = assertModFileName(previous.fileName);
    try {
      await files.rename(instance.id, `${context.folder}/${fileName}`, `${context.backupFolder}/${fileName}.rolledback.bak`, payload);
      await files.rename(instance.id, previous.backupPath, `${context.folder}/${previousName}`, payload);
    } catch (error) {
      if (fileInUse(error)) throw createModError("The server is using this file. Stop the server, then roll back.", "MOD_FILE_IN_USE", 409);
      throw error;
    }
    delete manifest.mods[fileName];
    manifest.mods[previousName] = { ...record, versionId: previous.versionId, versionNumber: previous.versionNumber, sha512: previous.sha512, sha1: previous.sha1, previous: undefined, installedAt: new Date().toISOString() };
    addHistory(manifest, { action: "rollback", title: record.title, from: record.versionNumber, versionNumber: previous.versionNumber });
    await writeManifest(instance.id, context, manifest, payload);
    return { fileName: previousName, rolledBack: true, restartRequired: running };
  });
}

// Manual import of a .jar the user chose. The content arrives base64-encoded
// from the renderer's file picker; nothing is downloaded.
async function importModFile(payload = {}) {
  const fileName = assertModFileName(path.basename(String(payload.fileName || "")).replace(/\.disabled$/, ""));
  const buffer = Buffer.from(String(payload.contentBase64 || ""), "base64");
  if (!buffer.length || buffer.length > MAX_MOD_BYTES) throw createModError("Choose a .jar file up to 64 MB.", "MOD_FILE_TOO_LARGE", 413);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw createModError("That file is not a Java archive (.jar).", "MOD_FILE_INVALID", 422);
  const { instance, context, running } = await loadContext(payload);
  return withJob(instance.id, "import", async () => {
    const entries = await listFolder(instance.id, context.folder, payload);
    if (entries.some((entry) => String(entry?.name || "").replace(/\.disabled$/, "") === fileName)) throw createModError(`${fileName} is already in ${context.folder}/.`, "MOD_ALREADY_INSTALLED", 409);
    const manifest = await readManifest(instance.id, context, payload);
    const sha512 = crypto.createHash("sha512").update(buffer).digest("hex");
    const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
    const duplicate = Object.entries(manifest.mods).find(([, record]) => record.sha512 === sha512 || record.sha1 === sha1);
    if (duplicate) throw createModError(`This file is already installed as ${duplicate[1].title}.`, "MOD_ALREADY_INSTALLED", 409);
    // A file Modrinth knows (same SHA-512) is recorded as that project, so it
    // can be updated and is caught as a duplicate later. Unknown files stay manual.
    let identified = null;
    try {
      const modrinth = getProvider("modrinth");
      const version = modrinth.identifyByHash ? await modrinth.identifyByHash(sha512) : null;
      if (version) {
        const installedKeys = new Set(Object.values(manifest.mods).map(recordKey));
        if (installedKeys.has(`modrinth:${version.projectId}`)) throw createModError("This add-on is already installed from Modrinth.", "MOD_ALREADY_INSTALLED", 409);
        const project = await modrinth.getProject(version.projectId);
        identified = { project, version, compatible: Boolean(selectCompatibleVersion([{ ...version, file: { fileName } }], context)) };
      }
    } catch (error) {
      if (error?.code === "MOD_ALREADY_INSTALLED") throw error;
    }
    await files.write(instance.id, `${context.folder}/${fileName}`, buffer.toString("base64"), { ...payload, encoding: "base64" });
    if (identified) {
      manifest.mods[fileName] = manifestRecord(getProvider("modrinth"), identified.project, identified.version, { fileName, hash: { algorithm: "sha512", value: sha512 } }, { importedByHand: true });
    }
    addHistory(manifest, { action: "import", title: identified?.project?.name || fileName });
    await writeManifest(instance.id, context, manifest, payload);
    return {
      fileName,
      imported: true,
      identifiedAs: identified ? { provider: "modrinth", name: identified.project.name, versionNumber: identified.version.versionNumber } : null,
      compatibilityWarning: identified && !identified.compatible ? `Modrinth lists this file for other Minecraft versions or loaders than this ${context.software} ${context.minecraftVersion} server. It may not load.` : null,
      restartRequired: running,
    };
  });
}

module.exports = {
  BACKUP_FOLDER,
  MANIFEST_NAME,
  checkModUpdates,
  configureModManager,
  createCurseForgeAdapter,
  createModrinthAdapter,
  getModContext,
  importModFile,
  installMod,
  listMods,
  planInstall,
  removeMod,
  rollbackMod,
  searchMods,
  selectCompatibleVersion,
  setModEnabled,
  updateAllMods,
  updateMod,
};
