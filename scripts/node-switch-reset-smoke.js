// Regression smoke for BUG #2: the renderer's node switch must always leave the
// "Switching node..." state, even if a switch never completes. The reset is
// keyed by a switch generation so a stale completion can never clear a newer
// switch. These are static guards against regressing to a conditional-only
// reset (which left the selector stuck).

const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync(require.resolve("../app.js"), "utf8");

assert(source.includes("let nodeSwitchGeneration = 0;"), "Renderer must declare a node-switch generation counter.");
assert(source.includes("++nodeSwitchGeneration"), "Renderer must capture a fresh generation when a switch starts.");
assert(source.includes("const switchGeneration = ++nodeSwitchGeneration;"), "Renderer must snapshot the switch generation.");
assert(source.includes("switchGeneration === nodeSwitchGeneration"), "Renderer must guard the reset by switch generation.");
assert(source.includes("} finally {") && source.includes("nodeSwitchInProgress = false;"), "Renderer must reset nodeSwitchInProgress unconditionally in a finally block.");
assert(source.includes("owned by selectNode's finally"), "Renderer must document that nodeSwitchInProgress is owned by selectNode's finally block.");

console.log("Node-switch reset smoke checks passed.");