// Shared choice of an instance executable that the REAL executable allowlist
// accepts on the running host.
//
// WHY THIS EXISTS
// rc:validate auto-discovers every *:smoke suite and also runs on the Linux RC
// job. There, process.execPath resolves under /opt/hostedtoolcache/node/...,
// which is outside DEFAULT_EXECUTABLE_ROOTS (/bin, /usr/bin, /usr/local/bin,
// ...), so any smoke that hands instanceServiceCore an ABSOLUTE binary path
// gets EXECUTABLE_NOT_ALLOWED. On Windows the same value passes because
// getExecutableRoots() allowlists dirname(process.execPath) on win32. The
// product allowlist is correct; the fixtures must supply a path the host
// actually permits.
//
// allowlistedCommand() therefore returns a matching {executable, args} pair:
// a Node one-liner on Windows (process.execPath, unchanged behaviour) or a
// POSIX shell command on linux/darwin using /bin/sh, which exists on the
// runners and is inside DEFAULT_EXECUTABLE_ROOTS.
function allowlistedCommand({ nodeScript, shellScript }) {
  return process.platform === "win32"
    ? { executable: process.execPath, args: ["-e", nodeScript] }
    : { executable: "/bin/sh", args: ["-c", shellScript] };
}

module.exports = { allowlistedCommand };
