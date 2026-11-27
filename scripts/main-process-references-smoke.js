#!/usr/bin/env node
"use strict";

// Build 216: the legacy retirement removed closeAddStorageWindow() but left two
// calls in main.js's window "close" handler. Closing the main window (to the
// tray, or at shutdown) then threw a ReferenceError after preventDefault() and
// before window.hide(); found when the Linux packages were stopped in the #54
// launch test. node --check cannot see a call to a missing function.
//
// R1 every bare function call in main.js and preload.js names something that
//    file declares (function, const/let/var, class, parameter or destructured
//    binding) or a JavaScript/Node global.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const KEYWORDS = new Set("if for while switch catch function return typeof new await async super require import delete void yield".split(" "));
const GLOBALS = new Set(Object.getOwnPropertyNames(globalThis).concat(["require", "module", "exports", "__dirname", "__filename", "process", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Buffer", "URL", "URLSearchParams", "structuredClone", "fetch", "queueMicrotask", "AbortController", "TextDecoder", "TextEncoder"]));

function undefinedCalls(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""');
  const called = new Set([...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const name = part.split(":").pop().split("=")[0].trim(); if (name) declared.add(name); }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const part of m[1].split(",")) { const name = part.split("=")[0].replace("...", "").trim(); if (name) declared.add(name); }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>|\bfunction\s*[\w$]*\s*\(([^)]*)\)|([A-Za-z_$][\w$]*)\s*=>|catch\s*\(\s*([\w$]+)/g)) {
    for (const part of (m[1] || m[2] || m[3] || m[4] || "").split(",")) { const name = part.split("=")[0].replace(/[{}\[\]]|\.\.\./g, "").trim(); if (/^[\w$]+$/.test(name)) declared.add(name); }
  }
  return [...called].filter((name) => !KEYWORDS.has(name) && !declared.has(name) && !GLOBALS.has(name));
}

const results = [];
for (const file of ["main.js", "preload.js"]) {
  try {
    const unknown = undefinedCalls(fs.readFileSync(path.join(ROOT, file), "utf8"));
    assert.deepStrictEqual(unknown, [], `${file} calls functions it never declares: ${unknown.join(", ")}`);
    results.push(`PASS R1 ${file}`);
  } catch (error) {
    results.push(`FAIL R1 ${file}\n  ${error.message}`);
  }
}
try {
  assert.deepStrictEqual(undefinedCalls("function a() {}\na();\nb();\n// c();\nconst d = () => e => f(e);\n"), ["b", "f"], "the check itself finds b() and f(), not a(), commented c() or e");
  results.push("PASS R1 self-test");
} catch (error) {
  results.push(`FAIL R1 self-test\n  ${error.message}`);
}
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) {
  console.log(`main-process-references-smoke: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`main-process-references-smoke passed (${results.length} checks)`);
