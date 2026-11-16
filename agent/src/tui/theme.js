"use strict";

// Color for the Agent terminal screen (Build 213). A pass over the finished
// screen text from render.js: it adds only our own SGR color codes, after
// untrusted text was sanitized and every line was clipped, so it never
// changes a character, a width or the layout that render.js guarantees and
// tests. Color is on only for an interactive terminal that has not asked for
// none (NO_COLOR, TERM=dumb, ANXOS_TUI_COLOR=0).
//
// Palette, matching the desktop app's charcoal and purple:
//   purple  headings, the AnxOS title, keys, the pairing code card
//   green   healthy states        amber  attention        red  failures
//   grey    rules, labels, secondary text

const RESET = "\u001b[0m";

function palette(trueColor) {
  const fg = (r, g, b, fallback) => (trueColor ? `\u001b[38;2;${r};${g};${b}m` : `\u001b[38;5;${fallback}m`);
  return {
    purple: fg(182, 108, 255, 141),
    violet: fg(214, 178, 255, 183),
    green: fg(143, 240, 189, 114),
    amber: fg(255, 208, 138, 221),
    red: fg(255, 133, 133, 203),
    grey: fg(150, 144, 168, 245),
    bold: "\u001b[1m",
    inverse: "\u001b[7m",
  };
}

function colorEnabled(env = {}, stream = {}) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.ANXOS_TUI_COLOR === "0") return false;
  if (String(env.TERM || "").toLowerCase() === "dumb") return false;
  return Boolean(stream.isTTY);
}

function trueColorSupported(env = {}) {
  return /truecolor|24bit/i.test(String(env.COLORTERM || ""));
}

const SECTION_TITLES = new Set(["Agent", "System", "Service", "Update", "Logs", "Help", "Pairing"]);
const GOOD = /\b(running|active|connected|paired|enabled|healthy|ready|up to date|online|ok)\b/gi;
const BAD = /\b(failed|failure|error|stopped|inactive|offline|unavailable|expired|refused|crashed)\b/gi;
const WARN = /\b(update available|not installed|not loaded|not checked|pending|waiting|warning|unsupported|disabled)\b/gi;

function paint(text, color, c) {
  return `${c[color]}${text}${RESET}`;
}

function colorWords(line, c) {
  // One pass so a word is never wrapped twice.
  const pattern = new RegExp(`${WARN.source}|${BAD.source}|${GOOD.source}`, "gi");
  return line.replace(pattern, (match) => {
    if (new RegExp(`^(?:${WARN.source})$`, "i").test(match)) return paint(match, "amber", c);
    if (new RegExp(`^(?:${BAD.source})$`, "i").test(match)) return paint(match, "red", c);
    return paint(match, "green", c);
  });
}

function isRule(line) {
  return /^[─-]{4,}$/.test(line);
}

function isKeyBar(line) {
  return /(?:^|[·|] )\[?[a-z?] [a-z]+\]?(?: [·|] |$)/.test(line) && /\b(quit|back|help|refresh)\b/.test(line);
}

function colorKeyBar(line, c) {
  return line
    .replace(/\[([a-z?]) ([a-z]+)\]/g, (match) => `${c.inverse}${c.purple}${c.bold}${match}${RESET}`)
    .replace(/(^|[·|] )([a-z?]) ([a-z]+)/g, (match, lead, key, label) => `${paint(lead, "grey", c)}${c.purple}${c.bold}${key}${RESET} ${paint(label, "grey", c)}`)
    .replace(/ ([·|]) /g, (match, separator) => ` ${paint(separator, "grey", c)} `);
}

// lines: the exact text render.js produced, already clipped.
function colorizeScreen(screen, { env = {}, trueColor = trueColorSupported(env) } = {}) {
  const c = palette(trueColor);
  const lines = String(screen).split("\n");
  return lines.map((line, index) => {
    if (!line) return line;
    if (index === 0) {
      // Every view's first line is its title, optionally followed by the host
      // name after a run of spaces.
      const match = line.match(/^(.*?\S)(\s{2,})(\S.*)$/);
      return match
        ? `${c.purple}${c.bold}${match[1]}${RESET}${match[2]}${paint(match[3], "grey", c)}`
        : `${c.purple}${c.bold}${line}${RESET}`;
    }
    if (isRule(line)) return paint(line, "grey", c);
    if (SECTION_TITLES.has(line.trim()) && !line.startsWith(" ")) return `${c.violet}${c.bold}${line}${RESET}`;
    if (/[█▀▄]/.test(line) && !/[a-z]{3}/i.test(line)) return `${c.purple}${c.bold}${line}${RESET}`;
    if (isKeyBar(line)) return colorKeyBar(line, c);
    // "  Label      value" rows: grey label, colored value words.
    const row = line.match(/^(\s{2}[A-Z][A-Za-z ]{1,18}?)(\s{2,})(.*)$/);
    if (row) return `${paint(row[1], "grey", c)}${row[2]}${colorWords(row[3], c)}`;
    return colorWords(line, c);
  }).join("\n");
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

module.exports = { colorEnabled, colorizeScreen, stripAnsi, trueColorSupported };
