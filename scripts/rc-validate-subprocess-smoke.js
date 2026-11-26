const assert = require("assert");
const { classifySubprocessResult, npmInvocation } = require("./rc-validate");

const nodeInvocation = npmInvocation("website:download-functions:smoke", { npm_execpath: "/tmp/npm-cli.js" }, "win32");
assert.strictEqual(nodeInvocation.command, process.execPath, "Configured npm_execpath must be launched through Node.");
assert.deepStrictEqual(nodeInvocation.args, ["/tmp/npm-cli.js", "run", "website:download-functions:smoke"]);
const fallbackInvocation = npmInvocation("website:download-functions:smoke", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
assert.strictEqual(fallbackInvocation.command, "C:\\Windows\\System32\\cmd.exe", "Windows fallback must use ComSpec.");
assert(fallbackInvocation.args.join(" ").includes("npm.cmd"), "Windows fallback must invoke npm.cmd through ComSpec.");

const warningResult = classifySubprocessResult({ status: 0, stderr: "npm notice run with --loglevel verbose\n" });
assert.strictEqual(warningResult.status, "PASS", "Exit code 0 must pass even when stderr contains npm notices.");
assert.strictEqual(warningResult.exitCode, 0);
assert(warningResult.stderr.includes("npm notice"), "Non-fatal stderr must remain available for diagnostics.");

// Plain `node scripts/x.js [args]` suites start directly (npm cost ~0.8 s each).
const path = require("path");
const { directInvocation } = require("./rc-validate");
const scripts = {
  "plain:smoke": "node scripts/plain-smoke.js",
  "args:smoke": "node scripts/tool.js --check",
  "chain:smoke": "node scripts/a.js && node scripts/b.js",
  "env:smoke": "FOO=1 node scripts/a.js",
  "quoted:smoke": "node scripts/a.js \"two words\"",
};
const direct = directInvocation("plain:smoke", { Path: "C:\\bin" }, scripts);
assert.strictEqual(direct.command, process.execPath, "A plain node script runs on this Node directly.");
assert.deepStrictEqual(direct.args, ["scripts/plain-smoke.js"]);
assert.strictEqual(direct.env.Path.split(path.delimiter)[0], path.join(process.cwd(), "node_modules", ".bin"), "node_modules/.bin comes first on the PATH, as with npm (whatever the variable's case).");
assert.ok(direct.env.Path.endsWith("C:\\bin"), "The caller's PATH is kept after it.");
assert.strictEqual(direct.env.npm_lifecycle_event, "plain:smoke");
assert.deepStrictEqual(directInvocation("args:smoke", {}, scripts).args, ["scripts/tool.js", "--check"], "Simple arguments are kept.");
for (const name of ["chain:smoke", "env:smoke", "quoted:smoke", "missing:smoke"]) {
  assert.strictEqual(directInvocation(name, {}, scripts), null, `${name} needs a shell, so it still goes through npm.`);
}
assert.strictEqual(directInvocation("plain:smoke", { RC_VIA_NPM: "1" }, scripts), null, "RC_VIA_NPM=1 sends every suite through npm.");

const failureResult = classifySubprocessResult({ status: 1, stderr: "real failure\n" });
assert.strictEqual(failureResult.status, "FAIL", "Non-zero exit codes must fail validation.");
assert.strictEqual(failureResult.exitCode, 1);
console.log("RC subprocess classification smoke: PASS");
