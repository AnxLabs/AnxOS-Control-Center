// V2-H exposure requirements + error/residual surfacing smoke (hermetic).
//
// Proves the two bounded slices added for the V2-H bullets:
//   "Distinguish HTTP routing from game-server TCP/UDP requirements; show
//    actual provider and protocol limits."
//   "Surface DNS/certificate/provider errors and residual billable resources
//    where applicable; never imply provisioning succeeded."
//
//   1. HTTP, raw TCP and UDP requirements classify differently and route to
//      different mechanisms (http-routing vs raw-port-exposure).
//   2. A UDP-only (and a TCP-only) workload requesting HTTP routing is refused
//      with a typed code, never silently degraded to a port forward.
//   3. Provider limits are declared data: a provider with no documented UDP
//      support reports unsupported, a provider this build cannot use reports
//      unknown, and no provider limit carries an invented number. The declared
//      protocol states are cross-checked against the existing provider
//      capability model so the two cannot drift apart.
//   4. An unreadable certificate expiry surfaces as "unknown" — never valid —
//      both from the pure lifecycle machine and through the diagnostics
//      snapshot built from real certificate records.
//   5. A workload whose provisioning state cannot be established reports
//      "unknown" and never "known-succeeded"; the snapshot always carries the
//      explicit provisioning vocabulary. Recorded DNS/provider errors surface;
//      absent records report "unknown", never "ok".
//   6. Residual billable resources report unknown with a null count when
//      undetectable — never zero-by-default.
//   7. Regression guard: every assertion the existing reverse-proxy smoke makes
//      about the pre-existing endpoint shapes is replicated here and still
//      holds, and the new endpoints are purely additive.
//
// Everything is injected or local: no provider is contacted, no external
// network is touched, no command is spawned. The HTTP slice uses a loopback
// listener started by this smoke. Ends with "exposure-requirements-smoke passed".
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
// Pin runtime roots BEFORE requiring any src/ service, or registry/service
// layers can write into the real machine root.
const smokeRoot = pinAgentRoots("anx-exposure-requirements-smoke-");

const root = path.resolve(__dirname, "..");
const policy = require("../src/shared/exposureRequirementsPolicy");
const certificatePolicy = require("../src/shared/reverseProxyPolicy");
const detection = require("../src/shared/publicAccessProviderDetection");
const registry = require("../src/shared/publicAccessServiceRegistry");
const service = require("../agent/src/services/reverseProxyService");
const agentRoute = require("../agent/src/routes/publicAccess");

const agentRouteSource = fs.readFileSync(path.join(root, "agent", "src", "routes", "publicAccess.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "agent", "src", "server.js"), "utf8");
const serviceSource = fs.readFileSync(path.join(root, "agent", "src", "services", "reverseProxyService.js"), "utf8");
const policySource = fs.readFileSync(path.join(root, "src", "shared", "exposureRequirementsPolicy.js"), "utf8");

const PROVIDERS_BY_ID = new Map(detection.PUBLIC_ACCESS_PROVIDERS.map((provider) => [provider.id, provider]));

// ---------------------------------------------------------------------------
// 1. Classification: HTTP routing is not raw port exposure.
// ---------------------------------------------------------------------------
const httpRequirement = policy.classifyExposureRequest({ protocol: "http" });
assert.strictEqual(httpRequirement.protocol, "http", "An http requirement must keep its protocol.");
assert.strictEqual(httpRequirement.transport, "tcp", "http is carried over tcp.");
assert.strictEqual(httpRequirement.workloadKind, "web", "An http requirement must classify as a web workload.");
assert.strictEqual(httpRequirement.mechanism, policy.EXPOSURE_MECHANISMS.httpRouting, "http must be satisfied by HTTP routing.");
assert.strictEqual(httpRequirement.outcome, "satisfiable", "A plain http requirement must be satisfiable.");
assert.strictEqual(httpRequirement.satisfiable, true, "A satisfiable requirement must report satisfiable true.");

const httpsRequirement = policy.classifyExposureRequest({ protocol: "https" });
assert.strictEqual(httpsRequirement.mechanism, policy.EXPOSURE_MECHANISMS.httpRouting, "https must be satisfied by HTTP routing.");

const tcpRequirement = policy.classifyExposureRequest({ protocol: "tcp" });
assert.strictEqual(tcpRequirement.transport, "tcp", "A tcp requirement must report its transport.");
assert.strictEqual(tcpRequirement.workloadKind, "game-server", "A raw tcp requirement must classify as a game-server workload.");
assert.strictEqual(tcpRequirement.mechanism, policy.EXPOSURE_MECHANISMS.rawPort, "tcp must be satisfied by raw port exposure.");

const udpRequirement = policy.classifyExposureRequest({ protocol: "udp" });
assert.strictEqual(udpRequirement.transport, "udp", "A udp requirement must report the udp transport.");
assert.strictEqual(udpRequirement.workloadKind, "game-server", "A raw udp requirement must classify as a game-server workload.");
assert.strictEqual(udpRequirement.mechanism, policy.EXPOSURE_MECHANISMS.rawPort, "udp must be satisfied by raw port exposure.");

assert.notStrictEqual(httpRequirement.mechanism, tcpRequirement.mechanism, "HTTP and raw TCP requirements must route to different mechanisms.");
assert.notStrictEqual(httpRequirement.mechanism, udpRequirement.mechanism, "HTTP and raw UDP requirements must route to different mechanisms.");
assert.notStrictEqual(tcpRequirement.transport, udpRequirement.transport, "TCP and UDP requirements must be distinguishable by transport.");

const explicitGameServer = policy.classifyExposureRequest({ protocol: "tcp", workloadKind: "service" });
assert.strictEqual(explicitGameServer.workloadKind, "service", "An explicit workload kind must be honoured.");

assert.throws(
  () => policy.classifyExposureRequest({ protocol: "sctp" }),
  (error) => error?.code === "EXPOSURE_PROTOCOL_INVALID",
  "An unsupported protocol must be refused with a typed code.",
);
assert.throws(
  () => policy.classifyExposureRequest({}),
  (error) => error?.code === "EXPOSURE_PROTOCOL_REQUIRED",
  "A missing protocol must be refused with a typed code.",
);
assert.throws(
  () => policy.classifyExposureRequest({ protocol: "udp", mechanism: "magic-tunnel" }),
  (error) => error?.code === "EXPOSURE_MECHANISM_INVALID",
  "An unknown mechanism must be refused with a typed code.",
);

// ---------------------------------------------------------------------------
// 2. The refusal that matters: HTTP routing cannot carry a raw TCP/UDP workload.
// ---------------------------------------------------------------------------
const udpOverHttpRouting = policy.classifyExposureRequest({ protocol: "udp", mechanism: "http-routing" });
assert.strictEqual(udpOverHttpRouting.outcome, "unsatisfiable", "HTTP routing for a UDP workload must be unsatisfiable.");
assert.strictEqual(udpOverHttpRouting.satisfiable, false, "An unsatisfiable request must not report satisfiable.");
assert.strictEqual(udpOverHttpRouting.mechanism, null, "An unsatisfiable request must not report a mechanism, because none can serve it.");
assert.strictEqual(udpOverHttpRouting.reason, "EXPOSURE_MECHANISM_UNSATISFIED", "The refusal must carry a typed reason.");
assert(/HTTP routing cannot carry a raw UDP workload/.test(udpOverHttpRouting.message), `The refusal must explain why (${udpOverHttpRouting.message}).`);

assert.throws(
  () => policy.assertExposureRequestSatisfiable({ protocol: "udp", mechanism: "http-routing" }),
  (error) => error?.code === "EXPOSURE_MECHANISM_UNSATISFIED" && error?.details?.protocol === "udp",
  "Requesting HTTP routing for a UDP-only workload must be a typed refusal.",
);
assert.throws(
  () => policy.assertExposureRequestSatisfiable({ protocol: "tcp", mechanism: "http-routing" }),
  (error) => error?.code === "EXPOSURE_MECHANISM_UNSATISFIED",
  "Requesting HTTP routing for a raw TCP workload must be a typed refusal.",
);
// The refusal is a refusal, not a degradation: an http request that only
// mentions a raw game port is still satisfiable through raw port exposure.
const httpRawPort = policy.classifyExposureRequest({ protocol: "http", mechanism: "raw-port-exposure" });
assert.strictEqual(httpRawPort.outcome, "satisfiable", "An http service explicitly exposed as a raw port is a coherent (if lossy) request.");
assert.strictEqual(httpRawPort.mechanism, policy.EXPOSURE_MECHANISMS.rawPort, "The explicit raw-port mechanism must be kept.");
// assertExposureRequestSatisfiable returns the classification for satisfiable input.
assert.strictEqual(policy.assertExposureRequestSatisfiable({ protocol: "http" }).outcome, "satisfiable", "A satisfiable request must pass the assert helper.");

// ---------------------------------------------------------------------------
// 3. Declared provider limits: never a fabricated capability.
// ---------------------------------------------------------------------------
const cloudflareUdp = policy.protocolLimitFor("cloudflare-tunnel", "udp");
assert.strictEqual(cloudflareUdp.state, "unsupported", "Cloudflare Tunnel must report UDP as unsupported, not as an available capability.");
assert.notStrictEqual(cloudflareUdp.state, "supported", "Cloudflare Tunnel UDP must never be reported supported.");
assert.strictEqual(cloudflareUdp.value, null, "A protocol limit must not carry an invented value.");
assert(/not document UDP support/.test(cloudflareUdp.note), `The UDP note must say support is not documented (${cloudflareUdp.note}).`);

const cloudflareUdpEval = policy.evaluateProviderExposure({ protocol: "udp", providerId: "cloudflare-tunnel" });
assert.strictEqual(cloudflareUdpEval.outcome, "unsatisfiable", "Cloudflare Tunnel must not claim UDP exposure.");
assert.strictEqual(cloudflareUdpEval.reason, "EXPOSURE_PROVIDER_PROTOCOL_UNSUPPORTED", "The provider refusal must be typed.");
assert.strictEqual(cloudflareUdpEval.satisfiable, false, "An unsupported provider protocol must not be satisfiable.");
assert.strictEqual(cloudflareUdpEval.limits, policy.DECLARED_PROVIDER_LIMITS["cloudflare-tunnel"].limits, "The evaluation must carry the declared limits.");

const cloudflareHttpEval = policy.evaluateProviderExposure({ protocol: "http", providerId: "cloudflare-tunnel" });
assert.strictEqual(cloudflareHttpEval.outcome, "satisfiable", "Cloudflare Tunnel must declare HTTP ingress as satisfiable.");

const cloudflareRawPortEval = policy.evaluateProviderExposure({ protocol: "tcp", mechanism: "raw-port-exposure", providerId: "cloudflare-tunnel" });
assert.strictEqual(cloudflareRawPortEval.outcome, "unsatisfiable", "Cloudflare Tunnel must not claim raw port exposure.");

// A provider this build cannot use reports unknown — not unsupported, and
// never supported. AnxOS never verified what the provider itself supports.
const relayUdp = policy.protocolLimitFor("anxos-relay", "udp");
assert.strictEqual(relayUdp.state, "unknown", "An unavailable provider must report an unknown UDP limit.");
assert.notStrictEqual(relayUdp.state, "supported", "An unavailable provider must never be reported as supporting UDP.");
assert.strictEqual(relayUdp.basis, "provider-unavailable", "The unknown basis must be explicit.");
const relayEval = policy.evaluateProviderExposure({ protocol: "udp", providerId: "anxos-relay" });
assert.strictEqual(relayEval.outcome, "unknown", "An unavailable provider must evaluate to unknown.");
assert.strictEqual(relayEval.satisfiable, null, "Unknown must never be collapsed into satisfiable true or false.");

// A provider id with no declared table is unknown, not assumed capable.
const unnamedProviderEval = policy.evaluateProviderExposure({ protocol: "tcp", providerId: "some-other-provider" });
assert.strictEqual(unnamedProviderEval.outcome, "unknown", "An undeclared provider must evaluate to unknown.");
assert.strictEqual(unnamedProviderEval.reason, "EXPOSURE_PROVIDER_UNKNOWN", "The undeclared provider reason must be explicit.");
assert.strictEqual(unnamedProviderEval.protocolLimit.state, "unknown", "An undeclared provider protocol limit must be unknown.");
assert.strictEqual(unnamedProviderEval.limits, null, "An undeclared provider must not invent a limits object.");
const classifiedWithUnknownProvider = policy.classifyExposureRequest({ protocol: "tcp", providerId: "some-other-provider" });
assert.strictEqual(classifiedWithUnknownProvider.outcome, "unknown", "A classification against an undeclared provider must be unknown.");
assert.strictEqual(classifiedWithUnknownProvider.satisfiable, null, "An unknown classification must not claim satisfiable.");
assert.strictEqual(classifiedWithUnknownProvider.mechanism, policy.EXPOSURE_MECHANISMS.rawPort, "The mechanism itself is still known even when the provider limit is not.");

// Consistency guard: the declared table must mirror the existing capability
// model for every provider this build can actually use. A "disabled" provider
// carries no established capability, so it stays unknown by design.
for (const [providerId, table] of Object.entries(policy.DECLARED_PROVIDER_LIMITS)) {
  const provider = PROVIDERS_BY_ID.get(providerId);
  assert(provider, `The declared limits table must cover the known provider ${providerId}.`);
  assert.strictEqual(table.providerId, providerId, `${providerId} must declare its own id.`);
  if (table.status === "disabled") {
    for (const protocol of policy.EXPOSURE_PROTOCOLS) {
      assert.strictEqual(table.protocols[protocol].state, "unknown", `${providerId}.${protocol} must be unknown for an unavailable provider.`);
    }
    continue;
  }
  assert(
    provider.status === "supported" || provider.status === "foundation",
    `${providerId} must be a provider this build can use to be capability-checked.`,
  );
  for (const protocol of policy.EXPOSURE_PROTOCOLS) {
    const declared = table.protocols[protocol];
    const capability = provider.capabilities[declared.capabilityField];
    assert.strictEqual(
      typeof capability,
      "boolean",
      `${providerId}.${protocol} must name a real capability field (${declared.capabilityField}).`,
    );
    assert.strictEqual(
      declared.capabilityValue,
      capability,
      `${providerId}.${protocol} declared limit drifted from the capability model.`,
    );
    assert.strictEqual(
      declared.state,
      capability ? "supported" : "unsupported",
      `${providerId}.${protocol} state must match the declared capability (${capability}).`,
    );
  }
  for (const [limitName, limit] of Object.entries(table.limits)) {
    assert.strictEqual(limit.value, null, `${providerId}.${limitName} must not carry an invented numeric limit.`);
    assert(["supported", "unsupported", "unknown"].includes(limit.state), `${providerId}.${limitName} must carry a declared state.`);
  }
}
assert.strictEqual(policy.protocolLimitFor("playit", "udp").state, "supported", "Playit must keep its declared UDP capability.");
assert.strictEqual(policy.mechanismLimitFor("manual-port-forwarding", "http-routing").state, "unsupported", "Manual port forwarding must not claim HTTP routing.");
assert.strictEqual(
  policy.DECLARED_PROVIDER_LIMITS.playit.limits.maxPortsPerService.state,
  "unknown",
  "Quantitative provider limits must be unknown, because no provider was contacted.",
);

// ---------------------------------------------------------------------------
// 4. Certificate: an unreadable expiry is unknown, never valid.
// ---------------------------------------------------------------------------
const noExpiry = certificatePolicy.evaluateCertificateState({ subject: "app.example.com" });
assert.strictEqual(noExpiry.state, "unknown", "A certificate with no readable expiry must report unknown.");
assert.notStrictEqual(noExpiry.state, "issued", "An unverifiable certificate must never be reported as issued.");
assert.strictEqual(noExpiry.verified, false, "An unverifiable certificate must not be marked verified.");
assert.strictEqual(noExpiry.reason, "EXPIRY_UNDETERMINABLE", "The unknown reason must be explicit.");
assert.strictEqual(certificatePolicy.evaluateCertificateState({ notAfter: "not-a-date" }).state, "unknown", "A malformed expiry must report unknown.");

// ---------------------------------------------------------------------------
// 5. Service-level diagnostics snapshot (injected config dir; no provider).
// ---------------------------------------------------------------------------
function fakeConnect(outcome) {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => {
      if (outcome === "connect") socket.emit("connect");
      else socket.emit("error", new Error("ECONNREFUSED"));
    });
    return socket;
  };
}

const NOW = Date.now();

async function assertDiagnosticsSlice() {
  const configDir = path.join(smokeRoot, "diagnostics-config");
  fs.mkdirSync(configDir, { recursive: true });

  // Real certificate records: one with an unreadable expiry, one expiring.
  fs.writeFileSync(path.join(configDir, service.CERTIFICATES_FILE_NAME), `${JSON.stringify({
    schemaVersion: 1,
    certificates: [
      { hostname: "unknown-cert.example.com", subject: "unknown-cert.example.com" },
      { hostname: "expiring.example.com", subject: "expiring.example.com", notAfter: new Date(NOW + 4 * 86400000).toISOString() },
    ],
  })}\n`);

  // Real reverse-proxy routes, recorded through the real service.
  await service.applyReverseProxyRoute(
    { hostname: "unknown-cert.example.com", upstream: "127.0.0.1:9201", tlsMode: "manual" },
    { configDir, connect: fakeConnect("connect") },
  );
  await service.applyReverseProxyRoute(
    { hostname: "expiring.example.com", upstream: "127.0.0.1:9202", tlsMode: "manual" },
    { configDir, connect: fakeConnect("connect") },
  );
  await service.applyReverseProxyRoute(
    { hostname: "dns.example.com", upstream: "127.0.0.1:9203" },
    { configDir, connect: fakeConnect("connect") },
  );

  // Real access services: one provider-confirmed, one provider-unavailable,
  // one still pending. These drive all three provisioning states.
  const running = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    name: "Running Game",
    localHost: "127.0.0.1",
    localPort: 8211,
    protocol: "udp",
    publicAddress: "run.playit.gg",
    state: "running",
  }, { configDir });
  const unavailable = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    name: "Unavailable Game",
    localHost: "127.0.0.1",
    localPort: 8212,
    protocol: "tcp",
    state: "provider-unavailable",
  }, { configDir });
  const pending = registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    name: "Pending Game",
    localHost: "127.0.0.1",
    localPort: 8213,
    protocol: "udp",
  }, { configDir });
  assert.strictEqual(running.state, "running", "The running access service fixture must persist its state.");
  assert.strictEqual(unavailable.state, "provider-unavailable", "The unavailable access service fixture must persist its state.");
  assert.notStrictEqual(pending.state, "running", "The pending access service must not be a confirmed endpoint.");

  const routes = service.listReverseProxyRoutes({ configDir });
  const dnsRoute = routes.find((route) => route.hostname === "dns.example.com");
  assert(dnsRoute, "The dns.example.com route must have been recorded.");
  const unknownCertRoute = routes.find((route) => route.hostname === "unknown-cert.example.com");
  assert(unknownCertRoute, "The unknown-cert.example.com route must have been recorded.");

  // No detected-error records yet: every error field must be unknown, never ok.
  const bare = await service.getExposureDiagnosticsSnapshot({ configDir });
  assert.strictEqual(bare.ok, true, "The diagnostics snapshot must resolve ok (the read succeeded).");
  assert.strictEqual(bare.supported, true, "The diagnostics snapshot must report supported true.");
  assert(Array.isArray(bare.workloads), "The diagnostics snapshot must carry a workloads array.");
  assert.strictEqual(bare.workloadCount, 6, `The snapshot must report every recorded workload (${bare.workloadCount}).`);
  assert(bare.workloadCount <= bare.maxWorkloads, "The snapshot must stay within its declared workload bound.");
  assert.strictEqual(bare.recordedDiagnostics.source, "absent", "With no diagnostics registry the source must be reported absent.");
  assert.strictEqual(bare.recordedDiagnostics.available, false, "An absent diagnostics registry must not be reported available.");

  const bareDnsWorkload = bare.workloads.find((workload) => workload.id === dnsRoute.id);
  assert.strictEqual(bareDnsWorkload.dns.state, "unknown", "With no recorded DNS error, DNS state must be unknown.");
  assert.notStrictEqual(bareDnsWorkload.dns.state, "ok", "DNS state must never be reported ok from the absence of a record.");
  assert.strictEqual(bareDnsWorkload.dns.lastError, null, "With no recorded DNS error there is no last error to show.");
  assert.strictEqual(bareDnsWorkload.provider.state, "unknown", "With no recorded provider error, provider state must be unknown.");

  // Certificate from the real state machine: unreadable expiry -> unknown.
  const unknownCertWorkload = bare.workloads.find((workload) => workload.id === unknownCertRoute.id);
  assert.strictEqual(unknownCertWorkload.certificate.state, "unknown", "An unreadable certificate expiry must surface as unknown.");
  assert.notStrictEqual(unknownCertWorkload.certificate.state, "issued", "An unreadable certificate must never surface as issued.");
  assert.strictEqual(unknownCertWorkload.certificate.verified, false, "An unreadable certificate must not surface as verified.");
  assert.strictEqual(unknownCertWorkload.certificate.expiryVerified, false, "An unreadable certificate must not surface as expiry-verified.");
  assert.strictEqual(unknownCertWorkload.certificate.lastError.code, "EXPIRY_UNDETERMINABLE", "The certificate last error must name the undeterminable expiry.");
  const expiringWorkload = bare.workloads.find((workload) => workload.hostname === "expiring.example.com");
  assert.strictEqual(expiringWorkload.certificate.state, "expiring", "A recorded certificate inside the window must surface as expiring.");
  assert.strictEqual(expiringWorkload.certificate.expiryVerified, true, "A determinable expiry must surface as verified.");

  // Never imply provisioning succeeded.
  assert.strictEqual(unknownCertWorkload.provisioning.state, "unknown", "A route whose provisioning cannot be established must report unknown.");
  assert.notStrictEqual(unknownCertWorkload.provisioning.state, "known-succeeded", "A route must never be reported as provisioned.");
  assert.strictEqual(unknownCertWorkload.provisioning.code, "REVERSE_PROXY_PROVISIONING_NOT_ESTABLISHED", "The route provisioning code must be explicit.");
  assert.strictEqual(bare.provisioning.state, "unknown", "The overall provisioning state must be unknown while any workload is unknown.");
  assert.notStrictEqual(bare.provisioning.state, "known-succeeded", "The overall state must never imply success while unestablished states exist.");
  assert.strictEqual(bare.provisioning.counts.unknown > 0, true, "The overall counts must name the unknown workloads.");
  assert.strictEqual(bare.provisioning.knownSucceeded, 1, "The provider-confirmed access service must be counted as known-succeeded.");
  assert.strictEqual(bare.provisioning.knownFailed, 1, "The provider-unavailable access service must be counted as known-failed.");
  assert.strictEqual(bare.provisioning.knownSucceeded + bare.provisioning.knownFailed + bare.provisioning.unknown, bare.workloadCount, "The provisioning counts must cover every workload.");

  const runningWorkload = bare.workloads.find((workload) => workload.id === running.id);
  assert.strictEqual(runningWorkload.provisioning.state, "known-succeeded", "A provider-confirmed endpoint may be reported known-succeeded.");
  assert.strictEqual(runningWorkload.provisioning.basis, "provider-detected-endpoint", "The known-succeeded basis must cite the provider-detected endpoint.");
  const unavailableWorkload = bare.workloads.find((workload) => workload.id === unavailable.id);
  assert.strictEqual(unavailableWorkload.provisioning.state, "known-failed", "A provider-unavailable exposure must be reported known-failed.");
  const pendingWorkload = bare.workloads.find((workload) => workload.id === pending.id);
  assert.strictEqual(pendingWorkload.provisioning.state, "unknown", "A pending exposure with no confirmed endpoint must be unknown.");
  assert.notStrictEqual(pendingWorkload.provisioning.state, "known-succeeded", "A pending exposure must never be reported provisioned.");

  // Classification survives into the snapshot, and HTTP/TCP/UDP differ.
  assert.strictEqual(bareDnsWorkload.protocol, "http", "A non-TLS route must classify as an http requirement.");
  assert.strictEqual(bareDnsWorkload.requirements.transport, "tcp", "A web route must report the tcp transport.");
  assert.strictEqual(bareDnsWorkload.requirements.workloadKind, "web", "A web route must classify as a web workload.");
  assert.strictEqual(bareDnsWorkload.requirements.outcome, "satisfiable", "A recorded web route must classify as satisfiable.");
  assert.strictEqual(bareDnsWorkload.mechanism, "http-routing", "A web route must classify to HTTP routing.");
  assert.strictEqual(runningWorkload.protocol, "udp", "The running game service must keep its udp protocol.");
  assert.strictEqual(runningWorkload.mechanism, "raw-port-exposure", "A udp game service must classify to raw port exposure.");
  assert.strictEqual(unavailableWorkload.mechanism, "raw-port-exposure", "A tcp game service must classify to raw port exposure.");
  assert.notStrictEqual(bareDnsWorkload.mechanism, runningWorkload.mechanism, "Web and game workloads must classify to different mechanisms.");

  // Residual billable resources: unknown with a null count, never zero.
  assert.strictEqual(bare.residualBillableResources.state, "unknown", "Undetectable residual resources must report unknown.");
  assert.strictEqual(bare.residualBillableResources.count, null, "An undetectable residual count must be null, never zero.");
  assert.notStrictEqual(bare.residualBillableResources.count, 0, "An undetectable residual count must never be reported as zero.");
  assert.strictEqual(bare.residualBillableResources.detectable, false, "A missing detector must be reported as not detectable.");
  for (const workload of bare.workloads) {
    assert.strictEqual(workload.residualBillableResources.state, "unknown", "Every undetected workload must report unknown residuals.");
    assert.strictEqual(workload.residualBillableResources.count, null, "Every undetected workload residual count must be null.");
  }

  // Recorded DNS and provider errors surface verbatim, and drive known-failed.
  fs.writeFileSync(path.join(configDir, service.DIAGNOSTICS_FILE_NAME), `${JSON.stringify({
    schemaVersion: 1,
    dnsErrors: {
      [dnsRoute.id]: { code: "DNS_RESOLUTION_FAILED", message: "No A record was found for dns.example.com", at: "2026-01-01T00:00:00.000Z" },
    },
    providerErrors: {
      [pending.id]: { code: "PLAYIT_TUNNEL_REJECTED", message: "The provider rejected the tunnel request", at: "2026-01-01T00:00:00.000Z" },
    },
    certificateErrors: {
      [unknownCertRoute.id]: { code: "CERTIFICATE_IMPORT_FAILED", message: "The recorded certificate could not be parsed", at: "2026-01-01T00:00:00.000Z" },
    },
  })}\n`);

  const recorded = await service.getExposureDiagnosticsSnapshot({ configDir });
  assert.strictEqual(recorded.recordedDiagnostics.available, true, "A readable diagnostics registry must be reported available.");
  assert.strictEqual(recorded.recordedDiagnostics.source, "recorded", "A readable diagnostics registry must report its source.");
  const recordedDns = recorded.workloads.find((workload) => workload.id === dnsRoute.id);
  assert.strictEqual(recordedDns.dns.state, "error", "A recorded DNS error must surface as an error.");
  assert.strictEqual(recordedDns.dns.lastError.code, "DNS_RESOLUTION_FAILED", "The recorded DNS error code must surface.");
  assert.strictEqual(recordedDns.dns.lastError.at, "2026-01-01T00:00:00.000Z", "The recorded DNS error time must surface.");
  assert.notStrictEqual(recordedDns.provisioning.state, "known-succeeded", "A route with a recorded DNS error must never be reported provisioned.");
  const recordedProvider = recorded.workloads.find((workload) => workload.id === pending.id);
  assert.strictEqual(recordedProvider.provider.state, "error", "A recorded provider error must surface as an error.");
  assert.strictEqual(recordedProvider.provider.lastError.code, "PLAYIT_TUNNEL_REJECTED", "The recorded provider error code must surface.");
  assert.strictEqual(recordedProvider.provisioning.state, "known-failed", "A recorded provider error must put provisioning in known-failed.");
  assert.strictEqual(recordedProvider.provisioning.basis, "recorded-provider-error", "The known-failed basis must cite the recorded provider error.");
  const recordedCert = recorded.workloads.find((workload) => workload.id === unknownCertRoute.id);
  assert.strictEqual(recordedCert.certificate.lastError.code, "CERTIFICATE_IMPORT_FAILED", "A recorded certificate error must surface over the derived reason.");
  assert.notStrictEqual(recordedCert.provisioning.state, "known-succeeded", "A workload with a certificate error must never be reported provisioned.");

  // An injected residual detector can establish presence, and only then.
  const withDetector = await service.getExposureDiagnosticsSnapshot({
    configDir,
    residualBillableResources: { [running.id]: [{ id: "tun-1", kind: "tunnel", providerId: "playit", billable: null }] },
  });
  const detectedWorkload = withDetector.workloads.find((workload) => workload.id === running.id);
  assert.strictEqual(detectedWorkload.residualBillableResources.state, "present", "An injected detector result must surface as present.");
  assert.strictEqual(detectedWorkload.residualBillableResources.count, 1, "An injected detector result must surface its real count.");
  assert.strictEqual(detectedWorkload.residualBillableResources.detectable, true, "A run detector must be reported detectable.");
  assert.strictEqual(withDetector.residualBillableResources.state, "unknown", "A partially detected set must still report unknown overall.");
  assert.strictEqual(withDetector.residualBillableResources.count, null, "A partially detected total must be null, never a partial sum.");

  // Only a detector covering every workload can establish a clean total.
  const residualAll = {};
  for (const workload of withDetector.workloads) residualAll[workload.id] = [];
  const covered = await service.getExposureDiagnosticsSnapshot({ configDir, residualBillableResources: residualAll });
  assert.strictEqual(covered.residualBillableResources.state, "none-detected", "A detector covering every workload may report none-detected.");
  assert.strictEqual(covered.residualBillableResources.count, 0, "A detector covering every workload may report a real zero.");

  // A workload set with only provider-confirmed endpoints can report success.
  const succeededDir = path.join(smokeRoot, "diag-succeeded-config");
  fs.mkdirSync(succeededDir, { recursive: true });
  registry.createAccessService({
    nodeId: "anxlab",
    providerId: "playit",
    providerName: "Playit.gg",
    name: "Confirmed Game",
    localHost: "127.0.0.1",
    localPort: 8231,
    protocol: "udp",
    publicAddress: "confirmed.playit.gg",
    state: "running",
  }, { configDir: succeededDir });
  const succeeded = await service.getExposureDiagnosticsSnapshot({ configDir: succeededDir });
  assert.strictEqual(succeeded.provisioning.state, "known-succeeded", "A set of provider-confirmed endpoints may report known-succeeded.");
  assert.strictEqual(succeeded.provisioning.counts.unknown, 0, "A confirmed set must have no unknown workloads.");

  // An empty workload set must not be reported as succeeded.
  const emptyDir = path.join(smokeRoot, "diag-empty-config");
  fs.mkdirSync(emptyDir, { recursive: true });
  const empty = await service.getExposureDiagnosticsSnapshot({ configDir: emptyDir });
  assert.strictEqual(empty.provisioning.state, "unknown", "An empty exposure set must report unknown, never succeeded.");
  assert.strictEqual(empty.provisioning.reason, "NO_EXPOSURE_WORKLOADS", "The empty-set reason must be explicit.");
  assert.strictEqual(empty.provisioning.knownSucceeded, 0, "An empty set must count no successes.");

  // A corrupt diagnostics file must degrade to unknown, not to a false ok.
  fs.writeFileSync(path.join(configDir, service.DIAGNOSTICS_FILE_NAME), "{not-json\n");
  const corrupt = await service.getExposureDiagnosticsSnapshot({ configDir });
  assert.strictEqual(corrupt.recordedDiagnostics.available, false, "An unreadable diagnostics registry must not be reported available.");
  assert.strictEqual(corrupt.recordedDiagnostics.source, "unreadable", "An unreadable diagnostics registry must report its source.");
  const corruptDns = corrupt.workloads.find((workload) => workload.id === dnsRoute.id);
  assert.strictEqual(corruptDns.dns.state, "unknown", "An unreadable diagnostics registry must leave DNS unknown.");
  assert.strictEqual(corruptDns.dns.lastError, null, "An unreadable diagnostics registry must not invent an error.");
}

// ---------------------------------------------------------------------------
// 6. Real Agent HTTP slice: regression guard on existing shapes + new endpoints.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startUpstreamListener() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function probe(baseUrl, method, routePath, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { status: response.status, code: payload?.error?.code || null, body: payload };
}

async function assertAgentHttpSlice() {
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  const fullDir = path.join(smokeRoot, "http-full");
  const restrictedDir = path.join(smokeRoot, "http-restricted");
  fs.mkdirSync(fullDir, { recursive: true });
  fs.mkdirSync(restrictedDir, { recursive: true });
  const upstream = await startUpstreamListener();
  const tokenFull = "exposure-requirements-smoke-agent-token";
  const tokenRestricted = "exposure-requirements-smoke-restricted-token";
  const portFull = await getFreePort();
  const portRestricted = await getFreePort();
  const urlFull = `http://127.0.0.1:${portFull}`;
  const urlRestricted = `http://127.0.0.1:${portRestricted}`;

  const spawnAgent = (configDir, port, token, agentUrl, extraEnv = {}) => {
    fs.writeFileSync(path.join(configDir, "agent.json"), JSON.stringify({ backendMode: "agent", agentUrl, agentToken: token }));
    return spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], {
      cwd: path.join(root, "agent"),
      env: {
        ...process.env,
        AGENT_HOST: "127.0.0.1",
        AGENT_PORT: String(port),
        AGENT_TOKEN: token,
        AGENT_FILE_ROOTS: smokeRoot,
        AGENT_INSTANCE_ROOT: path.join(configDir, "instances"),
        AGENT_BACKUP_ROOT: path.join(configDir, "backups"),
        ANXHUB_CONFIG_DIR: configDir,
        ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
        AGENT_API_RATE_LIMIT_PER_MINUTE: "5000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const fullAgent = spawnAgent(fullDir, portFull, tokenFull, urlFull, {});
  const restrictedAgent = spawnAgent(restrictedDir, portRestricted, tokenRestricted, urlRestricted, {
    AGENT_PERMISSION_PROFILE: "restricted",
    AGENT_API_PERMISSIONS: "",
  });
  const stderr = { value: "" };
  fullAgent.stderr.on("data", (chunk) => { stderr.value += String(chunk); });
  restrictedAgent.stderr.on("data", (chunk) => { stderr.value += String(chunk); });

  try {
    await Promise.all([
      waitForAgentReady({
        label: "Exposure requirements smoke full Agent",
        child: fullAgent,
        stderr: () => stderr.value,
        probe: async () => (await fetch(`${urlFull}/api/v1/health`, { redirect: "manual" })).ok,
      }),
      waitForAgentReady({
        label: "Exposure requirements smoke restricted Agent",
        child: restrictedAgent,
        stderr: () => stderr.value,
        probe: async () => (await fetch(`${urlRestricted}/api/v1/health`, { redirect: "manual" })).ok,
      }),
    ]);

    const listPath = "/api/v1/public-access/reverse-proxy";
    const applyPath = "/api/v1/public-access/reverse-proxy/routes";
    const diagnosticsPath = "/api/v1/public-access/reverse-proxy/diagnostics";
    const requirementsPath = "/api/v1/public-access/reverse-proxy/requirements";

    // --- Regression guard: the pre-existing reverse-proxy endpoint contract. ---
    const unauthList = await probe(urlFull, "GET", listPath, null);
    assert.strictEqual(unauthList.code, "UNAUTHORIZED", "An unauthenticated read must be refused 401.");
    assert.strictEqual(unauthList.status, 401, "An unauthenticated read must use the 401 bearer gate.");

    const restrictedList = await probe(urlRestricted, "GET", listPath, tokenRestricted);
    assert.strictEqual(restrictedList.code, "API_PERMISSION_DENIED", "A restricted-profile actor must be refused 403 on read.");
    assert.strictEqual(restrictedList.status, 403, "The restricted read must use the 403 permission gate.");

    const fullList = await probe(urlFull, "GET", listPath, tokenFull);
    assert.strictEqual(fullList.status, 200, "The full-profile credential must read the snapshot.");
    assert.strictEqual(fullList.body.ok, true, "The snapshot must resolve ok.");
    assert.strictEqual(fullList.body.activation.supported, false, "The read must state activation is unsupported.");
    assert.strictEqual(fullList.body.activation.code, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE", "The activation block must keep its honest code.");
    assert.strictEqual(fullList.body.certificateIssuance.supported, false, "The read must state issuance is unsupported.");
    assert.strictEqual(fullList.body.certificateIssuance.code, "REVERSE_PROXY_TLS_ISSUANCE_UNAVAILABLE", "The issuance block must keep its honest code.");
    // Every pre-existing top-level field must still be present and typed.
    for (const key of ["ok", "supported", "platform", "checkedAt", "routeCount", "maxRoutes", "routes", "certificates", "certificateLifecycle", "activation", "certificateIssuance"]) {
      assert(Object.prototype.hasOwnProperty.call(fullList.body, key), `The reverse-proxy snapshot must still carry ${key}.`);
    }
    assert.strictEqual(typeof fullList.body.routeCount, "number", "routeCount must remain a number.");
    assert.strictEqual(typeof fullList.body.maxRoutes, "number", "maxRoutes must remain a number.");
    assert(Array.isArray(fullList.body.routes), "routes must remain an array.");
    assert(Array.isArray(fullList.body.certificates), "certificates must remain an array.");
    for (const key of ["total", "counts", "overall", "warningDays"]) {
      assert(Object.prototype.hasOwnProperty.call(fullList.body.certificateLifecycle, key), `certificateLifecycle must still carry ${key}.`);
    }

    const unauthApply = await probe(urlFull, "POST", applyPath, null, {});
    assert.strictEqual(unauthApply.status, 401, "An unauthenticated apply must be refused 401.");

    const restrictedApply = await probe(urlRestricted, "POST", applyPath, tokenRestricted, {});
    assert.strictEqual(restrictedApply.code, "API_PERMISSION_DENIED", "A restricted-profile actor must be refused 403 on apply.");
    assert.strictEqual(restrictedApply.status, 403, "The restricted apply must use the 403 permission gate.");

    const unsafeApply = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "unsafe.example.com", upstream: "10.20.30.40:8080" });
    assert.strictEqual(unsafeApply.code, "REVERSE_PROXY_UPSTREAM_HOST_NOT_ALLOWED", "A non-allowlisted upstream must be refused 403 by the handler.");
    assert.strictEqual(unsafeApply.status, 403, "The upstream-host refusal must use 403.");

    const wildcardApply = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "*.example.com", upstream: `127.0.0.1:${upstream.port}` });
    assert.strictEqual(wildcardApply.code, "REVERSE_PROXY_WILDCARD_NOT_GRANTED", "An ungranted wildcard must be refused end to end.");

    const applied = await probe(urlFull, "POST", applyPath, tokenFull, { hostname: "smoke.example.com", upstream: `127.0.0.1:${upstream.port}`, tlsMode: "managed" });
    assert.strictEqual(applied.status, 200, "A valid apply must succeed through the real handler.");
    assert.strictEqual(applied.body.success, true, "A valid apply must record the route.");
    assert.strictEqual(applied.body.applied, false, "A valid apply must not claim activation.");
    assert.strictEqual(applied.body.activation.code, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE", "The apply must carry the honest activation code.");
    assert.strictEqual(applied.body.upstreamReachability.reachable, true, "The smoke's loopback listener must be observed as reachable.");
    assert.strictEqual(applied.body.certificate.state, "pending", "A managed TLS request must be pending, never issued.");
    assert.notStrictEqual(applied.body.certificate.state, "issued", "A managed TLS request must never be reported as issued.");
    assert.strictEqual(applied.body.certificate.issuanceSupported, false, "Issuance must be reported unsupported.");
    assert.strictEqual(applied.body.certificate.code, "REVERSE_PROXY_TLS_ISSUANCE_UNAVAILABLE", "The certificate block must keep its honest code.");

    for (const key of ["success", "applied", "activation", "certificate", "route", "upstreamReachability", "routes"]) {
      assert(Object.prototype.hasOwnProperty.call(applied.body, key), `A route apply must still carry ${key}.`);
    }
    for (const key of ["id", "name", "hostname", "pathPrefix", "upstream", "upstreamProtocol", "tlsMode", "managedBy", "createdAt", "updatedAt"]) {
      assert(Object.prototype.hasOwnProperty.call(applied.body.route, key), `A recorded route must still carry ${key}.`);
    }

    const afterApply = await probe(urlFull, "GET", listPath, tokenFull);
    assert.strictEqual(afterApply.status, 200, "The snapshot must still read after apply.");
    const appliedRoute = afterApply.body.routes.find((route) => route.hostname === "smoke.example.com");
    assert(appliedRoute, "The applied route must appear in the snapshot.");
    assert(appliedRoute.certificate, "A snapshot route must still carry its certificate report.");

    // --- New endpoint: exposure diagnostics (additive). ---
    const unauthDiagnostics = await probe(urlFull, "GET", diagnosticsPath, null);
    assert.strictEqual(unauthDiagnostics.status, 401, "The diagnostics read must sit behind the 401 bearer gate.");
    const restrictedDiagnostics = await probe(urlRestricted, "GET", diagnosticsPath, tokenRestricted);
    assert.strictEqual(restrictedDiagnostics.code, "API_PERMISSION_DENIED", "A restricted-profile actor must be refused 403 on diagnostics.");
    const fullDiagnostics = await probe(urlFull, "GET", diagnosticsPath, tokenFull);
    assert.strictEqual(fullDiagnostics.status, 200, "The full-profile credential must read diagnostics.");
    assert.strictEqual(fullDiagnostics.body.ok, true, "The diagnostics read must resolve ok.");
    assert(Array.isArray(fullDiagnostics.body.workloads), "The diagnostics payload must carry a workloads array.");
    assert(["known-succeeded", "known-failed", "unknown"].includes(fullDiagnostics.body.provisioning.state), `The provisioning state must use the explicit vocabulary (${fullDiagnostics.body.provisioning.state}).`);
    assert.strictEqual(fullDiagnostics.body.provisioning.state, "unknown", "A route recorded by a build that writes no proxy configuration must report unknown provisioning.");
    assert.notStrictEqual(fullDiagnostics.body.provisioning.state, "known-succeeded", "The diagnostics read must never imply provisioning succeeded.");
    assert.strictEqual(fullDiagnostics.body.residualBillableResources.count, null, "Residual resources must be null, never zero, without a detector.");
    assert.notStrictEqual(fullDiagnostics.body.residualBillableResources.count, 0, "Residual resources must never default to zero.");
    const httpWorkload = fullDiagnostics.body.workloads.find((workload) => workload.hostname === "smoke.example.com");
    assert(httpWorkload, "The applied route must appear in the diagnostics snapshot.");
    assert.strictEqual(httpWorkload.provisioning.state, "unknown", "An applied route must report unknown provisioning.");
    assert.notStrictEqual(httpWorkload.provisioning.state, "known-succeeded", "An applied route must never report succeeded.");
    assert.strictEqual(httpWorkload.mechanism, "http-routing", "A web route must classify to HTTP routing in the snapshot.");

    // --- New endpoint: exposure requirements (additive). ---
    const unauthRequirements = await probe(urlFull, "POST", requirementsPath, null, { protocol: "http" });
    assert.strictEqual(unauthRequirements.status, 401, "The requirements endpoint must sit behind the 401 bearer gate.");
    const restrictedRequirements = await probe(urlRestricted, "POST", requirementsPath, tokenRestricted, { protocol: "http" });
    assert.strictEqual(restrictedRequirements.status, 403, "A restricted-profile actor must be refused 403 on requirements.");

    const httpClass = await probe(urlFull, "POST", requirementsPath, tokenFull, { protocol: "http", providerId: "cloudflare-tunnel" });
    assert.strictEqual(httpClass.status, 200, "A satisfiable requirement must return 200.");
    assert.strictEqual(httpClass.body.outcome, "satisfiable", "An http requirement must be satisfiable.");
    assert.strictEqual(httpClass.body.mechanism, "http-routing", "An http requirement must route to HTTP routing.");
    assert.strictEqual(httpClass.body.provisionable, true, "A satisfiable requirement must be marked provisionable.");
    assert(httpClass.body.providerLimits, "A provider requirement must carry the declared limits.");

    const udpClass = await probe(urlFull, "POST", requirementsPath, tokenFull, { protocol: "udp" });
    assert.strictEqual(udpClass.status, 200, "A plain udp requirement must return 200.");
    assert.strictEqual(udpClass.body.mechanism, "raw-port-exposure", "A udp requirement must route to raw port exposure.");
    assert.notStrictEqual(udpClass.body.mechanism, httpClass.body.mechanism, "HTTP and UDP requirements must route to different mechanisms.");

    const udpRefusal = await probe(urlFull, "POST", requirementsPath, tokenFull, { protocol: "udp", mechanism: "http-routing" });
    assert.strictEqual(udpRefusal.status, 400, "HTTP routing for a UDP workload must be refused.");
    assert.strictEqual(udpRefusal.code, "EXPOSURE_MECHANISM_UNSATISFIED", "The refusal must carry the typed code.");
    assert.strictEqual(udpRefusal.body.error.details.protocol, "udp", "The refusal details must name the protocol.");

    const cloudflareUdpOverHttp = await probe(urlFull, "POST", requirementsPath, tokenFull, { protocol: "udp", providerId: "cloudflare-tunnel" });
    assert.strictEqual(cloudflareUdpOverHttp.status, 400, "Cloudflare Tunnel UDP exposure must be refused.");
    assert.strictEqual(cloudflareUdpOverHttp.code, "EXPOSURE_PROVIDER_PROTOCOL_UNSUPPORTED", "The provider refusal must be typed.");

    const relayUdpOverHttp = await probe(urlFull, "POST", requirementsPath, tokenFull, { protocol: "udp", providerId: "anxos-relay" });
    assert.strictEqual(relayUdpOverHttp.status, 200, "An unknown provider limit must be returned, not thrown.");
    assert.strictEqual(relayUdpOverHttp.body.outcome, "unknown", "An unavailable provider must report unknown.");
    assert.strictEqual(relayUdpOverHttp.body.satisfiable, null, "Unknown must not be reported as satisfiable.");
    assert.strictEqual(relayUdpOverHttp.body.provisionable, false, "An unknown requirement must not be marked provisionable.");
    assert.strictEqual(relayUdpOverHttp.body.provider.protocolLimit.state, "unknown", "The UDP limit must surface as unknown.");
    assert.notStrictEqual(relayUdpOverHttp.body.provider.protocolLimit.state, "supported", "The UDP limit must never surface as supported.");
  } finally {
    for (const agent of [fullAgent, restrictedAgent]) {
      agent.kill("SIGTERM");
    }
    await Promise.all([fullAgent, restrictedAgent].map((agent) => new Promise((resolve) => agent.once("exit", resolve))));
    await new Promise((resolve) => upstream.server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 7. Wiring assertions.
// ---------------------------------------------------------------------------
assert(policySource.includes("EXPOSURE_MECHANISM_UNSATISFIED"), "The policy must define the explicit mechanism refusal code.");
assert(policySource.includes("EXPOSURE_PROVIDER_PROTOCOL_UNSUPPORTED"), "The policy must define the explicit provider refusal code.");
assert(policySource.includes('state: "unknown"'), "The policy must be able to answer unknown rather than guessing.");
assert(!/require\(["'](?:fs|net|child_process|http|https)["']\)/.test(policySource), "The exposure requirements policy must stay pure (no fs/net/child_process).");

assert(serviceSource.includes("getExposureDiagnosticsSnapshot"), "The reverse-proxy service must expose the diagnostics snapshot.");
assert(serviceSource.includes("known-succeeded") && serviceSource.includes("known-failed"), "The service must use the explicit provisioning vocabulary.");
assert(serviceSource.includes("RESIDUAL_UNDETECTABLE_NOTE"), "The service must name the undetectable-residual rule.");
assert(agentRouteSource.includes("/api/v1/public-access/reverse-proxy/diagnostics"), "The Agent route must serve the diagnostics path.");
assert(agentRouteSource.includes("/api/v1/public-access/reverse-proxy/requirements"), "The Agent route must serve the requirements path.");
assert(agentRouteSource.includes("getExposureDiagnosticsSnapshot") && agentRouteSource.includes("classifyExposureRequirements"), "The Agent route must delegate to the new surfaces.");
assert(serverSource.includes('pathname.startsWith("/api/v1/public-access/reverse-proxy/")'), "The Agent dispatcher must forward the reverse-proxy sub-paths.");
assert.strictEqual(typeof agentRoute._test.getExposureDiagnosticsSnapshot, "function", "The route must expose the diagnostics handler for tests.");
assert.strictEqual(typeof agentRoute._test.classifyExposureRequirements, "function", "The route must expose the requirements handler for tests.");

(async () => {
  await assertDiagnosticsSlice();
  await assertAgentHttpSlice();
  console.log("exposure-requirements-smoke passed");
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  process.exit(1);
});