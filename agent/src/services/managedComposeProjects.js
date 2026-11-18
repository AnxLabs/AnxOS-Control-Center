"use strict";

// Compose projects that a Marketplace install creates (Build 214: Immich).
//
// The Agent's Compose routes run a project from a folder on this computer.
// This module writes such a folder, and nothing else: exactly
// docker-compose.yml and .env, inside one Agent-owned root, after the same
// Compose policy check the up route uses. The routes that run, stop, read
// and remove the project are the existing ones.

const fs = require("fs/promises");
const path = require("path");
const { assertComposePolicy } = require("./dockerService");

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ENV_ENTRIES = 64;

class ManagedComposeError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
    this.details = details;
  }
}

// Next to the instances folder, so it is on the same disk and owned by the
// same account: /srv/anxos/instances -> /srv/anxos/anxos-compose-projects.
function managedComposeRoot(instanceRoot) {
  if (process.env.ANXOS_COMPOSE_PROJECT_ROOT) return path.resolve(process.env.ANXOS_COMPOSE_PROJECT_ROOT);
  return path.join(path.dirname(path.resolve(instanceRoot)), "anxos-compose-projects");
}

function validateProjectName(value) {
  const name = String(value || "").trim();
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new ManagedComposeError("A Compose project name must be lowercase letters, digits, '-' or '_'.", "COMPOSE_PROJECT_NAME_INVALID");
  }
  return name;
}

function projectDirectory(instanceRoot, projectName) {
  const root = managedComposeRoot(instanceRoot);
  const directory = path.join(root, validateProjectName(projectName));
  if (path.dirname(directory) !== root) {
    throw new ManagedComposeError("Compose project folder is outside the managed folder.", "COMPOSE_PROJECT_NAME_INVALID");
  }
  return directory;
}

function renderEnvFile(env = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > MAX_ENV_ENTRIES) {
    throw new ManagedComposeError("Compose settings must be an object of at most 64 values.", "COMPOSE_ENV_INVALID");
  }
  return `${Object.entries(env).map(([key, value]) => {
    const text = String(value ?? "");
    if (!ENV_KEY_PATTERN.test(key) || text.length > 1024 || /[\0\r\n"'$`\\]/.test(text)) {
      throw new ManagedComposeError(`Compose setting ${key} is not allowed.`, "COMPOSE_ENV_INVALID", 400, { key });
    }
    return `${key}=${text}`;
  }).join("\n")}\n`;
}

// Writes the project. Refuses to write over an existing project of the same
// name: its .env holds the database password the existing data was made with.
async function writeManagedComposeProject(instanceRoot, payload = {}) {
  const projectName = validateProjectName(payload.projectName);
  const composeYaml = typeof payload.composeYaml === "string" ? payload.composeYaml : "";
  if (!composeYaml.trim() || Buffer.byteLength(composeYaml, "utf8") > MAX_COMPOSE_BYTES) {
    throw new ManagedComposeError("The Compose file is missing or too large.", "COMPOSE_FILE_INVALID");
  }
  const envText = renderEnvFile(payload.env);
  await assertComposePolicy({ composeYaml, policyGrant: {} });
  const directory = projectDirectory(instanceRoot, projectName);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ManagedComposeError(`A project named ${projectName} already exists on this computer.`, "COMPOSE_PROJECT_EXISTS", 409, { projectName });
    }
    throw error;
  }
  await fs.writeFile(path.join(directory, "docker-compose.yml"), composeYaml, { mode: 0o600 });
  await fs.writeFile(path.join(directory, ".env"), envText, { mode: 0o600 });
  return { projectName, projectDirectory: directory };
}

// Removes only the two files this module writes and the then-empty folder.
// Containers and volumes are removed with the existing Compose down route.
async function removeManagedComposeProject(instanceRoot, payload = {}) {
  const directory = projectDirectory(instanceRoot, payload.projectName);
  for (const name of ["docker-compose.yml", ".env"]) {
    await fs.rm(path.join(directory, name), { force: true });
  }
  await fs.rmdir(directory).catch((error) => {
    if (error?.code !== "ENOENT") throw new ManagedComposeError("The project folder holds other files and was left in place.", "COMPOSE_PROJECT_NOT_EMPTY", 409);
  });
  return { projectName: path.basename(directory), removed: true };
}

module.exports = {
  ManagedComposeError,
  managedComposeRoot,
  projectDirectory,
  removeManagedComposeProject,
  renderEnvFile,
  writeManagedComposeProject,
};
