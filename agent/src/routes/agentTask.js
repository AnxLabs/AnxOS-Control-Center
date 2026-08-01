const { inspectTask, repairTask, uninstallTask } = require("../services/windowsAgentTaskService");

async function handleAgentTask(request) {
  if (request.method === "GET") return { statusCode: 200, body: await inspectTask() };
  if (request.method === "POST") return { statusCode: 200, body: await repairTask() };
  if (request.method === "DELETE") return { statusCode: 200, body: await uninstallTask() };
  return { statusCode: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Request failed." } } };
}

module.exports = { handleAgentTask };
