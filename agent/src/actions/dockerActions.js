const { execFile } = require("child_process");

const { getDockerExecutableOrThrow } = require("../services/dockerService");

const COMMAND_TIMEOUT_MS = 8000;
const CONTAINER_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DOCKER_ACTIONS = new Map([
  ["docker.start", "start"],
  ["docker.stop", "stop"],
  ["docker.restart", "restart"],
]);

function exec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout: stdout ? stdout.trim() : "",
        stderr: stderr ? stderr.trim() : "",
      });
    });
  });
}

function isDockerAction(actionId) {
  return DOCKER_ACTIONS.has(actionId);
}

function getDockerCommand(actionId) {
  return DOCKER_ACTIONS.get(actionId) || null;
}

function getActionBody(request) {
  if (!request.body) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), {
      code: "INVALID_ACTION_BODY",
      statusCode: 400,
    });
  }
}

function getContainerTarget(request) {
  const body = getActionBody(request);
  const container = body?.target?.container;

  if (typeof container !== "string" || !container.trim()) {
    throw Object.assign(new Error("Container target is required."), {
      code: "CONTAINER_TARGET_REQUIRED",
      statusCode: 400,
    });
  }

  const normalized = container.trim();

  if (!CONTAINER_TARGET_PATTERN.test(normalized)) {
    throw Object.assign(new Error("Container target is invalid."), {
      code: "INVALID_CONTAINER_TARGET",
      statusCode: 400,
    });
  }

  return normalized;
}

async function inspectContainer(dockerPath, container) {
  const result = await exec(dockerPath, ["container", "inspect", container]);

  if (!result.ok) {
    const output = `${result.stdout}\n${result.stderr}`;

    if (/no such (container|object)|not found/i.test(output)) {
      throw Object.assign(new Error("Container not found."), {
        code: "CONTAINER_NOT_FOUND",
        statusCode: 404,
      });
    }

    throw Object.assign(new Error("Docker inspect failed."), {
      code: "DOCKER_INSPECT_FAILED",
      statusCode: 502,
    });
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const [containerInfo] = Array.isArray(parsed) ? parsed : [];

    return {
      id: containerInfo?.Id || container,
      name: typeof containerInfo?.Name === "string" ? containerInfo.Name.replace(/^\/+/, "") : container,
      state: containerInfo?.State?.Status || null,
    };
  } catch {
    return {
      id: container,
      name: container,
      state: null,
    };
  }
}

async function runDockerAction(action, request) {
  const command = getDockerCommand(action.actionId);
  const container = getContainerTarget(request);
  // The path string, not resolveDockerExecutable()'s { executablePath, found,
  // checks } record (passing that record to execFile failed every action with
  // ERR_INVALID_ARG_TYPE). A missing Docker is DOCKER_NOT_INSTALLED (503).
  const dockerPath = await getDockerExecutableOrThrow();
  const before = await inspectContainer(dockerPath, container);
  const result = await exec(dockerPath, [command, container]);

  if (!result.ok) {
    throw Object.assign(new Error("Docker action failed."), {
      code: "DOCKER_ACTION_FAILED",
      statusCode: 502,
    });
  }

  const after = await inspectContainer(dockerPath, container);

  return {
    command: `docker ${command}`,
    target: {
      container,
      id: after.id || before.id,
      name: after.name || before.name,
    },
    before: {
      state: before.state,
    },
    after: {
      state: after.state,
    },
  };
}

module.exports = {
  isDockerAction,
  runDockerAction,
};
