const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const bundledRuntimePaths = require("./bundledRuntimePaths");

const JAVA_RULES = Object.freeze([
  { min: [1, 20, 5], major: 21, source: "minecraft-version" },
  { min: [1, 18, 0], major: 17, source: "minecraft-version" },
  { min: [1, 17, 0], major: 16, source: "minecraft-version" },
  { min: [0, 0, 0], major: 8, source: "legacy-minecraft-version" },
]);

function versionTuple(value) {
  const match = String(value || "").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function compareTuple(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function getRequiredJavaMajor(metadata = {}) {
  const explicit = Number(metadata.requiredJavaMajor || metadata.javaMajor || metadata.runtime?.javaMajor);
  if ([8, 11, 16, 17, 21, 25].includes(explicit)) {
    return { major: explicit, source: "explicit-metadata" };
  }
  const minecraft = versionTuple(metadata.minecraftVersion || metadata.gameVersion || metadata.serverVersion || metadata.version);
  if (!minecraft) return null;
  const rule = JAVA_RULES.find((entry) => compareTuple(minecraft, entry.min) >= 0);
  if (!rule) return null;
  return {
    major: rule.major,
    source: rule.source,
    minecraftVersion: String(metadata.minecraftVersion || metadata.gameVersion || metadata.serverVersion || metadata.version),
    loader: String(metadata.loader || metadata.serverSoftware || "vanilla").toLowerCase(),
    loaderVersion: metadata.loaderVersion || null,
  };
}

function parseJavaMajor(output) {
  const text = String(output || "");
  const match = text.match(/version\s+["'](?:1\.)?(\d+)/i) || text.match(/openjdk\s+(?:version\s+)?["']?(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

function approvedRoots(platform = process.platform, environment = process.env) {
  const managedRoots = String(environment.ANXOS_JAVA_RUNTIME_ROOTS || "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  if (platform === "win32") {
    return [
      bundledRuntimePaths.resolveRoot({ platform, environment }),
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"],
      environment.ProgramData && path.join(environment.ProgramData, "AnxOS", "runtimes"),
      ...managedRoots,
    ].filter(Boolean).map((root) => path.resolve(root));
  }
  return ["/usr/lib/jvm", "/usr/java", "/opt/java", "/opt/jdk", "/srv/anxos/runtimes", ...managedRoots].map((root) => path.resolve(root));
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectJavaCandidates(platform = process.platform, environment = process.env) {
  const executable = platform === "win32" ? "java.exe" : "java";
  const candidates = new Set();
  for (const id of ["java-8", "java-16", "java-17", "java-21"]) {
    for (const candidate of bundledRuntimePaths.executableCandidates(id, { platform, environment })) candidates.add(candidate);
  }
  const javaHomes = [environment.JAVA_8_HOME, environment.JAVA_16_HOME, environment.JAVA_17_HOME, environment.JAVA_21_HOME, environment.JAVA_HOME];
  for (const home of javaHomes.filter(Boolean)) candidates.add(path.join(home, "bin", executable));
  for (const root of approvedRoots(platform, environment)) {
    if (!fs.existsSync(root)) continue;
    if (platform === "win32") {
      for (const vendor of ["Eclipse Adoptium", "Java", "Microsoft", "Amazon Corretto", "Zulu"] ) {
        const vendorRoot = path.join(root, vendor);
        if (!fs.existsSync(vendorRoot)) continue;
        for (const entry of fs.readdirSync(vendorRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
          candidates.add(path.join(vendorRoot, entry.name, "bin", executable));
        }
      }
    } else {
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
        candidates.add(path.join(root, entry.name, "bin", executable));
      }
    }
  }
  return [...candidates];
}

function inspectJavaExecutable(executablePath, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const candidate = path.resolve(String(executablePath || ""));
  const roots = options.approvedRoots || approvedRoots(platform, environment);
  if (!roots.some((root) => isInsideRoot(candidate, root))) return null;
  try {
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    const result = childProcess.spawnSync(candidate, ["-version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const major = parseJavaMajor(output);
    if (!major) return null;
    return { executable: fs.realpathSync(candidate), major, versionOutput: output.trim().split(/\r?\n/)[0] || null };
  } catch {
    return null;
  }
}

function discoverJavaRuntimes(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const candidates = options.candidates || collectJavaCandidates(platform, environment);
  const inspect = typeof options.inspectExecutable === "function" ? options.inspectExecutable : inspectJavaExecutable;
  const runtimes = candidates.map((candidate) => inspect(candidate, { ...options, platform, environment })).filter(Boolean);
  return [...new Map(runtimes.map((runtime) => [`${runtime.major}:${runtime.executable}`, runtime])).values()]
    .sort((left, right) => left.major - right.major || left.executable.localeCompare(right.executable));
}

function createJavaRuntimeRequired(requirement, runtimes) {
  const error = new Error(`Java ${requirement.major} is required for this Minecraft server.`);
  error.code = "JAVA_RUNTIME_REQUIRED";
  error.statusCode = 409;
  error.requiredMajor = requirement.major;
  error.detectedMajors = [...new Set(runtimes.map((runtime) => runtime.major))].sort((a, b) => a - b);
  error.dependencyId = "java";
  error.suggestion = "Open Dependencies and install or repair the required Java runtime, then retry.";
  return error;
}

function resolveJavaRuntime(metadata = {}, options = {}) {
  const requirement = getRequiredJavaMajor(metadata);
  if (!requirement) return null;
  const runtimes = discoverJavaRuntimes(options);
  const explicitOverride = metadata.javaRuntimeOverride || metadata.javaRuntime?.userOverride;
  if (explicitOverride) {
    const validated = inspectJavaExecutable(explicitOverride, options);
    if (!validated || validated.major !== requirement.major) {
      const error = new Error("The configured Java runtime override is invalid or incompatible.");
      error.code = "JAVA_RUNTIME_OVERRIDE_INVALID";
      error.statusCode = 400;
      error.requiredMajor = requirement.major;
      error.detectedMajors = [...new Set(runtimes.map((runtime) => runtime.major))];
      throw error;
    }
    return { ...validated, requiredMajor: requirement.major, source: "validated-user-override", resolvedAt: new Date().toISOString() };
  }
  const selected = runtimes.find((runtime) => runtime.major === requirement.major);
  if (!selected) throw createJavaRuntimeRequired(requirement, runtimes);
  return { ...selected, requiredMajor: requirement.major, source: requirement.source, resolvedAt: new Date().toISOString() };
}

module.exports = { approvedRoots, collectJavaCandidates, discoverJavaRuntimes, getRequiredJavaMajor, inspectJavaExecutable, parseJavaMajor, resolveJavaRuntime };
