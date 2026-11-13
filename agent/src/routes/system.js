const { getSystemSummary, runNetworkCheck } = require("../services/systemService");

async function handleSystemSummary() {
  return {
    statusCode: 200,
    body: await getSystemSummary(),
  };
}

async function handleStats() {
  return handleSystemSummary();
}

async function handleNetworkCheck() {
  return {
    statusCode: 200,
    body: await runNetworkCheck(),
  };
}

module.exports = {
  handleNetworkCheck,
  handleStats,
  handleSystemSummary,
};
