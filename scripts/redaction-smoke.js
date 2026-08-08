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
];

for (const [input, expected] of privatePaths) {
  assert.equal(redactString(input), expected, `Expected private path to be redacted: ${input}`);
}

const controls = [
  "https://example.test/srv/anxos/status",
  "https://example.test/opt/anxos/releases",
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
