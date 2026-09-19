// Shared text-assertion helper for suites that pin a call site in shipped source.
//
// `normalizeSource` returns a comment-stripped, whitespace-normalised view of a
// file so an exact multi-line CALL EXPRESSION can be asserted without being
// brittle about indentation. It exists because a bare `source.includes("someName")`
// is satisfied by a comment or an unused import, which lets a real unwiring pass
// review while the suite stays green.
//
// Limitations (accepted, and stated at each use site):
//   - It is a TEXT assertion. It cannot prove runtime reachability — only that the
//     call exists as code outside any comment.
//   - The `[^:]` guard leaves `https://` inside strings intact; a `/*` or `//`
//     occurring inside a string literal would still be mangled.
function normalizeSource(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { normalizeSource };