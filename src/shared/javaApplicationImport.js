"use strict";

// Build 214: the Java application card deploys a .jar the user chooses.
// The file is untrusted code from the user's own computer: it is checked to
// be a real runnable jar, never extracted or scanned beyond its manifest, and
// it runs as the AnxOS Agent's account (never elevated) like every server.

const unzipper = require("unzipper");

const MAX_JAR_BYTES = 150 * 1024 * 1024;
const MAX_PROGRAM_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 512;

function importError(message, code = "JAVA_APP_IMPORT_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.details = { retryable: false };
  return error;
}

// Splits what the user typed into arguments the way a simple shell would
// (spaces separate, double or single quotes group), without ever running a
// shell. Options for the Java runtime itself are refused here: the engine
// moves anything that looks like one (-D..., -X..., -javaagent...) in front
// of -jar, so it would silently change the runtime instead of reaching the
// application.
function parseProgramArguments(text = "") {
  const input = String(text ?? "");
  if (/[\0\r\n]/.test(input)) throw importError("Program arguments must be on one line.");
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) throw importError("A quote in the program arguments is not closed.");
  if (started) args.push(current);
  if (args.length > MAX_PROGRAM_ARGUMENTS) throw importError(`Use at most ${MAX_PROGRAM_ARGUMENTS} program arguments.`);
  for (const arg of args) {
    if (arg.length > MAX_ARGUMENT_LENGTH) throw importError(`Each program argument must be at most ${MAX_ARGUMENT_LENGTH} characters.`);
    if (/^-(?:X|D|agentlib:|agentpath:|javaagent:)/.test(arg) || /^--(?:add-|enable-|illegal-|module-|limit-|patch-|upgrade-)/.test(arg) || arg === "-jar" || arg === "-cp" || arg === "-classpath") {
      throw importError(`"${arg.slice(0, 40)}" is an option for the Java runtime, not the application. Memory is set with the Memory field; other runtime options are not supported.`);
    }
  }
  return args;
}

// A runnable jar is a ZIP archive whose META-INF/MANIFEST.MF names a
// Main-Class. Returns the main class for the install summary.
async function inspectJavaApplication(buffer, fileName = "") {
  if (!/\.jar$/i.test(String(fileName))) throw importError("Choose a .jar file.");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw importError("The chosen file is empty.");
  if (buffer.length > MAX_JAR_BYTES) throw importError("The chosen file is larger than 150 MB.", "JAVA_APP_TOO_LARGE");
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw importError("The chosen file is not a Java application (.jar) archive.");
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw importError("The chosen .jar could not be read as an archive.");
  }
  const manifestEntry = directory.files.find((entry) => entry.path === "META-INF/MANIFEST.MF");
  if (!manifestEntry || manifestEntry.uncompressedSize > 64 * 1024) {
    throw importError("The chosen .jar has no manifest, so Java cannot start it with -jar.");
  }
  const manifest = (await manifestEntry.buffer()).toString("utf8").replace(/\r?\n /g, "");
  const mainClass = /^Main-Class:\s*(\S+)\s*$/mi.exec(manifest)?.[1] || "";
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(mainClass)) {
    throw importError("The chosen .jar does not name a Main-Class, so Java cannot start it with -jar.");
  }
  return { mainClass, bytes: buffer.length };
}

module.exports = {
  MAX_JAR_BYTES,
  inspectJavaApplication,
  parseProgramArguments,
};
