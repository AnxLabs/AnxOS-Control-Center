"use strict";

// Docker-backed Marketplace templates (Build 214).
//
// A template's `docker` block is data, never a script: it may name an image,
// published ports, named volumes, environment values and generated secrets,
// and nothing else. Everything that could expose the computer (privileged
// mode, host networking, host path or engine-socket mounts, devices, added
// capabilities) is refused here before a request is built, and the Agent's
// own Docker policy gate (src/shared/dockerPolicy.js) refuses it again.

const crypto = require("crypto");

const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VOLUME_TARGET_PATTERN = /^\/[A-Za-z0-9._/-]{1,200}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PLACEHOLDER_PATTERN = /\{([a-z]+)(?::([a-z0-9-]+))?\}/g;
const MAX_ENV_VALUE_LENGTH = 512;
const SECRET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const DEFAULT_SECRET_LENGTH = 24;

// Keys a template may never set. Listed by name so a new, dangerous Docker
// option cannot arrive through a template without a code change here.
const FORBIDDEN_DOCKER_KEYS = Object.freeze([
  "privileged", "network", "networkMode", "binds", "mounts", "devices", "capAdd", "cap_add",
  "pid", "ipc", "securityOpt", "security_opt", "entrypoint", "user", "policyGrant",
]);
const ALLOWED_DOCKER_KEYS = Object.freeze([
  "image", "ports", "volumes", "environment", "secrets", "restartPolicy", "command", "hostFolder",
]);

// Folders a user may never hand to a container, even read-only: the system
// itself, the Docker engine, AnxOS's own data, whole home folders and the top
// of a drive (which contains all of them).
const BLOCKED_HOST_FOLDERS_POSIX = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var", "/srv/anxos"];
const BLOCKED_HOST_FOLDERS_WINDOWS = ["windows", "program files", "program files (x86)", "programdata"];

function isDockerTemplate(template = {}) {
  return template.runtime === "docker" || template.startupType === "docker-image";
}

function getDockerImage(template = {}) {
  return String(template.docker?.image || template.downloadSource?.image || "").trim();
}

function hasPathTraversal(target) {
  return String(target).split("/").some((segment) => segment === ".." || segment === ".");
}

// Returns a list of plain-language problems; an empty list means the block is
// acceptable. The Marketplace registry turns any problem into an invalid
// manifest, so an unsafe template is never offered as installable.
function findDockerTemplateProblems(template = {}) {
  const problems = [];
  const docker = template.docker && typeof template.docker === "object" ? template.docker : {};

  for (const key of Object.keys(docker)) {
    if (FORBIDDEN_DOCKER_KEYS.includes(key)) {
      problems.push(`docker.${key} is not allowed in a Marketplace template.`);
    } else if (!ALLOWED_DOCKER_KEYS.includes(key)) {
      problems.push(`docker.${key} is not a supported Marketplace Docker option.`);
    }
  }

  const image = getDockerImage(template);
  if (!IMAGE_PATTERN.test(image)) {
    problems.push("A Docker template must name a valid image.");
  } else if (!/[:@]/.test(image.slice(image.lastIndexOf("/") + 1))) {
    problems.push("A Docker template image must name a tag or digest.");
  }

  const volumes = docker.volumes === undefined ? [] : docker.volumes;
  if (!Array.isArray(volumes) || volumes.length > 8) {
    problems.push("docker.volumes must be a list of at most 8 named volumes.");
  } else {
    const seen = new Set();
    for (const volume of volumes) {
      const name = String(volume?.name || "");
      const target = String(volume?.target || "");
      if (!volume || typeof volume !== "object" || !VOLUME_NAME_PATTERN.test(name)) {
        problems.push("Each Docker volume needs a short lowercase name.");
      } else if (seen.has(name)) {
        problems.push(`Docker volume "${name}" is declared twice.`);
      }
      seen.add(name);
      if (!VOLUME_TARGET_PATTERN.test(target) || hasPathTraversal(target)) {
        problems.push(`Docker volume "${name || "?"}" needs an absolute path inside the container.`);
      }
    }
  }

  const secrets = docker.secrets === undefined ? [] : docker.secrets;
  const secretIds = new Set();
  if (!Array.isArray(secrets) || secrets.length > 8) {
    problems.push("docker.secrets must be a list of at most 8 generated secrets.");
  } else {
    for (const secret of secrets) {
      const id = String(secret?.id || "");
      if (!SECRET_ID_PATTERN.test(id) || !String(secret?.label || "").trim()) {
        problems.push("Each Docker secret needs an id and a label.");
      }
      secretIds.add(id);
    }
  }

  const environment = docker.environment === undefined ? {} : docker.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).length > 48) {
    problems.push("docker.environment must be an object of at most 48 values.");
  } else {
    for (const [key, value] of Object.entries(environment)) {
      if (!ENV_KEY_PATTERN.test(key)) {
        problems.push(`Docker environment name "${key}" is invalid.`);
      }
      if (typeof value !== "string" || value.length > MAX_ENV_VALUE_LENGTH || /[\r\n\0]/.test(value)) {
        problems.push(`Docker environment value for "${key}" must be a single-line string.`);
        continue;
      }
      for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
        const [, kind, argument] = match;
        if (kind === "secret" && secretIds.has(argument)) continue;
        if ((kind === "name" || kind === "port") && !argument) continue;
        problems.push(`Docker environment value for "${key}" uses an unknown placeholder ${match[0]}.`);
      }
    }
  }

  if (docker.command !== undefined && (!Array.isArray(docker.command) || docker.command.some((entry) => typeof entry !== "string"))) {
    problems.push("docker.command must be a list of strings.");
  }

  // One folder from the computer, chosen by the user at install time, always
  // mounted read-only. The template names where it appears in the container;
  // it can never name the folder itself.
  if (docker.hostFolder !== undefined) {
    const folder = docker.hostFolder;
    if (!folder || typeof folder !== "object" || Array.isArray(folder) || !String(folder.label || "").trim()) {
      problems.push("docker.hostFolder needs a label.");
    } else {
      if (!VOLUME_TARGET_PATTERN.test(String(folder.target || "")) || hasPathTraversal(folder.target)) {
        problems.push("docker.hostFolder needs an absolute path inside the container.");
      }
      if (folder.readOnly !== true) {
        problems.push("docker.hostFolder must be read-only.");
      }
      for (const key of Object.keys(folder)) {
        if (!["label", "target", "readOnly", "required", "help"].includes(key)) {
          problems.push(`docker.hostFolder.${key} is not supported.`);
        }
      }
    }
  }

  return problems;
}

function generateSecret(length = DEFAULT_SECRET_LENGTH, randomBytes = crypto.randomBytes) {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % SECRET_ALPHABET.length);
  let secret = "";
  while (secret.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && secret.length < length) {
        secret += SECRET_ALPHABET[byte % SECRET_ALPHABET.length];
      }
    }
  }
  return secret;
}

// Checks the folder the user typed for a hostFolder template. Returns the
// cleaned path, or throws a plain-language error. The Agent's Docker policy is
// still the boundary; this keeps obvious mistakes (a whole drive, the system
// folders, a relative path) from ever being sent.
function validateHostFolderPath(value) {
  const raw = String(value ?? "").trim();
  const fail = (message) => {
    const error = new Error(message);
    error.code = "HOST_FOLDER_INVALID";
    error.details = { field: "hostFolder", retryable: false };
    throw error;
  };
  if (!raw) fail("Choose the folder that holds your media.");
  if (raw.length > 400 || /[\0\r\n,"]/.test(raw)) fail("That folder path contains characters AnxOS cannot pass to Docker (commas, quotes or line breaks).");
  const windows = /^[a-zA-Z]:[\\/]/.test(raw);
  if (!windows && !raw.startsWith("/")) fail("Enter the full path of the folder, for example /srv/media or D:\\Media.");
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === ".")) fail("The folder path cannot contain . or .. parts.");
  if (windows) {
    const rest = segments.slice(1).map((segment) => segment.toLowerCase());
    if (rest.length === 0) fail("Choose a folder, not a whole drive.");
    if (BLOCKED_HOST_FOLDERS_WINDOWS.includes(rest[0]) || (rest[0] === "users" && rest.length <= 2)) {
      fail("Choose a folder of your own, not a Windows system folder or a whole user profile.");
    }
    return `${raw[0].toUpperCase()}:\\${segments.slice(1).join("\\")}`;
  }
  const cleaned = `/${segments.join("/")}`;
  const blocked = BLOCKED_HOST_FOLDERS_POSIX.some((entry) => cleaned === entry || cleaned.startsWith(`${entry}/`));
  if (blocked || segments.length === 0 || (segments[0] === "home" && segments.length < 3) || (segments[0] === "Users" && segments.length < 3)) {
    fail("Choose a folder of your own, not a system folder, a whole home folder or the top of a drive.");
  }
  return cleaned;
}

function volumeNameFor(containerName, volumeName) {
  return `${containerName}-${volumeName}`;
}

// Builds the container-create request for a validated template. Secrets are
// generated here, once per install; the caller shows them to the user a single
// time and never logs them.
function buildDockerInstallRequest(template = {}, context = {}) {
  const problems = findDockerTemplateProblems(template);
  if (problems.length > 0) {
    const error = new Error(problems[0]);
    error.code = "MARKETPLACE_MANIFEST_INVALID";
    error.details = { templateId: template.id || null, problems };
    throw error;
  }

  const docker = template.docker || {};
  const containerName = String(context.containerName || "");
  const hostPort = Array.isArray(context.hostPorts) && context.hostPorts.length > 0 ? String(context.hostPorts[0]) : "";
  const makeSecret = typeof context.generateSecret === "function" ? context.generateSecret : generateSecret;

  const secretValues = new Map();
  const credentials = (docker.secrets || []).map((secret) => {
    const value = makeSecret(DEFAULT_SECRET_LENGTH);
    secretValues.set(secret.id, value);
    return {
      id: secret.id,
      label: secret.label,
      username: secret.username || null,
      secret: value,
    };
  });

  const environment = {};
  for (const [key, raw] of Object.entries(docker.environment || {})) {
    environment[key] = raw.replace(PLACEHOLDER_PATTERN, (_, kind, argument) => {
      if (kind === "secret") return secretValues.get(argument);
      if (kind === "port") return hostPort;
      return containerName;
    });
  }

  const volumes = (docker.volumes || []).map((volume) => ({
    name: volumeNameFor(containerName, volume.name),
    target: volume.target,
    label: volume.label || volume.name,
  }));

  const payload = {
    name: containerName,
    image: getDockerImage(template),
    ports: context.portMappings || [],
    restartPolicy: docker.restartPolicy || "unless-stopped",
    start: context.start !== false,
    command: docker.command || [],
    labels: {
      "anxos.managed": "true",
      "anxos.template": String(template.id || ""),
      "anxos.template.version": String(template.version || ""),
    },
  };
  if (context.memory) payload.memory = context.memory;
  let hostFolder = null;
  if (docker.hostFolder) {
    const supplied = String(context.hostFolder ?? "").trim();
    if (supplied || docker.hostFolder.required === true) {
      const source = validateHostFolderPath(supplied);
      hostFolder = { source, target: docker.hostFolder.target, label: docker.hostFolder.label };
      payload.binds = [`type=bind,source=${source},target=${docker.hostFolder.target},readonly`];
      // The one explicit grant the Agent's Docker policy needs, and only for
      // this read-only folder the user chose.
      payload.policyGrant = { hostMount: true };
    }
  }
  if (Object.keys(environment).length > 0) payload.environment = environment;
  if (volumes.length > 0) payload.volumes = volumes.map((volume) => `${volume.name}:${volume.target}`);

  return { payload, credentials, volumes, hostFolder };
}

// Reads `docker inspect` output for the one fact the install needs: did the
// container stay up after it was started?
function readContainerRunState(inspectResult = {}) {
  const entry = Array.isArray(inspectResult?.inspect) ? inspectResult.inspect[0] : null;
  const state = entry?.State;
  if (!state || typeof state !== "object") {
    return { known: false, running: false, status: null, exitCode: null, health: null };
  }
  return {
    known: true,
    running: state.Running === true && state.Restarting !== true,
    status: String(state.Status || ""),
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    health: state.Health?.Status || null,
  };
}

module.exports = {
  ALLOWED_DOCKER_KEYS,
  FORBIDDEN_DOCKER_KEYS,
  buildDockerInstallRequest,
  findDockerTemplateProblems,
  generateSecret,
  getDockerImage,
  isDockerTemplate,
  readContainerRunState,
  validateHostFolderPath,
  volumeNameFor,
};
