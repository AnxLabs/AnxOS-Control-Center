"use strict";

// /api/v1/anxnet/* on the Agent (Phase 7.1). Reads are public-access:read,
// changes public-access:write (getRoutePermission in server.js), the same
// tiers as Playit and Public Access sharing.

const anxnet = require("../services/anxnetAgentService");
const instanceService = require("../services/instances/instanceService");

function parseBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  const text = typeof request.body === "string" ? request.body.trim() : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON payload."), { code: "INVALID_JSON", statusCode: 400 });
  }
}

async function loadInstance(instanceId) {
  const listing = await instanceService.listInstances();
  const instance = (listing?.instances || []).find((entry) => entry.id === instanceId);
  if (!instance) throw Object.assign(new Error("That server doesn't exist on this computer."), { code: "INSTANCE_NOT_FOUND", statusCode: 404 });
  return instance;
}

function errorResponse(error) {
  return {
    statusCode: Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 600 ? Number(error.statusCode) : 500,
    body: { error: { code: error?.code || "ANXNET_REQUEST_FAILED", message: error?.message || "The AnxNet request failed." } },
  };
}

async function handleAnxNet(request, url) {
  try {
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/v1/anxnet/status") return { statusCode: 200, body: await anxnet.getStatus() };
    if (request.method !== "POST") return { statusCode: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Request failed." } } };
    const body = parseBody(request);
    if (pathname === "/api/v1/anxnet/join") return { statusCode: 200, body: await anxnet.join({ code: body.code, deviceName: body.deviceName }) };
    if (pathname === "/api/v1/anxnet/leave") return { statusCode: 200, body: await anxnet.leave() };
    if (pathname === "/api/v1/anxnet/share") return { statusCode: 200, body: await anxnet.share({ instanceId: body.instanceId, port: body.port, protocol: body.protocol, name: body.name, allow: body.allow }, { loadInstance }) };
    if (pathname === "/api/v1/anxnet/unshare") return { statusCode: 200, body: await anxnet.unshare({ serviceId: body.serviceId }) };
    return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  } catch (error) {
    return errorResponse(error);
  }
}

module.exports = { handleAnxNet };
