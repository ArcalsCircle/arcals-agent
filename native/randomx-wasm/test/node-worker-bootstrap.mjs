// Runs engine-worker.mjs under Node worker_threads with a Web Worker surface.
import { parentPort, workerData } from "node:worker_threads";

globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
await import(workerData.workerUrl);
parentPort.on("message", (data) => globalThis.onmessage?.({ data }));
