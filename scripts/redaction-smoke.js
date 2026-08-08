const assert = require("assert").strict;
const { performance } = require("perf_hooks");
const { redactString, sanitize, sanitizeForDiagnostics } = require("../src/shared/redaction");

console.log("Checking private path redaction boundaries...");

const privatePaths = [
  ["open /home/private-user/projects/anxos/config.json", "open [redacted-path]"],
  ["open /Users/private-user/Library/AnxOS/config.json", "open [redacted-path]"],
  ["failed at /root/.config/anxos/config.json", "failed at [redacted-path]"],
  ["C:\\Users\\private-user\\AppData\\Roaming\\AnxOS\\config.json", "[redacted-path]"],
  ["read /srv/anxos/private/agent.json", "read [redacted-path]"],
  ["read /opt/anxos/private/agent.json", "read [redacted-path]"],
  ["inspect /var/lib/docker/volumes/customer-project/_data/config.json", "inspect [redacted-path]"],
  ["read /var/log/playit/playit.log", "read [redacted-path]"],
];

for (const [input, expected] of privatePaths) {
  assert.equal(redactString(input), expected, `Expected private path to be redacted: ${input}`);
}

const quotedPrivatePaths = [
  ['open "/home/Private User/AnxOS Control Center/config.json"', 'open "[redacted-path]"'],
  ['open "/Users/Private User/Application Support/AnxOS/config.json"', 'open "[redacted-path]"'],
  ['open "/root/AnxOS Data/Nested Folder/config.json"', 'open "[redacted-path]"'],
  ['open "/srv/Game Servers/Palworld/config.ini"', 'open "[redacted-path]"'],
  ['open "/opt/AnxOS Control Center/resources/app.asar"', 'open "[redacted-path]"'],
  ['open "/var/lib/AnxOS Data/Nested Folder/config.json"', 'open "[redacted-path]"'],
  ['open "/var/log/AnxOS Control Center/server.log"', 'open "[redacted-path]"'],
  ["open '/srv/Game Servers/Palworld/config.ini'", "open '[redacted-path]'"],
  ["open '/var/log/AnxOS Control Center/server.log'", "open '[redacted-path]'"],
  ['open "C:\\Users\\Private User\\AppData\\Roaming\\AnxOS Control Center\\config.json"', 'open "[redacted-path]"'],
  [
    'copy "/home/Private User/Source Folder/config.json" to "C:\\Users\\Backup User\\Destination Folder\\config.json"',
    'copy "[redacted-path]" to "[redacted-path]"',
  ],
  [
    'failed at "/var/lib/AnxOS Data/config.json", code=ENOENT; retry after checking permissions.',
    'failed at "[redacted-path]", code=ENOENT; retry after checking permissions.',
  ],
];

for (const [input, expected] of quotedPrivatePaths) {
  const redacted = redactString(input);
  assert.equal(redacted, expected, `Expected balanced quoted path to be fully redacted: ${input}`);
  assert.equal(redactString(redacted), redacted, `Expected quoted path redaction to be idempotent: ${input}`);
}

const sanitizedQuotedPath = sanitize({ message: quotedPrivatePaths[0][0], nested: { pathText: quotedPrivatePaths[9][0] } });
assert.deepStrictEqual(sanitize(sanitizedQuotedPath), sanitizedQuotedPath, "Repeated structured sanitization must remain idempotent.");

const diagnosticPathSource = {
  localPath: "C:\\Users\\Private User\\Downloads\\AnxOS Control Center\\server.zip",
  remotePath: "/home/Private User/Game Servers/world.zip",
  backupRoot: "/Users/Backup User/AnxOS Backups/world.zip",
  binaryPath: "/root/AnxOS Tools/bin/server",
  configPathUsed: "/srv/Game Servers/config/server.json",
  logPathUsed: "/opt/AnxOS Control Center/logs/server.log",
  workingDirectory: "/var/lib/AnxOS Data/Nested Folder",
  executablePath: "/var/log/AnxOS Control Center/helper",
  nested: {
    remotePath: [
      "/home/Array User/First Folder/file.txt",
      "relative/folder/file.txt",
      "https://example.test/home/Array%20User/file.txt",
      "/etc/anxos/config.json",
      "/usr/local/bin/docker",
      "/var/cache/anxos/index.json",
      "/var/run/anxos.sock",
      "/mnt/anxos/file.txt",
      "/media/anx/file.txt",
      "[redacted-path]",
      { localPath: "/Users/Nested User/Second Folder/file.txt" },
    ],
  },
};
const diagnosticPathSourceBefore = JSON.stringify(diagnosticPathSource);
const defaultDiagnosticPathOutput = sanitize(diagnosticPathSource);
assert.notStrictEqual(defaultDiagnosticPathOutput.localPath, "[redacted-path]", "Default sanitize behavior must not enable full diagnostic path-field redaction.");
assert(defaultDiagnosticPathOutput.localPath.includes(" User\\Downloads"), "Default sanitize behavior must retain its existing whitespace-suffix behavior.");

const diagnosticPathOutput = sanitizeForDiagnostics(diagnosticPathSource);
for (const field of ["localPath", "remotePath", "backupRoot", "binaryPath", "configPathUsed", "logPathUsed", "workingDirectory", "executablePath"]) {
  assert.strictEqual(diagnosticPathOutput[field], "[redacted-path]", `Diagnostic field ${field} must redact its complete supported absolute path.`);
}
assert.deepStrictEqual(diagnosticPathOutput.nested.remotePath.slice(0, 10), [
  "[redacted-path]",
  "relative/folder/file.txt",
  "https://example.test/home/Array%20User/file.txt",
  "/etc/anxos/config.json",
  "/usr/local/bin/docker",
  "/var/cache/anxos/index.json",
  "/var/run/anxos.sock",
  "/mnt/anxos/file.txt",
  "/media/anx/file.txt",
  "[redacted-path]",
]);
assert.strictEqual(diagnosticPathOutput.nested.remotePath[10].localPath, "[redacted-path]", "Objects inside diagnostic path arrays must recurse normally.");
assert.strictEqual(JSON.stringify(diagnosticPathSource), diagnosticPathSourceBefore, "Diagnostic sanitization must not mutate its source object.");
assert.deepStrictEqual(sanitizeForDiagnostics(diagnosticPathOutput), diagnosticPathOutput, "Repeated diagnostic sanitization must remain idempotent.");
assert.deepStrictEqual(sanitize(diagnosticPathOutput), diagnosticPathOutput, "Default sanitization after diagnostic sanitization must remain stable.");

const excludedDiagnosticFields = {
  path: "/home/Private User/path value",
  pathname: "/home/Private User/pathname value",
  filePath: "/home/Private User/file path",
  pathLabel: "/home/Private User/path label",
  mountpoint: "/home/Private User/mount point",
  filesystemRoot: "/home/Private User/filesystem root",
  sourcePath: "/home/Private User/source path",
  destinationPath: "/home/Private User/destination path",
};
assert.deepStrictEqual(sanitizeForDiagnostics(excludedDiagnosticFields), sanitize(excludedDiagnosticFields), "Excluded operational field names must retain default sanitizer behavior.");

const deepDiagnosticSource = { nested: [{ nested: [{ nested: [{ localPath: "/srv/Deep Structure/Folder/file.txt" }] }] }] };
assert.strictEqual(sanitizeForDiagnostics(deepDiagnosticSource).nested[0].nested[0].nested[0].localPath, "[redacted-path]", "Diagnostic path fields must redact within normal depth limits.");
assert.strictEqual(sanitizeForDiagnostics({ localPath: 42, remotePath: false, backupRoot: null }).localPath, 42, "Non-string diagnostic path fields must retain normal sanitizer behavior.");
assert.strictEqual(sanitizeForDiagnostics({ payload: Buffer.from("path") }).payload, "[buffer:4]", "Diagnostic sanitization must preserve Buffer handling.");
const circularDiagnosticSource = { localPath: "/home/Circular User/file.txt" };
circularDiagnosticSource.self = circularDiagnosticSource;
assert.strictEqual(sanitizeForDiagnostics(circularDiagnosticSource).self, "[circular]", "Diagnostic sanitization must preserve circular-reference handling.");

const controls = [
  "https://example.test/srv/anxos/status",
  "https://example.test/opt/anxos/releases",
  "https://example.test/var/lib/item",
  "https://example.test/var/log/playit",
  "GET /var/logs HTTP/1.1",
  "GET /var/liberate HTTP/1.1",
  "/var/cache/anxos/index.json",
  "/var/run/anxos.sock",
  "/usr/local/bin/docker",
  "/etc/anxos/config.json",
  "prefix/var/lib/data",
  "/mnt/anxos/instances/server.json",
  "/media/anx/Backups/server.tar.gz",
  "api/v1/servers/list",
  "alpha/beta/gamma",
  "provider --endpoint /api/v1/status --format json",
  "provider --config /etc/anxos/config.json --mode safe",
  "provider --mapping source/target --mode safe",
  "prefix/srv/anxos/status",
  "The service is optimized and healthy.",
  'message "ordinary quoted prose with spaces" remains',
  "message 'ordinary single-quoted prose with spaces' remains",
  'open "https://example.test/opt/AnxOS Control Center"',
  "open 'http://example.test/var/log/AnxOS Control Center'",
  'request "/api/v1/game servers/list"',
  'mapping "alpha/beta/gamma delta"',
  'open "/mnt/AnxOS Data/config.json"',
  'open "/media/Private User/Backups/server.tar.gz"',
  'open "/usr/local/AnxOS Control Center/bin/anxos"',
  'open "/var/cache/AnxOS Data/index.json"',
  'open "/var/run/AnxOS Data/anxos.sock"',
];

for (const input of controls) {
  assert.equal(redactString(input), input, `Expected control text to remain unchanged: ${input}`);
}

const deferredCases = [
  [
    'open "/opt/AnxOS Control Center/resources/app.asar',
    'open "[redacted-path] Control Center/resources/app.asar',
  ],
  [
    "open '/srv/Game Servers/Palworld/config.ini",
    "open '[redacted-path] Servers/Palworld/config.ini",
  ],
  [
    String.raw`{"path":"C:\\Users\\Private User\\AppData\\Roaming\\AnxOS Control Center\\config.json"}`,
    String.raw`{"path":"C:\\Users\\Private User\\AppData\\Roaming\\AnxOS Control Center\\config.json"}`,
  ],
  [
    "open file:///opt/AnxOS Control Center/resources/app.asar",
    "open file:///opt/AnxOS Control Center/resources/app.asar",
  ],
  [
    String.raw`open /opt/AnxOS\ Control\ Center/resources/app.asar`,
    String.raw`open [redacted-path] Control\ Center/resources/app.asar`,
  ],
];

for (const [input, expected] of deferredCases) {
  assert.equal(redactString(input), expected, `Expected deferred path shape to retain existing behavior: ${input}`);
}

const quoteHeavyInput = `${'message "ordinary quoted prose" and \'single quoted prose\' '.repeat(260)}open "/opt/AnxOS Control Center/resources/app.asar"`;
const performanceStart = performance.now();
const quoteHeavyOutput = redactString(quoteHeavyInput);
sanitizeForDiagnostics({ nested: Array.from({ length: 200 }, (_, index) => ({ localPath: `/home/Performance User/Folder ${index}/file.txt` })) });
const quoteHeavyElapsedMs = performance.now() - performanceStart;
assert(quoteHeavyOutput.endsWith('open "[redacted-path]"'), "Quote-heavy input must still redact the final balanced private path.");
assert(quoteHeavyElapsedMs < 250, `Quote-heavy redaction exceeded the 250 ms guard: ${quoteHeavyElapsedMs.toFixed(2)} ms.`);

console.log(`Private path redaction smoke checks passed (quote-heavy guard: ${quoteHeavyElapsedMs.toFixed(2)} ms).`);
