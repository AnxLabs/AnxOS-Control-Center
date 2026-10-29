(function initializeConnectivityDiagnostics(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxConnectivityDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConnectivityDiagnosticsApi(root) {
  "use strict";

  const hasCommonJs = typeof module === "object" && module && module.exports;
  let healthModel = null;
  if (hasCommonJs && typeof require === "function") {
    try {
      healthModel = require("./healthModel");
    } catch (error) {
      healthModel = null;
    }
  }
  if (!healthModel && root && root.AnxHealthModel) healthModel = root.AnxHealthModel;

  function requireHealthModel() {
    if (healthModel) return healthModel;
    if (root && root.AnxHealthModel) {
      healthModel = root.AnxHealthModel;
      return healthModel;
    }
    throw new Error("AnxConnectivityDiagnostics requires the AnxHealthModel module (load src/shared/healthModel.js first).");
  }

  // The six ordered checkpoints that describe one connectivity path from the
  // service process out to the public internet. The diagnostics service later
  // produces stage data; this module owns the vocabulary, validation, and
  // aggregation, never the probing.
  const STAGE_IDS = Object.freeze([
    "service-process",
    "local-socket",
    "host-network",
    "agent",
    "provider",
    "public-endpoint",
  ]);

  const STAGE_LABELS = Object.freeze({
    "service-process": "Service Process",
    "local-socket": "Local Port",
    "host-network": "Host Networking",
    agent: "Agent",
    provider: "Tunnel Provider",
    "public-endpoint": "Public Endpoint",
  });

  const REMEDIATION_KINDS = Object.freeze([
    "open-network",
    "open-provider",
    "start-service",
    "open-console",
    "copy-details",
  ]);

  const TARGET_KEYS = Object.freeze([
    "nodeId",
    "computerName",
    "serviceId",
    "serviceName",
    "endpointId",
    "endpointLabel",
  ]);

  const MAX_STAGES = 12;
  const MAX_EVIDENCE_KEYS = 24;
  const MAX_EVIDENCE_ARRAY_ITEMS = 32;

  // ---------------------------------------------------------------------------
  // Pure sha256 (no node:crypto — this module also loads as a plain browser
  // script). Used only for deterministic result ids. Verified against
  // node:crypto by connectivity-diagnostics-model-smoke.js.
  // ---------------------------------------------------------------------------

  const SHA256_K = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotr(value, bits) {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
  }

  function utf8Bytes(text) {
    const out = [];
    for (let index = 0; index < text.length; index += 1) {
      let code = text.charCodeAt(index);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
          out.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        } else {
          out.push(0xef, 0xbf, 0xbd);
        }
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function sha256Hex(input) {
    const message = utf8Bytes(String(input));
    const bitLength = message.length * 8;
    const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(message);
    bytes[message.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const schedule = new Uint32Array(64);

    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        schedule[index] = view.getUint32(offset + index * 4);
      }
      for (let index = 16; index < 64; index += 1) {
        const previous15 = schedule[index - 15];
        const previous2 = schedule[index - 2];
        const s0 = rotr(previous15, 7) ^ rotr(previous15, 18) ^ (previous15 >>> 3);
        const s1 = rotr(previous2, 17) ^ rotr(previous2, 19) ^ (previous2 >>> 10);
        schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;

      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choice + SHA256_K[index] + schedule[index]) >>> 0;
        const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  // ---------------------------------------------------------------------------
  // Stage construction and validation
  // ---------------------------------------------------------------------------

  function isScalarEvidenceValue(value) {
    return (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    );
  }

  // The anti-secret-leak guard: evidence may only carry flat, displayable
  // scalars (and flat arrays of them). Provider snapshots, credential-shaped
  // objects, or any nested structure are refused loudly so a raw object can
  // never be embedded in a diagnostics result and later rendered or logged.
  function copyEvidence(evidence) {
    if (evidence == null) return {};
    if (typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new TypeError("createStage: evidence must be a plain object of scalar values");
    }
    const keys = Object.keys(evidence);
    if (keys.length > MAX_EVIDENCE_KEYS) {
      throw new TypeError(`createStage: evidence may contain at most ${MAX_EVIDENCE_KEYS} keys`);
    }
    const copied = {};
    for (const key of keys) {
      const value = evidence[key];
      if (isScalarEvidenceValue(value)) {
        copied[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length > MAX_EVIDENCE_ARRAY_ITEMS) {
          throw new TypeError(
            `createStage: evidence["${key}"] may contain at most ${MAX_EVIDENCE_ARRAY_ITEMS} items`,
          );
        }
        for (const item of value) {
          if (!isScalarEvidenceValue(item)) {
            throw new TypeError(
              `createStage: evidence["${key}"] items must be string, number, boolean, or null`,
            );
          }
        }
        copied[key] = value.slice();
        continue;
      }
      throw new TypeError(
        `createStage: evidence["${key}"] must be a string, number, boolean, null, or an array of those (nested objects are not allowed)`,
      );
    }
    return copied;
  }

  function normalizeRemediation(remediation) {
    if (remediation == null) return [];
    if (!Array.isArray(remediation)) {
      throw new TypeError("createStage: remediation must be an array");
    }
    return remediation.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TypeError(`createStage: remediation[${index}] must be an object`);
      }
      if (!REMEDIATION_KINDS.includes(item.kind)) {
        throw new TypeError(`createStage: unknown remediation kind "${String(item.kind)}"`);
      }
      return { id: String(item.id || ""), label: String(item.label || ""), kind: item.kind };
    });
  }

  function createStage(input) {
    const stage = input && typeof input === "object" && !Array.isArray(input) ? input : null;
    if (!stage) throw new TypeError("createStage: stage must be an object");
    if (!STAGE_IDS.includes(stage.id)) {
      throw new TypeError(`createStage: unknown stage id "${String(stage.id)}"`);
    }
    if (!requireHealthModel().CONNECTIVITY_STATES.includes(stage.state)) {
      throw new TypeError(`createStage: unknown state "${String(stage.state)}" for stage "${stage.id}"`);
    }
    return {
      id: stage.id,
      label: STAGE_LABELS[stage.id],
      state: stage.state,
      detail: String(stage.detail || ""),
      evidence: copyEvidence(stage.evidence),
      remediation: normalizeRemediation(stage.remediation),
    };
  }

  // ---------------------------------------------------------------------------
  // Result construction
  // ---------------------------------------------------------------------------

  function normalizeTarget(target) {
    const source = target && typeof target === "object" && !Array.isArray(target) ? target : {};
    const canonical = {};
    for (const key of TARGET_KEYS) {
      const value = source[key];
      const text = value == null ? "" : String(value).trim();
      canonical[key] = text || null;
    }
    return canonical;
  }

  function normalizeDuration(durationMs) {
    const value = Number(durationMs);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function stageLabelOf(stage) {
    if (stage && typeof stage.label === "string" && stage.label) return stage.label;
    if (stage && STAGE_LABELS[stage.id]) return STAGE_LABELS[stage.id];
    return "Unknown Stage";
  }

  function labelsForState(stages, state) {
    return stages.filter((stage) => stage && stage.state === state).map(stageLabelOf);
  }

  function headlineForState(state, stages) {
    switch (state) {
      case "healthy":
        return "Healthy";
      case "failed":
        return `Path broken at: ${labelsForState(stages, "failed").join(", ")}`;
      case "unknown":
        return `Incomplete evidence: ${labelsForState(stages, "unknown").join(", ")}`;
      case "degraded":
        return `Degraded at: ${labelsForState(stages, "degraded").join(", ")}`;
      case "not_configured":
        return "Not configured";
      default:
        return requireHealthModel().stateLabel(state);
    }
  }

  function detailLineForStages(stages) {
    return stages
      .map((stage) => {
        const line = `${stageLabelOf(stage)}: ${stage.state}`;
        return stage.detail ? `${line} — ${stage.detail}` : line;
      })
      .join("; ");
  }

  // Defaults answer only the scopes the diagnostics path itself can prove:
  // process from the service-process stage, local from service-process +
  // local-socket. LAN, private overlay, and public reachability require
  // vantage-specific probes, so they stay unknown unless the caller supplies
  // explicit, valid scope states.
  function buildReachability(stateById, scopes) {
    const health = requireHealthModel();
    const processState = health.CONNECTIVITY_STATES.includes(stateById["service-process"])
      ? stateById["service-process"]
      : "unknown";
    const reachability = {
      process: processState,
      local: health.combineStates([stateById["service-process"], stateById["local-socket"]]),
      lan: "unknown",
      private_overlay: "unknown",
      public: "unknown",
    };
    if (scopes && typeof scopes === "object" && !Array.isArray(scopes)) {
      for (const scope of health.REACHABILITY_SCOPES) {
        if (health.CONNECTIVITY_STATES.includes(scopes[scope])) {
          reachability[scope] = scopes[scope];
        }
      }
    }
    return reachability;
  }

  // Deterministic id: sha256 over [canonical target, checkedAt, [[stageId,
  // state], ...]]. Only identity + states are hashed — never evidence, which
  // may contain values not safe to persist.
  function computeResultId(target, checkedAt, stages) {
    const stageStates = stages.map((stage) => [stage.id, stage.state]);
    return `dx-${sha256Hex(JSON.stringify([target, checkedAt, stageStates])).slice(0, 16)}`;
  }

  function buildDiagnosticsResult(options) {
    const input = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const target = normalizeTarget(input.target);
    const rawStages = Array.isArray(input.stages) ? input.stages : [];
    // Stages come from the diagnostics service (programmer-controlled), so an
    // unknown id/state/kind is a programmer error and throws via createStage.
    // Excess stages are capped deterministically at MAX_STAGES.
    const stages = rawStages.slice(0, MAX_STAGES).map((rawStage) => createStage(rawStage));
    const health = requireHealthModel();
    const stateById = {};
    for (const stage of stages) stateById[stage.id] = stage.state;
    const overallState = health.worstState(stages.map((stage) => stage.state));
    const checkedAt = input.checkedAt == null ? null : String(input.checkedAt);

    return {
      id: computeResultId(target, checkedAt, stages),
      target,
      checkedAt,
      durationMs: normalizeDuration(input.durationMs),
      cached: Boolean(input.cached),
      stages,
      overall: {
        state: overallState,
        headline: headlineForState(overallState, stages),
        detail: detailLineForStages(stages),
      },
      reachability: buildReachability(stateById, input.scopes),
      graph: input.graph == null ? null : input.graph,
    };
  }

  // ---------------------------------------------------------------------------
  // Result consumption and validation
  // ---------------------------------------------------------------------------

  function summarizeDiagnostics(result) {
    const safe = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const health = requireHealthModel();
    const rawStages = Array.isArray(safe.stages) ? safe.stages.filter(Boolean) : [];
    const overall = safe.overall && typeof safe.overall === "object" ? safe.overall : {};
    const overallState = health.CONNECTIVITY_STATES.includes(overall.state)
      ? overall.state
      : health.worstState(rawStages.map((stage) => stage.state));
    const reachability = safe.reachability && typeof safe.reachability === "object" ? safe.reachability : {};
    return {
      headline:
        typeof overall.headline === "string" && overall.headline
          ? overall.headline
          : headlineForState(overallState, rawStages),
      tone: health.stateTone(overallState),
      scopeRows: health.REACHABILITY_SCOPES.map((scope) => {
        const state = health.CONNECTIVITY_STATES.includes(reachability[scope])
          ? reachability[scope]
          : "unknown";
        return {
          scope,
          label: health.SCOPE_LABELS[scope],
          state,
          stateLabel: health.stateLabel(state),
          tone: health.stateTone(state),
        };
      }),
      failedStages: rawStages.filter((stage) => stage.state === "failed").map((stage) => stage.id),
      unknownStages: rawStages.filter((stage) => stage.state === "unknown").map((stage) => stage.id),
    };
  }

  function collectEvidenceErrors(evidence, path, errors) {
    if (evidence == null) return;
    if (typeof evidence !== "object" || Array.isArray(evidence)) {
      errors.push(`${path} must be a plain object`);
      return;
    }
    const keys = Object.keys(evidence);
    if (keys.length > MAX_EVIDENCE_KEYS) {
      errors.push(`${path} may contain at most ${MAX_EVIDENCE_KEYS} keys`);
    }
    for (const key of keys) {
      const value = evidence[key];
      if (isScalarEvidenceValue(value)) continue;
      if (Array.isArray(value)) {
        if (value.length > MAX_EVIDENCE_ARRAY_ITEMS) {
          errors.push(`${path}["${key}"] may contain at most ${MAX_EVIDENCE_ARRAY_ITEMS} items`);
        }
        if (value.some((item) => !isScalarEvidenceValue(item))) {
          errors.push(`${path}["${key}"] items must be string, number, boolean, or null`);
        }
        continue;
      }
      errors.push(`${path}["${key}"] must be a string, number, boolean, null, or an array of those`);
    }
  }

  function collectRemediationErrors(remediation, path, errors) {
    if (remediation == null) return;
    if (!Array.isArray(remediation)) {
      errors.push(`${path} must be an array`);
      return;
    }
    remediation.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${path}[${index}] must be an object`);
        return;
      }
      if (typeof item.id !== "string") errors.push(`${path}[${index}].id must be a string`);
      if (typeof item.label !== "string") errors.push(`${path}[${index}].label must be a string`);
      if (!REMEDIATION_KINDS.includes(item.kind)) {
        errors.push(`${path}[${index}].kind "${String(item.kind)}" is not a known remediation kind`);
      }
    });
  }

  function validateDiagnosticsResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { ok: false, errors: ["result must be an object"] };
    }
    const health = requireHealthModel();
    const errors = [];

    if (typeof result.id !== "string" || !/^dx-[0-9a-f]{16}$/.test(result.id)) {
      errors.push("id must match /^dx-[0-9a-f]{16}$/");
    }

    if (!result.target || typeof result.target !== "object" || Array.isArray(result.target)) {
      errors.push("target must be an object");
    } else {
      for (const key of Object.keys(result.target)) {
        if (!TARGET_KEYS.includes(key)) errors.push(`target contains unknown key "${key}"`);
      }
      for (const key of TARGET_KEYS) {
        if (!(key in result.target)) {
          errors.push(`target is missing "${key}"`);
          continue;
        }
        const value = result.target[key];
        if (value !== null && typeof value !== "string") {
          errors.push(`target.${key} must be a string or null`);
        }
      }
    }

    if (!("checkedAt" in result) || (result.checkedAt !== null && typeof result.checkedAt !== "string")) {
      errors.push("checkedAt must be a string or null");
    }

    if (
      typeof result.durationMs !== "number" ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0
    ) {
      errors.push("durationMs must be a non-negative finite number");
    }

    if (typeof result.cached !== "boolean") errors.push("cached must be a boolean");

    if (!Array.isArray(result.stages)) {
      errors.push("stages must be an array");
    } else {
      if (result.stages.length > MAX_STAGES) {
        errors.push(`stages may contain at most ${MAX_STAGES} entries`);
      }
      result.stages.forEach((stage, index) => {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
          errors.push(`stages[${index}] must be an object`);
          return;
        }
        if (!STAGE_IDS.includes(stage.id)) {
          errors.push(`stages[${index}].id "${String(stage.id)}" is not a known stage id`);
        }
        if (!health.CONNECTIVITY_STATES.includes(stage.state)) {
          errors.push(`stages[${index}].state "${String(stage.state)}" is not a known state`);
        }
        if (typeof stage.label !== "string" || !stage.label) {
          errors.push(`stages[${index}].label must be a non-empty string`);
        }
        if (typeof stage.detail !== "string") errors.push(`stages[${index}].detail must be a string`);
        collectEvidenceErrors(stage.evidence, `stages[${index}].evidence`, errors);
        collectRemediationErrors(stage.remediation, `stages[${index}].remediation`, errors);
      });
    }

    if (!result.overall || typeof result.overall !== "object" || Array.isArray(result.overall)) {
      errors.push("overall must be an object");
    } else {
      if (!health.CONNECTIVITY_STATES.includes(result.overall.state)) {
        errors.push("overall.state is not a known state");
      }
      if (typeof result.overall.headline !== "string" || !result.overall.headline) {
        errors.push("overall.headline must be a non-empty string");
      }
      if (typeof result.overall.detail !== "string") errors.push("overall.detail must be a string");
    }

    if (!result.reachability || typeof result.reachability !== "object" || Array.isArray(result.reachability)) {
      errors.push("reachability must be an object");
    } else {
      for (const scope of health.REACHABILITY_SCOPES) {
        if (!health.CONNECTIVITY_STATES.includes(result.reachability[scope])) {
          errors.push(`reachability.${scope} is not a known state`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  return {
    STAGE_IDS,
    STAGE_LABELS,
    REMEDIATION_KINDS,
    MAX_STAGES,
    createStage,
    buildDiagnosticsResult,
    summarizeDiagnostics,
    validateDiagnosticsResult,
  };
});
