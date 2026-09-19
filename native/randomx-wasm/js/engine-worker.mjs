// Web Worker that runs the Arcals RandomX WebAssembly build.
//
// Messages in:
//   { type: "prepare", epochKey }                       key the 256 MiB cache
//   { type: "search", jobId, challengeInput, target,    search nonces
//     startNonce, stride }
//   { type: "cancel", jobId }                            stop that search
// Messages out:
//   { type: "ready", epochKey, elapsedMs }
//   { type: "progress", jobId, hashes }                  hashes since last report
//   { type: "solution", jobId, workNonce, randomxHash, hashes }
//   { type: "stopped", jobId, hashes }                   cancelled
//   { type: "error", jobId, message }

import createArcalsRandomX from "./arcals-randomx.mjs";

/** Hashes per call into WebAssembly; small enough to notice a cancel quickly. */
const BATCH = 2;

const modulePromise = createArcalsRandomX();
let preparedKey = null;
const cancelled = new Set();

function bytes(hex, length, label) {
  if (
    typeof hex !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(hex)
  ) {
    throw new Error(`${label} must be ${length} bytes of hex`);
  }
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return out;
}

function hexOf(view) {
  return `0x${Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function copyIn(rx, data) {
  const pointer = rx._malloc(data.length);
  rx.HEAPU8.set(data, pointer);
  return pointer;
}

async function prepare(epochKey) {
  const rx = await modulePromise;
  if (preparedKey === epochKey) return;
  const started = performance.now();
  const key = copyIn(rx, bytes(epochKey, 32, "epochKey"));
  try {
    const status = rx._arx_prepare(key);
    if (status !== 0)
      throw new Error(`RandomX cache preparation failed (${status})`);
  } finally {
    rx._free(key);
  }
  preparedKey = epochKey;
  self.postMessage({
    type: "ready",
    epochKey,
    elapsedMs: Math.round(performance.now() - started),
  });
}

async function search({ jobId, challengeInput, target, startNonce, stride }) {
  const rx = await modulePromise;
  if (preparedKey === null) throw new Error("search before prepare");
  const challenge = copyIn(rx, bytes(challengeInput, 32, "challengeInput"));
  const bound = copyIn(rx, bytes(target, 32, "target"));
  const result = rx._malloc(44);
  let nonce = BigInt(startNonce);
  const step = BigInt(stride);
  let pending = 0;
  let lastReport = performance.now();
  try {
    for (;;) {
      if (cancelled.has(jobId)) {
        cancelled.delete(jobId);
        self.postMessage({ type: "stopped", jobId, hashes: pending });
        return;
      }
      const found = rx._arx_search(
        challenge,
        bound,
        Number(nonce & 0xffffffffn),
        Number(nonce >> 32n),
        stride,
        BATCH,
        result,
      );
      if (found < 0) throw new Error(`RandomX search failed (${found})`);
      const view = rx.HEAPU8.subarray(result, result + 44);
      const tried =
        view[40] | (view[41] << 8) | (view[42] << 16) | (view[43] << 24);
      pending += tried;
      if (found === 1) {
        let workNonce = 0n;
        for (let index = 7; index >= 0; index -= 1)
          workNonce = (workNonce << 8n) | BigInt(view[index]);
        self.postMessage({
          type: "solution",
          jobId,
          workNonce: workNonce.toString(),
          randomxHash: hexOf(view.subarray(8, 40)),
          hashes: pending,
        });
        return;
      }
      nonce += step * BigInt(BATCH);
      const now = performance.now();
      if (now - lastReport >= 500) {
        self.postMessage({ type: "progress", jobId, hashes: pending });
        pending = 0;
        lastReport = now;
      }
      // Yield so a cancel message can be delivered between batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    rx._free(challenge);
    rx._free(bound);
    rx._free(result);
  }
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  const run = async () => {
    if (message.type === "prepare") return prepare(message.epochKey);
    if (message.type === "search") return search(message);
    if (message.type === "cancel") {
      cancelled.add(message.jobId);
      return undefined;
    }
    throw new Error(`unknown message ${String(message.type)}`);
  };
  run().catch((error) => {
    self.postMessage({
      type: "error",
      jobId: message.jobId ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
