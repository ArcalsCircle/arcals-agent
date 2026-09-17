#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

import { ArcalsWorkApiClient } from "@arcals/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
} from "viem";

import { AgentRuntime } from "./agent.js";
import { CircleCliDriver } from "./circle-cli-driver.js";
import {
  executeParsedCommand,
  parseArguments,
  renderHuman,
} from "./commands.js";
import { SqliteOperationLedger } from "./ledger.js";
import { RealRandomXMiner } from "./randomx-miner.js";
import { apiErrorFor, classifyFailure } from "./errors.js";
import type { ProgressEvent } from "./types.js";
import { loadAgentManifest, ViemChainRecoveryGateway } from "./trust.js";
import type { CliEnvelope } from "./types.js";
import type { WalletAdapter } from "./types.js";
import {
  CircleAgentWalletAdapter,
  RpcUnlockedWalletAdapter,
} from "./wallets.js";

function bootstrapFailure(error: unknown): CliEnvelope {
  const failure = classifyFailure(error);
  // Bootstrap failures default to an untrusted environment rather than a
  // transient dependency, unless a more specific cause was recognised.
  const code =
    failure.code === "DEPENDENCY_UNAVAILABLE"
      ? "UNTRUSTED_DEPLOYMENT"
      : failure.code;
  return {
    ok: false,
    schemaVersion: "1",
    command: "preflight",
    state: "FAILED",
    operationId: null,
    chainId: null,
    wallet: null,
    txHash: null,
    data: {},
    error: apiErrorFor({ ...failure, code }),
    asOf: new Date().toISOString(),
  };
}

let ledger: SqliteOperationLedger | null = null;
let runtime: AgentRuntime | null = null;
try {
  const parsed = parseArguments(process.argv.slice(2));
  const manifestPath = parsed.values["--manifest"];
  const walletAddress = parsed.values["--wallet-address"];
  if (manifestPath === undefined || walletAddress === undefined) {
    throw new Error("--manifest and --wallet-address are required");
  }
  const manifest = await loadAgentManifest(manifestPath);
  const walletProvider = parsed.values["--wallet-provider"] ?? "rpc-unlocked";
  if (walletProvider !== "rpc-unlocked" && walletProvider !== "circle")
    throw new Error("--wallet-provider must be rpc-unlocked or circle");
  if (walletProvider === "rpc-unlocked" && manifest.mode !== "local-fixture")
    throw new Error("The bundled rpc-unlocked adapter is local-fixture only");
  if (
    walletProvider === "circle" &&
    manifest.mode !== "arc-testnet" &&
    manifest.mode !== "arc-mainnet"
  )
    throw new Error(
      "Circle execution requires an Arc Testnet or Arc Mainnet manifest",
    );
  const chain = defineChain({
    id: Number(manifest.chainId),
    name: `Arcals ${manifest.mode}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } },
  });
  // Public Arc RPCs rate-limit bursts. Coalesce concurrent reads into JSON-RPC
  // batches and back off on retryable errors (HTTP 429, -32005 limit
  // exceeded): about 25 s of exponential retries before failing.
  const rpcTransports = [
    manifest.rpcUrl,
    ...(manifest.rpcFallbackUrls ?? []),
  ].map((url) =>
    http(url, {
      batch: { batchSize: 50, wait: 10 },
      retryCount: 1,
      retryDelay: 400,
      timeout: 15_000,
    }),
  );
  // Move to the next independent RPC operator when one fails or keeps
  // rate-limiting; each still retries briefly with backoff first.
  const transport =
    rpcTransports.length === 1
      ? rpcTransports[0]!
      : fallback(rpcTransports, {
          rank: false,
          retryCount: 3,
          retryDelay: 600,
        });
  const publicClient = createPublicClient({ chain, transport });
  const ledgerPath =
    parsed.values["--ledger"] ?? join(homedir(), ".arcals", "ledger.sqlite");
  ledger = new SqliteOperationLedger(ledgerPath);
  let wallet: WalletAdapter;
  if (walletProvider === "circle") {
    const driver = new CircleCliDriver({
      address: walletAddress.toLowerCase() as `0x${string}`,
      chainId: BigInt(manifest.chainId),
      publicClient,
      journalDirectory:
        parsed.values["--circle-journal"] ?? `${ledgerPath}.circle-requests`,
      ...(manifest.contentRegistrar === undefined
        ? {}
        : { contentRegistrar: manifest.contentRegistrar }),
      ...(parsed.values["--circle-command"] === undefined
        ? {}
        : { circleCommand: parsed.values["--circle-command"] }),
    });
    wallet = new CircleAgentWalletAdapter(driver);
  } else {
    const walletClient = createWalletClient({ chain, transport });
    wallet = new RpcUnlockedWalletAdapter({
      address: walletAddress.toLowerCase() as `0x${string}`,
      chainId: BigInt(manifest.chainId),
      publicClient,
      walletClient,
    });
  }
  runtime = new AgentRuntime({
    ...(parsed.values["--progress"] === "jsonl"
      ? {
          progress: (event: ProgressEvent) => {
            process.stderr.write(`${JSON.stringify(event)}\n`);
          },
        }
      : {}),
    manifest,
    api: new ArcalsWorkApiClient(manifest.apiUrl),
    wallet,
    ledger,
    miner: new RealRandomXMiner(manifest.worker.binaryPath),
    publicClient,
    chain: new ViemChainRecoveryGateway(publicClient, manifest.deployment.core),
  });
  const envelope = await executeParsedCommand(runtime, parsed);
  process.stdout.write(
    parsed.flags.has("--json")
      ? `${JSON.stringify(envelope)}\n`
      : renderHuman(envelope),
  );
  process.exitCode = envelope.ok ? 0 : 1;
} catch (error) {
  const envelope = bootstrapFailure(error);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  ledger?.close();
}
