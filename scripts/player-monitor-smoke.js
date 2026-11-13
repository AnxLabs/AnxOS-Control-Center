#!/usr/bin/env node
"use strict";

// Phase 8 player monitoring (src/shared/instances/playerMonitor.js) against
// real local fake servers: HTTP for FiveM and Palworld, UDP for the Steam A2S
// query. Loopback only; nothing leaves this computer.
//   PM1 FiveM: names and the server's own per-player ping; identifiers and
//       endpoints are dropped; max players from dynamic.json
//   PM2 Palworld: REST API off -> says how to turn it on; wrong password is
//       reported; with the right one, names, ping and level; ids and IPs
//       dropped; the password never appears in the result
//   PM3 Steam A2S (challenge flow): names, score and connected time; ping is
//       "not supported", never invented
//   PM4 Minecraft: names from the status sample, ping not supported, an
//       incomplete sample is marked as such and does not create events
//   PM5 join/leave events and "seen for" from successive reads; bounded
//   PM6 a service-managed server shows counts and pings, never names
//   PM7 unsupported games, a stopped server and a silent server are reported
//       plainly; reads are cached for a few seconds
//   PM8 the Agent route and desktop IPC are wired at instance:read

const assert = require("assert");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createPlayerMonitor, _test } = require("../src/shared/instances/playerMonitor");

function listen(server, ...args) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", ...args, () => resolve(server.address().port)));
}

function cString(text) {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
}

async function main() {
  let clock = 1_000_000;
  const now = () => clock;

  // PM1
  const fivem = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/players.json") response.end(JSON.stringify([{ id: 1, name: "Alice", ping: 42, identifiers: ["license:abc", "ip:203.0.113.5"], endpoint: "203.0.113.5:1234" }, { id: 2, name: "Bob\u0007", ping: 180, identifiers: ["license:def"] }]));
    else if (request.url === "/dynamic.json") response.end(JSON.stringify({ clients: 2, sv_maxclients: 48, hostname: "x" }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  const fivemPort = await listen(fivem);
  const monitor = createPlayerMonitor({ now });
  const fivemResult = await monitor.read({ id: "fx", type: "fivem-fxserver", primaryPort: fivemPort }, { running: true });
  assert.deepStrictEqual([fivemResult.source, fivemResult.online, fivemResult.max], ["fivem-players", 2, 48]);
  assert.deepStrictEqual(fivemResult.players.map((player) => [player.name, player.pingMs]), [["Alice", 42], ["Bob", 180]], "names (control characters removed) and the server's ping");
  assert.deepStrictEqual([fivemResult.ping.supported, fivemResult.ping.averageMs, fivemResult.ping.highCount], [true, 111, 1]);
  assert.doesNotMatch(JSON.stringify(fivemResult), /license:|203\.0\.113|endpoint|identifiers/, "identifiers and endpoints are dropped");
  console.log("PASS PM1 FiveM: names and the server's own per-player ping; identifiers dropped");

  // PM2
  const password = "pal-secret-Zq9";
  let palAuthorized = 0;
  const pal = http.createServer((request, response) => {
    const expected = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
    if (request.headers.authorization !== expected) { response.statusCode = 401; response.end("{}"); return; }
    palAuthorized += 1;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/api/players") response.end(JSON.stringify({ players: [{ name: "Carol", accountName: "steam_acct", playerId: "PID1", userId: "steam_7656", ip: "198.51.100.7", ping: 63.4, location_x: 1, location_y: 2, level: 12 }] }));
    else if (request.url === "/v1/api/metrics") response.end(JSON.stringify({ currentplayernum: 1, maxplayernum: 16, serverfps: 60 }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  const palPort = await listen(pal);
  const settingsFor = (enabled, secret) => `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ServerPlayerMaxNum=32,AdminPassword="${secret}",RESTAPIEnabled=${enabled},RESTAPIPort=${palPort},ServerName="My, Server")\n`;
  let palSettings = settingsFor("False", password);
  const palMonitor = createPlayerMonitor({ now, readFile: async (config, relative) => (relative.includes("LinuxServer") ? palSettings : null) });
  const palConfig = { id: "pal", type: "palworld", primaryPort: 8211 };
  const off = await palMonitor.read(palConfig, { running: true });
  assert.deepStrictEqual([off.available, off.reason], [false, "rest_api_disabled"]);
  assert.match(off.message, /RESTAPIEnabled=True/, "says how to turn it on");
  clock += 6000;
  palSettings = settingsFor("True", "wrong-password");
  const refused = await palMonitor.read(palConfig, { running: true });
  assert.strictEqual(refused.reason, "rest_api_unauthorized");
  clock += 6000;
  palSettings = settingsFor("True", password);
  const palResult = await palMonitor.read(palConfig, { running: true });
  assert.deepStrictEqual([palResult.online, palResult.max, palResult.players[0].name, palResult.players[0].pingMs, palResult.players[0].level], [1, 16, "Carol", 63, 12]);
  assert.strictEqual(palAuthorized, 2, "players and metrics were read with the admin password");
  const palJson = JSON.stringify([off, refused, palResult]);
  assert.doesNotMatch(palJson, /steam_|PID1|198\.51\.100|location/, "account ids, ids, IPs and locations are dropped");
  assert.ok(!palJson.includes(password) && !palJson.includes("wrong-password"), "the admin password never appears in a result");
  assert.deepStrictEqual(_test.parsePalworldSettings(settingsFor("True", password)).ServerName, "My, Server", "quoted values may contain commas");
  console.log("PASS PM2 Palworld REST API: off, refused and working; ping and level; no ids, IPs or password");

  // PM3
  const challenge = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const requests = [];
  const a2s = dgram.createSocket("udp4");
  a2s.on("message", (message, rinfo) => {
    const kind = message[4];
    const hasChallenge = message.length >= 9 && message.subarray(message.length - 4).equals(challenge);
    requests.push(`${String.fromCharCode(kind)}${hasChallenge ? "+c" : ""}`);
    let reply;
    if (!hasChallenge) reply = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge]);
    else if (kind === 0x54) reply = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), cString("Valheim Srv"), cString("map"), cString("valheim"), cString("Valheim"), Buffer.from([0, 0, 2, 10, 0])]);
    else {
      const entry = (name, score, seconds) => { const tail = Buffer.alloc(8); tail.writeInt32LE(score, 0); tail.writeFloatLE(seconds, 4); return Buffer.concat([Buffer.from([0]), cString(name), tail]); };
      reply = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, 2]), entry("Dana", 5, 125.6), entry("Eve", 0, 30)]);
    }
    a2s.send(reply, rinfo.port, rinfo.address);
  });
  const a2sPort = await new Promise((resolve) => a2s.bind(0, "127.0.0.1", () => resolve(a2s.address().port)));
  const a2sMonitor = createPlayerMonitor({ now });
  // Valheim answers queries on the game port + 1.
  const valheim = await a2sMonitor.read({ id: "vh", type: "valheim", primaryPort: a2sPort - 1 }, { running: true });
  assert.deepStrictEqual([valheim.source, valheim.online, valheim.max, valheim.queryPort], ["steam-a2s", 2, 10, a2sPort]);
  assert.deepStrictEqual(valheim.players.map((player) => [player.name, player.score, player.connectedSeconds, player.pingMs]), [["Dana", 5, 126, null], ["Eve", 0, 30, null]]);
  assert.deepStrictEqual([valheim.ping.supported, /does not include/.test(valheim.ping.note)], [false, true], "ping is not supported and not invented");
  assert.deepStrictEqual(requests, ["T", "T+c", "U", "U+c"], "both queries follow the challenge flow");
  console.log("PASS PM3 Steam A2S: names, score and connected time; ping marked not supported");

  // PM4
  const sampleStatus = { status: { players: { online: 3, max: 20, sample: [{ name: "Finn", id: "1" }, { name: "Gus", id: "2" }] } } };
  const mcMonitor = createPlayerMonitor({ now, queryMinecraft: async () => sampleStatus });
  const mc = await mcMonitor.read({ id: "mc", type: "minecraft-paper" }, { running: true });
  assert.deepStrictEqual([mc.online, mc.max, mc.players.map((player) => player.name), mc.namesComplete, mc.ping.supported], [3, 20, ["Finn", "Gus"], false, false]);
  assert.deepStrictEqual(mc.events, [], "an incomplete sample never produces join/leave events");
  console.log("PASS PM4 Minecraft: names from the status sample; an incomplete list is marked and makes no events");

  // PM5
  let roster = [{ name: "Alice", ping: 40 }];
  const live = http.createServer((request, response) => { response.end(JSON.stringify(request.url === "/players.json" ? roster : { clients: roster.length, sv_maxclients: 8 })); });
  const livePort = await listen(live);
  const eventsMonitor = createPlayerMonitor({ now });
  const fxConfig = { id: "fx2", type: "fivem", primaryPort: livePort };
  const first = await eventsMonitor.read(fxConfig, { running: true });
  assert.deepStrictEqual(first.events, [], "the first read records who is there; it is not a join");
  clock += 1000;
  assert.strictEqual(await eventsMonitor.read(fxConfig, { running: true }), first, "a read within five seconds is served from cache");
  clock += 9000;
  roster = [{ name: "Alice", ping: 41 }, { name: "Bob", ping: 50 }];
  const second = await eventsMonitor.read(fxConfig, { running: true });
  assert.deepStrictEqual(second.events.map((event) => `${event.type}:${event.name}`), ["join:Bob"]);
  assert.strictEqual(second.players.find((player) => player.name === "Alice").seenForSeconds, 10, "seen for, measured from the first read");
  clock += 6000;
  roster = [{ name: "Bob", ping: 52 }];
  const third = await eventsMonitor.read(fxConfig, { running: true });
  assert.deepStrictEqual(third.events.map((event) => `${event.type}:${event.name}`), ["join:Bob", "leave:Alice"]);
  for (let index = 0; index < 30; index += 1) {
    clock += 6000;
    roster = index % 2 ? [{ name: "Bob" }] : [{ name: "Bob" }, { name: `P${index}` }];
    await eventsMonitor.read(fxConfig, { running: true });
  }
  clock += 6000;
  assert.ok((await eventsMonitor.read(fxConfig, { running: true })).events.length <= 40, "events are bounded");
  console.log("PASS PM5 join and leave events between reads, 'seen for' times, bounded history");

  // PM6
  clock += 6000;
  const managed = await createPlayerMonitor({ now }).read({ id: "anxrp", type: "fivem-fxserver", primaryPort: fivemPort }, { running: true, serviceManaged: true });
  assert.deepStrictEqual([managed.namesShown, managed.players.map((player) => [player.name, player.pingMs]), managed.events], [false, [[null, 42], [null, 180]], []]);
  assert.doesNotMatch(JSON.stringify(managed), /Alice|Bob/, "no names for a service-managed server");
  console.log("PASS PM6 a service-managed server shows counts and pings, never names");

  // PM7
  const generic = createPlayerMonitor({ now });
  const hytale = await generic.read({ id: "hy", type: "hytale" }, { running: true });
  const custom = await generic.read({ id: "web", type: "nginx" }, { running: true });
  const stopped = await generic.read({ id: "fx3", type: "fivem", primaryPort: fivemPort }, { running: false });
  const silent = await generic.read({ id: "cs", type: "cs2", primaryPort: 1 }, { running: true });
  assert.deepStrictEqual([hytale.supported, custom.supported, stopped.running, silent.available, silent.reason], [false, false, false, false, "no_response"]);
  console.log("PASS PM7 unsupported, stopped and silent servers are reported plainly");

  // PM8
  const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  assert.match(read("agent/src/routes/instances.js"), /getInstanceIdFromPath\(url\.pathname, "\/players"\)[\s\S]{0,80}request\.method === "GET"/);
  assert.match(read("src/ipc/instancesIpc.js"), /"instances:getPlayers"[^\n]*requirePermission\("instance:read"/);
  assert.match(read("test-helpers/permission-matrix.js"), /"instances:getPlayers"/);
  console.log("PASS PM8 the Agent route and desktop IPC are wired at instance:read");

  fivem.close(); pal.close(); live.close(); a2s.close();
  console.log("Player monitor smoke: 8 checks passed.");
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
