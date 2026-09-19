// SMOOTH-3010 regression guard: the instance-snapshot reuse window.
//
// WHY THIS SUITE EXISTS
// `src/services/alertService.js` publishes the instance payload the renderer
// already received (`publishInstanceSnapshot`) and lets an alert evaluation
// pass reuse it while it is fresh and for the SAME node, instead of issuing its
// own agent round trip (`resolveInstanceSnapshot`). That reuse is load-bearing:
// it is what removes the duplicated `serviceRouter.listInstances({})` call that
// measured `implicit-node-fallback-selected` at 3x/min. Before this suite, no
// automated check loaded the module, so mutating
// `INSTANCE_SNAPSHOT_MAX_AGE_MS` (e.g. 20000 -> -1, making the window never
// fresh) left every candidate smoke green. This suite pinning the reuse path is
// the guard that closes that hole.
//
// WHAT IT PINS (each check is named; a failure names the invariant)
//   1. REUSE        fresh snapshot + same node  -> fetcher NOT called
//   2. KEYING       snapshot for a different node -> fetcher IS called
//   3. EXPIRY       snapshot past the window     -> fetcher IS called
//   4. HOSTILE      malformed published payload  -> ignored, fetcher called
//   5. NULL-KEY     null and undefined node ids resolve to the same key
//   6. CONSTANT     the documented 20 s window is exported and is the value the
//                   module's expiry comparison actually uses
//   7. RESET        resetInstanceSnapshot() drops the window
//
// Hermetic: no Electron, no network, no real config dir. The module is required
// directly — `alertService.js` requires only `fs`/`path` at load time (its
// `require("electron")` is lazy and try/catch-wrapped inside
// resolveConfigDirectory), and the alert store is never touched because
// resolveConfigDirectory() short-circuits on ANXHUB_CONFIG_DIR, which
// pinAgentRoots pins into a temp tree before any src module loads.
const assert = require("assert");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

// Must run before the src module loads so no runtime root can leak into the
// real machine (same idiom as scripts/alert-engine-smoke.js).
pinAgentRoots("anx-instance-snapshot-reuse-");

const alertService = require("../src/services/alertService");

const {
  INSTANCE_SNAPSHOT_MAX_AGE_MS,
  getInstanceSnapshot,
  publishInstanceSnapshot,
  resetInstanceSnapshot,
  resolveInstanceSnapshot,
} = alertService;

// ---------------------------------------------------------------------------
// Deterministic clock. getInstanceSnapshot/resolveInstanceSnapshot call
// Date.now() at call time (they do not capture it), so substituting the global
// lets the real default-window arithmetic be exercised without sleeping.
// ---------------------------------------------------------------------------
const realDateNow = Date.now;
let fakeNow = Date.parse("2026-01-01T12:00:00.000Z");

function installClock() {
  Date.now = () => fakeNow;
}

function restoreClock() {
  Date.now = realDateNow;
}

// The payload the renderer's `instances:list` reply carries (main.js publishes
// that reply verbatim), and a distinct payload returned by a fetcher.
function rendererPayload(instances) {
  return { instances, nodes: [], backups: [] };
}

function makeFetcher(value) {
  const fetcher = async () => {
    fetcher.calls += 1;
    return value;
  };
  fetcher.calls = 0;
  return fetcher;
}

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error && error.message ? error.message : error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. REUSE — the invariant the mutation killed.
// ---------------------------------------------------------------------------
async function checkReuse() {
  await check(
    "1. REUSE: a fresh same-node snapshot is reused, so the fetcher is NOT called",
    async () => {
      resetInstanceSnapshot();
      installClock();
      const published = rendererPayload([{ id: "inst-1", nodeId: "node-a" }]);
      publishInstanceSnapshot("node-a", published);

      // 1 s later: comfortably inside the 20 s window.
      fakeNow += 1000;

      const fetcher = makeFetcher(rendererPayload([{ id: "inst-fetched", nodeId: "node-a" }]));
      const resolved = await resolveInstanceSnapshot("node-a", fetcher);

      assert.strictEqual(
        fetcher.calls,
        0,
        `reuse invariant violated: a fresh snapshot for the SAME node must be reused, so the fetcher must NOT be called (fetcher was called ${fetcher.calls} time(s)). A never-fresh window (INSTANCE_SNAPSHOT_MAX_AGE_MS <= 0) breaks this.`,
      );
      assert.strictEqual(
        resolved,
        published,
        "reuse invariant violated: the reused value must be the published payload itself, not a re-fetched replacement.",
      );
      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        published,
        "reuse invariant violated: getInstanceSnapshot must return the fresh same-node payload.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 2. PER-NODE KEYING — not a global cache.
// ---------------------------------------------------------------------------
async function checkPerNodeKeying() {
  await check(
    "2. KEYING: a snapshot for a different node does not satisfy the caller (fetcher IS called)",
    async () => {
      resetInstanceSnapshot();
      installClock();
      const forA = rendererPayload([{ id: "inst-a", nodeId: "node-a" }]);
      const forB = rendererPayload([{ id: "inst-b", nodeId: "node-b" }]);
      publishInstanceSnapshot("node-a", forA);
      fakeNow += 1000;

      assert.strictEqual(
        getInstanceSnapshot("node-b"),
        null,
        "per-node keying violated: a snapshot published for node-a must not be returned for node-b.",
      );

      const fetcher = makeFetcher(forB);
      const resolved = await resolveInstanceSnapshot("node-b", fetcher);

      assert.strictEqual(
        fetcher.calls,
        1,
        `per-node keying violated: a snapshot for a different node must not be reused, so the fetcher must be called exactly once (was called ${fetcher.calls} time(s)).`,
      );
      assert.strictEqual(
        resolved,
        forB,
        "per-node keying violated: the caller must receive the fetcher's value, not node-a's snapshot.",
      );

      // A miss for node-b must not evict node-a's still-fresh snapshot.
      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        forA,
        "per-node keying violated: resolving a miss for another node must not evict the fresh snapshot.",
      );
      assert.strictEqual(
        (await resolveInstanceSnapshot("node-a", makeFetcher(null))),
        forA,
        "per-node keying violated: node-a's fresh snapshot must still be reusable after a node-b miss.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 3. EXPIRY — the window is bounded; past it the caller fetches.
// ---------------------------------------------------------------------------
async function checkExpiry() {
  await check(
    "3. EXPIRY: a snapshot older than the window is not reused (fetcher IS called)",
    async () => {
      resetInstanceSnapshot();
      installClock();
      const published = rendererPayload([{ id: "inst-1", nodeId: "node-a" }]);
      const t0 = fakeNow;
      publishInstanceSnapshot("node-a", published);

      // Boundary: the comparison is `Date.now() - at > maxAge`, so exactly at
      // the window edge the snapshot is still fresh.
      fakeNow = t0 + INSTANCE_SNAPSHOT_MAX_AGE_MS;
      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        published,
        "expiry boundary violated: a snapshot exactly `INSTANCE_SNAPSHOT_MAX_AGE_MS` old is still fresh (the comparison is strict `>`).",
      );

      // One millisecond past the window: expired, so the caller must fetch.
      fakeNow = t0 + INSTANCE_SNAPSHOT_MAX_AGE_MS + 1;
      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        null,
        "expiry violated: a snapshot older than the window must not be returned.",
      );

      const fetcher = makeFetcher(rendererPayload([{ id: "inst-fresh", nodeId: "node-a" }]));
      const resolved = await resolveInstanceSnapshot("node-a", fetcher);

      assert.strictEqual(
        fetcher.calls,
        1,
        `expiry violated: an expired snapshot must not be reused, so the fetcher must be called exactly once (was called ${fetcher.calls} time(s)).`,
      );
      assert.notStrictEqual(
        resolved,
        published,
        "expiry violated: once expired the caller must receive the fetcher's value, not the stale payload.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 4. HOSTILE PAYLOADS — malformed publishes are ignored, never fatal.
// ---------------------------------------------------------------------------
async function checkMalformedPayloads() {
  await check(
    "4. HOSTILE: malformed published payloads are ignored (no snapshot, fetcher called, no throw)",
    async () => {
      const malformed = [
        ["null", null],
        ["undefined", undefined],
        ["false", false],
        ["empty object", {}],
        ["instances: null", { instances: null }],
        ["instances: 'nope'", { instances: "nope" }],
        ["instances: 7", { instances: 7 }],
        ["instances: {} (non-array object)", { instances: {} }],
        ["bare array", []],
        ["string", "instances"],
        ["number", 42],
      ];

      for (const [label, payload] of malformed) {
        resetInstanceSnapshot();
        installClock();

        assert.doesNotThrow(
          () => publishInstanceSnapshot("node-a", payload),
          `hostile payload (${label}) must not throw from publishInstanceSnapshot.`,
        );
        assert.strictEqual(
          getInstanceSnapshot("node-a"),
          null,
          `hostile payload (${label}) must not establish a snapshot.`,
        );

        const fetcher = makeFetcher(rendererPayload([]));
        const resolved = await resolveInstanceSnapshot("node-a", fetcher);
        assert.strictEqual(
          fetcher.calls,
          1,
          `hostile payload (${label}) must fall back to a real fetch (fetcher calls: ${fetcher.calls}).`,
        );
        assert.deepStrictEqual(
          resolved,
          { instances: [], nodes: [], backups: [] },
          `hostile payload (${label}) must resolve to the fetcher's value.`,
        );
      }
    },
  );

  await check(
    "4b. HOSTILE: an empty `instances` array IS a valid payload (accepted by the guard)",
    async () => {
      resetInstanceSnapshot();
      installClock();
      const empty = rendererPayload([]);
      publishInstanceSnapshot("node-a", empty);
      fakeNow += 1000;

      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        empty,
        "an empty `instances` array satisfies the shape guard (Array.isArray), so it must be published.",
      );

      const fetcher = makeFetcher(rendererPayload([]));
      assert.strictEqual(
        await resolveInstanceSnapshot("node-a", fetcher),
        empty,
        "a published empty `instances` payload must be reused while fresh (no fetch).",
      );
      assert.strictEqual(fetcher.calls, 0, "no fetch may occur for a fresh published empty payload.");
    },
  );

  await check(
    "4c. HOSTILE: a malformed publish does NOT clear an existing valid snapshot (pinned behaviour)",
    async () => {
      resetInstanceState();
      installClock();
      const valid = rendererPayload([{ id: "inst-1", nodeId: "node-a" }]);
      publishInstanceSnapshot("node-a", valid);

      publishInstanceSnapshot("node-a", null);
      publishInstanceSnapshot("node-a", {});
      publishInstanceSnapshot("node-b", { instances: "nope" });

      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        valid,
        "pinned: the shape guard returns early, so a malformed publish is ignored and does not clear the existing snapshot.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 5. NULL-KEY EQUIVALENCE — what the real code does, pinned.
// ---------------------------------------------------------------------------
async function checkNullKeyEquivalence() {
  await check(
    "5. NULL-KEY: null and undefined node ids resolve to the same key",
    async () => {
      // null published, undefined read (and vice versa).
      resetInstanceState();
      installClock();
      const payload = rendererPayload([{ id: "inst-null-key" }]);
      publishInstanceSnapshot(null, payload);
      fakeNow += 1000;

      assert.strictEqual(
        getInstanceSnapshot(null),
        payload,
        "null-key violated: a snapshot published under null must be returned for null.",
      );
      assert.strictEqual(
        getInstanceSnapshot(undefined),
        payload,
        "null-key violated: undefined and null must normalise to the same key (`nodeId || null`).",
      );

      const fetcher = makeFetcher(rendererPayload([]));
      assert.strictEqual(
        await resolveInstanceSnapshot(undefined, fetcher),
        payload,
        "null-key violated: resolveInstanceSnapshot(undefined) must reuse a snapshot published under null.",
      );
      assert.strictEqual(fetcher.calls, 0, "null-key violated: no fetch may occur for the equivalent null key.");

      // undefined published, null read.
      resetInstanceState();
      installClock();
      const payload2 = rendererPayload([{ id: "inst-undefined-key" }]);
      publishInstanceSnapshot(undefined, payload2);
      fakeNow += 1000;
      assert.strictEqual(
        getInstanceSnapshot(null),
        payload2,
        "null-key violated: a snapshot published under undefined must be returned for null.",
      );

      // A real node id is a DIFFERENT key from the null key.
      resetInstanceState();
      installClock();
      const payload3 = rendererPayload([{ id: "inst-node-a" }]);
      publishInstanceSnapshot("node-a", payload3);
      fakeNow += 1000;
      assert.strictEqual(
        getInstanceSnapshot(null),
        null,
        "null-key violated: a snapshot for a real node id must not be reused under the null key.",
      );
      assert.strictEqual(
        getInstanceSnapshot(undefined),
        null,
        "null-key violated: a snapshot for a real node id must not be reused under the undefined key.",
      );

      // Pinned extra: other falsy ids normalise into the same null key.
      resetInstanceState();
      installClock();
      const payload4 = rendererPayload([{ id: "inst-falsy-key" }]);
      publishInstanceSnapshot("", payload4);
      fakeNow += 1000;
      assert.strictEqual(
        getInstanceSnapshot(null),
        payload4,
        "pinned: an empty-string node id normalises to the same null key as null/undefined (`|| null`).",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 6. THE CONSTANT — exported, documented value, and the window expiry uses.
// ---------------------------------------------------------------------------
async function checkWindowConstant() {
  await check(
    "6. CONSTANT: INSTANCE_SNAPSHOT_MAX_AGE_MS is exported and is the documented 20000 ms",
    async () => {
      assert.strictEqual(
        typeof INSTANCE_SNAPSHOT_MAX_AGE_MS,
        "number",
        "INSTANCE_SNAPSHOT_MAX_AGE_MS must be exported as a number.",
      );
      assert.ok(
        Number.isFinite(INSTANCE_SNAPSHOT_MAX_AGE_MS),
        "INSTANCE_SNAPSHOT_MAX_AGE_MS must be finite.",
      );
      assert.strictEqual(
        INSTANCE_SNAPSHOT_MAX_AGE_MS,
        20000,
        `the documented reuse window must be exactly 20000 ms (20 s); got ${INSTANCE_SNAPSHOT_MAX_AGE_MS}. A silent change to this constant changes how long the renderer's payload may be reused, so it is pinned here.`,
      );
      assert.ok(
        INSTANCE_SNAPSHOT_MAX_AGE_MS > 0,
        "a reuse window <= 0 makes the snapshot never fresh, which disables reuse entirely (the mutation this suite guards against).",
      );
    },
  );

  await check(
    "6b. CONSTANT: the exported value is what the expiry comparison uses",
    async () => {
      resetInstanceState();
      installClock();
      const payload = rendererPayload([{ id: "inst-1", nodeId: "node-a" }]);
      const t0 = fakeNow;
      publishInstanceSnapshot("node-a", payload);

      // At the exported boundary the snapshot is still fresh...
      fakeNow = t0 + INSTANCE_SNAPSHOT_MAX_AGE_MS;
      assert.strictEqual(
        getInstanceSnapshot("node-a", INSTANCE_SNAPSHOT_MAX_AGE_MS),
        payload,
        "at exactly INSTANCE_SNAPSHOT_MAX_AGE_MS old the snapshot must still be usable.",
      );

      // ...one millisecond later it is not.
      fakeNow = t0 + INSTANCE_SNAPSHOT_MAX_AGE_MS + 1;
      assert.strictEqual(
        getInstanceSnapshot("node-a", INSTANCE_SNAPSHOT_MAX_AGE_MS),
        null,
        "at INSTANCE_SNAPSHOT_MAX_AGE_MS + 1 old the snapshot must be expired.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 7. RESET — the explicit clearing path.
// ---------------------------------------------------------------------------
async function checkReset() {
  await check(
    "7. RESET: resetInstanceSnapshot() drops the window so the caller fetches",
    async () => {
      resetInstanceState();
      installClock();
      publishInstanceSnapshot("node-a", rendererPayload([{ id: "inst-1", nodeId: "node-a" }]));
      fakeNow += 1000;
      assert.notStrictEqual(getInstanceSnapshot("node-a"), null, "precondition: a snapshot must be present.");

      resetInstanceSnapshot();

      assert.strictEqual(
        getInstanceSnapshot("node-a"),
        null,
        "resetInstanceSnapshot() must clear the published snapshot.",
      );
      const fetcher = makeFetcher(rendererPayload([]));
      const resolved = await resolveInstanceSnapshot("node-a", fetcher);
      assert.strictEqual(fetcher.calls, 1, "after a reset the caller must fetch.");
      assert.deepStrictEqual(resolved, { instances: [], nodes: [], backups: [] }, "the fetcher's value must be returned.");
    },
  );
}

// `resetInstanceSnapshot` plus a fresh clock baseline, so no check inherits
// another check's snapshot or fake time.
function resetInstanceState() {
  resetInstanceSnapshot();
  fakeNow = Date.parse("2026-01-01T12:00:00.000Z");
  installClock();
}

async function main() {
  installClock();
  console.log("instance-snapshot-reuse-smoke: SMOOTH-3010 reuse-window regression guard");

  try {
    await checkReuse();
    await checkPerNodeKeying();
    await checkExpiry();
    await checkMalformedPayloads();
    await checkNullKeyEquivalence();
    await checkWindowConstant();
    await checkReset();
  } finally {
    restoreClock();
  }

  console.log(`${results.length} checks passed`);
  console.log("instance-snapshot-reuse-smoke passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
