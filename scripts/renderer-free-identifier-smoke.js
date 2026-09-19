#!/usr/bin/env node
"use strict";

// Renderer free-identifier smoke.
//
// WHY THIS EXISTS
// app.js is a classic browser script loaded with a plain <script> tag. In that
// mode, reading an identifier that is declared nowhere in the file throws
// `ReferenceError: <name> is not defined` at the moment of the read. The shipped
// V2-E defect was exactly that: renderInstanceRestartSchedules() dereferenced
// five names (`restartScheduleList`, `restartScheduleEmpty`,
// `restartScheduleStatus`, `restartSchedulesState`,
// `restartSchedulesRequestInFlight`) that app.js never declared. The first read
// sat inside `if (!restartScheduleList)`, which reads like a guard but is not
// one: the read itself throws. Because the call was outside a try, the throw
// escaped selectNode()'s finally and stranded `nodeSwitchInProgress` true, so
// the sidebar said "Switching node…" for the rest of the session.
//
// Nothing in the test suite could see it. scripts/renderer-safety-smoke.js is a
// source-pattern gate (it greps for HTML sinks), and the node-switch smoke only
// covers the restart-schedule identifiers it was written for. This smoke closes
// the CLASS: any identifier that app.js reads but never declares.
//
// METHOD (no parser is available in this repo and none may be added: acorn,
// esprima and babel are all absent, and the tree is dependency-frozen)
//   1. Mask the source: comments, string literals, regex literals and the
//      literal text of template literals are replaced by spaces (newlines
//      preserved). Code inside `${ ... }` template substitutions is kept.
//   2. Collect every declared name anywhere in the file (a file-wide superset;
//      lexical scoping is deliberately not modelled): `var|let|const`
//      declarators including destructuring patterns and defaults, `function`
//      names, `class` names, function/arrow/catch/method parameter bindings.
//   3. Collect every identifier *read*: an identifier token that is not a
//      reserved word, not a property access (`a.b`, `a?.b`), not a property key
//      (`{ a: 1 }`), not a method name (`foo() { }`), not a statement label,
//      not a simple assignment target (`a = 1`, which writes rather than reads
//      and therefore does not throw in sloppy mode), and not masked.
//   4. Subtract declared names and a documented allowlist of real browser
//      globals. Whatever is left is a candidate free identifier.
//
// KNOWN LIMITS — this is a static scan, not a parser. It CANNOT catch:
//   * scope errors: a name declared in one function and read in another is
//     "declared somewhere", so it is not reported (false negative by design);
//   * reads of an identifier that is only ever *assigned* (`foo = 1`), because
//     assignment is filtered as a write — that creates an implicit global and
//     does not throw;
//   * destructuring *assignment* targets without a declaration (`({ a } = o)`);
//   * dynamic property access (`obj[name]`) and any name built at runtime;
//   * names produced by eval-like constructs (`eval`, `new Function`, `with`);
//   * identifiers inside the masked literal text of template literals (reads
//     inside `${ ... }` ARE scanned);
//   * patterns this scan does not model: computed keys in destructuring
//     (`const { [k]: v } = o` counts `k` as declared), regex/division
//     disambiguation after `}` (rare), and any syntax added to app.js that the
//     declaration collector below does not know;
//   * that a live window renders anything: this does not launch Electron.
//
// CLI
//   node scripts/renderer-free-identifier-smoke.js            gate (exit 1 on candidates)
//   node scripts/renderer-free-identifier-smoke.js --report   print all candidates, exit 0
//   node scripts/renderer-free-identifier-smoke.js --stats    print declaration statistics, exit 0

const fs = require("fs");
const path = require("path");

const APP_PATH = path.resolve(__dirname, "..", "app.js");

// ---------------------------------------------------------------------------
// Reserved words and other non-identifier tokens.
// ---------------------------------------------------------------------------
const RESERVED_WORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "constructor",
  "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "of", "package", "private", "protected", "public", "return", "set",
  "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
  "void", "while", "with", "yield",
]);

// Keywords after which a `/` begins a regex literal rather than a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw", "default",
]);

// Control-flow keywords that can precede a parenthesised expression followed by
// a block. Excluded when deciding whether `name(...) {` is a method definition,
// so `if (x) {` is never mistaken for a parameter list.
const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "with", "function", "return",
  "typeof", "delete", "void", "new", "do", "else", "yield", "await", "in",
  "of", "instanceof", "case", "throw", "super", "class", "extends", "export",
  "import", "default", "const", "let", "var", "static", "get", "set", "async",
]);

// ---------------------------------------------------------------------------
// Documented allowlist of genuine globals. Every entry is a name app.js reads
// and that the browser/Electron environment supplies. Each is justified:
//   browser DOM/global object  -> provided by the host environment
//   ECMAScript built-in        -> provided by the JS engine
//   implicit binding           -> supplied by the language at runtime
// ---------------------------------------------------------------------------
const GLOBAL_ALLOWLIST = new Map([
  // --- host environment -----------------------------------------------------
  ["window", "browser global object"],
  ["document", "browser DOM entry point"],
  ["console", "browser logging API"],
  ["navigator", "browser navigator API"],
  ["location", "browser location API"],
  ["history", "browser history API"],
  ["localStorage", "browser persistent storage"],
  ["sessionStorage", "browser per-session storage"],
  ["fetch", "browser network API"],
  ["setTimeout", "host timer API"],
  ["clearTimeout", "host timer API"],
  ["setInterval", "host timer API"],
  ["clearInterval", "host timer API"],
  ["requestAnimationFrame", "host animation-frame API"],
  ["cancelAnimationFrame", "host animation-frame API"],
  ["queueMicrotask", "host microtask API"],
  ["structuredClone", "host deep-clone API"],
  ["performance", "host performance API"],
  ["crypto", "host Web Crypto API"],
  ["atob", "host base64 decode"],
  ["btoa", "host base64 encode"],
  ["getComputedStyle", "browser style API"],
  ["matchMedia", "browser media-query API"],
  ["alert", "browser dialog API"],
  ["confirm", "browser dialog API"],
  ["prompt", "browser dialog API"],
  ["close", "browser window API"],
  ["focus", "browser window API"],
  ["print", "browser window API"],
  ["scrollTo", "browser window API"],
  ["scrollBy", "browser window API"],
  ["postMessage", "browser cross-context API"],
  ["getSelection", "browser selection API"],
  ["open", "browser window API"],
  // --- ECMAScript built-ins -------------------------------------------------
  ["Object", "built-in"],
  ["Array", "built-in"],
  ["String", "built-in"],
  ["Number", "built-in"],
  ["Boolean", "built-in"],
  ["Symbol", "built-in"],
  ["BigInt", "built-in"],
  ["Function", "built-in"],
  ["Math", "built-in"],
  ["JSON", "built-in"],
  ["Date", "built-in"],
  ["RegExp", "built-in"],
  ["Promise", "built-in"],
  ["Map", "built-in"],
  ["Set", "built-in"],
  ["WeakMap", "built-in"],
  ["WeakSet", "built-in"],
  ["Proxy", "built-in"],
  ["Reflect", "built-in"],
  ["Intl", "built-in"],
  ["Error", "built-in"],
  ["TypeError", "built-in"],
  ["RangeError", "built-in"],
  ["SyntaxError", "built-in"],
  ["ReferenceError", "built-in"],
  ["DOMException", "built-in / host"],
  ["URL", "host URL API"],
  ["URLSearchParams", "host URL API"],
  ["Blob", "host binary API"],
  ["File", "host file API"],
  ["FileReader", "host file API"],
  ["FormData", "host form API"],
  ["Headers", "host fetch API"],
  ["Request", "host fetch API"],
  ["Response", "host fetch API"],
  ["AbortController", "host abort API"],
  ["AbortSignal", "host abort API"],
  ["TextEncoder", "host text API"],
  ["TextDecoder", "host text API"],
  ["ArrayBuffer", "built-in"],
  ["Uint8Array", "built-in"],
  ["Uint16Array", "built-in"],
  ["Uint32Array", "built-in"],
  ["Int8Array", "built-in"],
  ["Int16Array", "built-in"],
  ["Int32Array", "built-in"],
  ["Float32Array", "built-in"],
  ["Float64Array", "built-in"],
  ["DataView", "built-in"],
  ["Event", "host DOM event"],
  ["CustomEvent", "host DOM event"],
  ["MouseEvent", "host DOM event"],
  ["KeyboardEvent", "host DOM event"],
  ["Element", "host DOM type"],
  ["HTMLElement", "host DOM type"],
  ["Node", "host DOM type"],
  ["NodeList", "host DOM type"],
  ["MutationObserver", "host DOM API"],
  ["ResizeObserver", "host DOM API"],
  ["IntersectionObserver", "host DOM API"],
  ["Image", "host DOM constructor"],
  ["Audio", "host DOM constructor"],
  // Used only as `new Worker(dataUrl, {...})` for the Monaco worker; supplied by
  // the browser, not declared in app.js.
  ["Worker", "host Web Worker constructor"],
  // Used only as `new Option(text, value)`; the DOM's HTMLOptionElement
  // constructor supplied by the browser.
  ["Option", "host DOM constructor (HTMLOptionElement)"],
  // Used only as `new Notification(title, {...})`, guarded by
  // `"Notification" in window`; supplied by the browser.
  ["Notification", "host Notification API"],
  ["DOMParser", "host DOM parser"],
  ["XMLHttpRequest", "host network API"],
  ["CSS", "host CSS API"],
  ["customElements", "host custom-element registry"],
  ["globalThis", "language global object"],
  ["parseInt", "built-in"],
  ["parseFloat", "built-in"],
  ["isNaN", "built-in"],
  ["isFinite", "built-in"],
  ["encodeURIComponent", "built-in"],
  ["decodeURIComponent", "built-in"],
  ["encodeURI", "built-in"],
  ["decodeURI", "built-in"],
  ["NaN", "built-in"],
  ["Infinity", "built-in"],
  ["undefined", "built-in literal"],
  // --- implicit language bindings ------------------------------------------
  ["arguments", "implicit function-scope binding"],
  // --- Electron preload bridge ---------------------------------------------
  // preload.js exposes these with contextBridge.exposeInMainWorld; the renderer
  // reaches them through `window.*`, but they are listed so a bare read would
  // still be triaged here rather than silently allowed.
  ["anx", "preload bridge (window.anx)"],
  ["anxos", "preload bridge (window.anxos)"],
  ["anxhub", "preload bridge (window.anxhub)"],
  ["anxWindow", "preload bridge (window.anxWindow)"],
  ["electronAPI", "preload bridge (window.electronAPI)"],
  // --- CDN script globals ---------------------------------------------------
  ["monaco", "Monaco editor loaded from the CDN bundle"],
]);

// Names below this count mean the declaration collector collapsed; the gate
// must refuse to pass rather than silently report zero candidates.
const MIN_DECLARED_NAMES = 2000;

// ---------------------------------------------------------------------------
// Small text helpers.
// ---------------------------------------------------------------------------
const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_PART_RE = /[A-Za-z0-9_$]/;

function isIdentStart(ch) {
  return ch !== undefined && IDENT_START_RE.test(ch);
}
function isIdentPart(ch) {
  return ch !== undefined && IDENT_PART_RE.test(ch);
}
function isWs(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}
function skipWs(text, index) {
  let i = index;
  while (i < text.length && isWs(text[i])) i += 1;
  return i;
}
function previousNonWsChar(text, index) {
  let i = index - 1;
  while (i >= 0 && isWs(text[i])) i -= 1;
  return i < 0 ? null : text[i];
}
function nextNonWsChar(text, index) {
  const i = skipWs(text, index);
  return i >= text.length ? null : text[i];
}
function previousWordBefore(text, index) {
  let i = index - 1;
  while (i >= 0 && isWs(text[i])) i -= 1;
  const end = i;
  while (i >= 0 && isIdentPart(text[i])) i -= 1;
  if (end <= i) return "";
  return text.slice(i + 1, end + 1);
}
function readWordAt(text, index) {
  let j = index;
  while (j < text.length && isIdentPart(text[j])) j += 1;
  return text.slice(index, j);
}
// Index of the `closer` that matches the `opener` at `openIndex`, or -1.
function findMatchingClose(text, openIndex, opener, closer) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Step 1 — mask comments, strings, regex literals and template-literal text.
// The returned string has the same length and the same newline positions as the
// input, so line numbers stay valid.
// ---------------------------------------------------------------------------
function maskSource(source) {
  const len = source.length;
  const out = source.split("");
  const mask = (from, to) => {
    const stop = Math.min(to, len);
    for (let k = Math.max(0, from); k < stop; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let lastWord = "";
  let lastWasValue = false;

  const noteWord = (word) => {
    lastWord = word;
    lastWasValue = !REGEX_PRECEDING_KEYWORDS.has(word);
  };
  const notePunct = (ch) => {
    lastWord = "";
    if (ch === ")" || ch === "]" || /[0-9]/.test(ch)) lastWasValue = true;
    else lastWasValue = false; // includes `}`: a block end starts a statement
  };
  const noteOperand = () => {
    lastWord = "";
    lastWasValue = true;
  };

  function lineEnd(from) {
    let j = from;
    while (j < len && source[j] !== "\n") j += 1;
    return j;
  }

  function consumeString(start) {
    const quote = source[start];
    let j = start + 1;
    while (j < len) {
      const ch = source[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        j += 1;
        break;
      }
      if (ch === "\n") break; // unterminated single-line string
      j += 1;
    }
    mask(start, j);
    noteOperand();
    return j;
  }

  function consumeRegex(start) {
    let j = start + 1;
    let inClass = false;
    let closed = false;
    while (j < len) {
      const ch = source[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "\n") return -1; // a regex literal cannot span a line
      if (ch === "[") {
        inClass = true;
        j += 1;
        continue;
      }
      if (ch === "]") {
        inClass = false;
        j += 1;
        continue;
      }
      if (ch === "/" && !inClass) {
        closed = true;
        j += 1;
        break;
      }
      j += 1;
    }
    if (!closed) return -1;
    while (j < len && /[a-z]/i.test(source[j])) j += 1; // flags
    mask(start, j);
    noteOperand();
    return j;
  }

  function consumeWord(start) {
    const end = start + readWordAt(source, start).length;
    noteWord(source.slice(start, end));
    return end;
  }

  function consumeTemplate(start) {
    let j = start + 1;
    mask(start, start + 1);
    while (j < len) {
      const ch = source[j];
      if (ch === "\\") {
        mask(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === "`") {
        mask(j, j + 1);
        j += 1;
        break;
      }
      if (ch === "$" && source[j + 1] === "{") {
        mask(j, j + 2);
        j = runCode(j + 2, true);
        continue;
      }
      if (ch !== "\n") out[j] = " ";
      j += 1;
    }
    noteOperand();
    return j;
  }

  // Executes the masker over code. When stopAtBrace is true it stops just past
  // the `}` that closes the current template substitution.
  function runCode(from, stopAtBrace) {
    let i = from;
    let depth = 0;
    while (i < len) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === "/" && next === "/") {
        const end = lineEnd(i);
        mask(i, end);
        i = end;
        continue;
      }
      if (ch === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        const end = close === -1 ? len : close + 2;
        mask(i, end);
        i = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = consumeString(i);
        continue;
      }
      if (ch === "`") {
        i = consumeTemplate(i);
        continue;
      }
      if (ch === "/" && !lastWasValue) {
        const end = consumeRegex(i);
        if (end > i) {
          i = end;
          continue;
        }
      }
      if (isIdentStart(ch)) {
        i = consumeWord(i);
        continue;
      }
      if (stopAtBrace && ch === "{") {
        depth += 1;
        notePunct(ch);
        i += 1;
        continue;
      }
      if (stopAtBrace && ch === "}") {
        if (depth === 0) {
          mask(i, i + 1);
          return i + 1;
        }
        depth -= 1;
        notePunct(ch);
        i += 1;
        continue;
      }
      if (!isWs(ch)) notePunct(ch);
      i += 1;
    }
    return i;
  }

  runCode(0, false);
  return out.join("");
}

// ---------------------------------------------------------------------------
// Step 2 — declared-name collection.
// ---------------------------------------------------------------------------
function parseBindingPattern(masked, start, names) {
  const i = skipWs(masked, start);
  const ch = masked[i];
  if (ch === "{") return parseObjectPattern(masked, i, names);
  if (ch === "[") return parseBindingElements(masked, i + 1, "]", names);
  if (isIdentStart(ch)) {
    const word = readWordAt(masked, i);
    if (!RESERVED_WORDS.has(word)) names.add(word);
    return { end: i + word.length };
  }
  return { end: start };
}

// Skips one expression (an initializer or a default value), stopping at the
// first `stopChars` character seen at bracket depth zero.
function skipExpression(masked, start, stopChars) {
  let i = start;
  let depth = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && stopChars.includes(ch)) return i;
    i += 1;
  }
  return i;
}

function parseObjectPattern(masked, start, names) {
  let i = start + 1;
  while (i < masked.length) {
    i = skipWs(masked, i);
    const ch = masked[i];
    if (ch === "}") return { end: i + 1 };
    if (ch === undefined) return { end: i };
    if (ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "." && masked[i + 1] === "." && masked[i + 2] === ".") {
      const rest = parseBindingPattern(masked, i + 3, names);
      i = rest.end === i + 3 ? i + 3 : rest.end;
    } else if (isIdentStart(ch)) {
      const word = readWordAt(masked, i);
      const after = skipWs(masked, i + word.length);
      if (masked[after] === ":") {
        const inner = parseBindingPattern(masked, after + 1, names);
        i = inner.end === after + 1 ? after + 1 : inner.end;
      } else {
        if (!RESERVED_WORDS.has(word)) names.add(word); // shorthand binding
        i += word.length;
      }
    } else if (ch === ":") {
      // A quoted key was masked away, leaving only its colon.
      const inner = parseBindingPattern(masked, i + 1, names);
      i = inner.end === i + 1 ? i + 1 : inner.end;
    } else {
      i += 1;
      continue;
    }
    const eq = skipWs(masked, i);
    if (masked[eq] === "=" && masked[eq + 1] !== "=" && masked[eq + 1] !== ">") {
      i = skipExpression(masked, eq + 1, [",", "}"]);
    }
  }
  return { end: i };
}

function parseBindingElements(masked, start, closer, names) {
  let i = start;
  while (i < masked.length) {
    i = skipWs(masked, i);
    const ch = masked[i];
    if (ch === closer) return { end: i + 1 };
    if (ch === undefined) return { end: i };
    if (ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "." && masked[i + 1] === "." && masked[i + 2] === ".") {
      const rest = parseBindingPattern(masked, i + 3, names);
      i = rest.end === i + 3 ? i + 3 : rest.end;
    } else if (ch === "{" || ch === "[" || isIdentStart(ch)) {
      const inner = parseBindingPattern(masked, i, names);
      i = inner.end === i ? i + 1 : inner.end;
    } else {
      i += 1;
      continue;
    }
    const eq = skipWs(masked, i);
    if (masked[eq] === "=" && masked[eq + 1] !== "=" && masked[eq + 1] !== ">") {
      i = skipExpression(masked, eq + 1, [",", closer]);
    }
  }
  return { end: i };
}

function collectDeclaratorList(masked, start, names) {
  let i = start;
  let guard = 0;
  while (guard < 5000) {
    guard += 1;
    const pattern = parseBindingPattern(masked, i, names);
    if (pattern.end === i) return i;
    i = pattern.end;
    const eq = skipWs(masked, i);
    if (masked[eq] === "=" && masked[eq + 1] !== "=" && masked[eq + 1] !== ">") {
      i = skipExpression(masked, eq + 1, [",", ";", ")", "}"]);
    }
    const sep = skipWs(masked, i);
    if (masked[sep] === ",") {
      i = sep + 1;
      continue;
    }
    return i;
  }
  return i;
}

function collectDeclaredNames(masked, stats) {
  const names = new Set();
  const bump = (key) => {
    if (stats) stats[key] = (stats[key] || 0) + 1;
  };

  // var / let / const, including destructuring and multiple declarators.
  const declRe = /\b(?:var|let|const)\b/g;
  let m;
  while ((m = declRe.exec(masked)) !== null) {
    if (previousNonWsChar(masked, m.index) === ".") continue; // obj.const
    const after = skipWs(masked, m.index + m[0].length);
    const ch = masked[after];
    if (!(ch === "{" || ch === "[" || isIdentStart(ch))) continue;
    bump("declaratorLists");
    collectDeclaratorList(masked, after, names);
  }

  // function declarations and named function expressions.
  const fnRe = /\bfunction\b/g;
  while ((m = fnRe.exec(masked)) !== null) {
    if (previousNonWsChar(masked, m.index) === ".") continue;
    let i = skipWs(masked, m.index + m[0].length);
    if (masked[i] === "*") i = skipWs(masked, i + 1);
    if (isIdentStart(masked[i])) {
      const word = readWordAt(masked, i);
      if (!RESERVED_WORDS.has(word)) names.add(word);
      bump("functionNames");
      i = skipWs(masked, i + word.length);
    }
    if (masked[i] === "(") {
      bump("functionParams");
      parseBindingElements(masked, i + 1, ")", names);
    }
  }

  // class declarations.
  const classRe = /\bclass\b/g;
  while ((m = classRe.exec(masked)) !== null) {
    if (previousNonWsChar(masked, m.index) === ".") continue;
    const i = skipWs(masked, m.index + m[0].length);
    if (isIdentStart(masked[i])) {
      const word = readWordAt(masked, i);
      if (!RESERVED_WORDS.has(word)) names.add(word);
      bump("classNames");
    }
  }

  // catch bindings.
  const catchRe = /\bcatch\b/g;
  while ((m = catchRe.exec(masked)) !== null) {
    if (previousNonWsChar(masked, m.index) === ".") continue;
    const i = skipWs(masked, m.index + m[0].length);
    if (masked[i] === "(") {
      bump("catchBindings");
      parseBindingElements(masked, i + 1, ")", names);
    }
  }

  // arrow parameters: `(a, b) =>` and bare `x =>`.
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(masked)) !== null) {
    let j = m.index - 1;
    while (j >= 0 && isWs(masked[j])) j -= 1;
    if (j < 0) continue;
    if (masked[j] === ")") {
      let open = -1;
      let depth = 0;
      for (let k = j; k >= 0; k -= 1) {
        if (masked[k] === ")") depth += 1;
        else if (masked[k] === "(") {
          depth -= 1;
          if (depth === 0) {
            open = k;
            break;
          }
        }
      }
      if (open >= 0) {
        bump("arrowParams");
        parseBindingElements(masked, open + 1, ")", names);
      }
    } else if (isIdentPart(masked[j])) {
      let k = j;
      while (k >= 0 && isIdentPart(masked[k])) k -= 1;
      if (k < 0 || masked[k] !== ".") {
        const word = masked.slice(k + 1, j + 1);
        if (!RESERVED_WORDS.has(word)) names.add(word);
        bump("arrowParamsBare");
      }
    }
  }

  // object-literal / class method shorthand: `name(params) {`.
  const parenRe = /\(/g;
  while ((m = parenRe.exec(masked)) !== null) {
    const before = previousNonWsChar(masked, m.index);
    if (!isIdentPart(before)) continue;
    const word = previousWordBefore(masked, m.index);
    if (!word || CONTROL_KEYWORDS.has(word)) continue;
    const close = findMatchingClose(masked, m.index, "(", ")");
    if (close < 0) continue;
    if (nextNonWsChar(masked, close + 1) !== "{") continue;
    bump("methodParams");
    parseBindingElements(masked, m.index + 1, ")", names);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Step 3 — identifier-read collection.
// ---------------------------------------------------------------------------
function collectIdentifierReads(masked) {
  const reads = new Map(); // name -> [offset, ...]
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const name = m[0];
    if (RESERVED_WORDS.has(name)) continue;

    const before = previousNonWsChar(masked, m.index);
    if (before === ".") continue; // property read: a.b, a?.b

    const end = m.index + name.length;
    const after = nextNonWsChar(masked, end);

    // Simple assignment is a write, not a read; it does not throw.
    if (after === "=" && masked[skipWs(masked, end) + 1] !== "=" && masked[skipWs(masked, end) + 1] !== ">") {
      continue;
    }

    // Property key or statement label: `{ a: 1 }`, `label:`. In `case X:` the
    // identifier IS read (the colon separates the clause), so it stays.
    if (after === ":") {
      const inObjectOrBlock = before === "{" || before === "," || before === ";" || before === "}" || before === null;
      if (inObjectOrBlock) continue;
    }

    // Method name in a definition: `name(...) {`.
    if (after === "(") {
      const openIndex = skipWs(masked, end);
      const close = findMatchingClose(masked, openIndex, "(", ")");
      if (close >= 0 && nextNonWsChar(masked, close + 1) === "{") {
        const prevWord = previousWordBefore(masked, m.index);
        if (!prevWord || prevWord !== "function") continue;
      }
    }

    // Label after break/continue.
    const prevWord = previousWordBefore(masked, m.index);
    if ((prevWord === "break" || prevWord === "continue") && after === ";") continue;

    if (!reads.has(name)) reads.set(name, []);
    reads.get(name).push(m.index);
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Analysis: mask, collect, subtract.
// ---------------------------------------------------------------------------
function buildLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
function lineOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function analyze(source) {
  const masked = maskSource(source);
  const stats = {};
  const declared = collectDeclaredNames(masked, stats);
  const reads = collectIdentifierReads(masked);
  const lineStarts = buildLineIndex(source);
  const lines = source.split("\n");

  const candidates = [];
  const allowed = [];
  for (const [name, offsets] of reads) {
    if (declared.has(name)) continue;
    if (GLOBAL_ALLOWLIST.has(name)) {
      allowed.push(name);
      continue;
    }
    for (const offset of offsets) {
      const line = lineOf(lineStarts, offset);
      candidates.push({
        name,
        line,
        column: offset - lineStarts[line - 1] + 1,
        text: (lines[line - 1] || "").trim().slice(0, 200),
      });
    }
  }
  candidates.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  return { masked, declared, reads, candidates, allowed, stats, statsSummary: stats };
}

// ---------------------------------------------------------------------------
// Self-tests: prove the detector still detects and still stays quiet where it
// should. A detector that has silently collapsed must fail loudly rather than
// report zero candidates.
// ---------------------------------------------------------------------------
function selfTest() {
  const failures = [];
  const check = (label, fn) => {
    try {
      fn();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };
  const candidateNames = (source) => {
    const result = analyze(source);
    return new Set(result.candidates.map((entry) => entry.name));
  };

  check("undeclared read inside a falsy guard is a candidate", () => {
    const names = candidateNames("if (!zzGuard) { zzGuard.replaceChildren(); }\n");
    if (!names.has("zzGuard")) throw new Error("zzGuard was not reported");
  });

  check("declared forms are not candidates", () => {
    const source = [
      "const zzA = 1;",
      "let zzB = 2;",
      "var zzC = 3;",
      "function zzD(zzParam1, { zzParam2, zzParam3: zzParam4 = zzA }, ...zzParam5) { return zzParam1; }",
      "const zzE = (zzArrow1, [zzArrow2]) => zzArrow1 + zzArrow2;",
      "try { zzA(); } catch (zzCatch) { console.log(zzCatch); }",
      "const { zzDestr1, zzDestr2: zzDestr3, ...zzDestr4 } = {};",
      "const [zzArr1, , zzArr2 = zzA] = [];",
      "for (const zzLoop of []) { zzLoop(); }",
      "function zzOuter() { const zzInner = 1; return zzInner; }",
      "",
    ].join("\n");
    const names = candidateNames(source);
    const unexpected = [...names].filter((name) => name.startsWith("zz") === false);
    if (unexpected.length > 0) throw new Error(`non-zz candidates: ${unexpected.join(", ")}`);
    if (names.size > 0) throw new Error(`declared names reported as candidates: ${[...names].join(", ")}`);
  });

  check("property reads are not candidates", () => {
    const names = candidateNames("const zzObj = {}; zzObj.zzProp1.zzProp2; zzObj?.zzProp3; zzObj[zzIdx]; zzObj.zzCall();\n");
    if (names.has("zzProp1") || names.has("zzProp2") || names.has("zzProp3") || names.has("zzCall")) {
      throw new Error(`property read reported: ${[...names].join(", ")}`);
    }
    if (!names.has("zzIdx")) throw new Error("computed-key identifier must still be reported");
  });

  check("property keys, labels and case clauses are not candidates", () => {
    const names = candidateNames("const zzObj = { zzKey1: 1 };\nzzLabel: for (;;) { break zzLabel; }\nswitch (zzObj) { case zzCaseValue: break; }\n");
    if (names.has("zzKey1") || names.has("zzLabel")) {
      throw new Error(`key/label reported: ${[...names].join(", ")}`);
    }
    if (!names.has("zzCaseValue")) throw new Error("case-test expression must still be reported");
  });

  check("object shorthand is a read, not a key", () => {
    const names = candidateNames("const zzObj = { zzShorthand };\n");
    if (!names.has("zzShorthand")) throw new Error("object shorthand must be reported as a read");
  });

  check("method names are not candidates but their bodies' reads are", () => {
    const names = candidateNames("const zzObj = { zzMethod(zzP) { return zzP; } };\n");
    if (names.has("zzMethod")) throw new Error("method name reported");
    if (names.size > 0) throw new Error(`unexpected candidates: ${[...names].join(", ")}`);
  });

  check("comments, strings and regex literals are masked", () => {
    const names = candidateNames("// zzInComment\n/* zzInBlock */\nconst zzS = \"zzInString\";\nconst zzR = /zzInRegex[a-z]/g;\nconst zzT = `zzInTemplateText`;\n");
    const leaked = [...names].filter((name) => name.startsWith("zz") && name !== "zzS" && name !== "zzR" && name !== "zzT");
    if (leaked.length > 0) throw new Error(`masked text leaked: ${leaked.join(", ")}`);
  });

  check("template substitutions are scanned", () => {
    const names = candidateNames("const zzT = `prefix ${zzSubstitution} suffix`;\n");
    if (!names.has("zzSubstitution")) throw new Error("read inside ${} was not reported");
  });

  check("simple assignment is treated as a write, compound assignment as a read", () => {
    const names = candidateNames("zzWriteTarget = 1;\nif (zzCompound === 1) { zzCompound += 1; }\n");
    if (names.has("zzWriteTarget")) throw new Error("simple assignment reported as a read");
    if (!names.has("zzCompound")) throw new Error("compound assignment must be reported as a read");
  });

  check("the restart-schedule shape is detected", () => {
    const source = [
      "function renderInstanceRestartSchedules(instance) {",
      "  if (!restartScheduleList) {",
      "    return;",
      "  }",
      "  restartScheduleList.replaceChildren();",
      "}",
      "",
    ].join("\n");
    const names = candidateNames(source);
    if (!names.has("restartScheduleList")) throw new Error("restartScheduleList was not reported");
  });

  if (failures.length > 0) {
    console.error("Detector self-tests FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("  ok   detector self-tests (9 checks)");
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const report = argv.includes("--report");
  const statsOnly = argv.includes("--stats");

  console.log("Renderer free-identifier smoke");
  selfTest();

  const source = fs.readFileSync(APP_PATH, "utf8");
  const result = analyze(source);

  console.log(`  declared names collected: ${result.declared.size}`);
  console.log(`  distinct identifiers read: ${result.reads.size}`);
  console.log(`  allowlisted globals read: ${result.allowed.length}`);
  console.log(`  free-identifier candidates: ${result.candidates.length}`);

  if (statsOnly) {
    console.log("  declaration forms collected:", JSON.stringify(result.statsSummary));
    return;
  }

  if (report) {
    if (result.candidates.length === 0) {
      console.log("  no candidates to report.");
      return;
    }
    console.log("");
    for (const candidate of result.candidates) {
      console.log(`  app.js:${candidate.line}:${candidate.column}  ${candidate.name}`);
      console.log(`      ${candidate.text}`);
    }
    console.log("");
    const names = [...new Set(result.candidates.map((candidate) => candidate.name))];
    console.log(`  distinct candidate names (${names.length}): ${names.join(", ")}`);
    return;
  }

  // Gate.
  if (result.declared.size < MIN_DECLARED_NAMES) {
    console.error(
      `  FAIL the declaration collector found only ${result.declared.size} names (expected >= ${MIN_DECLARED_NAMES}).`,
    );
    console.error("       The detector has collapsed; refusing to report a pass.");
    process.exit(1);
  }

  if (result.candidates.length > 0) {
    console.error("");
    console.error("  FAIL app.js reads identifiers that it never declares.");
    console.error("       In a classic script a read of an undeclared identifier throws");
    console.error("       ReferenceError at that line, and `if (!name)` is NOT a guard.");
    console.error("       Declare the identifier (const/let/var) or add it to");
    console.error("       GLOBAL_ALLOWLIST in this file with a justification.");
    console.error("");
    for (const candidate of result.candidates) {
      console.error(`  app.js:${candidate.line}:${candidate.column}  ${candidate.name}`);
      console.error(`      ${candidate.text}`);
    }
    console.error("");
    const names = [...new Set(result.candidates.map((candidate) => candidate.name))];
    console.error(`  ${result.candidates.length} read(s) of ${names.length} undeclared name(s): ${names.join(", ")}`);
    process.exit(1);
  }

  console.log("Renderer free-identifier smoke checks passed.");
}

main();