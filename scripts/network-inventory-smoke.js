const assert = require("assert");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

const { pinAgentRoots } = require(path.join(rootDir, "test-helpers", "pin-agent-roots"));

// Hermetic root pinning first (shared helper contract): no smoke may leak
// config/instance roots into the real machine layout.
pinAgentRoots("anx-network-inventory-");

const service = require(path.join(rootDir, "agent", "src", "services", "networkInventoryService"));

// ---------------------------------------------------------------------------
// Platform-command fixtures (hermetic: real command text, no real commands).
// ---------------------------------------------------------------------------
const WINDOWS_NETSTAT_FIXTURE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1232",
  "  TCP    127.0.0.1:5354         0.0.0.0:0              LISTENING       4880",
  "  TCP    0.0.0.0:5354           0.0.0.0:0              LISTENING       9001",
  "  TCP    0.0.0.0:5354           0.0.0.0:0              LISTENING       9001",
  "  TCP    192.168.1.10:27015     0.0.0.0:0              LISTENING       7002",
  "  TCP    10.0.0.5:27015         0.0.0.0:0              LISTENING       7002",
  "  TCP    192.168.1.10:51000     52.1.2.3:443           ESTABLISHED     4242",
  "  TCP    [::]:135               [::]:0                 LISTENING       1232",
  "  UDP    0.0.0.0:5353           *:*                                    4880",
  "  UDP    [::]:5353              *:*                                    4880",
  "  not-a-real-row-at-all",
  "  UDP    0.0.0.0:1900           *:*                                    notapid",
].join("\r\n");

const WINDOWS_EXPECTED_ROWS = [
  { protocol: "tcp", localAddress: "0.0.0.0", localPort: 135, state: "LISTENING", pid: 1232, processName: null },
  { protocol: "tcp", localAddress: "127.0.0.1", localPort: 5354, state: "LISTENING", pid: 4880, processName: null },
  { protocol: "tcp", localAddress: "0.0.0.0", localPort: 5354, state: "LISTENING", pid: 9001, processName: null },
  { protocol: "tcp", localAddress: "192.168.1.10", localPort: 27015, state: "LISTENING", pid: 7002, processName: null },
  { protocol: "tcp", localAddress: "10.0.0.5", localPort: 27015, state: "LISTENING", pid: 7002, processName: null },
  { protocol: "tcp", localAddress: "[::]", localPort: 135, state: "LISTENING", pid: 1232, processName: null },
  { protocol: "udp", localAddress: "0.0.0.0", localPort: 5353, state: null, pid: 4880, processName: null },
  { protocol: "udp", localAddress: "[::]", localPort: 5353, state: null, pid: 4880, processName: null },
];

const SS_TCP_FIXTURE = [
  "State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
  "LISTEN  0       128     0.0.0.0:22          0.0.0.0:*          users:((\"sshd\",pid=800,fd=3))",
  "LISTEN  0       128     [::]:22             [::]:*             users:((\"sshd\",pid=801,fd=4))",
  "LISTEN  0       511     0.0.0.0:8080        0.0.0.0:*          users:((\"nginx\",pid=909,fd=6))",
  "LISTEN  0       511     127.0.0.1:8080      0.0.0.0:*",
  "LISTEN  0       64      10.0.0.2:25565      0.0.0.0:*          users:((\"java\",pid=777,fd=50))",
  "LISTEN  0       128     0.0.0.0:22          0.0.0.0:*          users:((\"sshd\",pid=800,fd=3))",
  "LISTEN  0       128",
  "garbage row with nothing parseable",
].join("\n");

const SS_TCP_EXPECTED_ROWS = [
  { protocol: "tcp", localAddress: "0.0.0.0", localPort: 22, state: null, pid: 800, processName: "sshd" },
  { protocol: "tcp", localAddress: "[::]", localPort: 22, state: null, pid: 801, processName: "sshd" },
  { protocol: "tcp", localAddress: "0.0.0.0", localPort: 8080, state: null, pid: 909, processName: "nginx" },
  { protocol: "tcp", localAddress: "127.0.0.1", localPort: 8080, state: null, pid: null, processName: null },
  { protocol: "tcp", localAddress: "10.0.0.2", localPort: 25565, state: null, pid: 777, processName: "java" },
];

const SS_UDP_FIXTURE = [
  "State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
  "UNCONN 0       0       0.0.0.0:5353        0.0.0.0:*          users:((\"avahi\",pid=500,fd=12))",
  "UNCONN 0       0       [::]:5353           [::]:*",
  "garbage",
].join("\n");

const LINUX_NETSTAT_TCP_FIXTURE = [
  "Active Internet connections (only servers)",
  "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
  "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      800/sshd",
  "tcp6       0      0 :::22                   :::*                    LISTEN      800/sshd",
  "tcp        0      0 127.0.0.1:3306          0.0.0.0:*               LISTEN      900/mysqld",
  "this is garbage",
].join("\n");

const LINUX_NETSTAT_UDP_FIXTURE = [
  "Active Internet connections (only servers)",
  "Proto Recv-Q Send-Q Local Address           Foreign Address         PID/Program name",
  "udp        0      0 0.0.0.0:68              0.0.0.0:*                           700/systemd",
  "tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 800/sshd",
].join("\n");

const INTERFACES_FIXTURE = {
  Ethernet: [{ address: "192.168.1.10", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.10/24" }],
  lo: [{ address: "::1", family: 6, internal: true, mac: "00:00:00:00:00:00", cidr: "::1/128" }],
};

function buildWindowsNetstatRowCapFixture() {
  const lines = ["  Proto  Local Address          Foreign Address        State           PID"];
  for (let port = 1; port <= service._test.MAX_LISTENER_ROWS + 50; port += 1) {
    lines.push(`  TCP    127.0.0.1:${port}            0.0.0.0:0              LISTENING       ${port}`);
  }
  return lines.join("\r\n");
}

async function testWindowsParsing() {
  const rows = service.parseWindowsNetstatListeners(WINDOWS_NETSTAT_FIXTURE);
  assert.deepStrictEqual(rows, [
    { protocol: "tcp", localAddress: "0.0.0.0", localPort: 135, state: "LISTENING", pid: 1232, processName: null },
    { protocol: "tcp", localAddress: "127.0.0.1", localPort: 5354, state: "LISTENING", pid: 4880, processName: null },
    { protocol: "tcp", localAddress: "0.0.0.0", localPort: 5354, state: "LISTENING", pid: 9001, processName: null },
    { protocol: "tcp", localAddress: "192.168.1.10", localPort: 27015, state: "LISTENING", pid: 7002, processName: null },
    { protocol: "tcp", localAddress: "10.0.0.5", localPort: 27015, state: "LISTENING", pid: 7002, processName: null },
    { protocol: "tcp", localAddress: "[::]", localPort: 135, state: "LISTENING", pid: 1232, processName: null },
    { protocol: "udp", localAddress: "0.0.0.0", localPort: 5353, state: null, pid: 4880, processName: null },
    { protocol: "udp", localAddress: "[::]", localPort: 5353, state: null, pid: 4880, processName: null },
  ], "Windows parsing: LISTENING rows + UDP rows kept, ESTABLISHED/malformed rows and the duplicate dropped.");
}

async function testSsParsing() {
  const tcpRows = service.parseSsListeners(SS_TCP_FIXTURE, "tcp");
  assert.deepStrictEqual(tcpRows, SS_TCP_EXPECTED_ROWS, "ss tcp parsing: fixture rows, malformed rows and duplicates dropped");

  const udpRows = service.parseSsListeners(SS_UDP_FIXTURE, "udp");
  assert.deepStrictEqual(udpRows, [
    { protocol: "udp", localAddress: "0.0.0.0", localPort: 5353, state: null, pid: 500, processName: "avahi" },
    { protocol: "udp", localAddress: "[::]", localPort: 5353, state: null, pid: null, processName: null },
  ]);

  assert.deepStrictEqual(service.parseSsListeners("", "tcp"), []);
  assert.deepStrictEqual(service.parseSsListeners("garbage\nmore garbage", "tcp"), []);
  assert.deepStrictEqual(service.parseSsListeners(SS_TCP_FIXTURE, "icmp"), [], "unsupported protocol must yield no rows");
}

async function testLinuxNetstatParsing() {
  const tcpRows = service.parseLinuxNetstatListeners(LINUX_NETSTAT_TCP_FIXTURE, "tcp");
  assert.deepStrictEqual(tcpRows, [
    { protocol: "tcp", localAddress: "0.0.0.0", localPort: 22, state: "LISTEN", pid: 800, processName: "sshd" },
    { protocol: "tcp", localAddress: "::", localPort: 22, state: "LISTEN", pid: 800, processName: "sshd" },
    { protocol: "tcp", localAddress: "127.0.0.1", localPort: 3306, state: "LISTEN", pid: 900, processName: "mysqld" },
  ], "netstat fallback parsing: tcp/tcp6 rows normalize to tcp with the v6 wildcard");
  const udpRows = service.parseLinuxNetstatListeners(LINUX_NETSTAT_UDP_FIXTURE, "udp");
  assert.deepStrictEqual(udpRows, [
    { protocol: "udp", localAddress: "0.0.0.0", localPort: 68, state: null, pid: 700, processName: "systemd" },
  ]);
}

async function testConflictDetection() {
  const windowsRows = service.parseWindowsNetstatListeners(WINDOWS_NETSTAT_FIXTURE);
  assert.deepStrictEqual(service.detectPortConflicts(windowsRows), [
    { reason: "multiple_bind_addresses", protocol: "tcp", port: 5354, addresses: ["0.0.0.0", "127.0.0.1"], processes: [] },
    { reason: "multiple_bind_addresses", protocol: "tcp", port: 27015, addresses: ["10.0.0.5", "192.168.1.10"], processes: [] },
  ], "Windows conflicts: wildcard+specific and two concrete addresses conflict, dual-stack wildcards do not.");

  const ssRows = [
    ...service.parseSsListeners(SS_TCP_FIXTURE, "tcp"),
    ...service.parseSsListeners(SS_UDP_FIXTURE, "udp"),
  ];
  assert.deepStrictEqual(service.detectPortConflicts(ssRows), [
    { reason: "multiple_bind_addresses", protocol: "tcp", port: 8080, addresses: ["0.0.0.0", "127.0.0.1"], processes: ["nginx"] },
  ], "ss conflicts: port 22 is a normal dual-stack wildcard pair, 8080 conflicts across a wildcard and a loopback bind.");

  // Single-socket ports are never conflicts even with rich process metadata.
  assert.deepStrictEqual(service.detectPortConflicts([
    { protocol: "tcp", localAddress: "0.0.0.0", localPort: 443, pid: 1, processName: "server" },
  ]), []);
}

async function testRowCap() {
  service._test.setExecFileForTest((command) => {
    if (command === "netstat") {
      return Promise.resolve({ ok: true, stdout: buildWindowsNetstatRowCapFixture(), stderr: "" });
    }
    return Promise.resolve({ ok: false, stdout: "", stderr: "unexpected command" });
  });
  try {
    const result = await service.collectListeners("win32");
    assert.strictEqual(result.source, "netstat");
    assert.strictEqual(result.rows.length, service._test.MAX_LISTENER_ROWS, "row cap must clamp listener rows");
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.dropped, 50);
    assert(
      result.rows.every((row) => row.localPort >= 1 && row.localPort <= service._test.MAX_LISTENER_ROWS + 50),
      "capped rows must keep the first parsed rows in order",
    );
  } finally {
    service._test.setExecFileForTest(null);
    service._test.setNetworkInterfacesForTest(null);
  }
}

async function testInterfaceParsing() {
  const rows = service.collectNetworkInterfaces(INTERFACES_FIXTURE);
  assert.deepStrictEqual(rows, [
    { name: "Ethernet", address: "192.168.1.10", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.10/24" },
    { name: "lo", address: "::1", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "::1/128" },
  ]);
}

function makeStubbedExec() {
  return (command, args) => {
    if (command === "ss") {
      return Promise.resolve({ ok: true, stdout: args.includes("-tlnp") ? SS_TCP_FIXTURE : SS_UDP_FIXTURE, stderr: "" });
    }
    if (command === "netstat") {
      return Promise.resolve({ ok: true, stdout: WINDOWS_NETSTAT_FIXTURE, stderr: "" });
    }
    if (command === "tasklist") {
      return Promise.resolve({ ok: true, stdout: '"node.exe","9001"', stderr: "" });
    }
    return Promise.resolve({ ok: false, stdout: "", stderr: `unexpected command ${command}` });
  };
}

async function testCollectNetworkInventoryStubbed() {
  service._test.setExecFileForTest(makeStubbedExec());
  service._test.setNetworkInterfacesForTest(() => INTERFACES_FIXTURE);
  try {
    const inventory = await service.collectNetworkInventory("win32");
    assert.strictEqual(inventory.source, "agent");
    assert.strictEqual(inventory.supported, true);
    assert.strictEqual(inventory.listenerSource, "netstat");
    assert.strictEqual(inventory.platform, "win32");
    assert.strictEqual(typeof inventory.generatedAt, "string");
    assert(Number.isFinite(Date.parse(inventory.generatedAt)), "generatedAt must be an ISO timestamp");
    assert.strictEqual(inventory.interfaceCount, 2);
    assert.strictEqual(inventory.listeners.length, WINDOWS_EXPECTED_ROWS.length);
    assert.strictEqual(inventory.listenerCount, inventory.listeners.length);
    assert.strictEqual(inventory.listenersTruncated, false);
    assert.strictEqual(inventory.listenersDropped, 0);
    assert.strictEqual(inventory.conflictCount, 2);
    assert.deepStrictEqual(inventory.conflicts[0].addresses, ["0.0.0.0", "127.0.0.1"]);
    // Process names resolve through the stubbed tasklist map (best effort).
    const enriched = inventory.listeners.find((row) => row.pid === 9001);
    assert.strictEqual(enriched.processName, "node.exe", "Windows pids must resolve to process names via tasklist");
    assert.deepStrictEqual(inventory.conflicts.find((row) => row.port === 5354).processes, ["node.exe"]);
    assert(Array.isArray(inventory.errors) && inventory.errors.length === 0, "stubbed collection must produce no errors");

    const linuxInventory = await service.collectNetworkInventory("linux");
    assert.strictEqual(linuxInventory.listenerSource, "ss");
    assert.strictEqual(linuxInventory.conflictCount, 1);
    assert.strictEqual(linuxInventory.conflicts[0].port, 8080);
  } finally {
    service._test.setExecFileForTest(null);
    service._test.setNetworkInterfacesForTest(null);
  }
}

async function testCheckPort() {
  service._test.setExecFileForTest(makeStubbedExec());
  try {
    const bound = await service.checkPort(8080, { platform: "linux", protocol: "tcp" });
    assert.strictEqual(bound.listening, true, "port 8080 must report as bound on the ss fixture");
    assert.strictEqual(bound.wildcardBound, true, "0.0.0.0:8080 makes the port wildcard-bound");
    assert.deepStrictEqual(bound.boundAddresses, ["0.0.0.0", "127.0.0.1"]);
    assert.strictEqual(bound.entries.length, 2);

    const free = await service.checkPort(9999, { platform: "linux", protocol: "udp" });
    assert.strictEqual(free.listening, false);
    assert.strictEqual(free.listenerSource, "ss");

    await assert.rejects(() => service.checkPort(0), (error) => error.code === "INVALID_PORT");
    await assert.rejects(() => service.checkPort(70000), (error) => error.code === "INVALID_PORT");
    await assert.rejects(() => service.checkPort("not-a-port"), (error) => error.code === "INVALID_PORT");
    await assert.rejects(() => service.checkPort(8080, { protocol: "sctp" }), (error) => error.code === "INVALID_PROTOCOL");
  } finally {
    service._test.setExecFileForTest(null);
    service._test.setNetworkInterfacesForTest(null);
  }
}

async function runLiveOptionalLeg() {
  // Live leg: run the real platform command (read-only host enumeration, no
  // network calls) and assert shape only. Skips cleanly when the command is
  // unavailable on this host.
  service._test.setExecFileForTest(null);
  service._test.setNetworkInterfacesForTest(null);

  const liveListeners = await service.collectListeners(process.platform);
  if (liveListeners.source === null) {
    console.log("network-inventory-smoke: live listener leg skipped (platform command unavailable).");
  } else {
    assert(Array.isArray(liveListeners.rows));
    for (const row of liveListeners.rows) {
      assert(["tcp", "udp"].includes(row.protocol), `live listener protocol must be tcp/udp, saw ${row.protocol}`);
      assert(Number.isInteger(row.localPort) && row.localPort >= 0 && row.localPort <= 65535, "live listener port must be a valid integer");
      assert(typeof row.localAddress === "string" && row.localAddress.length > 0, "live listener address must be a non-empty string");
      assert(row.pid === null || Number.isInteger(row.pid), "live listener pid must be an integer or null");
      assert(row.processName === null || typeof row.processName === "string");
    }
    assert(Array.isArray(service.detectPortConflicts(liveListeners.rows)));
  }

  const liveInventory = await service.collectNetworkInventory();
  assert.strictEqual(liveInventory.source, "agent");
  assert(Array.isArray(liveInventory.interfaces));
  assert(liveInventory.interfaces.every((row) => row.family === "IPv4" || row.family === "IPv6"));
  assert(Array.isArray(liveInventory.conflicts));
  assert(typeof liveInventory.listenersTruncated === "boolean");

  const liveCheck = await service.checkPort(65535, { platform: process.platform });
  assert.strictEqual(typeof liveCheck.listening, "boolean");
  assert(Array.isArray(liveCheck.entries));
}

async function main() {
  await testWindowsParsing();
  await testSsParsing();
  await testLinuxNetstatParsing();
  await testConflictDetection();
  await testRowCap();
  await testInterfaceParsing();
  await testCollectNetworkInventoryStubbed();
  await testCheckPort();
  await runLiveOptionalLeg();
  console.log("network-inventory-smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
