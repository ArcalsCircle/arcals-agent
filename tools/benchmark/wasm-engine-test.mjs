// End-to-end check of the browser engine under Node: it must find nonces the
// native worker agrees with, at the production Target, and cancel cleanly.
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { RandomXWorkerClient } from "@arcals/randomx-tools";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/randomx-wasm",
);
const { ArcalsBrowserEngine, ALGORITHM_ID, PARAMETER_DIGEST } = await import(
  join(root, "dist/engine.mjs")
);

/** A Web Worker look-alike backed by worker_threads. */
function nodeWorker() {
  const worker = new Worker(join(root, "test/node-worker-bootstrap.mjs"), {
    workerData: {
      workerUrl: pathToFileURL(join(root, "dist/engine-worker.mjs")).href,
    },
  });
  const facade = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => worker.postMessage(m),
    terminate: () => worker.terminate(),
  };
  worker.on("message", (data) => facade.onmessage?.({ data }));
  worker.on("error", (error) => facade.onerror?.({ message: error.message }));
  return facade;
}

const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const epochKey =
  "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de";
// Epoch 3 production Target: 320 expected hashes.
const target =
  "361850278866613110698659328152149712041468702080126762623304950024728530123";
const workers = Number(process.argv[2] ?? 4);
const rounds = Number(process.argv[3] ?? 5);
const engine = new ArcalsBrowserEngine({ workers, createWorker: nodeWorker });
const native = new RandomXWorkerClient(
  join(root, "../randomx-worker/build/arcals-randomx-worker"),
);
await native.request(
  {
    protocolVersion: 1,
    jobId: randomUUID(),
    command: "prepare",
    algorithmId: ALGORITHM_ID,
    epochKey,
    parameterDigest: PARAMETER_DIGEST,
    mode: "fast",
    jit: true,
    hardwareAes: true,
    largePages: false,
    secure: true,
    initThreads: 8,
  },
  ["ready"],
  600000,
);

let failures = 0;
let totalMs = 0;
let totalHashes = 0;
const prepareStarted = performance.now();
for (let round = 0; round < rounds; round += 1) {
  const challengeInput = hex(randomBytes(32));
  const started = performance.now();
  const solution = await engine.solve({
    challengeInput,
    epochKey,
    target,
    expiresAt: String(Math.floor(Date.now() / 1000) + 900),
    algorithmId: ALGORITHM_ID,
    parameterDigest: PARAMETER_DIGEST,
  });
  const ms = performance.now() - started;
  if (round === 0)
    console.log(
      `first solve includes cache preparation: ${Math.round(performance.now() - prepareStarted)} ms`,
    );
  const nonce = BigInt(solution.workNonce);
  const input = Buffer.alloc(40);
  Buffer.from(challengeInput.slice(2), "hex").copy(input);
  input.writeBigUInt64LE(nonce, 32);
  const nativeHash = (
    await native.request(
      {
        protocolVersion: 1,
        jobId: randomUUID(),
        command: "hash",
        inputHex: hex(input),
        mode: "fast",
        jit: true,
        hardwareAes: true,
        largePages: false,
        secure: true,
      },
      ["hash"],
      60000,
    )
  ).data.hash;
  const agrees =
    nativeHash === solution.randomxHash && BigInt(nativeHash) <= BigInt(target);
  if (!agrees) failures += 1;
  if (round > 0) {
    totalMs += ms;
    totalHashes += Number(solution.hashesTried);
  }
  console.log(
    `round ${round}: nonce ${solution.workNonce} after ${solution.hashesTried} hashes in ${(ms / 1000).toFixed(1)} s — native ${agrees ? "AGREES" : "DISAGREES"}`,
  );
}
console.log(
  `aggregate after warm-up: ${(totalHashes / (totalMs / 1000)).toFixed(2)} H/s with ${workers} workers`,
);

// Cancellation: an impossible Target, aborted after 3 s, then the engine is reused.
const controller = new AbortController();
setTimeout(() => controller.abort(), 3000);
const cancelStarted = performance.now();
let cancelled = false;
try {
  await engine.solve(
    {
      challengeInput: hex(randomBytes(32)),
      epochKey,
      target: "1",
      expiresAt: String(Math.floor(Date.now() / 1000) + 900),
      algorithmId: ALGORITHM_ID,
      parameterDigest: PARAMETER_DIGEST,
    },
    { signal: controller.signal },
  );
} catch (error) {
  cancelled = error.name === "AbortError";
}
console.log(
  `cancel: ${cancelled ? "AbortError" : "NOT CANCELLED"} after ${((performance.now() - cancelStarted) / 1000).toFixed(1)} s`,
);
const reuse = await engine.solve({
  challengeInput: hex(randomBytes(32)),
  epochKey,
  target,
  expiresAt: String(Math.floor(Date.now() / 1000) + 900),
  algorithmId: ALGORITHM_ID,
  parameterDigest: PARAMETER_DIGEST,
});
console.log(`reuse after cancel: nonce ${reuse.workNonce}`);

// Parameters from another build are refused.
let refused = false;
try {
  await engine.solve({
    challengeInput: hex(randomBytes(32)),
    epochKey,
    target,
    expiresAt: String(Math.floor(Date.now() / 1000) + 900),
    algorithmId: ALGORITHM_ID,
    parameterDigest: `0x${"33".repeat(32)}`,
  });
} catch {
  refused = true;
}
console.log(`foreign parameters: ${refused ? "refused" : "ACCEPTED"}`);

engine.dispose();
await native.close();
const ok = failures === 0 && cancelled && refused;
console.log(ok ? "ENGINE TEST PASSED" : "ENGINE TEST FAILED");
process.exit(ok ? 0 : 1);
