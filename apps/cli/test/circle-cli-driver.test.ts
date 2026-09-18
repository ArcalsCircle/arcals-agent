import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintControllerAbi } from "@arcals/contract-bindings";
import type { Bytes32, HexAddress } from "@arcals/protocol";
import { buildEncodedMintCall, buildRegisterContentCall } from "@arcals/sdk";
import type { ContractCall } from "@arcals/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeFunctionData } from "viem";

import {
  CircleCliDriver,
  decodeCircleCall,
  type CircleCliRunner,
} from "../src/circle-cli-driver.js";
import { CircleAgentWalletAdapter } from "../src/wallets.js";

const address = "0x2000000000000000000000000000000000000002" as HexAddress;
const controller = "0x1000000000000000000000000000000000000005" as HexAddress;
const transactionHash = `0x${"ab".repeat(32)}` as Bytes32;
const hash = `0x${"11".repeat(32)}` as Bytes32;
const signature = `0x${"22".repeat(65)}` as `0x${string}`;

const data = encodeFunctionData({
  abi: mintControllerAbi,
  functionName: "mint",
  args: [
    {
      protocolVersion: 1,
      configDigest: hash,
      challengeId: `0x${"33".repeat(32)}`,
      epochId: 7n,
      minter: address,
      mintNonce: 9n,
      challengeInput: `0x${"44".repeat(32)}`,
      mintFee: 100_000_000_000_000_000n,
      validAfter: 1_800_000_000n,
      expiresAt: 1_800_000_600n,
      signerVersion: 1n,
    },
    signature,
    {
      protocolVersion: 1,
      challengeHash: `0x${"55".repeat(32)}`,
      workNonce: 42n,
      randomxHash: `0x${"66".repeat(32)}`,
      issuedAt: 1_800_000_100n,
      expiresAt: 1_800_000_500n,
      signerVersion: 1n,
    },
    signature,
  ],
});

const mintCall: ContractCall = {
  chainId: 5_042_002n,
  to: controller,
  data,
  valueNative: 100_000_000_000_000_000n,
};

const handleOpsV07Abi = [
  {
    type: "function",
    name: "handleOps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** An EntryPoint v0.7 bundle whose user operations wrap each call in an SCA execute(). */
function bundle(
  ops: readonly { sender: string; call: string }[],
): `0x${string}` {
  return encodeFunctionData({
    abi: handleOpsV07Abi,
    functionName: "handleOps",
    args: [
      ops.map((op, index) => ({
        sender: op.sender as `0x${string}`,
        nonce: BigInt(index),
        initCode: "0x" as `0x${string}`,
        callData:
          `0xb61d27f6${"00".repeat(64)}${op.call.slice(2)}` as `0x${string}`,
        accountGasLimits: `0x${"00".repeat(32)}` as `0x${string}`,
        preVerificationGas: 0n,
        gasFees: `0x${"00".repeat(32)}` as `0x${string}`,
        paymasterAndData: "0x" as `0x${string}`,
        signature: "0x" as `0x${string}`,
      })),
      "0x000000000000000000000000000000000000dEaD",
    ],
  });
}

const directories: string[] = [];

function temporaryJournal(): string {
  const directory = mkdtempSync(join(tmpdir(), "arcals-circle-"));
  directories.push(directory);
  return directory;
}

function publicClient() {
  return {
    getBalance: async () => 1_000_000_000_000_000_000n,
    call: async () => ({ data: "0x" }),
    estimateGas: async () => 500_000n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 2n,
      gasPrice: 1n,
    }),
    getTransactionReceipt: async () => ({
      status: "success",
      gasUsed: 400_000n,
      effectiveGasPrice: 2n,
      blockNumber: 99n,
    }),
    getTransaction: async () => ({ hash: transactionHash }),
  } as never;
}

class FakeRunner implements CircleCliRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly handler: (
      args: readonly string[],
    ) => Promise<{ readonly stdout: string; readonly stderr: string }>,
  ) {}

  async run(args: readonly string[]) {
    this.calls.push([...args]);
    return this.handler(args);
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Circle CLI Arc Testnet driver", () => {
  it("decodes the frozen nested Mint calldata into one Circle CLI argument per ABI input", () => {
    const decoded = decodeCircleCall(data);
    expect(decoded.abiFunctionSignature).toBe(
      "mint((uint32,bytes32,bytes32,uint64,address,uint256,bytes32,uint256,uint64,uint64,uint64),bytes,(uint32,bytes32,uint64,bytes32,uint64,uint64,uint64),bytes)",
    );
    expect(decoded.abiParameters).toHaveLength(4);
    expect(JSON.parse(decoded.abiParameters[0]!)).toEqual([
      "1",
      hash,
      `0x${"33".repeat(32)}`,
      "7",
      address,
      "9",
      `0x${"44".repeat(32)}`,
      "100000000000000000",
      "1800000000",
      "1800000600",
      "1",
    ]);
    expect(JSON.parse(decoded.abiParameters[2]!)).toHaveLength(7);
  });

  it("passes 0.1 as Native value, preserves the request ID, and returns a provider handle", async () => {
    const runner = new FakeRunner(async (args) => {
      if (args[0] === "wallet" && args[1] === "execute") {
        return {
          stdout: JSON.stringify({
            data: {
              id: "circle-operation-1",
              state: "CONFIRMED",
              txHash: transactionHash,
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({ data: { transactions: [] } }),
        stderr: "",
      };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    const adapter = new CircleAgentWalletAdapter(driver);
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    await adapter.prepareSubmission(requestId, mintCall);
    const handle = await adapter.submitCall(requestId, mintCall);
    expect(handle).toEqual({
      kind: "provider-operation",
      provider: "circle-agent-wallet",
      requestId,
      operationId: "circle-operation-1",
      chainId: "5042002",
    });
    const execute = runner.calls.find(
      (args) => args[0] === "wallet" && args[1] === "execute",
    );
    expect(execute).toBeDefined();
    expect(execute?.[2]).toBe("mintEncoded(bytes)");
    expect(execute?.[3]).toBe(`0x${mintCall.data.slice(10)}`);
    expect(execute).toContain("0.1");
    expect(execute).toContain(requestId);
    expect(execute).toContain(controller);
    expect(execute).not.toContain("100000000000000000");
  });

  it("deploys an undeployed Agent Wallet with one idempotent zero-value self-transfer", async () => {
    let deployed = false;
    const runner = new FakeRunner(async (args) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify({
            data: {
              wallets: [{ type: "agent", blockchain: "ARC", address }],
            },
          }),
          stderr: "",
        };
      }
      if (args[1] === "transfer") deployed = true;
      return {
        stdout: JSON.stringify({ data: { state: "COMPLETE" } }),
        stderr: "",
      };
    });
    const client = {
      ...(publicClient() as object),
      getCode: async () => (deployed ? "0x6080" : undefined),
    } as never;
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042n,
      publicClient: client,
      journalDirectory: temporaryJournal(),
      runner,
      deploymentPollMs: 1,
    });
    await expect(driver.deploymentStatus()).resolves.toBe("UNDEPLOYED");
    await driver.deployAccount();
    await expect(driver.deploymentStatus()).resolves.toBe("DEPLOYED");
    const transfers = runner.calls.filter((args) => args[1] === "transfer");
    expect(transfers).toHaveLength(1);
    const transfer = transfers[0]!;
    expect(transfer[2]).toBe(address);
    expect(transfer[transfer.indexOf("--amount") + 1]).toBe("0");
    expect(transfer[transfer.indexOf("--address") + 1]).toBe(address);
    expect(transfer[transfer.indexOf("--chain") + 1]).toBe("ARC");
    const key = transfer[transfer.indexOf("--idempotency-key") + 1]!;
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // Already deployed: no second transfer.
    await driver.deployAccount();
    expect(runner.calls.filter((args) => args[1] === "transfer")).toHaveLength(
      1,
    );
  });

  it("retries transient failures for signing but never for contract execution", async () => {
    let signFailures = 1;
    let executeCalls = 0;
    const runner = new FakeRunner(async (args) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify({
            data: {
              wallets: [{ type: "agent", blockchain: "ARC-TESTNET", address }],
            },
          }),
          stderr: "",
        };
      }
      if (args[1] === "sign") {
        if (signFailures > 0) {
          signFailures -= 1;
          throw new Error("CIRCLE_CLI_FAILED: fetch failed");
        }
        return {
          stdout: JSON.stringify({
            data: { signature: `0x${"ab".repeat(65)}` },
          }),
          stderr: "",
        };
      }
      if (args[1] === "execute" && !args.includes("--estimate")) {
        executeCalls += 1;
        throw new Error("CIRCLE_CLI_FAILED: fetch failed");
      }
      return {
        stdout: JSON.stringify({ data: { transactions: [] } }),
        stderr: "",
      };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
      retryBaseMs: 1,
    });
    await expect(driver.signMessage("login")).resolves.toMatch(/^0x/u);
    expect(runner.calls.filter((args) => args[1] === "sign")).toHaveLength(2);
    const adapter = new CircleAgentWalletAdapter(driver);
    const requestId = "223e4567-e89b-42d3-a456-426614174000";
    await adapter.prepareSubmission(requestId, mintCall);
    await expect(adapter.submitCall(requestId, mintCall)).rejects.toThrow();
    expect(executeCalls).toBe(1);
  });

  it("attributes sponsored Gas to the paymaster instead of the wallet", async () => {
    const paymaster = "0x03df76c8c30a88f424cf3cbbc36a1ca02763103b";
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const eventData = `0x${word(1n)}${word(1n)}${word(72_700_000_000_000_000n)}${word(350_000n)}`;
    const runner = new FakeRunner(async (args) => {
      if (args[1] === "list" && args.includes("--type")) {
        return {
          stdout: JSON.stringify({
            data: {
              wallets: [{ type: "agent", blockchain: "ARC", address }],
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          data: {
            transactions: [
              {
                id: "circle-operation-sponsored",
                state: "COMPLETE",
                txHash: transactionHash,
                networkFee: "0.0727",
                blockHeight: "100",
              },
            ],
          },
        }),
        stderr: "",
      };
    });
    const client = {
      ...(publicClient() as object),
      getTransactionReceipt: async () => ({
        status: "success",
        gasUsed: 400_000n,
        effectiveGasPrice: 2n,
        blockNumber: 100n,
        logs: [
          {
            address: "0x0000000071727de22e5e9d8baf0edac6f37da032",
            topics: [
              "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f",
              `0x${"77".repeat(32)}`,
              `0x${address.slice(2).padStart(64, "0")}`,
              `0x${paymaster.slice(2).padStart(64, "0")}`,
            ],
            data: eventData,
          },
        ],
      }),
    } as never;
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042n,
      publicClient: client,
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(
      driver.queryOperation("circle-operation-sponsored"),
    ).resolves.toMatchObject({
      status: "CONFIRMED",
      gasSpentNative: 0n,
      networkGasCostNative: 72_700_000_000_000_000n,
      gasSponsor: paymaster,
      sponsorshipStatus: "SPONSORED",
    });
  });

  it("uses Circle's SCA-aware estimate before submission", async () => {
    const runner = new FakeRunner(async (args) => {
      expect(args).toContain("--estimate");
      expect(args).toContain("0.1");
      expect(args[2]).toBe("mintEncoded(bytes)");
      expect(args[3]).toBe(`0x${mintCall.data.slice(10)}`);
      return {
        stdout: JSON.stringify({
          data: {
            blockchain: "ARC-TESTNET",
            medium: { gasLimit: "700000", networkFee: "0.0000042" },
            callGasLimit: "500000",
            verificationGasLimit: "150000",
            preVerificationGas: "50000",
          },
        }),
        stderr: "",
      };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(driver.estimate(mintCall)).resolves.toEqual({
      gasLimit: 700_000n,
      maxGasNative: 4_200_000_000_000n,
    });
  });

  it("resolves a request Circle rejected before it broadcast anything", async () => {
    // Circle reports such a rejection as a terminal transaction with no hash,
    // which no chain lookup can find. Leaving it unresolved would block the
    // wallet from ever Minting again.
    const runner = new FakeRunner(async (args) => {
      if (args[0] === "transaction" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            data: {
              transactions: [
                {
                  id: "circle-operation-rejected",
                  state: "FAILED",
                  blockchain: "ARC",
                  sourceAddress: address,
                  operation: "CONTRACT_EXECUTION",
                  contractAddress: controller,
                  abiParameters: null,
                  errorReason: "ESTIMATION_ERROR",
                  errorDetails: "execution reverted",
                  createDate: new Date().toISOString(),
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify({ data: {} }), stderr: "" };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    await driver.prepare(requestId, mintCall);
    await expect(driver.queryRequest(requestId)).resolves.toMatchObject({
      status: "REVERTED",
      transactionHash: null,
      gasSpentNative: 0n,
    });
  });

  it("quotes fees from the chain when Circle cannot estimate", async () => {
    // Circle's estimate endpoint has returned 503 while the rest of the wallet
    // kept working; the Mint must still go out.
    const runner = new FakeRunner(async (args) => {
      if (args.includes("--estimate")) {
        throw new Error(
          "CIRCLE_CLI_INTERNAL: Service returned error 503: Something went wrong.",
        );
      }
      return { stdout: JSON.stringify({ data: {} }), stderr: "" };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    // 500,000 estimated Gas with the 20% margin, priced at maxFeePerGas 2.
    await expect(driver.estimate(mintCall)).resolves.toEqual({
      gasLimit: 600_000n,
      maxGasNative: 1_200_000n,
    });
  });

  it("quotes fees from the chain when Circle omits the medium tier", async () => {
    const runner = new FakeRunner(async () => ({
      stdout: JSON.stringify({ data: { blockchain: "ARC-TESTNET" } }),
      stderr: "",
    }));
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(driver.estimate(mintCall)).resolves.toEqual({
      gasLimit: 600_000n,
      maxGasNative: 1_200_000n,
    });
  });

  it("recovers a lost execute response from the durable public request journal", async () => {
    const decoded = decodeCircleCall(buildEncodedMintCall(mintCall).data);
    const journalDirectory = temporaryJournal();
    const failing = new FakeRunner(async () => {
      throw new Error("CIRCLE_CLI_TIMEOUT: outcome unknown");
    });
    const first = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory,
      runner: failing,
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174001";
    await first.prepare(requestId, mintCall);
    await expect(first.submit(requestId, mintCall)).rejects.toThrow(
      /outcome unknown/u,
    );

    const recovery = new FakeRunner(async () => ({
      stdout: JSON.stringify({
        data: {
          transactions: [
            {
              id: "circle-operation-recovered",
              state: "CONFIRMED",
              blockchain: "ARC-TESTNET",
              txHash: transactionHash,
              sourceAddress: address,
              networkFee: "0.000001",
              operation: "CONTRACT_EXECUTION",
              abiFunctionSignature: decoded.abiFunctionSignature,
              abiParameters: decoded.abiParameters,
              contractAddress: controller,
              blockHeight: 100,
              createDate: new Date().toISOString(),
            },
          ],
        },
      }),
      stderr: "",
    }));
    const restarted = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory,
      runner: recovery,
    });
    await expect(restarted.queryRequest(requestId)).resolves.toMatchObject({
      status: "CONFIRMED",
      transactionHash,
      // Circle's networkFee is not treated as wallet spend; without an
      // on-chain UserOperationEvent the charge stays unknown.
      gasSpentNative: null,
      sponsorshipStatus: "UNKNOWN",
      blockNumber: 100n,
      handle: {
        kind: "provider-operation",
        requestId,
        operationId: "circle-operation-recovered",
      },
    });
  });

  it("recovers a lost response from live-shaped Circle list items by matching chain call data", async () => {
    const encoded = buildEncodedMintCall(mintCall);
    const journalDirectory = temporaryJournal();
    const failing = new FakeRunner(async () => {
      throw new Error(
        "CIRCLE_CLI_FAILED: simulated network loss after submission",
      );
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174009";
    const first = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory,
      runner: failing,
    });
    await first.prepare(requestId, mintCall);
    await expect(first.submit(requestId, mintCall)).rejects.toThrow(
      /network loss/u,
    );

    const liveShaped = (hash: string, id: string) => ({
      id,
      state: "COMPLETE",
      blockchain: "ARC-TESTNET",
      txHash: hash,
      sourceAddress: address,
      networkFee: "0.02",
      operation: "CONTRACT_EXECUTION",
      abiParameters: null,
      contractAddress: controller,
      blockHeight: 101,
      createDate: new Date().toISOString(),
    });
    const otherHash = `0x${"cd".repeat(32)}`;
    const listing = new FakeRunner(async () => ({
      stdout: JSON.stringify({
        data: {
          transactions: [
            liveShaped(otherHash, "circle-other-execution"),
            liveShaped(transactionHash, "circle-lost-response"),
          ],
        },
      }),
      stderr: "",
    }));
    const otherWallet = "0x3000000000000000000000000000000000000003";
    const chainInputs = new Map<string, string>([
      // Another wallet's identical call in a bundle never counts for this wallet.
      [otherHash, bundle([{ sender: otherWallet, call: encoded.data }])],
      [
        transactionHash,
        bundle([
          { sender: otherWallet, call: encoded.data },
          { sender: address, call: encoded.data },
        ]),
      ],
    ]);
    const client = {
      ...(publicClient() as object),
      getTransaction: async ({ hash }: { hash: string }) => ({
        hash,
        input: chainInputs.get(hash) ?? "0x",
      }),
    } as never;
    const restarted = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: client,
      journalDirectory,
      runner: listing,
    });
    await expect(restarted.queryRequest(requestId)).resolves.toMatchObject({
      status: "CONFIRMED",
      transactionHash,
      handle: {
        kind: "provider-operation",
        requestId,
        operationId: "circle-lost-response",
      },
    });

    const unrelatedDirectory = temporaryJournal();
    const unrelated = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: {
        ...(publicClient() as object),
        getTransaction: async ({ hash }: { hash: string }) => ({
          hash,
          input: bundle([
            {
              sender: "0x3000000000000000000000000000000000000003",
              call: encoded.data,
            },
          ]),
        }),
      } as never,
      journalDirectory: unrelatedDirectory,
      runner: listing,
    });
    await unrelated.prepare(requestId, mintCall);
    await expect(unrelated.queryRequest(requestId)).resolves.toMatchObject({
      status: "UNKNOWN",
    });
  });

  it("tells identical executions apart by excluding Circle operations claimed by another request", async () => {
    const encoded = buildEncodedMintCall(mintCall);
    const journalDirectory = temporaryJournal();
    const claimedRequest = "123e4567-e89b-42d3-a456-42661417000a";
    const lostRequest = "123e4567-e89b-42d3-a456-42661417000b";
    const firstHash = `0x${"e1".repeat(32)}`;
    const secondHash = `0x${"e2".repeat(32)}`;
    const item = (hash: string, id: string) => ({
      id,
      state: "COMPLETE",
      blockchain: "ARC-TESTNET",
      txHash: hash,
      sourceAddress: address,
      networkFee: "0.01",
      operation: "CONTRACT_EXECUTION",
      abiParameters: null,
      contractAddress: controller,
      blockHeight: 120,
      createDate: new Date().toISOString(),
    });
    const listing = new FakeRunner(async () => ({
      stdout: JSON.stringify({
        data: {
          transactions: [
            item(secondHash, "circle-second"),
            item(firstHash, "circle-first"),
          ],
        },
      }),
      stderr: "",
    }));
    const client = {
      ...(publicClient() as object),
      getTransaction: async ({ hash }: { hash: string }) => ({
        hash,
        input: bundle([{ sender: address, call: encoded.data }]),
      }),
    } as never;
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: client,
      journalDirectory,
      runner: listing,
    });
    await driver.prepare(claimedRequest, mintCall);
    await driver.prepare(lostRequest, mintCall);
    // Both identical executions match the call data, so neither request can be resolved yet.
    await expect(driver.queryRequest(lostRequest)).resolves.toMatchObject({
      status: "UNKNOWN",
    });
    // Once the first request is bound to its operation, the lost one resolves to the other.
    const claimedPath = join(
      journalDirectory,
      `${createHash("sha256").update(claimedRequest).digest("hex")}.json`,
    );
    writeFileSync(
      claimedPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(claimedPath, "utf8")),
        operationId: "circle-first",
        transactionHash: firstHash,
      }),
    );
    await expect(driver.queryRequest(lostRequest)).resolves.toMatchObject({
      status: "CONFIRMED",
      transactionHash: secondHash,
      handle: { operationId: "circle-second", requestId: lostRequest },
    });
  });

  it("routes content registration through a registrar verified to forward to the trusted Mirror", async () => {
    const mirror = "0x1000000000000000000000000000000000000003" as HexAddress;
    const registrar =
      "0x1000000000000000000000000000000000000009" as HexAddress;
    const proof = Array.from(
      { length: 20 },
      (_, index) => `0x${index.toString(16).padStart(64, "0")}` as Bytes32,
    );
    const registerCall = buildRegisterContentCall(
      5_042_002n,
      mirror,
      7n,
      `0x${"12".repeat(180)}`,
      proof,
    );
    const estimates: string[][] = [];
    const runner = new FakeRunner(async (args) => {
      estimates.push([...args]);
      return {
        stdout: JSON.stringify({
          data: { medium: { gasLimit: "200000", networkFee: "0.003" } },
        }),
        stderr: "",
      };
    });
    const clientFor = (forwardsTo: string) =>
      ({
        ...(publicClient() as object),
        readContract: async () => forwardsTo,
      }) as never;

    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: clientFor(mirror),
      journalDirectory: temporaryJournal(),
      runner,
      contentRegistrar: registrar,
    });
    await driver.estimate(registerCall);
    expect(estimates[0]?.slice(0, 3)).toEqual([
      "wallet",
      "execute",
      "registerEncoded(bytes)",
    ]);
    expect(estimates[0]).toContain(registrar);
    const payload = estimates[0]![3]!;
    expect(
      decodeAbiParameters(
        [{ type: "uint256" }, { type: "bytes" }, { type: "bytes32[]" }],
        payload as `0x${string}`,
      )[0],
    ).toBe(7n);

    const spoofed = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: clientFor("0x2000000000000000000000000000000000000002"),
      journalDirectory: temporaryJournal(),
      runner,
      contentRegistrar: registrar,
    });
    await expect(spoofed.estimate(registerCall)).rejects.toThrow(
      /UNTRUSTED_DEPLOYMENT/u,
    );

    const unconfigured = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: clientFor(mirror),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(unconfigured.estimate(registerCall)).rejects.toThrow(
      /CIRCLE_CALL_UNSUPPORTED/u,
    );
  });

  it("keeps Arc Testnet policy capabilities unavailable and signs through Circle without accepting secrets as arguments", async () => {
    const runner = new FakeRunner(async (args) => {
      expect(args.slice(0, 4)).toEqual([
        "wallet",
        "sign",
        "message",
        "arcals authentication",
      ]);
      return {
        stdout: JSON.stringify({ data: { signature } }),
        stderr: "",
      };
    });
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(driver.signMessage("arcals authentication")).resolves.toBe(
      signature,
    );
    const capabilities = await driver.capabilities();
    expect(capabilities.nativeValue.supported).toBe(true);
    expect(capabilities.idempotentSubmission.supported).toBe(true);
    expect(capabilities.contractAllowlist.supported).toBe(false);
    expect(capabilities.erc721Receive.supported).toBe(false);
  });

  it("verifies that the configured address belongs to the logged-in Circle Arc Testnet session", async () => {
    const runner = new FakeRunner(async () => ({
      stdout: JSON.stringify({
        data: {
          wallets: [{ type: "agent", address, blockchain: "ARC-TESTNET" }],
        },
      }),
      stderr: "",
    }));
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042_002n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(driver.balance()).resolves.toBe(1_000_000_000_000_000_000n);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual([
      "wallet",
      "list",
      "--chain",
      "ARC-TESTNET",
      "--type",
      "agent",
      "--output",
      "json",
    ]);
  });

  it("maps Circle CLI 1.1.0 Arc Mainnet without claiming live policy evidence", async () => {
    const runner = new FakeRunner(async () => ({
      stdout: JSON.stringify({
        data: {
          wallets: [{ type: "agent", address, blockchain: "ARC" }],
        },
      }),
      stderr: "",
    }));
    const driver = new CircleCliDriver({
      address,
      chainId: 5_042n,
      publicClient: publicClient(),
      journalDirectory: temporaryJournal(),
      runner,
    });
    await expect(driver.balance()).resolves.toBe(1_000_000_000_000_000_000n);
    expect(runner.calls[0]).toContain("ARC");
    expect(runner.calls[0]).not.toContain("ARC-TESTNET");
    const capabilities = await driver.capabilities();
    expect(capabilities.chain.evidenceRef).toBe("circle-cli-1.1.0:ARC");
    expect(capabilities.contractAllowlist.supported).toBe(false);
  });
});
