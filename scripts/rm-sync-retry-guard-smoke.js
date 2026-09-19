#!/usr/bin/env node
"use strict";

// rm-sync-retry-guard-smoke — the recursive-retry rule for directory deletes.
//
// WHY THIS EXISTS
// A sweep added `maxRetries: 5, retryDelay: 100` to teardown deletions to stop
// Windows handle-release races (ENOTEMPTY / EBUSY when a directory whose last
// handle is still closing is deleted instead of waited for). Two defects then
// had to be cleaned up by hand:
//
//   1. Node's fs binding forwards maxRetries / retryDelay to the underlying
//      retry loop ONLY on the recursive-removal path. A non-recursive delete
//      that carries those options advertises a durability it does not have:
//      the options are silently inert.
//   2. A few sites layered retries inside a hand-rolled retry loop, silently
//      multiplying a deliberately bounded policy.
//
// Defect 1 is the one this suite enforces mechanically, because it will
// otherwise be re-made by the next person who "hardens" a delete:
//
//   RULE: maxRetries / retryDelay may appear ONLY on a call to rmSync or rm
//         whose own literal options object also passes `recursive: true`.
//
// ENFORCE (fail the suite): a call whose literal options object contains
// maxRetries or retryDelay but NOT `recursive: true`.
//
// REPORT ONLY (never fail): a recursive delete whose options carry no retries.
// That is a policy preference, not a correctness rule; failing on it would
// create permanent, unfixable-by-design noise and pressure people to add
// options they may not need.
//
// WHY A TEXT SCAN IS THE RIGHT TOOL HERE
// The rule is purely syntactic: it is about the SHAPE of a literal options
// object at a call site, not about runtime behaviour. There is no "false green"
// of the kind a behavioural invariant would have. The scan reads each call's
// actual options object with a balanced-paren extractor (not a line regex), so
// multi-line and multi-argument call shapes are handled.
//
// WHAT THIS CANNOT PROVE (honest limits)
//   * It only inspects LITERAL object arguments. A deletion whose options are
//     built elsewhere (assigned to a variable first, a spread, or a computed
//     options value) is counted as "options not a literal" and is NOT
//     classified. It can neither confirm nor deny the rule for those sites.
//   * It is not a parser. String/template/comment bodies are skipped by the
//     balanced scanner, but an unusual regex literal containing a quote or an
//     unbalanced bracket inside a template expression could desynchronise a
//     scan over that call. Such a shape would surface as an unparsed call, not
//     as a silent pass, but it is not proven impossible.
//   * It cannot see whether a recursive delete actually NEEDS retries, only
//     whether they are present.
//   * Scan scope is src, agent and scripts (see SCAN_ROOTS). Root-level files
//     such as app.js / main.js and any non-.js source are outside this rule's
//     scope.
//
// NON-VACUOUS BY CONSTRUCTION
// The suite asserts it actually walked a plausible number of files and found a
// plausible number of calls, and fails if the scan finds zero calls. A broken
// glob can therefore never make it pass forever.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOTS = ["src", "agent", "scripts"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"]);

// Deliberately conservative floors. The tree currently holds far more than
// these; they exist to catch a broken walk, not to be tight bounds.
const MIN_FILES_SCANNED = 100;
const MIN_CALLS_SCANNED = 100;

// A call token only, never a full literal in this file (so this file cannot
// match itself). Callee is captured; the options object is extracted by
// balanced scan below.
const CALL_PATTERN = /(?<![\w$])(rmSync|rm)\s*\(/g;

const RETRY_OPTION_PATTERN = /\b(?:maxRetries|retryDelay)\s*:/;
const RECURSIVE_TRUE_PATTERN = /\brecursive\s*:\s*true\b/;

// --- source walking ---------------------------------------------------------

function collectSourceFiles(rootRelative) {
  const rootAbsolute = path.join(REPO_ROOT, rootRelative);
  if (!fs.existsSync(rootAbsolute)) return [];
  const found = [];
  const walk = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.forEach((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) return;
        walk(absolute);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) found.push(absolute);
    });
  };
  walk(rootAbsolute);
  return found;
}

// --- balanced scanning ------------------------------------------------------

// Index of the closing quote for the string that opens at `start`. Handles
// backslash escapes. Template literals are treated as opaque strings: a `${}`
// expression inside one is skipped along with the literal, so a nested call
// inside a template expression is not discovered. That shape does not occur in
// deletion call sites here, and the cost of missing it is an unclassified call,
// never a false pass of the rule.
function skipQuoted(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") { index += 1; continue; }
    if (character === quote) return index;
  }
  return source.length - 1;
}

// Index of the final character of the comment beginning at `start`.
function skipLineComment(source, start) {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length - 1 : newline;
}

function skipBlockComment(source, start) {
  const end = source.indexOf("*/", start + 2);
  return end < 0 ? source.length - 1 : end + 1;
}

// Index of the `)` matching the `(` at `openIndex`, or -1.
function findMatchingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" || character === "\"" || character === "`") {
      index = skipQuoted(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Split a call's argument text on top-level commas, respecting nested (), [],
// {}, strings and comments.
function splitTopLevelArguments(argumentText) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < argumentText.length; index += 1) {
    const character = argumentText[index];
    if (character === "'" || character === "\"" || character === "`") {
      index = skipQuoted(argumentText, index);
      continue;
    }
    if (character === "/" && argumentText[index + 1] === "/") {
      index = skipLineComment(argumentText, index);
      continue;
    }
    if (character === "/" && argumentText[index + 1] === "*") {
      index = skipBlockComment(argumentText, index);
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(argumentText.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(argumentText.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

// Every rmSync / rm call in one file, with its literal options object (or null
// when the options argument is absent or not an object literal).
function findCalls(relativePath, source) {
  const calls = [];
  CALL_PATTERN.lastIndex = 0;
  let match = CALL_PATTERN.exec(source);
  while (match !== null) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen < 0) {
      calls.push({
        callee: match[1],
        path: relativePath,
        line: lineNumberAt(source, match.index),
        options: null,
        unparsed: true,
      });
      match = CALL_PATTERN.exec(source);
      continue;
    }
    const argumentText = source.slice(openParen + 1, closeParen);
    const argumentsList = splitTopLevelArguments(argumentText);
    const literalOptions = argumentsList.find((argument) => argument.startsWith("{")) || null;
    calls.push({
      callee: match[1],
      path: relativePath,
      line: lineNumberAt(source, match.index),
      options: literalOptions,
      unparsed: false,
    });
    CALL_PATTERN.lastIndex = closeParen + 1;
    match = CALL_PATTERN.exec(source);
  }
  return calls;
}

// --- classification ---------------------------------------------------------

function classify(call) {
  if (!call.options) return { kind: "unclassified" };
  const hasRetryOptions = RETRY_OPTION_PATTERN.test(call.options);
  const recursiveTrue = RECURSIVE_TRUE_PATTERN.test(call.options);
  if (hasRetryOptions && !recursiveTrue) return { kind: "violation", hasRetryOptions, recursiveTrue };
  if (recursiveTrue && !hasRetryOptions) return { kind: "recursive-without-retries", hasRetryOptions, recursiveTrue };
  return { kind: "ok", hasRetryOptions, recursiveTrue };
}

function describeOptions(optionsText) {
  // One normalised line, so a violation is reported with the exact options.
  return String(optionsText).replace(/\s+/g, " ").trim();
}

// --- run --------------------------------------------------------------------

function run() {
  const files = [];
  SCAN_ROOTS.forEach((root) => { files.push(...collectSourceFiles(root)); });
  files.sort();

  const calls = [];
  files.forEach((absolute) => {
    const relativePath = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
    const source = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
    calls.push(...findCalls(relativePath, source));
  });

  const violations = [];
  const recursiveWithoutRetries = [];
  const unclassified = [];
  calls.forEach((call) => {
    const result = classify(call);
    if (result.kind === "violation") violations.push(call);
    else if (result.kind === "recursive-without-retries") recursiveWithoutRetries.push(call);
    else if (result.kind === "unclassified") unclassified.push(call);
  });

  const callsWithLiteralOptions = calls.length - unclassified.length;

  console.log("rm-sync-retry-guard-smoke");
  console.log("=========================");
  console.log(`scanned ${files.length} file(s) under ${SCAN_ROOTS.join(", ")}`);
  console.log(`found ${calls.length} rm-call(s): ${callsWithLiteralOptions} with a literal options object, ${unclassified.length} without one`);
  console.log("");

  // Non-vacuity: a broken walk must fail loudly, never pass silently.
  assert.ok(
    files.length >= MIN_FILES_SCANNED,
    `the scan is vacuous: only ${files.length} file(s) scanned, expected at least ${MIN_FILES_SCANNED}`,
  );
  assert.ok(
    calls.length >= MIN_CALLS_SCANNED,
    `the scan is vacuous: only ${calls.length} rm-call(s) found, expected at least ${MIN_CALLS_SCANNED}`,
  );
  assert.ok(
    calls.length > 0,
    "the scan found zero rm-calls, which cannot be true for this tree — the walk or the call pattern is broken",
  );
  assert.ok(
    violations.length === 0,
    [
      `${violations.length} rm-call(s) carry maxRetries/retryDelay without recursive: true`,
      "(Node ignores those options on the non-recursive path — they are inert):",
      ...violations.map((call) => `  ${call.path}:${call.line}  ${call.callee}  ${describeOptions(call.options)}`),
    ].join("\n"),
  );

  console.log(`ENFORCED  ${violations.length} violation(s) of the recursive-retry rule.`);

  // Report only — policy, not correctness. Never fails the suite.
  console.log("");
  console.log(`REPORT ONLY (no failure): ${recursiveWithoutRetries.length} recursive delete(s) carry no retries.`);
  recursiveWithoutRetries.forEach((call) => {
    console.log(`  info  ${call.path}:${call.line}  ${call.callee}  ${describeOptions(call.options)}`);
  });

  console.log("");
  console.log(`rm-sync-retry-guard-smoke passed (${files.length} files, ${calls.length} rm-calls, 0 violations).`);
}

try {
  run();
} catch (error) {
  console.error("");
  console.error("rm-sync-retry-guard-smoke FAILED");
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
}