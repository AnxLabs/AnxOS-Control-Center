#!/usr/bin/env node
"use strict";

// AnxNet name lookup (src/anxnet/dnsIntegration.js and the node resolver).
// Nothing here changes the computer's DNS settings: applying the NRPT /
// systemd-resolved change needs administrator permission and is only done
// from the UI when the user asks.
//   D1 the Windows plan adds exactly one rule, scoped to .<network>.internal,
//      tagged "AnxNet <id>", refuses to replace another program's rule, and
//      its removal touches only AnxNet-tagged rules
//   D2 the Linux plan is a routing-only domain on a dummy link (not a
//      default route), on port 5353; removal deletes only that link
//   D3 detection reads rules beside other programs' rules (Tailscale-style)
//      and reports a conflict for a foreign rule on the same namespace
//   D4 verification uses the OS resolver path (dns.lookup) and reports
//      mismatches honestly
//   D5 real (Windows): a node's resolver on 127.77.0.1:53 answers Windows'
//      own DNS client (Resolve-DnsName) for device and service names,
//      refuses other domains, and says unknown names don't exist
// Run: node scripts/anxnet-dns-smoke.js

const assert = require("assert");
const { execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const dnsIntegration = require("../src/anxnet/dnsIntegration");
const { AnxNetNode } = require("../src/anxnet/node");

const NETWORK_ID = `net-${"b".repeat(26)}`;

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => resolve(`${stdout || ""}${stderr || ""}`.trim())));
}

async function main() {
  // D1
  const windows = dnsIntegration.plan({ platform: "win32", domain: "anx-frost72.internal", networkId: NETWORK_ID });
  const applyText = windows.apply.join("\n");
  assert.strictEqual(windows.resolverPort, 53);
  assert.strictEqual((applyText.match(/Add-DnsClientNrptRule/g) || []).length, 1, "exactly one rule is added");
  assert.ok(applyText.includes("$ns = '.anx-frost72.internal'") && applyText.includes(`-Comment 'AnxNet ${NETWORK_ID}'`) && applyText.includes("-NameServers '127.77.0.1'"));
  assert.ok(applyText.includes("$_.Comment -notlike 'AnxNet *' }) { throw"), "another program's rule for the same names is never replaced");
  assert.ok(windows.remove.every((line) => !/Remove-DnsClientNrptRule/.test(line) || /Comment -like 'AnxNet \*'/.test(line)), "removal only touches AnxNet rules");
  assert.ok(!/Set-DnsClientServerAddress|Set-DnsClientGlobalSetting|hosts/i.test(applyText), "ordinary DNS settings are never changed");
  assert.throws(() => dnsIntegration.plan({ platform: "win32", domain: "example.com", networkId: NETWORK_ID }), (error) => error.code === "ANXNET_DNS_DOMAIN");
  assert.throws(() => dnsIntegration.plan({ platform: "win32", domain: "anx-x1'; rm.internal", networkId: NETWORK_ID }), (error) => error.code === "ANXNET_DNS_DOMAIN", "no command injection through the name");
  console.log("PASS D1 Windows: one tagged rule scoped to .<network>.internal; foreign rules never replaced; removal only touches AnxNet rules");

  // D2
  const linux = dnsIntegration.plan({ platform: "linux", domain: "anx-frost72.internal", networkId: NETWORK_ID });
  assert.strictEqual(linux.resolverPort, 5353);
  assert.ok(linux.apply.includes("resolvectl domain anxnet0 '~anx-frost72.internal'"), "routing-only domain");
  assert.ok(linux.apply.includes("resolvectl default-route anxnet0 false"), "never a default route");
  assert.ok(linux.apply.some((line) => line.includes("127.77.0.1:5353")));
  assert.deepStrictEqual(linux.remove, ["ip link del anxnet0 2>/dev/null || true"]);
  assert.strictEqual(dnsIntegration.plan({ platform: "darwin", domain: "anx-frost72.internal", networkId: NETWORK_ID }).supported, false);
  console.log("PASS D2 Linux: routing-only domain on a dummy link, not a default route; removal deletes only that link");

  // D3
  const tailscaleStyle = [
    { Namespace: [".100.100.in-addr.arpa", ".ts.net"], NameServers: ["100.100.100.100"], Comment: "" },
    { Namespace: ".anx-frost72.internal", NameServers: "127.77.0.1", Comment: `AnxNet ${NETWORK_ID}` },
  ];
  const fake = (rules) => async () => ({ ok: true, stdout: JSON.stringify(rules) });
  const detected = await dnsIntegration.detect({ platform: "win32", domain: "anx-frost72.internal", runCommand: fake(tailscaleStyle) });
  assert.deepStrictEqual([detected.enabled, detected.conflict, detected.otherRules], [true, false, 1]);
  const conflicted = await dnsIntegration.detect({ platform: "win32", domain: "anx-frost72.internal", runCommand: fake([{ Namespace: ".anx-frost72.internal", NameServers: "10.0.0.1", Comment: "Corp VPN" }]) });
  assert.deepStrictEqual([conflicted.enabled, conflicted.conflict], [false, true]);
  const renamed = await dnsIntegration.detect({ platform: "win32", domain: "anx-new11.internal", runCommand: fake(tailscaleStyle) });
  assert.deepStrictEqual([renamed.enabled, renamed.leftover], [false, [".anx-frost72.internal"]], "a rule for an old network name is reported as leftover");
  console.log("PASS D3 detection beside other programs' rules; foreign rules are conflicts; old names are leftovers");

  // D4
  assert.deepStrictEqual(await dnsIntegration.verify({ name: "pc.anx-frost72.internal", expected: "127.77.0.3", lookup: async () => ({ address: "127.77.0.3" }) }), { ok: true, address: "127.77.0.3", name: "pc.anx-frost72.internal" });
  assert.strictEqual((await dnsIntegration.verify({ name: "pc.anx-frost72.internal", expected: "127.77.0.3", lookup: async () => ({ address: "93.184.216.34" }) })).ok, false, "a different answer is a failure");
  assert.strictEqual((await dnsIntegration.verify({ name: "pc.anx-frost72.internal", expected: "127.77.0.3", lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } })).error, "ENOTFOUND");
  console.log("PASS D4 verification uses the OS lookup path and reports wrong or missing answers");

  // D5
  if (process.platform !== "win32") { console.log("SKIP D5 (Windows only)"); console.log("AnxNet DNS smoke passed (4 checks)."); return; }
  const portFree = await new Promise((resolve) => { const dgram = require("dgram").createSocket("udp4"); dgram.once("error", () => resolve(false)); dgram.bind(53, "127.77.0.1", () => dgram.close(() => resolve(true))); });
  if (!portFree) { console.log("SKIP D5 (127.77.0.1:53 is in use on this computer)"); console.log("AnxNet DNS smoke passed (4 checks)."); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-dns-smoke-"));
  const node = new AnxNetNode({ dataDir: root, deviceName: "Mini PC", listenHost: "127.0.0.1", dnsPort: 5353 });
  try {
    await node.start();
    await node.createNetwork({ name: "anx-dnstest42", deviceName: "Mini PC" });
    const echo = net.createServer(() => {});
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const service = await node.shareService({ name: "Minecraft", port: 25565, protocol: "tcp", targetHost: "127.0.0.1", targetPort: echo.address().port });
    const moved = await node.setDnsEndpoint({ port: 53 });
    assert.deepStrictEqual(moved, { host: "127.77.0.1", port: 53 }, "the resolver moves to port 53 for OS name lookup");
    const ask = (name) => run("powershell", ["-NoProfile", "-Command", `try { (Resolve-DnsName -Name '${name}' -Server 127.77.0.1 -DnsOnly -Type A -ErrorAction Stop).IPAddress } catch { 'ERR: ' + $_.Exception.Message }`]);
    assert.strictEqual(await ask("mini-pc.anx-dnstest42.internal"), "127.77.0.2");
    assert.strictEqual(await ask(service.hostname), "127.77.0.2");
    assert.match(await ask("nope.anx-dnstest42.internal"), /does not exist/i);
    assert.match(await ask("example.com"), /refused/i, "other domains are refused, never forwarded");
    echo.close();
    console.log(`PASS D5 Windows' own DNS client resolves ${service.hostname} -> 127.77.0.2 through the AnxNet resolver on 127.77.0.1:53; other domains refused`);
  } finally {
    await node.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log("AnxNet DNS smoke passed (5 checks). The OS rule itself was not applied (needs administrator approval).");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
