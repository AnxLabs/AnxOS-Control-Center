"use strict";

// V2-J bullet 6: "Take and verify required recovery points before risky migrations."
//
// This module is the decision half of that sentence. Application rollback versus
// data-schema rollback were already distinguished in cycle 17, and the update
// manifest already reports per-store downgrade status; what was missing was a
// gate that refuses a risky migration when a recovery point could not be taken
// or could not be verified. The policy is pure and fail-closed:
//
//   * a migration whose recovery point cannot be TAKEN is refused;
//   * a migration whose recovery point was taken but NOT VERIFIED is refused;
//   * the only warning path is a store the descriptor explicitly declares
//     reconstructible, and it must name the source it can be rebuilt from;
//   * everything else — a malformed descriptor, an inconsistent one, a
//     backwards version transition — is refused rather than guessed through.
//
// WHAT "VERIFIED" MEANS HERE
// --------------------------
// A recovery point counts as verified only when it was READ BACK and CHECKED
// after it was written:
//
//   * `bytes` mode: the copy was re-read and its byte length AND SHA-256 digest
//     both match the original file's. A copy that was written but never read
//     back is `unverified`, and `unverified` is never `verified`.
//   * `json` mode: the copy was re-read and parsed as a non-array object, and
//     (when supplied) the caller's `expect` predicate accepted the parsed value.
//     This is the mode used by stores whose recovery point is a re-encoded
//     envelope rather than a byte copy — an encrypted credential/config backup
//     cannot be byte-compared against a plaintext legacy original.
//   * stores that re-encode add their own read-back check on top (for example
//     decrypting the backup and comparing the logical payload), which is
//     strictly stronger than the parse check on its own.
//
// WHAT IT DOES NOT PROVE
// ----------------------
// Verification proves the recovery point's BYTES MATCH the pre-migration
// source, or that its JSON envelope is parseable and structurally expected.
// It does NOT prove that restoring the recovery point would succeed, that the
// restore path is correct, that the backup is complete relative to every
// dependent file, or that the migrated store is semantically correct. No
// restore drill has been run anywhere in this repository, so a "verified"
// recovery point is evidence of a faithful copy, not of a working recovery.
//
// The policy is deliberately free of filesystem access so it can be unit-tested
// without a temp tree; call sites do the reading and pass the results in.

const crypto = require("crypto");

const MIGRATION_VERDICTS = Object.freeze({
  PROCEED: "proceed",
  PROCEED_WITH_WARNING: "proceed-with-warning",
  REFUSE: "refuse",
});

const MIGRATION_RECOVERY_REASONS = Object.freeze({
  // proceed
  NO_MIGRATION_REQUIRED: "no_migration_required",
  RECOVERY_POINT_VERIFIED: "recovery_point_verified",
  // proceed-with-warning
  RECOVERY_POINT_UNAVAILABLE_RECONSTRUCTIBLE: "recovery_point_unavailable_reconstructible",
  // refuse
  DESCRIPTOR_INVALID: "descriptor_invalid",
  DESCRIPTOR_INCONSISTENT: "descriptor_inconsistent",
  INVALID_VERSION_TRANSITION: "invalid_version_transition",
  RECOVERY_POINT_UNAVAILABLE: "recovery_point_unavailable",
  RECOVERY_POINT_NOT_TAKEN: "recovery_point_not_taken",
  RECOVERY_POINT_UNVERIFIED: "recovery_point_unverified",
});

const VERIFICATION_MODES = Object.freeze({ BYTES: "bytes", JSON: "json" });

const VERIFICATION_REASONS = Object.freeze({
  BYTE_IDENTICAL: "byte_identical",
  JSON_PARSED: "json_parsed",
  RECOVERY_POINT_MISSING: "recovery_point_missing",
  ORIGINAL_MISSING: "original_missing",
  SIZE_MISMATCH: "size_mismatch",
  HASH_MISMATCH: "hash_mismatch",
  JSON_PARSE_FAILED: "json_parse_failed",
  JSON_EXPECTATION_FAILED: "json_expectation_failed",
  UNKNOWN_MODE: "unknown_mode",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function computeRecoveryPointDigest(bytes) {
  const buffer = toBuffer(bytes);
  if (buffer === null) {
    return { size: null, sha256: null };
  }
  return {
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Verify a recovery point that has already been read back by the caller.
 *
 * @param {object} input
 * @param {"bytes"|"json"} [input.mode]
 * @param {Buffer|string|Uint8Array|null} [input.original] original bytes (bytes mode)
 * @param {Buffer|string|Uint8Array|null} [input.copy] re-read recovery-point bytes
 * @param {(parsed: unknown) => boolean} [input.expect] optional structural check (json mode)
 * @returns {{ verified: boolean, mode: string, reason: string, size: number|null, sha256: string|null }}
 */
function verifyRecoveryPoint(input = {}) {
  const mode = input.mode === undefined ? VERIFICATION_MODES.BYTES : input.mode;
  const copyBuffer = toBuffer(input.copy);

  if (mode !== VERIFICATION_MODES.BYTES && mode !== VERIFICATION_MODES.JSON) {
    return { verified: false, mode: String(mode), reason: VERIFICATION_REASONS.UNKNOWN_MODE, size: null, sha256: null };
  }

  if (copyBuffer === null || copyBuffer.length === 0) {
    return { verified: false, mode, reason: VERIFICATION_REASONS.RECOVERY_POINT_MISSING, size: null, sha256: null };
  }

  const copyDigest = computeRecoveryPointDigest(copyBuffer);

  if (mode === VERIFICATION_MODES.JSON) {
    let parsed;
    try {
      parsed = JSON.parse(copyBuffer.toString("utf8"));
    } catch {
      return { verified: false, mode, reason: VERIFICATION_REASONS.JSON_PARSE_FAILED, ...copyDigest };
    }
    if (!isPlainObject(parsed)) {
      return { verified: false, mode, reason: VERIFICATION_REASONS.JSON_PARSE_FAILED, ...copyDigest };
    }
    if (typeof input.expect === "function") {
      let accepted = false;
      try {
        accepted = input.expect(parsed) === true;
      } catch {
        accepted = false;
      }
      if (!accepted) {
        return { verified: false, mode, reason: VERIFICATION_REASONS.JSON_EXPECTATION_FAILED, ...copyDigest };
      }
    }
    return { verified: true, mode, reason: VERIFICATION_REASONS.JSON_PARSED, ...copyDigest };
  }

  const originalBuffer = toBuffer(input.original);
  if (originalBuffer === null) {
    return { verified: false, mode, reason: VERIFICATION_REASONS.ORIGINAL_MISSING, ...copyDigest };
  }
  const originalDigest = computeRecoveryPointDigest(originalBuffer);
  if (originalDigest.size !== copyDigest.size) {
    return { verified: false, mode, reason: VERIFICATION_REASONS.SIZE_MISMATCH, ...copyDigest };
  }
  if (originalDigest.sha256 !== copyDigest.sha256) {
    return { verified: false, mode, reason: VERIFICATION_REASONS.HASH_MISMATCH, ...copyDigest };
  }
  return { verified: true, mode, reason: VERIFICATION_REASONS.BYTE_IDENTICAL, ...copyDigest };
}

function refuse(reason, detail) {
  return { verdict: MIGRATION_VERDICTS.REFUSE, reason, allowed: false, detail: detail || null };
}

function allow(verdict, reason, detail) {
  return { verdict, reason, allowed: true, detail: detail || null };
}

/**
 * Decide whether a risky migration may proceed.
 *
 * Descriptor shape:
 *   {
 *     storeId: string,                       // non-empty
 *     fromSchemaVersion: integer >= 0,
 *     toSchemaVersion: integer >= 0,
 *     recoveryPoint: { canTake: boolean, taken: boolean, verified: boolean },
 *     reconstructible: { isReconstructible: boolean, source: string|null },
 *   }
 *
 * `reconstructible` is only honoured when `isReconstructible === true` AND a
 * non-empty `source` names what the store can be rebuilt from. That is the only
 * path that yields `proceed-with-warning`; every other unavailable or
 * unverified recovery point is refused.
 *
 * @returns {{ verdict: "proceed"|"proceed-with-warning"|"refuse", reason: string, allowed: boolean, detail: string|null }}
 */
function decideMigrationRecovery(descriptor = {}) {
  if (!isPlainObject(descriptor)) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "descriptor must be an object");
  }
  const storeId = descriptor.storeId;
  if (typeof storeId !== "string" || storeId.trim().length === 0) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "storeId must be a non-empty string");
  }
  const from = descriptor.fromSchemaVersion;
  const to = descriptor.toSchemaVersion;
  if (!isNonNegativeInteger(from) || !isNonNegativeInteger(to)) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "fromSchemaVersion and toSchemaVersion must be non-negative integers");
  }
  if (!isPlainObject(descriptor.recoveryPoint)) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "recoveryPoint must be an object");
  }
  const { canTake, taken, verified } = descriptor.recoveryPoint;
  if (typeof canTake !== "boolean" || typeof taken !== "boolean" || typeof verified !== "boolean") {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "recoveryPoint.canTake, .taken and .verified must be booleans");
  }
  const reconstructible = descriptor.reconstructible === undefined
    ? { isReconstructible: false, source: null }
    : descriptor.reconstructible;
  if (!isPlainObject(reconstructible) || typeof reconstructible.isReconstructible !== "boolean") {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "reconstructible.isReconstructible must be a boolean");
  }
  const reconstructSource = reconstructible.source === undefined ? null : reconstructible.source;
  if (reconstructSource !== null && typeof reconstructSource !== "string") {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID, "reconstructible.source must be a string or null");
  }

  if (to < from) {
    return refuse(MIGRATION_RECOVERY_REASONS.INVALID_VERSION_TRANSITION, `cannot migrate ${storeId} backwards from ${from} to ${to}`);
  }
  if (to === from) {
    return allow(MIGRATION_VERDICTS.PROCEED, MIGRATION_RECOVERY_REASONS.NO_MIGRATION_REQUIRED, `${storeId} already at schema ${to}`);
  }

  // A recovery point cannot be verified unless it was taken, and it cannot have
  // been taken if the descriptor says it could not be. Both are descriptor
  // contradictions and are refused rather than interpreted.
  if (verified && !taken) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INCONSISTENT, `${storeId} claims a verified recovery point that was never taken`);
  }
  if (taken && !canTake) {
    return refuse(MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INCONSISTENT, `${storeId} claims a taken recovery point the descriptor says cannot be taken`);
  }

  if (taken && verified) {
    return allow(MIGRATION_VERDICTS.PROCEED, MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_VERIFIED, `${storeId} ${from}->${to}`);
  }
  if (taken && !verified) {
    return refuse(MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNVERIFIED, `${storeId} recovery point was taken but not verified`);
  }
  if (canTake) {
    return refuse(MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_NOT_TAKEN, `${storeId} recovery point could have been taken but was not`);
  }

  const namedSource = typeof reconstructSource === "string" && reconstructSource.trim().length > 0;
  if (reconstructible.isReconstructible === true && namedSource) {
    return allow(
      MIGRATION_VERDICTS.PROCEED_WITH_WARNING,
      MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNAVAILABLE_RECONSTRUCTIBLE,
      `${storeId} cannot take a recovery point and is reconstructible from ${reconstructSource.trim()}`,
    );
  }
  return refuse(MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNAVAILABLE, `${storeId} recovery point cannot be taken`);
}

module.exports = {
  MIGRATION_RECOVERY_REASONS,
  MIGRATION_VERDICTS,
  VERIFICATION_MODES,
  VERIFICATION_REASONS,
  computeRecoveryPointDigest,
  decideMigrationRecovery,
  verifyRecoveryPoint,
};