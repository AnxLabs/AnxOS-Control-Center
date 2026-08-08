const SENSITIVE_KEY = /(password|passphrase|token|secret|api[_-]?key|apikey|private[_-]?key|authorization|cookie|session|refresh[_-]?token|access[_-]?token|agent[_-]?token|supabase[_-]?anon[_-]?key|^encrypted(?:payload|blob)?$|ciphertext)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRET_ASSIGNMENT = /\b(password|passphrase|token|secret|api[_-]?key|apikey|authorization|cookie|session|refresh[_-]?token|access[_-]?token|agent[_-]?token|supabase[_-]?anon[_-]?key)\b\s*[:=]\s*(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const COMMAND_LINE_SECRET = /(--?(?:password|passphrase|token|secret|api[_-]?key|apikey|authorization|cookie|session|refresh[_-]?token|access[_-]?token|agent[_-]?token|client[_-]?secret))\s+(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const PRIVATE_PATH = /(^|[\s"'=(,:[{])((?:[A-Za-z]:\\Users\\|\/(?:home|Users|root|srv|opt)\/)[^\s"',)}\]]+)/g;
const LARGE_BASE64 = /\b[A-Za-z0-9+/]{160,}={0,2}\b/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
// Catches privateKey=-----BEGIN...----- assignments even when truncated (no matching END marker).
const PRIVATE_KEY_ASSIGNMENT = /\b(private[_-]?key)\b\s*[:=]\s*(?:"|')?-----BEGIN[\s\S]*?(?:-----END[^\n"']*|$)(?:"|')?/gi;
const USER_FACING_DECRYPT_FAILURE = /\bNODE_CREDENTIAL_DECRYPT_FAILED\b(?::\s*Saved node credentials could not be decrypted on this device\.?)?/gi;

function redactString(value) {
  return String(value)
    .replace(USER_FACING_DECRYPT_FAILURE, "Saved node credentials could not be restored. Unlock AnxOS to continue.")
    .replace(PRIVATE_KEY_BLOCK, "[redacted-private-key]")
    .replace(PRIVATE_KEY_ASSIGNMENT, "$1=[redacted-private-key]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT, "[redacted-jwt]")
    .replace(COMMAND_LINE_SECRET, "$1 [redacted]")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(PRIVATE_PATH, "$1[redacted-path]")
    .replace(LARGE_BASE64, "[redacted-base64]");
}

function sanitize(value, options = {}, seen = new WeakSet()) {
  const depth = Number(options.depth || 0);
  const maxDepth = Number(options.maxDepth || 8);
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value).slice(0, Number(options.maxStringLength || 16000));
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, code: value.code || null, stack: value.stack || null }, { ...options, depth: depth + 1 }, seen);
  }
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (depth >= maxDepth) return "[truncated]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitize(entry, { ...options, depth: depth + 1 }, seen));
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(entry, { ...options, depth: depth + 1 }, seen);
    }
    return result;
  }
  return redactString(value);
}

module.exports = { SENSITIVE_KEY, redactString, sanitize };
