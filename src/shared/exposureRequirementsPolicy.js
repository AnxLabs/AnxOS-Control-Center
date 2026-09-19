// V2-H exposure requirements policy (pure, testable).
//
// This module answers two questions and nothing else:
//
//   1. What does this exposure request actually REQUIRE?
//      (classifyExposureRequest / assertExposureRequestSatisfiable)
//
//      A web workload behind an HTTP reverse proxy and a game server that needs
//      raw TCP/UDP are different requirements. HTTP routing carries HTTP/HTTPS
//      requests and applies host/path rules; raw port exposure forwards a
//      transport port. Requesting HTTP routing for a TCP/UDP-only workload is
//      refused with a typed code rather than silently degraded to a port
//      forward, and vice versa is not assumed either: the classification names
//      the mechanism that actually satisfies the protocol.
//
//   2. What are the provider's DECLARED limits?
//      (resolveProviderExposureLimits / evaluateProviderExposure)
//
//      Limits are declared data, never probed. A protocol or mechanism this
//      project has not verified is reported state "unknown" — the UI can then
//      say "this provider does not document UDP support" instead of pretending.
//      No numeric limit is invented: every quantitative limit in this table is
//      `{ value: null, state: "unknown" }` because no provider was contacted
//      and no provider document was verified by this project.
//
// Like reverseProxyPolicy.js this module is deliberately pure: no filesystem,
// no network, no process access, no clock beyond what a caller passes in.

const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_MECHANISM_LENGTH = 48;
const MAX_NOTE_LENGTH = 400;

// Application protocols carry an HTTP request/response and can therefore be
// served by HTTP routing (host + path rules, managed TLS). Transport protocols
// are raw byte streams / datagrams and can only be carried by a forwarded port.
const APPLICATION_PROTOCOLS = Object.freeze(["http", "https"]);
const TRANSPORT_PROTOCOLS = Object.freeze(["tcp", "udp"]);
const EXPOSURE_PROTOCOLS = Object.freeze([...APPLICATION_PROTOCOLS, ...TRANSPORT_PROTOCOLS]);

const WORKLOAD_KINDS = Object.freeze(["web", "game-server", "service"]);

// The two exposure mechanisms AnxOS can describe. They are NOT interchangeable:
// one applies HTTP rules, the other forwards a port.
const EXPOSURE_MECHANISMS = Object.freeze({
  httpRouting: "http-routing",
  rawPort: "raw-port-exposure",
});
const MECHANISM_VALUES = Object.freeze(Object.values(EXPOSURE_MECHANISMS));

// support/limit states. "unknown" is a first-class answer, never a stand-in for
// "assume yes" or "assume no".
const LIMIT_STATES = Object.freeze(["supported", "unsupported", "unknown"]);
const OUTCOME_STATES = Object.freeze(["satisfiable", "unsatisfiable", "unknown"]);
// The vocabulary a diagnostics snapshot must use for "did provisioning happen".
const PROVISIONING_STATES = Object.freeze(["known-succeeded", "known-failed", "unknown"]);

const UNKNOWN_LIMIT_NOTE = "This project has not verified a limit for this provider and protocol; it is reported as unknown rather than assumed.";

function exposureRequirementError(code, message, details = {}, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

function unknownLimit(note = UNKNOWN_LIMIT_NOTE) {
  return { state: "unknown", basis: "not-established", capabilityField: null, capabilityValue: null, value: null, note: truncate(note, MAX_NOTE_LENGTH) };
}

function declaredLimit(state, capabilityField, capabilityValue, note) {
  return { state, basis: "declared-capability", capabilityField, capabilityValue, value: null, note: truncate(note, MAX_NOTE_LENGTH) };
}

function unavailableLimit(note) {
  return { state: "unknown", basis: "provider-unavailable", capabilityField: null, capabilityValue: null, value: null, note: truncate(note, MAX_NOTE_LENGTH) };
}

// ---------------------------------------------------------------------------
// DECLARED provider exposure limits.
//
// RULE (enforced by scripts/exposure-requirements-smoke.js): for any provider
// whose status is "supported" or "foundation", every protocol entry MUST mirror
// the declared capability boolean named by `capabilityField`/`capabilityValue`
// in src/shared/publicAccessProviderDetection.js. That keeps this table from
// drifting away from the capability model Public Access already renders.
//
// A provider that this build cannot use at all (status "disabled") has no
// established protocol capability: it is "unknown", not "unsupported", because
// AnxOS never verified what the provider itself supports.
//
// `limits` are quantitative provider limits. Every one of them is unknown:
// this project has contacted no provider and verified no published limit, so a
// number here would be fabricated.
// ---------------------------------------------------------------------------
const DECLARED_PROVIDER_LIMITS = Object.freeze({
  playit: Object.freeze({
    providerId: "playit",
    providerName: "Playit.gg",
    status: "supported",
    exposureScope: "public-internet",
    mechanisms: Object.freeze({
      [EXPOSURE_MECHANISMS.httpRouting]: declaredLimit("supported", null, null, "Playit exposes tunnel endpoints; an HTTP endpoint can be routed as a web service."),
      [EXPOSURE_MECHANISMS.rawPort]: declaredLimit("supported", null, null, "Playit tunnels forward a raw local port."),
    }),
    protocols: Object.freeze({
      http: declaredLimit("supported", "http", true, "Declared capability: Playit advertises HTTP exposure."),
      https: declaredLimit("supported", "https", true, "Declared capability: Playit advertises HTTPS exposure."),
      tcp: declaredLimit("supported", "tcp", true, "Declared capability: Playit advertises TCP exposure."),
      udp: declaredLimit("supported", "udp", true, "Declared capability: Playit advertises UDP exposure. Port ranges, concurrent UDP tunnel limits and datagram-size behaviour remain unverified by this project."),
    }),
    limits: Object.freeze({
      maxPublicHostnames: unknownLimit("No verified Playit limit for public hostnames; not published or checked by this project."),
      maxConcurrentTunnels: unknownLimit("No verified Playit limit for concurrent tunnels; not published or checked by this project."),
      maxPortsPerService: unknownLimit("No verified Playit limit for ports per service."),
      bandwidth: unknownLimit("No verified Playit bandwidth limit."),
    }),
  }),
  "cloudflare-tunnel": Object.freeze({
    providerId: "cloudflare-tunnel",
    providerName: "Cloudflare Tunnel",
    status: "foundation",
    exposureScope: "public-internet",
    mechanisms: Object.freeze({
      [EXPOSURE_MECHANISMS.httpRouting]: declaredLimit("supported", null, null, "Cloudflare Tunnel public hostname ingress routes HTTP/HTTPS requests."),
      [EXPOSURE_MECHANISMS.rawPort]: declaredLimit("unsupported", null, null, "This integration exposes only HTTP/HTTPS public hostname ingress. Raw TCP/UDP is not exposed here, so a game-server port cannot be satisfied by this mechanism."),
    }),
    protocols: Object.freeze({
      http: declaredLimit("supported", "http", true, "Declared capability: Cloudflare Tunnel advertises HTTP ingress."),
      https: declaredLimit("supported", "https", true, "Declared capability: Cloudflare Tunnel advertises HTTPS ingress."),
      tcp: declaredLimit("unsupported", "tcp", false, "This integration does not document raw TCP exposure; it is HTTP/HTTPS ingress only."),
      udp: declaredLimit("unsupported", "udp", false, "This integration does not document UDP support. UDP is refused rather than assumed available."),
    }),
    limits: Object.freeze({
      maxPublicHostnames: unknownLimit("No verified Cloudflare limit for public hostnames on this account; not checked by this project."),
      maxConcurrentTunnels: unknownLimit("No verified Cloudflare limit for concurrent tunnels; not checked by this project."),
      maxPortsPerService: unknownLimit("Cloudflare public hostname ingress is not port-based; no port limit applies and none is verified."),
      bandwidth: unknownLimit("No verified Cloudflare bandwidth limit."),
    }),
  }),
  tailscale: Object.freeze({
    providerId: "tailscale",
    providerName: "Tailscale",
    status: "foundation",
    exposureScope: "tailnet-only",
    mechanisms: Object.freeze({
      [EXPOSURE_MECHANISMS.httpRouting]: declaredLimit("supported", null, null, "Tailscale serve can route HTTP/HTTPS within the tailnet."),
      [EXPOSURE_MECHANISMS.rawPort]: declaredLimit("supported", null, null, "A tailnet address carries raw TCP/UDP between tailnet members."),
    }),
    protocols: Object.freeze({
      http: declaredLimit("supported", "http", true, "Declared capability: Tailscale advertises HTTP service sharing."),
      https: declaredLimit("supported", "https", true, "Declared capability: Tailscale advertises HTTPS service sharing."),
      tcp: declaredLimit("supported", "tcp", true, "Declared capability: Tailscale advertises TCP exposure within the tailnet."),
      udp: declaredLimit("supported", "udp", true, "Declared capability: Tailscale advertises UDP exposure within the tailnet."),
    }),
    limits: Object.freeze({
      maxPublicHostnames: unknownLimit("Tailscale exposure here is tailnet-only; a public hostname limit does not apply and none is verified."),
      maxConcurrentTunnels: declaredLimit("unsupported", null, null, "Not a tunnel provider in this integration; there is no tunnel count to limit."),
      maxPortsPerService: unknownLimit("No verified Tailscale limit for ports per service."),
      bandwidth: unknownLimit("No verified Tailscale bandwidth limit."),
    }),
  }),
  "manual-port-forwarding": Object.freeze({
    providerId: "manual-port-forwarding",
    providerName: "Manual Port Forwarding",
    status: "foundation",
    exposureScope: "public-internet",
    mechanisms: Object.freeze({
      [EXPOSURE_MECHANISMS.httpRouting]: declaredLimit("unsupported", null, null, "A router forwards a port; it performs no HTTP host or path routing and no certificate management."),
      [EXPOSURE_MECHANISMS.rawPort]: declaredLimit("supported", null, null, "Router port forwarding exposes a raw port."),
    }),
    protocols: Object.freeze({
      http: declaredLimit("supported", "http", true, "A forwarded TCP port can carry HTTP bytes, but without HTTP routing or managed TLS."),
      https: declaredLimit("supported", "https", true, "A forwarded TCP port can carry HTTPS bytes, but the certificate is managed entirely by the operator."),
      tcp: declaredLimit("supported", "tcp", true, "Declared capability: Manual Port Forwarding advertises TCP exposure."),
      udp: declaredLimit("supported", "udp", true, "Declared capability: Manual Port Forwarding advertises UDP exposure."),
    }),
    limits: Object.freeze({
      maxPublicHostnames: unknownLimit("There is no provider API here; whether the ISP or router allows a hostname is outside AnxOS and unverified."),
      maxConcurrentTunnels: declaredLimit("unsupported", null, null, "Not a tunnel provider."),
      maxPortsPerService: unknownLimit("No verified router or ISP limit for ports per service."),
      bandwidth: unknownLimit("No verified ISP bandwidth or port-blocking limit."),
    }),
  }),
  "anxos-relay": Object.freeze({
    providerId: "anxos-relay",
    providerName: "AnxOS Relay",
    status: "disabled",
    exposureScope: "unavailable",
    mechanisms: Object.freeze({
      [EXPOSURE_MECHANISMS.httpRouting]: unavailableLimit("The AnxOS Relay backend does not exist in this build; no routing capability is established."),
      [EXPOSURE_MECHANISMS.rawPort]: unavailableLimit("The AnxOS Relay backend does not exist in this build; no port exposure capability is established."),
    }),
    protocols: Object.freeze({
      http: unavailableLimit("The AnxOS Relay backend does not exist in this build; no protocol capability is established."),
      https: unavailableLimit("The AnxOS Relay backend does not exist in this build; no protocol capability is established."),
      tcp: unavailableLimit("The AnxOS Relay backend does not exist in this build; no protocol capability is established."),
      udp: unavailableLimit("The AnxOS Relay backend does not exist in this build; no UDP capability is documented. Reported unknown, never as supported or as a fabricated limit."),
    }),
    limits: Object.freeze({
      maxPublicHostnames: unavailableLimit("Provider unavailable; no limit is established."),
      maxConcurrentTunnels: unavailableLimit("Provider unavailable; no limit is established."),
      maxPortsPerService: unavailableLimit("Provider unavailable; no limit is established."),
      bandwidth: unavailableLimit("Provider unavailable; no limit is established."),
    }),
  }),
});

const UNKNOWN_PROVIDER_NOTE = "AnxOS has no declared exposure limits for this provider id; every limit is reported unknown.";

function normalizeExposureProtocol(value) {
  const protocol = String(value ?? "").trim().toLowerCase();
  if (!protocol) {
    throw exposureRequirementError("EXPOSURE_PROTOCOL_REQUIRED", "An exposure protocol is required.", { field: "protocol", expected: [...EXPOSURE_PROTOCOLS] });
  }
  if (!EXPOSURE_PROTOCOLS.includes(protocol)) {
    throw exposureRequirementError("EXPOSURE_PROTOCOL_INVALID", "The exposure protocol must be http, https, tcp or udp.", {
      field: "protocol",
      received: value,
      expected: [...EXPOSURE_PROTOCOLS],
    });
  }
  return protocol;
}

function normalizeWorkloadKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  if (!kind) return null;
  if (!WORKLOAD_KINDS.includes(kind)) {
    throw exposureRequirementError("EXPOSURE_WORKLOAD_KIND_INVALID", "The workload kind must be web, game-server or service.", {
      field: "workloadKind",
      received: value,
      expected: [...WORKLOAD_KINDS],
    });
  }
  return kind;
}

function normalizeRequestedMechanism(value) {
  const mechanism = String(value ?? "").trim().toLowerCase();
  if (!mechanism) return null;
  if (!MECHANISM_VALUES.includes(mechanism)) {
    throw exposureRequirementError("EXPOSURE_MECHANISM_INVALID", "The exposure mechanism must be http-routing or raw-port-exposure.", {
      field: "mechanism",
      received: value,
      expected: [...MECHANISM_VALUES],
    });
  }
  return mechanism;
}

function normalizeProviderId(value) {
  const providerId = String(value ?? "").trim().toLowerCase();
  return providerId ? truncate(providerId, MAX_PROVIDER_ID_LENGTH) : null;
}

// A web workload speaks HTTP; anything on a raw transport is a game/server
// workload unless the caller says otherwise.
function inferWorkloadKind(protocol, requestedKind) {
  const explicit = normalizeWorkloadKind(requestedKind);
  if (explicit) return explicit;
  return APPLICATION_PROTOCOLS.includes(protocol) ? "web" : "game-server";
}

function transportForProtocol(protocol) {
  return protocol === "udp" ? "udp" : "tcp";
}

function mechanismForProtocol(protocol) {
  return APPLICATION_PROTOCOLS.includes(protocol) ? EXPOSURE_MECHANISMS.httpRouting : EXPOSURE_MECHANISMS.rawPort;
}

// HTTP routing is only ever coherent for an application protocol. Raw port
// exposure transports any of the four (an http/https service exposed this way
// simply loses host/path routing and managed TLS).
function mechanismSatisfiesProtocol(mechanism, protocol) {
  if (mechanism === EXPOSURE_MECHANISMS.httpRouting) return APPLICATION_PROTOCOLS.includes(protocol);
  if (mechanism === EXPOSURE_MECHANISMS.rawPort) return EXPOSURE_PROTOCOLS.includes(protocol);
  return false;
}

function resolveProviderExposureLimits(providerId) {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return null;
  return DECLARED_PROVIDER_LIMITS[normalized] || null;
}

function protocolLimitFor(providerId, protocol) {
  const table = resolveProviderExposureLimits(providerId);
  if (!table) return unknownLimit(UNKNOWN_PROVIDER_NOTE);
  return table.protocols[protocol] || unknownLimit(`No declared limit for protocol "${protocol}" on this provider.`);
}

function mechanismLimitFor(providerId, mechanism) {
  const table = resolveProviderExposureLimits(providerId);
  if (!table) return unknownLimit(UNKNOWN_PROVIDER_NOTE);
  return table.mechanisms[mechanism] || unknownLimit(`No declared limit for mechanism "${truncate(mechanism, MAX_MECHANISM_LENGTH)}" on this provider.`);
}

// ---------------------------------------------------------------------------
// Provider-side evaluation: can this provider satisfy this mechanism+protocol?
// "unknown" is returned when the project has no established limit, and it is
// never collapsed into "satisfiable".
// ---------------------------------------------------------------------------
function evaluateProviderExposure(input = {}) {
  const protocol = normalizeExposureProtocol(input.protocol);
  const mechanism = normalizeRequestedMechanism(input.mechanism) || mechanismForProtocol(protocol);
  const providerId = normalizeProviderId(input.providerId);
  const table = resolveProviderExposureLimits(providerId);
  const protocolLimit = protocolLimitFor(providerId, protocol);
  const mechanismLimit = mechanismLimitFor(providerId, mechanism);
  const base = {
    providerId,
    providerName: table?.providerName || null,
    exposureScope: table?.exposureScope || null,
    mechanism,
    protocol,
    protocolLimit,
    mechanismLimit,
    limits: table?.limits || null,
  };

  if (!table) {
    return {
      ...base,
      outcome: "unknown",
      satisfiable: null,
      reason: "EXPOSURE_PROVIDER_UNKNOWN",
      message: `${UNKNOWN_PROVIDER_NOTE} AnxOS cannot confirm ${protocol.toUpperCase()} exposure through ${mechanism}.`,
    };
  }

  if (protocolLimit.state === "unsupported" || mechanismLimit.state === "unsupported") {
    const cause = protocolLimit.state === "unsupported" ? protocolLimit : mechanismLimit;
    return {
      ...base,
      outcome: "unsatisfiable",
      satisfiable: false,
      reason: "EXPOSURE_PROVIDER_PROTOCOL_UNSUPPORTED",
      message: `${table.providerName} cannot satisfy ${protocol.toUpperCase()} exposure through ${mechanism}. ${cause.note}`,
    };
  }

  if (protocolLimit.state === "unknown" || mechanismLimit.state === "unknown") {
    const cause = protocolLimit.state === "unknown" ? protocolLimit : mechanismLimit;
    return {
      ...base,
      outcome: "unknown",
      satisfiable: null,
      reason: "EXPOSURE_PROVIDER_LIMIT_UNKNOWN",
      message: `${table.providerName} does not declare a verified limit for ${protocol.toUpperCase()} exposure through ${mechanism}. ${cause.note}`,
    };
  }

  return {
    ...base,
    outcome: "satisfiable",
    satisfiable: true,
    reason: null,
    message: `${table.providerName} declares ${protocol.toUpperCase()} exposure through ${mechanism}.`,
  };
}

// ---------------------------------------------------------------------------
// Classification: what a request requires, which mechanism satisfies it, and
// what the named provider (if any) declares.
// ---------------------------------------------------------------------------
function classifyExposureRequest(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw exposureRequirementError("EXPOSURE_REQUEST_INVALID", "An exposure requirement request is required.", { field: "request" });
  }
  const protocol = normalizeExposureProtocol(input.protocol ?? input.transport ?? options.protocol);
  const workloadKind = inferWorkloadKind(protocol, input.workloadKind);
  const requestedMechanism = normalizeRequestedMechanism(input.mechanism ?? input.exposureMechanism);
  const recommendedMechanism = mechanismForProtocol(protocol);
  const resolvedMechanism = requestedMechanism || recommendedMechanism;
  const pairSatisfiable = mechanismSatisfiesProtocol(resolvedMechanism, protocol);
  const providerId = normalizeProviderId(input.providerId ?? options.providerId);
  const provider = providerId ? evaluateProviderExposure({ protocol, mechanism: resolvedMechanism, providerId }) : null;

  const base = {
    protocol,
    transport: transportForProtocol(protocol),
    workloadKind,
    requestedMechanism,
    recommendedMechanism,
    mechanism: pairSatisfiable ? resolvedMechanism : null,
    providerId,
    provider: provider
      ? {
          providerId: provider.providerId,
          providerName: provider.providerName,
          outcome: provider.outcome,
          satisfiable: provider.satisfiable,
          reason: provider.reason,
          message: provider.message,
          protocolLimit: provider.protocolLimit,
          mechanismLimit: provider.mechanismLimit,
        }
      : null,
    providerLimits: provider?.limits || null,
  };

  if (!pairSatisfiable) {
    // The one refusal this module exists to make: never silently degrade an
    // HTTP-routing request into a port forward (or vice versa).
    return {
      ...base,
      outcome: "unsatisfiable",
      satisfiable: false,
      reason: "EXPOSURE_MECHANISM_UNSATISFIED",
      message: requestedMechanism === EXPOSURE_MECHANISMS.httpRouting
        ? `HTTP routing cannot carry a raw ${protocol.toUpperCase()} workload. HTTP routing applies host and path rules to HTTP/HTTPS requests; a ${transportForProtocol(protocol).toUpperCase()} workload requires raw port exposure.`
        : `${resolvedMechanism} cannot satisfy a ${protocol.toUpperCase()} exposure.`,
    };
  }

  if (provider && provider.outcome === "unsatisfiable") {
    return { ...base, outcome: "unsatisfiable", satisfiable: false, reason: provider.reason, message: provider.message };
  }
  if (provider && provider.outcome === "unknown") {
    return { ...base, outcome: "unknown", satisfiable: null, reason: provider.reason, message: provider.message };
  }

  return {
    ...base,
    outcome: "satisfiable",
    satisfiable: true,
    reason: null,
    message: `${protocol.toUpperCase()} exposure is satisfied by ${resolvedMechanism}${provider ? ` on ${provider.providerName}` : ""}.`,
  };
}

// Fail-closed helper for callers that must not proceed on an impossible
// combination. Unknown provider limits are returned (not thrown) so a caller
// can render "cannot confirm" instead of a false success or a false failure.
function assertExposureRequestSatisfiable(input = {}, options = {}) {
  const classification = classifyExposureRequest(input, options);
  if (classification.outcome === "unsatisfiable") {
    throw exposureRequirementError(
      classification.reason || "EXPOSURE_MECHANISM_UNSATISFIED",
      classification.message,
      {
        protocol: classification.protocol,
        mechanism: classification.requestedMechanism || classification.recommendedMechanism,
        requestedMechanism: classification.requestedMechanism,
        recommendedMechanism: classification.recommendedMechanism,
        providerId: classification.providerId,
        protocolLimit: classification.provider?.protocolLimit || null,
        mechanismLimit: classification.provider?.mechanismLimit || null,
      },
      400,
    );
  }
  return classification;
}

module.exports = {
  APPLICATION_PROTOCOLS,
  DECLARED_PROVIDER_LIMITS,
  EXPOSURE_MECHANISMS,
  EXPOSURE_PROTOCOLS,
  LIMIT_STATES,
  MECHANISM_VALUES,
  OUTCOME_STATES,
  PROVISIONING_STATES,
  TRANSPORT_PROTOCOLS,
  UNKNOWN_LIMIT_NOTE,
  WORKLOAD_KINDS,
  assertExposureRequestSatisfiable,
  classifyExposureRequest,
  evaluateProviderExposure,
  exposureRequirementError,
  inferWorkloadKind,
  mechanismForProtocol,
  mechanismLimitFor,
  mechanismSatisfiesProtocol,
  normalizeExposureProtocol,
  normalizeRequestedMechanism,
  protocolLimitFor,
  resolveProviderExposureLimits,
  transportForProtocol,
  _test: {
    normalizeProviderId,
    unknownLimit,
  },
};