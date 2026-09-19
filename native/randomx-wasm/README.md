# Arcals browser RandomX engine

RandomX compiled to WebAssembly, so a web page can do Arcals work on the
visitor's own machine with nothing to install. It is built from the same
pinned RandomX source and Arcals patch as the native worker, and its hashes
are bit-identical to the native worker and to the Arcals verifier.

## Why a separate build

A browser cannot generate native code or use AES instructions, so this build
uses RandomX's light mode (a 256 MiB cache instead of the 2 GiB dataset), the
bytecode interpreter and software AES. RandomX defines identical results for
every mode, so these choices only change speed.

One thing does not carry over on its own: RandomX's `CFROUND` instruction
switches the floating-point rounding mode, and WebAssembly only rounds to
nearest-even (`fesetround` is silently ignored). Without handling it, nearly
every hash would be wrong. `src/wasm_rounding.h` computes each addition,
subtraction, multiplication, division and square root to nearest, determines
exactly which side of that result the true value lies on (TwoSum for
addition, 128-bit integer comparison for the rest), and steps one unit in the
last place when the active mode requires it, including IEEE overflow,
underflow and signed-zero rules. `patches/0001-wasm-directed-rounding.patch`
routes RandomX's portable floating-point operations through it when compiling
with Emscripten; native builds are unchanged.

## Build

Requires Emscripten 4.0.15 (`emcc` on `PATH`) and the RandomX submodule.

```sh
bash native/randomx-wasm/scripts/build.sh
```

`dist/` then holds `arcals-randomx.wasm`, `arcals-randomx.mjs`, `engine.mjs`,
`engine-worker.mjs` and `SHA256SUMS`.

## Verification

| Check                                                                                                                                  | Command                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Software rounding vs the CPU's own modes, 30 million operations including NaN, infinities, subnormals, overflow and exact cancellation | `g++ -O2 -std=c++17 -frounding-math native/randomx-wasm/test/rounding_test.cpp && ./a.out` |
| Official test vector and native parity                                                                                                 | `node tools/benchmark/wasm-parity.mjs`                                                     |
| Large differential against the native worker                                                                                           | `node tools/benchmark/wasm-differential.mjs 20000 14`                                      |
| Engine end to end at the production Target, cancellation, reuse                                                                        | `node tools/benchmark/wasm-engine-test.mjs 4 5`                                            |
| Real Chromium with real Web Workers                                                                                                    | `CHROMIUM_PATH=… PLAYWRIGHT_CORE=… node tools/benchmark/wasm-browser-test.mjs 4 8`         |

The native-parity checks need the native worker built first
(`bash native/randomx-worker/scripts/build.sh`).

## Using it in a page

```js
import { ArcalsBrowserEngine } from "./engine.mjs";

const engine = new ArcalsBrowserEngine(); // one Web Worker per spare core, at most 8
const controller = new AbortController();
const solution = await engine.solve(
  {
    challengeInput: challenge.challengeInput,
    expiresAt: challenge.expiresAt,
    epochKey: config.epoch.epochKey,
    target: config.workConfig.target,
    algorithmId: config.workConfig.algorithmId,
    parameterDigest: config.workConfig.parameterDigest,
  },
  { onProgress: (p) => render(p), signal: controller.signal },
);
// solution: { workNonce, randomxHash, hashesTried, elapsedMs }
```

- `engine-worker.mjs`, `arcals-randomx.mjs` and `arcals-randomx.wasm` must be
  served next to `engine.mjs`; bundlers pick them up through
  `new URL(…, import.meta.url)`.
- Each Web Worker holds its own 256 MiB cache and needs no
  `SharedArrayBuffer`, so the page does not need cross-origin isolation.
- The cache is prepared once per Epoch (about a second) and reused across
  solves; `dispose()` releases it.
- `health()` returns the same fields as the Compute Companion's `/health`.

Measured in headless Chromium 149 on a 16-core desktop, at the Epoch 3 Target
(320 expected hashes): 2 workers 5.2 H/s, 4 workers 10.2 H/s, 8 workers
18.6 H/s, about 2.5 H/s per worker.
