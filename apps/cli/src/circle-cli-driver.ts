import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  arcalMirrorAbi,
  arclBaseAbi,
  arcalsContentRegistrarAbi,
  arcalsCoreAbi,
  arcalsVaultAbi,
  mintControllerAbi,
} from "@arcals/contract-bindings";
import type { Bytes32, HexAddress, WalletHandle } from "@arcals/protocol";
import { buildEncodedMintCall } from "@arcals/sdk";
import type { ContractCall } from "@arcals/sdk";
import type { Abi, AbiFunction, AbiParameter, Hex, PublicClient } from "viem";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";

import type { ProviderWalletDriver } from "./wallets.js";
import type {
  SubmissionResult,
  WalletCapabilities,
  WalletFeeQuote,
  WalletMintAuthorizationRequest,
  WalletSimulation,
} from "./types.js";
import { unsupportedCapabilities } from "./types.js";

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const ARC_MAINNET_CHAIN_ID = 5_042n;
const REQUEST_SCHEMA_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 190_000;
/** keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)") */
const USER_OPERATION_EVENT_TOPIC =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const TRANSIENT_CIRCLE_FAILURE =
  /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|too many requests|\b429\b|\b50[234]\b|temporarily|CIRCLE_CLI_TIMEOUT|timed? ?out/iu;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;

/** ERC-4337 EntryPoint v0.7 and v0.6 handleOps, used to find this wallet's own user operation. */
const ENTRYPOINT_HANDLE_OPS_ABI = [
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
          { name: "callGasLimit", type: "uint256" },
          { name: "verificationGasLimit", type: "uint256" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "maxFeePerGas", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
  },
] as const;

const ARCALS_ABI: Abi = [
  ...arcalsCoreAbi,
  ...arclBaseAbi,
  ...arcalMirrorAbi,
  ...arcalsVaultAbi,
  ...mintControllerAbi,
  ...arcalsContentRegistrarAbi,
];

interface CircleCliResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CircleCliRunner {
  run(args: readonly string[], timeoutMs?: number): Promise<CircleCliResult>;
}

export class CircleCliProcessRunner implements CircleCliRunner {
  constructor(private readonly command = "circle") {}

  async run(
    args: readonly string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CircleCliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current) >= MAX_PROCESS_OUTPUT_BYTES)
          return current;
        const remaining = MAX_PROCESS_OUTPUT_BYTES - Buffer.byteLength(current);
        return current + chunk.subarray(0, remaining).toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(
          new Error(
            "CIRCLE_CLI_TIMEOUT: outcome is unknown; recover the original request before retrying",
          ),
        );
      }, timeoutMs);
      timer.unref();
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `CIRCLE_CLI_UNAVAILABLE: ${sanitizeDiagnostic(error.message)}`,
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(circleFailure(stdout, stderr, code)));
      });
    });
  }
}

interface CircleRequestRecord {
  readonly schemaVersion: typeof REQUEST_SCHEMA_VERSION;
  readonly requestId: string;
  readonly address: HexAddress;
  readonly chainId: string;
  readonly contractAddress: HexAddress;
  readonly callData: Hex;
  readonly valueNative: string;
  readonly abiFunctionSignature: string;
  readonly abiParameters: readonly string[];
  readonly preparedAt: string;
  readonly operationId: string | null;
  readonly transactionHash: Bytes32 | null;
}

class CircleRequestJournal {
  constructor(private readonly directory: string) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      return;
    }
    const metadata = statSync(directory);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new Error(
        "CIRCLE_JOURNAL_INSECURE: existing journal path must be a private directory",
      );
    }
  }

  prepare(record: CircleRequestRecord): CircleRequestRecord {
    const existing = this.get(record.requestId);
    if (existing !== null) {
      if (
        existing.address !== record.address ||
        existing.chainId !== record.chainId ||
        existing.contractAddress !== record.contractAddress ||
        existing.callData !== record.callData ||
        existing.valueNative !== record.valueNative
      ) {
        throw new Error(
          "CIRCLE_IDEMPOTENCY_CONFLICT: requestId was already prepared for a different call",
        );
      }
      return existing;
    }
    this.write(record);
    return record;
  }

  bind(
    requestId: string,
    operationId: string,
    transactionHash: Bytes32 | null,
  ): CircleRequestRecord {
    const existing = this.get(requestId);
    if (existing === null)
      throw new Error("Circle request journal entry is missing");
    if (existing.operationId !== null && existing.operationId !== operationId) {
      throw new Error(
        "CIRCLE_IDEMPOTENCY_CONFLICT: provider returned a different operation",
      );
    }
    const updated: CircleRequestRecord = {
      ...existing,
      operationId,
      transactionHash: transactionHash ?? existing.transactionHash,
    };
    this.write(updated);
    return updated;
  }

  get(requestId: string): CircleRequestRecord | null {
    return this.read(this.pathFor(requestId));
  }

  findByOperationId(operationId: string): CircleRequestRecord | null {
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      let record: CircleRequestRecord | null = null;
      try {
        record = this.read(join(this.directory, name));
      } catch {
        // A corrupt unrelated journal entry must not block recovery of other requests.
        continue;
      }
      if (record?.operationId === operationId) return record;
    }
    return null;
  }

  private read(path: string): CircleRequestRecord | null {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCircleRequestRecord(parsed)) {
      throw new Error("Invalid Circle request journal record");
    }
    return parsed;
  }

  private write(record: CircleRequestRecord): void {
    const path = this.pathFor(record.requestId);
    const temporary = `${path}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private pathFor(requestId: string): string {
    const digest = createHash("sha256").update(requestId).digest("hex");
    return join(this.directory, `${digest}.json`);
  }
}

interface CircleTransaction {
  readonly id?: unknown;
  readonly state?: unknown;
  readonly blockchain?: unknown;
  readonly txHash?: unknown;
  readonly sourceAddress?: unknown;
  readonly networkFee?: unknown;
  readonly operation?: unknown;
  readonly abiFunctionSignature?: unknown;
  readonly abiParameters?: unknown;
  readonly contractAddress?: unknown;
  readonly blockHeight?: unknown;
  readonly createDate?: unknown;
}

export interface CircleCliDriverOptions {
  readonly address: HexAddress;
  readonly chainId: bigint;
  readonly publicClient: PublicClient;
  readonly journalDirectory: string;
  readonly runner?: CircleCliRunner;
  readonly circleCommand?: string;
  /** Trusted scalar-ABI registrar used because Circle CLI cannot pass bytes32[]. */
  readonly contentRegistrar?: HexAddress;
  /** Attempts and base backoff for transient Circle failures on safe calls. */
  readonly retryAttempts?: number;
  readonly retryBaseMs?: number;
  /** How long to wait for wallet code after the deployment transfer. */
  readonly deploymentWaitMs?: number;
  readonly deploymentPollMs?: number;
}

export interface DecodedCircleCall {
  readonly abiFunctionSignature: string;
  readonly abiParameters: readonly string[];
}

export class CircleCliDriver implements ProviderWalletDriver {
  readonly provider = "circle-agent-wallet";
  readonly address: HexAddress;
  readonly chainId: bigint;
  readonly mode = "manual" as const;
  private readonly runner: CircleCliRunner;
  private readonly journal: CircleRequestJournal;
  private readonly circleChain: "ARC" | "ARC-TESTNET";
  private identityValidated = false;

  constructor(private readonly options: CircleCliDriverOptions) {
    if (
      options.chainId !== ARC_MAINNET_CHAIN_ID &&
      options.chainId !== ARC_TESTNET_CHAIN_ID
    ) {
      throw new Error(
        "CIRCLE_CHAIN_UNSUPPORTED: Circle CLI supports Arc chain IDs 5042 and 5042002",
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/u.test(options.address)) {
      throw new Error("CIRCLE_WALLET_INVALID: expected an EVM address");
    }
    this.address = options.address.toLowerCase() as HexAddress;
    this.chainId = options.chainId;
    this.circleChain =
      options.chainId === ARC_MAINNET_CHAIN_ID ? "ARC" : "ARC-TESTNET";
    this.runner =
      options.runner ?? new CircleCliProcessRunner(options.circleCommand);
    this.journal = new CircleRequestJournal(options.journalDirectory);
  }

  async balance(): Promise<bigint> {
    await this.ensureCircleIdentity();
    return this.options.publicClient.getBalance({ address: this.address });
  }

  async capabilities(): Promise<WalletCapabilities> {
    const result = unsupportedCapabilities(
      `circle-cli-1.1.0:${this.circleChain}:not-live-tested`,
    );
    result.chain = {
      supported: true,
      enforcement: "account",
      evidenceRef: `circle-cli-1.1.0:${this.circleChain}`,
    };
    result.nativeValue = {
      supported: true,
      enforcement: "wallet",
      evidenceRef: "circle-cli-1.1.0:wallet-execute-amount",
    };
    result.authenticationSignature = {
      supported: true,
      enforcement: "wallet",
      evidenceRef: "circle-cli-1.1.0:wallet-sign-message",
    };
    result.idempotentSubmission = {
      supported: true,
      enforcement: "wallet",
      evidenceRef: "circle-cli-1.1.0:wallet-execute-idempotency-key",
    };
    return result;
  }

  async deploymentStatus(): Promise<"DEPLOYED" | "UNDEPLOYED"> {
    const code = await this.options.publicClient.getCode({
      address: this.address,
    });
    return code !== undefined && code !== "0x" ? "DEPLOYED" : "UNDEPLOYED";
  }

  /**
   * Circle refuses to sign for an undeployed Agent Wallet and recommends a
   * zero-value transfer. A zero-value self-transfer moves no assets and Circle
   * sponsors its Gas, so it works even before the wallet is funded. The
   * idempotency key is derived from chain and address, so a retry after a lost
   * response cannot create a second transfer.
   */
  async deployAccount(): Promise<void> {
    if ((await this.deploymentStatus()) === "DEPLOYED") return;
    await this.ensureCircleIdentity();
    const digest = createHash("sha256")
      .update(`arcals-wallet-deploy:${this.circleChain}:${this.address}`)
      .digest("hex");
    const idempotencyKey = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `5${digest.slice(13, 16)}`,
      `8${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join("-");
    await this.runRetriable([
      "wallet",
      "transfer",
      this.address,
      "--amount",
      "0",
      "--address",
      this.address,
      "--chain",
      this.circleChain,
      "--idempotency-key",
      idempotencyKey,
      "--output",
      "json",
    ]);
    const deadline = Date.now() + (this.options.deploymentWaitMs ?? 90_000);
    while (Date.now() < deadline) {
      if ((await this.deploymentStatus()) === "DEPLOYED") return;
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.deploymentPollMs ?? 2_000),
      );
    }
    throw new Error(
      "WALLET_UNDEPLOYED: the zero-value deployment transfer did not produce wallet code in time; retry deployment",
    );
  }

  async configureMintAuthorization(
    _request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities> {
    throw new Error(
      "WALLET_CAPABILITY_UNAVAILABLE: Arcals has not live-verified every Circle policy boundary; use one-Mint manual confirmation",
    );
  }

  async signMessage(message: string): Promise<Hex> {
    const result = await this.runRetriable([
      "wallet",
      "sign",
      "message",
      message,
      "--address",
      this.address,
      "--chain",
      this.circleChain,
      "--output",
      "json",
    ]);
    const data = parseCircleData(result.stdout);
    const signature = asOptionalString(data.signature);
    if (signature === null || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(signature)) {
      throw new Error("CIRCLE_SIGN_FAILED: Circle returned no hex signature");
    }
    return signature as Hex;
  }

  async simulate(call: ContractCall): Promise<WalletSimulation> {
    this.assertCall(call);
    const executable = await this.executableCall(call);
    try {
      await this.options.publicClient.call({
        account: this.address,
        to: executable.to,
        data: executable.data,
        value: executable.valueNative,
      });
      return { success: true, diagnostic: null };
    } catch (error) {
      return {
        success: false,
        diagnostic:
          error instanceof Error
            ? sanitizeDiagnostic(error.message)
            : "contract simulation failed",
      };
    }
  }

  async estimate(call: ContractCall): Promise<WalletFeeQuote> {
    this.assertCall(call);
    const executable = await this.executableCall(call);
    const decoded = decodeCircleCall(executable.data);
    let result;
    try {
      result = await this.runRetriable([
        "wallet",
        "execute",
        decoded.abiFunctionSignature,
        ...decoded.abiParameters,
        "--contract",
        executable.to,
        "--amount",
        formatUnits(executable.valueNative, 18),
        "--address",
        this.address,
        "--chain",
        this.circleChain,
        "--estimate",
        "--output",
        "json",
      ]);
    } catch {
      // Circle's estimate endpoint can be unavailable while the rest of the
      // wallet works. The quote only bounds this CLI's own budget accounting,
      // and Circle sponsors the Gas it actually charges, so a chain estimate
      // is an honest substitute rather than a reason to abandon the work.
      return this.chainFeeQuote(executable);
    }
    const data = parseCircleData(result.stdout);
    const medium =
      data.medium !== null && typeof data.medium === "object"
        ? (data.medium as Record<string, unknown>)
        : null;
    const gasLimit = unsignedBigintOrNull(medium?.gasLimit);
    const maxGasNative = decimalNativeOrNull(medium?.networkFee);
    if (gasLimit === null || maxGasNative === null) {
      return this.chainFeeQuote(executable);
    }
    return { gasLimit, maxGasNative };
  }

  /**
   * A fee quote taken from the chain itself, with the same margins Circle's
   * medium tier applies, for when Circle cannot quote one.
   */
  private async chainFeeQuote(executable: {
    readonly to: HexAddress;
    readonly data: Hex;
    readonly valueNative: bigint;
  }): Promise<WalletFeeQuote> {
    const gas = await this.options.publicClient.estimateGas({
      account: this.address,
      to: executable.to,
      data: executable.data,
      value: executable.valueNative,
    });
    const fees = await this.options.publicClient.estimateFeesPerGas();
    const price =
      fees.maxFeePerGas ??
      fees.gasPrice ??
      (await this.options.publicClient.getGasPrice());
    // Round both up, so the budget this CLI reserves is never below the cost.
    const gasLimit = (gas * 12n) / 10n;
    return { gasLimit, maxGasNative: gasLimit * price };
  }

  async prepare(requestId: string, call: ContractCall): Promise<void> {
    this.assertCall(call);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        requestId,
      )
    ) {
      throw new Error(
        "CIRCLE_IDEMPOTENCY_INVALID: provider requestId must be UUIDv4",
      );
    }
    const executable = await this.executableCall(call);
    const decoded = decodeCircleCall(executable.data);
    this.journal.prepare({
      schemaVersion: REQUEST_SCHEMA_VERSION,
      requestId,
      address: this.address,
      chainId: this.chainId.toString(),
      contractAddress: executable.to.toLowerCase() as HexAddress,
      callData: executable.data,
      valueNative: executable.valueNative.toString(),
      abiFunctionSignature: decoded.abiFunctionSignature,
      abiParameters: decoded.abiParameters,
      preparedAt: new Date().toISOString(),
      operationId: null,
      transactionHash: null,
    });
  }

  async submit(
    requestId: string,
    call: ContractCall,
  ): Promise<{
    readonly providerOperationId: string;
    readonly transactionHash: Bytes32 | null;
  }> {
    await this.prepare(requestId, call);
    const record = this.journal.get(requestId);
    if (record === null)
      throw new Error("Circle request journal entry missing");
    const result = await this.runner.run([
      "wallet",
      "execute",
      record.abiFunctionSignature,
      ...record.abiParameters,
      "--contract",
      record.contractAddress,
      "--amount",
      formatUnits(BigInt(record.valueNative), 18),
      "--address",
      this.address,
      "--chain",
      this.circleChain,
      "--idempotency-key",
      requestId,
      "--output",
      "json",
    ]);
    const data = parseCircleData(result.stdout);
    const operationId = asOptionalString(data.id);
    if (operationId === null) {
      throw new Error(
        "CIRCLE_SUBMISSION_UNKNOWN: Circle returned no operation ID; recover the original request",
      );
    }
    const transactionHash = asBytes32OrNull(data.txHash);
    this.journal.bind(requestId, operationId, transactionHash);
    return { providerOperationId: operationId, transactionHash };
  }

  async queryOperation(providerOperationId: string): Promise<SubmissionResult> {
    return this.attributeGas(await this.queryOperationRaw(providerOperationId));
  }

  async queryRequest(requestId: string): Promise<SubmissionResult> {
    return this.attributeGas(await this.queryRequestRaw(requestId));
  }

  /**
   * Circle reports a networkFee even when its paymaster pays. Attribute Gas
   * from this wallet's UserOperationEvent instead: a non-zero paymaster means
   * the wallet was charged nothing.
   */
  private async attributeGas(
    result: SubmissionResult,
  ): Promise<SubmissionResult> {
    const unknown: SubmissionResult = {
      ...result,
      gasSpentNative: null,
      networkGasCostNative: null,
      gasSponsor: null,
      sponsorshipStatus: "UNKNOWN",
    };
    if (result.status === "REVERTED" && result.transactionHash === null) {
      // Rejected before broadcast: no transaction ran, so no Gas was spent.
      return { ...unknown, gasSpentNative: 0n, networkGasCostNative: 0n };
    }
    if (
      result.transactionHash === null ||
      (result.status !== "CONFIRMED" && result.status !== "REVERTED")
    ) {
      return unknown;
    }
    try {
      const receipt = await this.options.publicClient.getTransactionReceipt({
        hash: result.transactionHash,
      });
      const walletTopic = `0x${this.address.slice(2).padStart(64, "0")}`;
      const event = receipt.logs.find(
        (log) =>
          log.topics[0] === USER_OPERATION_EVENT_TOPIC &&
          log.topics[2]?.toLowerCase() === walletTopic,
      );
      if (event === undefined || event.topics[3] === undefined) {
        return {
          ...unknown,
          networkGasCostNative: receipt.gasUsed * receipt.effectiveGasPrice,
        };
      }
      const data = event.data.slice(2);
      const actualGasCost = BigInt(`0x${data.slice(128, 192)}`);
      const paymaster = `0x${event.topics[3].slice(26)}`.toLowerCase();
      const sponsored = BigInt(paymaster) !== 0n;
      return {
        ...result,
        gasSpentNative: sponsored ? 0n : actualGasCost,
        networkGasCostNative: actualGasCost,
        gasSponsor: sponsored ? (paymaster as HexAddress) : null,
        sponsorshipStatus: sponsored ? "SPONSORED" : "WALLET_PAID",
      };
    } catch {
      return unknown;
    }
  }

  private async queryOperationRaw(
    providerOperationId: string,
  ): Promise<SubmissionResult> {
    const record = this.journal.findByOperationId(providerOperationId);
    let listed: readonly CircleTransaction[];
    try {
      listed = await this.listTransactions();
    } catch (error) {
      if (
        record?.transactionHash !== null &&
        record?.transactionHash !== undefined
      )
        return this.queryChain(record);
      throw error;
    }
    const transaction = listed.find(
      (candidate) => candidate.id === providerOperationId,
    );
    if (transaction !== undefined) {
      return this.transactionResult(transaction, record);
    }
    if (
      record?.transactionHash !== null &&
      record?.transactionHash !== undefined
    ) {
      return this.queryChain(record);
    }
    return submission("NOT_FOUND", this.handle(record, providerOperationId));
  }

  private async queryRequestRaw(requestId: string): Promise<SubmissionResult> {
    const record = this.journal.get(requestId);
    if (record === null) return submission("UNKNOWN", null);
    if (record.operationId !== null) {
      return this.queryOperationRaw(record.operationId);
    }
    const listed = await this.listTransactions();
    let matches = listed.filter((candidate) =>
      matchesRecord(candidate, record),
    );
    if (matches.length === 0) {
      // Live Circle list items omit ABI signature/parameters. Fall back to the chain: the
      // executed transaction must contain this request's exact call data.
      matches = await this.matchByChainCallData(
        listed.filter((candidate) => {
          if (!matchesEnvelope(candidate, record)) return false;
          // Identical calls (e.g. repeated approvals) are told apart by excluding Circle
          // operations already claimed by another journaled request.
          const id = asOptionalString(candidate.id);
          const claimed =
            id === null ? null : this.journal.findByOperationId(id);
          return claimed === null || claimed.requestId === record.requestId;
        }),
        record,
      );
    }
    if (matches.length === 0) {
      // Circle can reject a request before it ever broadcasts one: the
      // transaction is terminal, carries no hash and never reaches the chain,
      // so the call-data match above cannot see it. Nothing was executed and
      // nothing was charged, and leaving it unresolved would block the wallet
      // from ever Minting again.
      matches = listed.filter((candidate) => {
        if (asBytes32OrNull(candidate.txHash) !== null) return false;
        const state = asOptionalString(candidate.state)?.toUpperCase() ?? "";
        if (state !== "FAILED" && state !== "CANCELLED" && state !== "DENIED") {
          return false;
        }
        if (!matchesEnvelope(candidate, record)) return false;
        const id = asOptionalString(candidate.id);
        const claimed = id === null ? null : this.journal.findByOperationId(id);
        return claimed === null || claimed.requestId === record.requestId;
      });
    }
    if (matches.length !== 1) return submission("UNKNOWN", null);
    const transaction = matches[0]!;
    const operationId = asOptionalString(transaction.id);
    if (operationId === null) return submission("UNKNOWN", null);
    const transactionHash = asBytes32OrNull(transaction.txHash);
    const bound = this.journal.bind(requestId, operationId, transactionHash);
    return this.transactionResult(transaction, bound);
  }

  async revoke(): Promise<void> {
    // Circle exposes no policy/session authorization for Arcals to revoke on
    // Arc. The adapter is manual and every Mint still needs Arcals consent.
  }

  private async matchByChainCallData(
    candidates: readonly CircleTransaction[],
    record: CircleRequestRecord,
  ): Promise<CircleTransaction[]> {
    const needle = record.callData.slice(2).toLowerCase();
    const verified: CircleTransaction[] = [];
    for (const candidate of candidates) {
      const hash = asBytes32OrNull(candidate.txHash);
      if (hash === null) continue;
      try {
        const transaction = (await this.options.publicClient.getTransaction({
          hash,
        })) as { input?: Hex; from?: string };
        if (
          needle.length > 0 &&
          this.transactionCarriesOwnCall(transaction, needle)
        ) {
          verified.push(candidate);
        }
      } catch {
        // An unreadable candidate stays unmatched; recovery reports UNKNOWN and retries later.
      }
    }
    return verified;
  }

  /**
   * For an ERC-4337 bundle, only this wallet's own user operation may contain the call data;
   * other senders in the same bundle never count. A plain transaction must come from this wallet.
   */
  private transactionCarriesOwnCall(
    transaction: { input?: Hex; from?: string },
    needle: string,
  ): boolean {
    const input = transaction.input ?? "0x";
    let operations: readonly {
      readonly sender: string;
      readonly callData: Hex;
    }[];
    try {
      const decoded = decodeFunctionData({
        abi: ENTRYPOINT_HANDLE_OPS_ABI,
        data: input,
      });
      operations = decoded.args[0] as typeof operations;
    } catch {
      return (
        transaction.from?.toLowerCase() === this.address &&
        input.toLowerCase().includes(needle)
      );
    }
    return operations.some(
      (operation) =>
        operation.sender.toLowerCase() === this.address &&
        operation.callData.toLowerCase().includes(needle),
    );
  }

  private async listTransactions(): Promise<readonly CircleTransaction[]> {
    const result = await this.runRetriable([
      "transaction",
      "list",
      "--address",
      this.address,
      "--chain",
      this.circleChain,
      "--operation",
      "execute",
      "--limit",
      "50",
      "--output",
      "json",
    ]);
    const data = parseCircleData(result.stdout);
    return Array.isArray(data.transactions)
      ? (data.transactions as readonly CircleTransaction[])
      : [];
  }

  /**
   * Retries Circle calls that do not move assets, or that are protected by a
   * fixed idempotency key, when the failure looks transient (network, timeout,
   * rate limit, 5xx). Contract execution submissions never use this path;
   * they rely on request journals and recovery instead.
   */
  private async runRetriable(
    args: readonly string[],
  ): Promise<CircleCliResult> {
    const attempts = this.options.retryAttempts ?? 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.runner.run(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= attempts || !TRANSIENT_CIRCLE_FAILURE.test(message)) {
          throw error;
        }
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          (this.options.retryBaseMs ?? 1_000) * 2 ** (attempt - 1),
        ),
      );
    }
  }

  private async ensureCircleIdentity(): Promise<void> {
    if (this.identityValidated) return;
    const result = await this.runRetriable([
      "wallet",
      "list",
      "--chain",
      this.circleChain,
      "--type",
      "agent",
      "--output",
      "json",
    ]);
    const data = parseCircleData(result.stdout);
    const wallets = Array.isArray(data.wallets) ? data.wallets : [];
    const matched = wallets.some((candidate) => {
      if (candidate === null || typeof candidate !== "object") return false;
      const wallet = candidate as Record<string, unknown>;
      return (
        asOptionalString(wallet.type) === "agent" &&
        asOptionalString(wallet.blockchain) === this.circleChain &&
        asOptionalString(wallet.address)?.toLowerCase() === this.address
      );
    });
    if (!matched) {
      throw new Error(
        `CIRCLE_WALLET_NOT_FOUND: log in to the ${this.circleChain === "ARC" ? "Arc Mainnet" : "Arc Testnet"} Circle session and use an address returned by circle wallet list`,
      );
    }
    this.identityValidated = true;
  }

  private transactionResult(
    transaction: CircleTransaction,
    record: CircleRequestRecord | null,
  ): SubmissionResult {
    const operationId = asOptionalString(transaction.id);
    if (operationId === null) return submission("UNKNOWN", null);
    const state = asOptionalString(transaction.state)?.toUpperCase() ?? "";
    const status =
      state === "CONFIRMED" || state === "COMPLETE"
        ? "CONFIRMED"
        : state === "FAILED" || state === "CANCELLED" || state === "DENIED"
          ? "REVERTED"
          : state === "INITIATED" ||
              state === "QUEUED" ||
              state === "SENT" ||
              state === "STUCK"
            ? "PENDING"
            : "UNKNOWN";
    return submission(status, this.handle(record, operationId), {
      transactionHash: asBytes32OrNull(transaction.txHash),
      gasSpentNative: decimalNativeOrNull(transaction.networkFee),
      blockNumber: unsignedBigintOrNull(transaction.blockHeight),
    });
  }

  private async queryChain(
    record: CircleRequestRecord,
  ): Promise<SubmissionResult> {
    const operationId = record.operationId;
    if (operationId === null || record.transactionHash === null) {
      return submission("UNKNOWN", null);
    }
    try {
      const receipt = await this.options.publicClient.getTransactionReceipt({
        hash: record.transactionHash,
      });
      return submission(
        receipt.status === "success" ? "CONFIRMED" : "REVERTED",
        this.handle(record, operationId),
        {
          transactionHash: record.transactionHash,
          gasSpentNative: receipt.gasUsed * receipt.effectiveGasPrice,
          blockNumber: receipt.blockNumber,
        },
      );
    } catch {
      try {
        await this.options.publicClient.getTransaction({
          hash: record.transactionHash,
        });
        return submission("PENDING", this.handle(record, operationId), {
          transactionHash: record.transactionHash,
        });
      } catch {
        return submission("NOT_FOUND", this.handle(record, operationId), {
          transactionHash: record.transactionHash,
        });
      }
    }
  }

  private handle(
    record: CircleRequestRecord | null,
    operationId: string,
  ): WalletHandle {
    return {
      kind: "provider-operation",
      provider: this.provider,
      requestId: record?.requestId ?? "unknown",
      operationId,
      chainId: this.chainId.toString(),
    };
  }

  private readonly verifiedRegistrars = new Set<string>();

  /**
   * Circle CLI passes every ABI argument as a string, so nested tuples and arrays fail at
   * estimation. Mint uses the Controller's mintEncoded entry; content registration goes through
   * the stateless registrar after confirming on-chain that it forwards to the same Mirror.
   */
  private async executableCall(call: ContractCall): Promise<ContractCall> {
    const signature = decodeCircleCall(call.data).abiFunctionSignature;
    if (signature.startsWith("mint(")) return buildEncodedMintCall(call);
    if (!signature.startsWith("registerContent(")) return call;
    const registrar = this.options.contentRegistrar;
    if (registrar === undefined || !isHexAddress(registrar)) {
      throw new Error(
        "CIRCLE_CALL_UNSUPPORTED: Circle CLI cannot pass bytes32[]; the manifest must name a contentRegistrar",
      );
    }
    const key = `${registrar.toLowerCase()}>${call.to.toLowerCase()}`;
    if (!this.verifiedRegistrars.has(key)) {
      const target = await this.options.publicClient.readContract({
        address: registrar,
        abi: arcalsContentRegistrarAbi,
        functionName: "mirror",
      });
      if (String(target).toLowerCase() !== call.to.toLowerCase()) {
        throw new Error(
          "UNTRUSTED_DEPLOYMENT: contentRegistrar does not forward to the trusted Mirror",
        );
      }
      this.verifiedRegistrars.add(key);
    }
    const decoded = decodeFunctionData({
      abi: arcalMirrorAbi,
      data: call.data,
    });
    const [id, packedDigits, proof] = decoded.args as readonly [
      bigint,
      Hex,
      readonly Hex[],
    ];
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }, { type: "bytes32[]" }],
      [id, packedDigits, [...proof]],
    );
    return {
      chainId: call.chainId,
      to: registrar,
      valueNative: call.valueNative,
      data: encodeFunctionData({
        abi: arcalsContentRegistrarAbi,
        functionName: "registerEncoded",
        args: [payload],
      }),
    };
  }

  private assertCall(call: ContractCall): void {
    if (call.chainId !== this.chainId) {
      throw new Error("WRONG_NETWORK: Circle call chain does not match wallet");
    }
    if (!/^0x[0-9a-fA-F]{40}$/u.test(call.to)) {
      throw new Error("CIRCLE_CALL_INVALID: expected an EVM contract address");
    }
    if (call.valueNative < 0n) {
      throw new Error("CIRCLE_CALL_INVALID: Native value cannot be negative");
    }
  }
}

function isHexAddress(value: string): value is HexAddress {
  return /^0x[0-9a-fA-F]{40}$/u.test(value);
}

export function decodeCircleCall(data: Hex): DecodedCircleCall {
  const selector = data.slice(0, 10).toLowerCase();
  const item = ARCALS_ABI.find(
    (candidate): candidate is AbiFunction =>
      candidate.type === "function" &&
      toFunctionSelector(candidate).toLowerCase() === selector,
  );
  if (item === undefined) {
    throw new Error(
      `CIRCLE_CALL_UNSUPPORTED: selector ${selector} is not in the frozen Arcals ABI`,
    );
  }
  const decoded = decodeFunctionData({ abi: [item], data });
  const args = decoded.args ?? [];
  return {
    abiFunctionSignature: toFunctionSignature(item),
    abiParameters: item.inputs.map((parameter, index) =>
      serializeCircleParameter(parameter, args[index]),
    ),
  };
}

function serializeCircleParameter(
  parameter: AbiParameter,
  value: unknown,
): string {
  const normalized = normalizeAbiValue(parameter, value);
  return Array.isArray(normalized)
    ? JSON.stringify(normalized)
    : String(normalized);
}

function normalizeAbiValue(parameter: AbiParameter, value: unknown): unknown {
  if (parameter.type === "tuple") {
    if (!("components" in parameter) || parameter.components === undefined)
      throw new Error("Tuple ABI parameter has no components");
    const components = parameter.components as readonly AbiParameter[];
    return components.map((component: AbiParameter, index: number) => {
      const componentValue = Array.isArray(value)
        ? value[index]
        : value !== null &&
            typeof value === "object" &&
            component.name !== undefined &&
            component.name !== ""
          ? (value as Record<string, unknown>)[component.name]
          : undefined;
      return normalizeAbiValue(component, componentValue);
    });
  }
  if (parameter.type.endsWith("[]")) {
    if (!Array.isArray(value))
      throw new TypeError(`Expected array for ${parameter.type}`);
    const child = { ...parameter, type: parameter.type.slice(0, -2) };
    return value.map((entry) =>
      normalizeAbiValue(child as AbiParameter, entry),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean" || typeof value === "string") return value;
  throw new TypeError(`Unsupported decoded ABI value for ${parameter.type}`);
}

function parseCircleData(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("CIRCLE_CLI_INVALID_OUTPUT: expected JSON output");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("CIRCLE_CLI_INVALID_OUTPUT: expected an object");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.error !== undefined) {
    throw new Error("CIRCLE_CLI_ERROR: Circle returned an error envelope");
  }
  const data = envelope.data;
  if (data === null || typeof data !== "object") {
    throw new Error("CIRCLE_CLI_INVALID_OUTPUT: data object is missing");
  }
  return data as Record<string, unknown>;
}

function circleFailure(
  stdout: string,
  stderr: string,
  code: number | null,
): string {
  try {
    const parsed = JSON.parse(stdout) as {
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    const errorCode = asOptionalString(parsed.error?.code) ?? "FAILED";
    const message =
      asOptionalString(parsed.error?.message) ?? "Circle command failed";
    return `CIRCLE_CLI_${errorCode}: ${sanitizeDiagnostic(message)}`;
  } catch {
    const diagnostic = sanitizeDiagnostic(stderr).trim().slice(0, 500);
    return `CIRCLE_CLI_FAILED: ${diagnostic || `process exited ${String(code)}`}`;
  }
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/0x[0-9a-fA-F]{130,}/gu, "[REDACTED_SIGNATURE]")
    .replace(
      /\b(userToken|refreshToken|encryptionKey|encryptedUserSecret|storageKey|otp)\b\s*[:=]\s*[^\s,;}]+/giu,
      "$1=[REDACTED]",
    );
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBytes32OrNull(value: unknown): Bytes32 | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)
    ? (value.toLowerCase() as Bytes32)
    : null;
}

function unsignedBigintOrNull(value: unknown): bigint | null {
  if (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value))
  ) {
    return BigInt(value);
  }
  return null;
}

function decimalNativeOrNull(value: unknown): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)
  )
    return null;
  try {
    return parseUnits(value, 18);
  } catch {
    return null;
  }
}

function submission(
  status: SubmissionResult["status"],
  handle: WalletHandle | null,
  detail: {
    readonly transactionHash?: Bytes32 | null;
    readonly gasSpentNative?: bigint | null;
    readonly blockNumber?: bigint | null;
  } = {},
): SubmissionResult {
  return {
    status,
    handle,
    transactionHash: detail.transactionHash ?? null,
    replacementHash: null,
    gasSpentNative: detail.gasSpentNative ?? null,
    blockNumber: detail.blockNumber ?? null,
  };
}

function matchesRecord(
  transaction: CircleTransaction,
  record: CircleRequestRecord,
): boolean {
  return (
    matchesEnvelope(transaction, record) &&
    asOptionalString(transaction.abiFunctionSignature) ===
      record.abiFunctionSignature &&
    Array.isArray(transaction.abiParameters) &&
    JSON.stringify(transaction.abiParameters) ===
      JSON.stringify(record.abiParameters)
  );
}

function matchesEnvelope(
  transaction: CircleTransaction,
  record: CircleRequestRecord,
): boolean {
  if (
    asOptionalString(transaction.operation) !== "CONTRACT_EXECUTION" ||
    asOptionalString(transaction.sourceAddress)?.toLowerCase() !==
      record.address ||
    asOptionalString(transaction.contractAddress)?.toLowerCase() !==
      record.contractAddress
  ) {
    return false;
  }
  const createdAt = asOptionalString(transaction.createDate);
  if (createdAt === null) return true;
  const created = Date.parse(createdAt);
  const prepared = Date.parse(record.preparedAt);
  return Number.isFinite(created) && created >= prepared - 120_000;
}

function isCircleRequestRecord(value: unknown): value is CircleRequestRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<CircleRequestRecord>;
  return (
    record.schemaVersion === REQUEST_SCHEMA_VERSION &&
    typeof record.requestId === "string" &&
    typeof record.address === "string" &&
    typeof record.chainId === "string" &&
    typeof record.contractAddress === "string" &&
    typeof record.callData === "string" &&
    typeof record.valueNative === "string" &&
    typeof record.abiFunctionSignature === "string" &&
    Array.isArray(record.abiParameters) &&
    record.abiParameters.every((entry) => typeof entry === "string") &&
    typeof record.preparedAt === "string" &&
    (record.operationId === null || typeof record.operationId === "string") &&
    (record.transactionHash === null ||
      typeof record.transactionHash === "string")
  );
}
