const assert = require("assert");
const fs = require("fs");
const path = require("path");

// V2-E stretch item smoke (docs mission: scoped live console + player
// information where the adapter supports it). Hermetic — no engine, no agent:
// (1) the shared parse/normalize helpers handle valid/empty/corrupt/missing
// player files with honest states, (2) counts compute correctly, (3) the
// renderer wiring renders the Players tab only for minecraft instances and
// never mutates server files, (4) unsupported-state copy is pinned.

const players = require("../src/shared/instances/minecraftPlayerFiles");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractPlayersBlock(source) {
  const begin = source.indexOf("/* V2-E players tab (begin)");
  const end = source.indexOf("/* V2-E players tab (end)");
  assert.ok(begin !== -1, "app.js must contain the V2-E players tab begin marker.");
  assert.ok(end !== -1, "app.js must contain the V2-E players tab end marker.");
  assert.ok(end > begin, "The players tab block markers must be ordered.");
  return source.slice(begin, end);
}

function main() {
  const specs = players.MINECRAFT_PLAYER_FILE_SPECS;
  const specKeys = specs.map((spec) => spec.key);

  // --- 1. File spec surface -------------------------------------------------
  assert.deepStrictEqual(specKeys, ["whitelist", "ops", "banned-players", "banned-ips"],
    "Exactly the four vanilla Minecraft player files must be exposed.");
  assert.deepStrictEqual(specs.map((spec) => spec.path),
    ["whitelist.json", "ops.json", "banned-players.json", "banned-ips.json"],
    "Player files must map to the vanilla file names.");
  assert.strictEqual(players.getMinecraftPlayerFileSpec("whitelist").identity, "name");
  assert.strictEqual(players.getMinecraftPlayerFileSpec("banned-ips").identity, "ip");
  assert.strictEqual(players.getMinecraftPlayerFileSpec("nope"), null);

  // --- 2. Valid files parse and normalize ------------------------------------
  const whitelist = players.parseMinecraftPlayerFile("whitelist", JSON.stringify([
    { uuid: "uuid-1", name: "Herobrine" },
    { name: "  Steve  ", uuid: "uuid-2" },
    { uuid: "uuid-3" }, // no identity field -> dropped, never guessed
    "not-an-object",
  ]));
  assert.strictEqual(whitelist.status, "ok");
  assert.strictEqual(whitelist.count, 2, "Entries without a name must not be counted.");
  assert.deepStrictEqual(whitelist.entries[0], {
    identity: "Herobrine", name: "Herobrine", uuid: "uuid-1", level: null,
    bypassesPlayerLimit: null, reason: null, source: null, created: null, expires: null, ip: null,
  });
  assert.strictEqual(whitelist.entries[1].identity, "Steve");
  assert.strictEqual(whitelist.entries[1].uuid, "uuid-2");
  assert.strictEqual(whitelist.message, "");
  assert.strictEqual(whitelist.count, whitelist.entries.length, "Count must equal normalized entries.");

  const ops = players.parseMinecraftPlayerFile("ops", JSON.stringify([
    { name: "AdminDude", uuid: "uuid-9", level: 4, bypassesPlayerLimit: true },
    { name: "ModDude", uuid: "uuid-8", level: "2", bypassesPlayerLimit: false },
  ]));
  assert.strictEqual(ops.status, "ok");
  assert.strictEqual(ops.count, 2);
  assert.strictEqual(ops.entries[0].level, 4);
  assert.strictEqual(ops.entries[0].bypassesPlayerLimit, true);
  assert.strictEqual(ops.entries[1].level, 2, "Numeric strings normalize to finite numbers.");
  assert.strictEqual(ops.entries[1].bypassesPlayerLimit, false);

  const bannedPlayers = players.parseMinecraftPlayerFile("banned-players", JSON.stringify([
    {
      uuid: "uuid-7", name: "Griefer", created: "2026-01-02 03:04:05 +0000",
      source: "Server", expires: "forever", reason: "Griefing spawn",
    },
  ]));
  assert.strictEqual(bannedPlayers.status, "ok");
  assert.strictEqual(bannedPlayers.count, 1);
  assert.strictEqual(bannedPlayers.entries[0].reason, "Griefing spawn");
  assert.strictEqual(bannedPlayers.entries[0].source, "Server");
  assert.strictEqual(bannedPlayers.entries[0].expires, "forever");

  const bannedIps = players.parseMinecraftPlayerFile("banned-ips", JSON.stringify([
    { ip: "203.0.113.9", created: "2026-01-02 03:04:05 +0000", source: "Server", expires: "forever", reason: "Bot spam" },
  ]));
  assert.strictEqual(bannedIps.status, "ok");
  assert.strictEqual(bannedIps.count, 1);
  assert.strictEqual(bannedIps.entries[0].identity, "203.0.113.9");
  assert.strictEqual(bannedIps.entries[0].ip, "203.0.113.9");
  assert.strictEqual(bannedIps.entries[0].name, null, "IP bans must not invent a player name.");

  // --- 3. Empty, corrupt, missing, and unexpected shapes ---------------------
  for (const key of specKeys) {
    const empty = players.parseMinecraftPlayerFile(key, "");
    assert.strictEqual(empty.status, "empty", `${key}: empty file must report "empty".`);
    assert.strictEqual(empty.count, 0);
    assert.ok(empty.message, `${key}: empty state must carry an honest message.`);

    const whitespace = players.parseMinecraftPlayerFile(key, "   \n ");
    assert.strictEqual(whitespace.status, "empty");

    const corrupt = players.parseMinecraftPlayerFile(key, '{"not":"an array"...');
    assert.strictEqual(corrupt.status, "invalid", `${key}: corrupt JSON must report "invalid".`);
    assert.strictEqual(corrupt.count, 0);
    assert.ok(corrupt.message, `${key}: corrupt state must carry an honest message.`);

    const object = players.parseMinecraftPlayerFile(key, '{"uuid":"uuid-1","name":"Solo"}');
    assert.strictEqual(object.status, "invalid", `${key}: non-array JSON must report "invalid".`);

    const missing = players.parseMinecraftPlayerFile(key, null);
    assert.strictEqual(missing.status, "missing", `${key}: null content must report "missing".`);
    assert.strictEqual(missing.count, 0);
    assert.ok(missing.message, `${key}: missing state must carry an honest message.`);
  }

  // --- 4. Unsupported-state strings are pinned and truthful ------------------
  assert.strictEqual(players.describeMinecraftPlayerFileState("missing"),
    "Not present yet — Minecraft creates this file when the feature is first used.");
  assert.strictEqual(players.describeMinecraftPlayerFileState("empty"), "File exists but is empty.");
  assert.strictEqual(players.describeMinecraftPlayerFileState("invalid"),
    "File could not be parsed as a JSON player list.");
  assert.strictEqual(players.describeMinecraftPlayerFileState("too_large"),
    "File is too large to display here (over the 1 MB file-read limit).");
  assert.strictEqual(players.describeMinecraftPlayerFileState("read_error"),
    "Could not read the file from the server.");
  assert.deepStrictEqual(players.FILE_STATES, ["ok", "empty", "invalid", "missing", "too_large", "read_error"]);

  // --- 5. Read-outcome mapping (summarize) -----------------------------------
  const summarizedOk = players.summarizeMinecraftPlayerFile("whitelist", { kind: "content", content: '[{"name":"Steve"}]' });
  assert.strictEqual(summarizedOk.status, "ok");
  assert.strictEqual(summarizedOk.count, 1);
  assert.strictEqual(summarizedOk.path, "whitelist.json");
  assert.strictEqual(summarizedOk.label, "Whitelist");

  assert.strictEqual(players.summarizeMinecraftPlayerFile("ops", { kind: "missing" }).status, "missing");
  assert.strictEqual(players.summarizeMinecraftPlayerFile("ops", { kind: "too_large" }).status, "too_large");
  assert.strictEqual(players.summarizeMinecraftPlayerFile("ops", { kind: "read_error" }).status, "read_error");
  assert.strictEqual(players.summarizeMinecraftPlayerFile("ops", { kind: "content", content: "" }).status, "empty");
  assert.strictEqual(players.summarizeMinecraftPlayerFile("ops", null).status, "missing");

  // The module must be loadable as a browser global (renderer script tag).
  assert.ok(globalThis.AnxMinecraftPlayerFiles, "The module must expose the AnxMinecraftPlayerFiles global for the renderer.");

  // --- 6. Renderer source pins: minecraft-only visibility --------------------
  const block = extractPlayersBlock(appJs);
  assert.ok(block.includes('getInstanceAccessGameKind(instance) === "minecraft"'),
    "The players view must gate on the renderer's minecraft game-kind inference.");
  assert.ok(block.includes("isMinecraftPlayersSupportedInstance(selectedInstance)"),
    "File fetches must re-check the minecraft gate for the selected instance.");
  assert.ok(block.includes("isMinecraftPlayersSupportedInstance(instance)"),
    "Panel rendering must check the minecraft gate before showing rosters.");

  assert.ok(indexHtml.includes('<script src="src/shared/instances/minecraftPlayerFiles.js"></script>'),
    "index.html must load the shared player-file module before app.js.");
  assert.ok(indexHtml.includes('data-instance-tab="players"'), "index.html must declare the Players tab button.");
  assert.ok(indexHtml.includes('data-instance-panel="players"'), "index.html must declare the Players tab panel.");
  assert.ok(indexHtml.indexOf('data-instance-tab="players"') < indexHtml.indexOf('data-instance-tab="files"'),
    "The Players tab must sit beside Console/Files in the tab order.");
  assert.ok(indexHtml.includes("Player rosters are available for Minecraft servers only."),
    "The game-level unsupported state must be pinned copy.");

  // --- 7. Renderer source pins: tab wiring and detail lifecycle --------------
  assert.ok(appJs.includes('activeInstanceTab === "players"'),
    "setActiveInstanceTab must handle the players tab.");
  const playersTabBranch = appJs.slice(appJs.indexOf('activeInstanceTab === "players"'),
    appJs.indexOf('activeInstanceTab === "backups"'));
  assert.ok(playersTabBranch.includes("refreshMinecraftPlayerFiles()"),
    "Activating the players tab must refresh the player file views.");
  assert.ok(appJs.includes("renderMinecraftPlayersPanel(instance);"),
    "setInstanceDetails must render the players panel for a selected instance.");
  assert.ok(appJs.includes("renderMinecraftPlayersPanel(null);"),
    "setInstanceDetails must reset the players panel when no instance is selected.");

  // --- 8. Renderer source pins: read-only, existing read chain ---------------
  assert.ok(block.includes("api.readFile"),
    "The players view must read files through the existing instances.readFile chain.");
  const forbidden = ["writeInstanceFile", "deleteInstanceFile", "createInstanceFolder", "writeInstanceInput", "sendInstanceCommand"];
  for (const mutation of forbidden) {
    assert.ok(!block.includes(mutation), `The players view must stay read-only (found ${mutation}).`);
  }
  assert.ok(block.includes('getAgentErrorCode(error) === "PATH_NOT_FOUND"'),
    "Missing player files must be detected via PATH_NOT_FOUND, not guessed.");
  assert.ok(block.includes("summarizeMinecraftPlayerFile"),
    "The renderer must reuse the shared parse/normalize helper.");
  assert.ok(block.includes("resetMinecraftPlayerCardBodies()"),
    "Switching instances must clear the previous instance's rosters.");

  // --- 9. Renderer source pins: honest states and view-only copy -------------
  assert.ok(indexHtml.includes("View only for now — whitelist and operator edits are not available yet."),
    "The players tab must state that roster edits are a later slice.");
  assert.ok(indexHtml.includes("Read-only view of the server's player files."),
    "The players tab heading must state it is a read-only view.");

  console.log("minecraft-players-smoke passed");
}

main();
