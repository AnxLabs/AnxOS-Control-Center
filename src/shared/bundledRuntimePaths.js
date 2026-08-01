const fs = require("fs");
const path = require("path");

function candidateRoots(options = {}) {
  const environment = options.environment || process.env;
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  return [
    environment.ANXOS_BUNDLED_RUNTIME_ROOT,
    resourcesPath && path.join(resourcesPath, "bundled-runtimes", "win-x64"),
    path.resolve(__dirname, "../../resources/bundled-runtimes/win-x64"),
  ].filter(Boolean).map((entry) => path.resolve(entry));
}

function resolveRoot(options = {}) {
  return candidateRoots(options).find((entry) => fs.existsSync(path.join(entry, "bundle-manifest.json"))) || null;
}

function executableCandidates(id, options = {}) {
  const root = resolveRoot(options);
  if (!root || (options.platform || process.platform) !== "win32") return [];
  const relative = {
    "java-8": ["java", "8", "bin", "java.exe"],
    "java-16": ["java", "16", "bin", "java.exe"],
    "java-17": ["java", "17", "bin", "java.exe"],
    "java-21": ["java", "21", "bin", "java.exe"],
    "dotnet-8": ["dotnet", "8", "dotnet.exe"],
    steamcmd: ["steamcmd", "steamcmd.exe"],
  }[id];
  return relative ? [path.join(root, ...relative)] : [];
}

function resolveExecutable(id, options = {}) {
  return executableCandidates(id, options).find((entry) => fs.existsSync(entry)) || null;
}

function buildRuntimeEnvironment(base = process.env, options = {}) {
  const root = resolveRoot(options);
  if (!root) return { ...base };
  const directories = [
    path.join(root, "steamcmd"),
    path.join(root, "dotnet", "8"),
    path.join(root, "java", "21", "bin"),
    path.join(root, "java", "17", "bin"),
    path.join(root, "java", "16", "bin"),
    path.join(root, "java", "8", "bin"),
  ].filter((entry) => fs.existsSync(entry));
  return {
    ...base,
    ANXOS_BUNDLED_RUNTIME_ROOT: root,
    DOTNET_ROOT: path.join(root, "dotnet", "8"),
    PATH: [...directories, base.PATH || ""].filter(Boolean).join(path.delimiter),
  };
}

module.exports = { buildRuntimeEnvironment, candidateRoots, executableCandidates, resolveExecutable, resolveRoot };
