"use strict";

// TEST-ONLY. Loaded with `node --require` into a real Agent process to give it
// the environment systemd gives a unit's main process: INVOCATION_ID and
// SYSTEMD_EXEC_PID naming this very process. Nothing else is changed.
process.env.INVOCATION_ID = process.env.INVOCATION_ID || "anxos-test-invocation";
process.env.SYSTEMD_EXEC_PID = String(process.pid);
