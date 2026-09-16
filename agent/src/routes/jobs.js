// V2-A Agent jobs REST surface (docs/v2/V2A_JOB_LIFECYCLE.md §4.2).
//
// Job records are owned agent-side so a desktop client restart can never orphan
// an in-flight operation: the Agent continues running the job, the durable
// record survives, and a reconnecting client re-observes job state here.
//
// NOTE (integration): this module is registered and live in
// `agent/src/server.js` — imported at the top, dispatched from `routeRequest`
// for `/api/v1/jobs`, and permission-mapped in `getRoutePermission`
// (`instance:lifecycle` for /cancel, `instance:read` otherwise). Keep that
// permission mapping in sync when adding endpoints here.

const instanceService = require("../services/instances/instanceService");

function parseJsonBody(request) {
  if (!request.body) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function result(statusCode, body) {
  return {
    statusCode,
    body,
  };
}

function errorResult(error) {
  return result(error.statusCode || 500, {
    error: {
      code: error.code || "JOB_REQUEST_FAILED",
      message: error.message && error.message !== error.code ? error.message : "Request failed.",
      details: error.details || undefined,
    },
  });
}

function getJobIdFromPath(pathname, suffix = "") {
  const prefix = "/api/v1/jobs/";

  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const raw = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const id = decodeURIComponent(raw.replace(/\/$/, ""));
  return id && !id.includes("/") ? id : null;
}

async function handleJobs(request, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/jobs") {
      return result(200, await instanceService.listInstanceJobs({
        limit: url.searchParams.get("limit"),
        type: url.searchParams.get("type") || undefined,
        instanceId: url.searchParams.get("instanceId") || undefined,
      }));
    }

    if (request.method === "GET") {
      const jobId = getJobIdFromPath(url.pathname);
      if (jobId) {
        const job = await instanceService.getInstanceJob(jobId);
        if (!job) {
          return result(404, {
            error: {
              code: "JOB_NOT_FOUND",
              message: "The requested job does not exist on this node.",
            },
          });
        }
        return result(200, { job });
      }
    }

    if (request.method === "POST") {
      const cancelJobId = getJobIdFromPath(url.pathname, "/cancel");
      if (cancelJobId) {
        const body = parseJsonBody(request);
        const outcome = await instanceService.cancelInstanceJob(cancelJobId, {
          reason: body?.reason,
        });
        if (!outcome) {
          return result(404, {
            error: {
              code: "JOB_NOT_FOUND",
              message: "The requested job does not exist on this node.",
            },
          });
        }
        // Idempotent: a cancel of an already-terminal job returns the existing
        // record with alreadyTerminal: true and no new side effect.
        return result(200, outcome);
      }
    }

    return result(404, {
      error: {
        code: "NOT_FOUND",
        message: "Request failed.",
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}

module.exports = {
  handleJobs,
};
