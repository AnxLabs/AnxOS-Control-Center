const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Could not find ${name}.`);
  const signatureEnd = source.indexOf(")", start);
  const open = source.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

const context = {};
vm.createContext(context);
vm.runInContext(`${extractFunction("getNodeIdentity")}; this.getNodeIdentity = getNodeIdentity;`, context);

assert.doesNotThrow(() => context.getNodeIdentity(null), "Logged-out node rendering must tolerate a null selected node.");
assert.deepStrictEqual({ ...context.getNodeIdentity(null) }, {}, "A null selected node must normalize to an empty identity.");
// Since the Local Owner authentication model (Build 203) the sidebar detail
// chain gained a leading unlock branch before the null guard; the pinned
// behavior is that a null node is still handled BEFORE selected.kind is read.
const normalizedSource = source.replace(/\s+/g, " ");
assert(normalizedSource.includes(': securityState?.localOwnerAuthenticated !== true ? "Unlock AnxOS to start the Application Host." : !selected ? "Application Host unavailable." : selected.kind === "application-host"'),
  "Logged-out sidebar rendering must guard a null selected node before reading its kind.");
assert(source.includes('const authorizationUnavailable = /LOGIN_REQUIRED|UNAUTHORIZED|AUTHENTICATION_FAILED|FORBIDDEN'), "SSH profile loading must classify explicit authorization-gate failures.");
assert(source.includes('category: authorizationUnavailable ? "authorization-required" : "unexpected"'), "Expected authorization failures must remain distinguishable from genuine renderer errors.");
assert(source.includes("sshProfilesState.servers = []") && source.includes("sshSelectedProfileId = null"), "Logged-out SSH state must clear inaccessible profile data.");

console.log("QA logged-out renderer smoke checks passed.");
