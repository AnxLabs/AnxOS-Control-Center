"use strict";

// Phase X: optional model providers.
//
// "deterministic" needs no model: it is always available and is what the
// assistant falls back to. "ollama" talks to an Ollama server the user runs;
// only a loopback address is allowed unless the user turned on remote
// processing, and Ollama "cloud" model tags count as remote because they run
// on ollama.com. "sona" is declared but unavailable: Sona has no documented
// service-to-service contract for Control Center yet, so nothing is sent to it.
//
// The model never receives credentials or tool access. It returns JSON that
// the assistant validates; see assistant.js.

const PROVIDERS = Object.freeze(["deterministic", "ollama", "sona"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const SONA_UNAVAILABLE = "Sona has no supported Control Center integration contract yet (only its health route is verified). It needs an owner-approved contract and credentials before Control Center can use it.";

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

// An address of one of this PC's own network interfaces (for example Ollama
// bound to a LAN or tailnet address of this PC). Requests to it never leave
// the machine, so it counts as this PC, like loopback.
function isThisPcAddress(hostname, interfaces = require("os").networkInterfaces()) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHost(host)) return true;
  return Object.values(interfaces || {}).flat().some((entry) => entry && String(entry.address || "").toLowerCase() === host);
}

function isCloudModel(model) {
  return /(^|[:\-_.])cloud($|[:\-_.])/i.test(String(model || ""));
}

// Validates the configured endpoint and model against the privacy settings.
function checkOllamaConfig({ baseUrl, model, allowRemoteProvider = false, interfaces } = {}) {
  let url;
  try { url = new URL(String(baseUrl || "")); } catch { throw providerError("AI_PROVIDER_URL_INVALID", "The Ollama address is not a valid URL."); }
  if (!/^https?:$/.test(url.protocol)) throw providerError("AI_PROVIDER_URL_INVALID", "The Ollama address must start with http:// or https://.");
  if (url.username || url.password) throw providerError("AI_PROVIDER_URL_INVALID", "Do not put a user name or password in the Ollama address.");
  const remote = !isThisPcAddress(url.hostname, interfaces);
  if (remote && !allowRemoteProvider) throw providerError("AI_PROVIDER_REMOTE_NOT_ALLOWED", "This Ollama address is on another computer. Turn on \"Allow processing on another computer\" first, so you decide what leaves this PC.");
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw providerError("AI_PROVIDER_MODEL_INVALID", "Choose a model.");
  if (isCloudModel(model) && !allowRemoteProvider) throw providerError("AI_PROVIDER_REMOTE_NOT_ALLOWED", "This is an Ollama cloud model, which runs on ollama.com, not on your computer. Choose a local model, or allow processing elsewhere.");
  return { origin: url.origin, remote: remote || isCloudModel(model), hostKind: remote ? "another computer" : "this PC", model };
}

async function readBoundedJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw providerError("AI_PROVIDER_RESPONSE_TOO_LARGE", "The model's reply was too large and was discarded.");
  try { return JSON.parse(text); } catch { throw providerError("AI_PROVIDER_RESPONSE_INVALID", "The model server returned something that is not JSON."); }
}

async function timedFetch(fetchImpl, url, options, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw providerError("AI_PROVIDER_HTTP", `The model server answered ${response.status}.`);
    return await readBoundedJson(response);
  } catch (error) {
    if (error?.name === "AbortError") throw providerError(outerSignal?.aborted ? "AI_CANCELLED" : "AI_PROVIDER_TIMEOUT", outerSignal?.aborted ? "Cancelled." : "The model took too long and was stopped.");
    if (error?.code) throw error;
    throw providerError("AI_PROVIDER_UNREACHABLE", "The model server could not be reached.");
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener?.("abort", onAbort);
  }
}

function createOllamaProvider({ baseUrl, model, allowRemoteProvider = false, maxContextTokens = 4096, maxOutputTokens = 512, requestTimeoutMs = 60000, keepModelLoaded = false, fetchImpl = globalThis.fetch } = {}) {
  const config = checkOllamaConfig({ baseUrl, model, allowRemoteProvider });
  let busy = false;

  async function health({ timeoutMs = 8000 } = {}) {
    try {
      const version = await timedFetch(fetchImpl, `${config.origin}/api/version`, { method: "GET" }, timeoutMs);
      const tags = await timedFetch(fetchImpl, `${config.origin}/api/tags`, { method: "GET" }, timeoutMs);
      const models = Array.isArray(tags?.models) ? tags.models.map((entry) => String(entry?.name || entry?.model || "")).filter(Boolean).slice(0, 100) : [];
      const modelPresent = models.some((name) => name === config.model || name === `${config.model}:latest` || name.replace(/:latest$/, "") === config.model);
      return {
        provider: "ollama",
        available: modelPresent,
        version: typeof version?.version === "string" ? version.version.slice(0, 40) : null,
        models: models.filter((name) => allowRemoteProvider || !isCloudModel(name)),
        model: config.model,
        modelPresent,
        host: config.hostKind,
        remote: config.remote,
        reason: modelPresent ? null : `Ollama is running but the model "${config.model}" is not installed.`,
      };
    } catch (error) {
      return { provider: "ollama", available: false, model: config.model, host: config.hostKind, remote: config.remote, reason: error.code === "AI_PROVIDER_UNREACHABLE" || error.code === "AI_PROVIDER_TIMEOUT" ? "Ollama is not running at that address." : error.message };
    }
  }

  // messages: [{ role: "system"|"user", content }]. Returns parsed JSON from
  // the model (format: "json"), or throws a coded error.
  async function completeJson({ messages, signal } = {}) {
    if (busy) throw providerError("AI_PROVIDER_BUSY", "The model is still answering the previous question.");
    busy = true;
    try {
      const body = {
        model: config.model,
        messages,
        stream: false,
        format: "json",
        keep_alive: keepModelLoaded ? "30m" : "60s",
        options: { temperature: 0, num_ctx: Math.max(1024, Math.min(32768, Number(maxContextTokens) || 4096)), num_predict: Math.max(64, Math.min(4096, Number(maxOutputTokens) || 512)) },
      };
      const reply = await timedFetch(fetchImpl, `${config.origin}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, requestTimeoutMs, signal);
      const content = String(reply?.message?.content || "");
      try {
        return { json: JSON.parse(content), model: config.model, durationMs: Number(reply?.total_duration) ? Math.round(reply.total_duration / 1e6) : null };
      } catch {
        throw providerError("AI_PROVIDER_RESPONSE_INVALID", "The model did not answer in the required format.");
      }
    } finally {
      busy = false;
    }
  }

  return { id: "ollama", config, health, completeJson };
}

function createSonaProvider() {
  return {
    id: "sona",
    async health() { return { provider: "sona", available: false, reason: SONA_UNAVAILABLE }; },
    async completeJson() { throw providerError("AI_PROVIDER_UNAVAILABLE", SONA_UNAVAILABLE); },
  };
}

function createDeterministicProvider() {
  return {
    id: "deterministic",
    async health() { return { provider: "deterministic", available: true, reason: null, host: "this PC", remote: false }; },
    completeJson: null,
  };
}

// settings: the ai.* preferences.
function createProvider(settings = {}, { fetchImpl } = {}) {
  const id = PROVIDERS.includes(settings["ai.provider"]) ? settings["ai.provider"] : "deterministic";
  if (id === "ollama") {
    return createOllamaProvider({
      baseUrl: settings["ai.ollamaUrl"],
      model: settings["ai.ollamaModel"],
      allowRemoteProvider: settings["ai.allowRemoteProvider"] === true,
      maxContextTokens: settings["ai.maxContextTokens"],
      maxOutputTokens: settings["ai.maxOutputTokens"],
      requestTimeoutMs: settings["ai.requestTimeoutMs"],
      keepModelLoaded: settings["ai.keepModelLoaded"] === true,
      fetchImpl,
    });
  }
  if (id === "sona") return createSonaProvider();
  return createDeterministicProvider();
}

module.exports = {
  PROVIDERS,
  SONA_UNAVAILABLE,
  checkOllamaConfig,
  createDeterministicProvider,
  createOllamaProvider,
  createProvider,
  createSonaProvider,
  isCloudModel,
  isLoopbackHost,
  isThisPcAddress,
};
