// Arcals browser RandomX engine: runs Arcals work in Web Workers on the
// visitor's machine. It never receives a wallet key, an API session or a
// transaction; it only turns a Challenge into a work nonce.
//
//   const engine = new ArcalsBrowserEngine();
//   const solution = await engine.solve(work, { onProgress, signal });
//   // solution: { workNonce, randomxHash, hashesTried, elapsedMs }
//
// Results are bit-identical to the native worker and the Arcals verifier.

export const ENGINE_PROTOCOL_VERSION = 1;
export const ALGORITHM_ID =
  "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9";
export const PARAMETER_DIGEST =
  "0x207c0c80715507e7133d2b79d6067d774c24a06c3f2cf46a63f1dfdf74fab8f1";

/** A challenge needs at least this much life left to be worth starting. */
const MIN_START_SECONDS = 5;
/** Each worker holds a 256 MiB RandomX cache. */
const MAX_WORKERS = 8;

function defaultWorkerCount() {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  const memoryGiB = globalThis.navigator?.deviceMemory ?? 8;
  // Leave a core for the page, and keep caches within a quarter of memory.
  const byMemory = Math.max(1, Math.floor((memoryGiB * 1024) / 4 / 272));
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1, byMemory));
}

function defaultCreateWorker() {
  return new Worker(new URL("./engine-worker.mjs", import.meta.url), {
    type: "module",
  });
}

function targetHex(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("target must be an unsigned decimal string");
  }
  const target = BigInt(value);
  if (target === 0n || target >= 1n << 256n) {
    throw new Error("target must be a non-zero uint256");
  }
  return `0x${target.toString(16).padStart(64, "0")}`;
}

function bytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase();
}

export class ArcalsBrowserEngine {
  /**
   * @param {{ workers?: number, createWorker?: () => Worker }} [options]
   */
  constructor(options = {}) {
    this.workerCount = options.workers ?? defaultWorkerCount();
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.workers = [];
    this.preparedKey = null;
    this.busy = false;
    this.nextJob = 0;
  }

  /** Mirrors the Compute Companion's /health for the website's checks. */
  health() {
    return {
      ok: typeof WebAssembly === "object" && typeof Worker === "function",
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      algorithmId: ALGORITHM_ID,
      parameterDigest: PARAMETER_DIGEST,
      workerVerified: true,
      engine: "wasm",
      threads: this.workerCount,
    };
  }

  /**
   * Finds a work nonce for a Challenge.
   * @param {{ challengeInput: string, epochKey: string, target: string,
   *   expiresAt: string, algorithmId: string, parameterDigest: string }} work
   * @param {{ onProgress?: (p: { phase: string, hashesTried: string,
   *   elapsedMs: string, hashRate: string }) => void,
   *   signal?: AbortSignal }} [options]
   */
  async solve(work, options = {}) {
    if (this.busy) throw new Error("the engine is already computing");
    if (
      bytes32(work.algorithmId, "algorithmId") !== ALGORITHM_ID ||
      bytes32(work.parameterDigest, "parameterDigest") !== PARAMETER_DIGEST
    ) {
      throw new Error("work parameters do not match the Arcals RandomX build");
    }
    const challengeInput = bytes32(work.challengeInput, "challengeInput");
    const epochKey = bytes32(work.epochKey, "epochKey");
    const target = targetHex(work.target);
    const expiresAt = Number(work.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("expiresAt is invalid");
    const secondsLeft = () => expiresAt - Date.now() / 1000;
    if (secondsLeft() <= MIN_START_SECONDS) {
      throw new Error("challenge expires too soon to start work");
    }
    this.busy = true;
    try {
      await this.prepare(epochKey, options);
      return await this.search(challengeInput, target, secondsLeft, options);
    } finally {
      this.busy = false;
    }
  }

  /** Stops every worker and frees their caches. */
  dispose() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.preparedKey = null;
  }

  async prepare(epochKey, options) {
    if (this.workers.length === 0) {
      this.workers = Array.from({ length: this.workerCount }, () =>
        this.createWorker(),
      );
    }
    if (this.preparedKey === epochKey) return;
    options.onProgress?.({
      phase: "PREPARING",
      hashesTried: "0",
      elapsedMs: "0",
      hashRate: "0",
    });
    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.onmessage = (event) => {
              const message = event.data;
              if (message.type === "ready") resolve();
              else if (message.type === "error")
                reject(new Error(message.message));
            };
            worker.onerror = (event) =>
              reject(new Error(event.message ?? "RandomX worker failed"));
            worker.postMessage({ type: "prepare", epochKey });
          }),
      ),
    );
    this.preparedKey = epochKey;
  }

  search(challengeInput, target, secondsLeft, options) {
    const jobId = `job-${(this.nextJob += 1)}`;
    const started = performance.now();
    let hashes = 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const stopAll = () => {
        for (const worker of this.workers)
          worker.postMessage({ type: "cancel", jobId });
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        options.signal?.removeEventListener("abort", onAbort);
        stopAll();
        if (error) reject(error);
        else resolve(value);
      };
      const report = () => {
        const elapsed = performance.now() - started;
        options.onProgress?.({
          phase: "COMPUTING",
          hashesTried: String(hashes),
          elapsedMs: String(Math.round(elapsed)),
          hashRate: elapsed > 0 ? (hashes / (elapsed / 1000)).toFixed(2) : "0",
        });
      };
      const onAbort = () =>
        finish(new DOMException("Work was cancelled.", "AbortError"));
      const timer = setInterval(() => {
        report();
        if (secondsLeft() <= 1)
          finish(new Error("challenge expired before a solution was found"));
      }, 500);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      this.workers.forEach((worker, index) => {
        worker.onmessage = (event) => {
          const message = event.data;
          if (message.jobId !== jobId) return;
          if (message.type === "progress" || message.type === "stopped") {
            hashes += message.hashes;
          } else if (message.type === "solution") {
            hashes += message.hashes;
            report();
            finish(null, {
              workNonce: message.workNonce,
              randomxHash: message.randomxHash,
              hashesTried: String(hashes),
              elapsedMs: String(Math.round(performance.now() - started)),
            });
          } else if (message.type === "error") {
            finish(new Error(message.message));
          }
        };
        // Worker i tries nonces i, i + N, i + 2N, ... like the native worker.
        worker.postMessage({
          type: "search",
          jobId,
          challengeInput,
          target,
          startNonce: String(index),
          stride: this.workers.length,
        });
      });
    });
  }
}
