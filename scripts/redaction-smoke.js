const assert = require("assert").strict;
const { redactString } = require("../src/shared/redaction");

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
];

for (const input of controls) {
  assert.equal(redactString(input), input, `Expected control text to remain unchanged: ${input}`);
}

console.log("Private path redaction smoke checks passed.");
