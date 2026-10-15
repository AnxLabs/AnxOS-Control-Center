"use strict";

// Manual / Port Forwarding provider adapter. There is nothing to detect on the
// machine: reachability depends on operator-managed router and DNS
// configuration that AnxOS cannot observe, so the provider stays in
// "setup-required" and only reports whether the operator has recorded manual
// endpoints. Pure data mapping, no probing of any kind.

const { normalizeProviderState } = require("../providerAdapterContract");

const MANUAL_PROVIDER_CAPABILITIES = Object.freeze({
  detect: false,
  status: true,
  listTunnels: false,
  controlAgent: false,
  publicAddress: false,
  localTarget: false,
  region: false,
  endpointDiscovery: false,
  createTunnel: false,
  deleteTunnel: false,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createManualProviderAdapter() {
  return {
    id: "manual",
    displayName: "Manual / Port Forwarding",
    capabilities: MANUAL_PROVIDER_CAPABILITIES,
    status(context = {}) {
      const input = isPlainObject(context) ? context : {};
      return normalizeProviderState({
        providerId: "manual",
        displayName: "Manual / Port Forwarding",
        availability: input.hasManualEndpoints === true ? "available" : "unknown",
        state: "setup-required",
        diagnostics: [{
          code: "MANUAL_PROVIDER_ADVISORY",
          message: "Public reachability depends on operator-managed router/DNS configuration and is not verified by AnxOS.",
        }],
      });
    },
    listTunnels() {
      return [];
    },
    normalizeState: normalizeProviderState,
  };
}

module.exports = {
  MANUAL_PROVIDER_CAPABILITIES,
  createManualProviderAdapter,
};
