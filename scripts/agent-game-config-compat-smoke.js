const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: null };
  return originalLoad.call(this, request, parent, isMain);
};

let agentClient;
try {
  agentClient = require("../src/services/agentClient");
} finally {
  Module._load = originalLoad;
}

async function main() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert(String(url).endsWith("/api/v1/instances/atm10/game-config?adapterId=minecraft"));
    return {
      ok: false,
      status: 404,
      headers: { get: () => "application/json" },
      json: async () => ({ error: { code: "NOT_FOUND", message: "Not found." } }),
    };
  };

  try {
    await assert.rejects(
      () => agentClient.getGameServerConfig("atm10", { adapterId: "minecraft" }, {
        backendMode: "agent",
        agentUrl: "http://127.0.0.1:47131",
        agentToken: "compat-token",
      }),
      (error) => {
        assert.strictEqual(error.code, "AGENT_GAME_CONFIG_UNSUPPORTED");
        assert.strictEqual(error.status, 404);
        assert.match(error.message, /Agent update required for Minecraft Configuration/);
        assert.strictEqual(error.payload.error.details.compatibilityEndpoint, "/api/v1/instances/:id/game-config");
        return true;
      },
      "Old Agent game-config 404s should surface a friendly update-required error."
    );
  } finally {
    global.fetch = originalFetch;
  }

  console.log("Agent game-config compatibility smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
