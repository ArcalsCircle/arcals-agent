#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const SCHEMA_VERSION = "1";
// The version this Skill installs. Circle also enforces a floor server side and
// refuses wallet operations from older CLIs, so an installation that is newer
// than the tested one is accepted rather than downgraded.
const CIRCLE_VERSION = "1.1.3";
const CIRCLE_MINIMUM_VERSION = "1.1.3";
const MIN_NODE = [20, 18, 2];
const MINT_FEE_NATIVE = 100_000_000_000_000_000n;
// Circle login calls can take well over 30 s; a shorter timeout would abandon
// a live request and force the user to request a second OTP.
const LOGIN_TIMEOUT_MS = 120_000;
// Small reserve per Mint in case Circle Gas sponsorship is capped or
// unavailable. Circle currently sponsors Agent Wallet Gas on Arc, but the
// Arcals CLI reports actual sponsorship per operation and never assumes it.
const GAS_RESERVE_PER_MINT_NATIVE = {
  ARC: 20_000_000_000_000_000n,
  "ARC-TESTNET": 20_000_000_000_000_000n,
};
const OFFICIAL_CIRCLE_SKILLS = [
  "use-circle-cli",
  "use-agent-wallet",
  "fund-agent-wallet",
  "agent-wallet-policy",
  "use-arc",
];
const CIRCLE_SKILL_TOOLS = new Set([
  "amp",
  "claude-code",
  "codex",
  "cursor",
  "opencode",
]);
const VALUE_OPTIONS = new Set([
  "--chain",
  "--email",
  "--mints",
  "--otp",
  "--request-id",
  "--terms-version",
  "--tool",
]);
const FLAG_OPTIONS = new Set(["--confirm-install", "--confirm-user-accepted"]);
const CHAINS = {
  ARC: {
    chainId: "5042",
    explorer: "https://explorer.arc.io",
    rpcUrl: process.env.ARCALS_ARC_RPC_URL ?? "https://rpc.mainnet.arc.io",
    loginFlags: [],
  },
  "ARC-TESTNET": {
    chainId: "5042002",
    explorer: "https://testnet.arcscan.app",
    rpcUrl:
      process.env.ARCALS_ARC_TESTNET_RPC_URL ??
      "https://rpc.testnet.arc.network",
    loginFlags: ["--testnet"],
  },
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const circleBin = process.env.ARCALS_CIRCLE_BIN ?? "circle";
const npmBin = process.env.ARCALS_NPM_BIN ?? "npm";
const agentHome = process.env.ARCALS_AGENT_HOME ?? join(homedir(), ".arcals");
const publicWalletConfig = join(agentHome, "agent-wallet.json");

function parseArguments(command, tokens) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.startsWith("--") &&
      /private[-_]?key|mnemonic|seed|session|secret/iu.test(token)
    ) {
      fail(
        "SECRET_ARGUMENT_REJECTED",
        "Wallet secrets and authentication codes are never accepted as setup arguments.",
      );
    }
    if (FLAG_OPTIONS.has(token)) {
      flags.add(token);
      continue;
    }
    if (!token.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    }
    if (!VALUE_OPTIONS.has(token)) {
      fail("INVALID_ARGUMENT", `Unsupported option: ${token}`);
    }
    if (token === "--otp" && command !== "login-complete") {
      fail(
        "OTP_SCOPE_INVALID",
        "A Circle login OTP is accepted only by login-complete for the active request.",
      );
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `${token} requires a value`);
    }
    values[token] = value;
    index += 1;
  }
  return { values, flags };
}

function output(command, state, data = {}, error = null, ok = true) {
  process.stdout.write(
    `${JSON.stringify({
      ok,
      schemaVersion: SCHEMA_VERSION,
      command,
      state,
      data,
      error,
      asOf: new Date().toISOString(),
    })}\n`,
  );
}

function fail(code, message, details = null) {
  output(
    process.argv[2] ?? "check",
    "FAILED",
    {},
    { code, message, details },
    false,
  );
  process.exit(1);
}

function capture(binary, args, timeout = 30_000) {
  return spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 1_048_576,
    env: process.env,
  });
}

function safeJson(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function circleVersion() {
  const result = capture(circleBin, ["--version"]);
  if (result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+\.\d+\.\d+)/u);
  return match?.[1] ?? null;
}

function nodeSupported() {
  const parts = process.versions.node.split(".").map(Number);
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    if ((parts[index] ?? 0) > MIN_NODE[index]) return true;
    if ((parts[index] ?? 0) < MIN_NODE[index]) return false;
  }
  return true;
}

function runtimeStatus() {
  const configured = process.env.ARCALS_CLI_BIN;
  if (configured !== undefined && existsSync(configured)) {
    return { status: "CONFIGURED", path: configured };
  }
  const cliPath = join(repositoryRoot, "apps/cli/dist/main.js");
  const localWorker = join(
    repositoryRoot,
    "native/randomx-worker/build/arcals-randomx-worker",
  );
  if (existsSync(cliPath)) {
    // The CLI verifies the RandomX worker itself against the trusted
    // manifest: it downloads the platform release build and checks its
    // SHA-256 before use. A local build is never trusted unless its hash
    // matches the manifest entry for this platform.
    return {
      status: "READY",
      cliPath,
      worker: existsSync(localWorker)
        ? { source: "LOCAL_BUILD", path: localWorker }
        : { source: "MANIFEST_RELEASE_DOWNLOAD" },
    };
  }
  return {
    status: "CLI_NOT_BUILT",
    reason:
      "The Arcals CLI is not built in this checkout. Run pnpm install --frozen-lockfile && pnpm build at the release tag.",
  };
}

/** True when `version` is at least `minimum`, comparing numeric components. */
function atLeastVersion(version, minimum) {
  if (typeof version !== "string") return false;
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const floor = minimum.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < floor.length; index += 1) {
    const left = parts[index] ?? 0;
    const right = floor[index];
    if (left !== right) return left > right;
  }
  return true;
}

function requireCircle(command) {
  const version = circleVersion();
  if (version === null) {
    output(command, "NEEDS_INSTALL", {
      package: `@circle-fin/cli@${CIRCLE_VERSION}`,
    });
    return null;
  }
  if (!atLeastVersion(version, CIRCLE_MINIMUM_VERSION)) {
    fail(
      "CIRCLE_VERSION_UNSUPPORTED",
      `Circle CLI ${version} is below ${CIRCLE_MINIMUM_VERSION}, which Circle requires for wallet operations. Run "circle update" or install @circle-fin/cli@${CIRCLE_VERSION}.`,
    );
  }
  return version;
}

function requiredChain(values) {
  const name = values["--chain"] ?? "ARC";
  if (!(name in CHAINS)) {
    fail("UNSUPPORTED_CHAIN", "--chain must be ARC or ARC-TESTNET");
  }
  return { name, ...CHAINS[name] };
}

function terms() {
  const result = capture(circleBin, ["terms", "show", "--output", "json"]);
  const envelope = safeJson(result.stdout);
  const statusData = envelope?.data;
  const accepted = statusData?.accepted === true;
  const initResult = accepted
    ? null
    : capture(circleBin, ["terms", "show", "--init", "--output", "json"]);
  const initData =
    initResult === null ? null : safeJson(initResult.stdout)?.data;
  const data = initData ?? statusData;
  return {
    accepted,
    currentVersion:
      typeof data?.currentVersion === "string" ? data.currentVersion : null,
    termsOfUseUrl:
      typeof data?.termsOfUseUrl === "string"
        ? data.termsOfUseUrl
        : "https://agents.circle.com/terms-of-use",
    privacyPolicyUrl:
      typeof data?.privacyPolicyUrl === "string"
        ? data.privacyPolicyUrl
        : "https://www.circle.com/legal/privacy-policy",
    termsNotice:
      typeof data?.termsNotice === "string" ? data.termsNotice : null,
  };
}

function termsConfirmationData(chain, termsState) {
  if (termsState.currentVersion === null || termsState.termsNotice === null) {
    fail(
      "TERMS_PRESENTATION_UNAVAILABLE",
      "Circle did not return a Terms version and live notice; do not request unbound acceptance.",
    );
  }
  return {
    chain: chain.name,
    chainId: chain.chainId,
    ...termsState,
    requiredInput: {
      kind: "confirmation",
      purpose: "circle-terms-acceptance",
      modelVisible: true,
      secret: false,
      binding: {
        termsVersion: termsState.currentVersion,
        termsOfUseUrl: termsState.termsOfUseUrl,
        privacyPolicyUrl: termsState.privacyPolicyUrl,
        termsNotice: termsState.termsNotice,
      },
    },
  };
}

function emailRequiredData(chain) {
  return {
    chain: chain.name,
    chainId: chain.chainId,
    requiredInput: {
      kind: "text",
      purpose: "circle-login-email",
      modelVisible: true,
      secret: false,
    },
    nextState: "OTP_REQUIRED",
  };
}

function otpRequiredData(chain, requestId) {
  return {
    chain: chain.name,
    chainId: chain.chainId,
    requestId,
    expiresInSeconds: 600,
    requiredInput: {
      kind: "otp",
      purpose: "circle-agent-wallet-login",
      modelVisible: true,
      ephemeral: true,
      persist: false,
      acceptedFormats: ["ABC-123456", "123456"],
    },
  };
}

function validateEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    fail("INVALID_EMAIL", "Enter a valid Circle login email.");
  }
}

function validateRequestId(requestId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      requestId,
    )
  ) {
    fail("INVALID_LOGIN_REQUEST", "Circle login request ID must be a UUID.");
  }
}

function validateLoginOtp(otp) {
  if (!/^(?:[A-Z0-9]{3}-)?[0-9]{6}$/u.test(otp)) {
    fail(
      "INVALID_LOGIN_OTP",
      "Circle login OTP must be six digits or the prefixed ABC-123456 form.",
    );
  }
}

function requestIdFromLoginOutput(stdout) {
  const match = stdout.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  );
  return match?.[0] ?? null;
}

function discoverWallet(chain) {
  const result = capture(circleBin, [
    "wallet",
    "list",
    "--chain",
    chain.name,
    "--type",
    "agent",
    "--output",
    "json",
  ]);
  const envelope = safeJson(result.stdout);
  if (result.status !== 0) {
    const code = envelope?.error?.code;
    if (code === "AUTH_REQUIRED") return { state: "LOGIN_REQUIRED" };
    fail(
      "CIRCLE_WALLET_DISCOVERY_FAILED",
      "Circle could not list the Agent Wallet. Inspect the local Circle CLI directly.",
    );
  }
  const wallets = Array.isArray(envelope?.data?.wallets)
    ? envelope.data.wallets
        .filter(
          (wallet) =>
            wallet !== null &&
            typeof wallet === "object" &&
            wallet.type === "agent" &&
            wallet.blockchain === chain.name &&
            typeof wallet.address === "string" &&
            /^0x[0-9a-fA-F]{40}$/u.test(wallet.address),
        )
        .map((wallet) => ({
          address: wallet.address.toLowerCase(),
          blockchain: wallet.blockchain,
          type: wallet.type,
        }))
    : [];
  if (wallets.length === 0) return { state: "WALLET_NOT_FOUND" };
  if (wallets.length > 1)
    return { state: "WALLET_SELECTION_REQUIRED", wallets };
  return { state: "WALLET_READY", wallet: wallets[0] };
}

function walletState(command, chain) {
  if (requireCircle(command) === null) return null;
  const termsState = terms();
  if (!termsState.accepted) {
    output(
      command,
      "TERMS_CONFIRMATION_REQUIRED",
      termsConfirmationData(chain, termsState),
    );
    return null;
  }
  return discoverWallet(chain);
}

function savePublicWallet(chain, wallet) {
  mkdirSync(agentHome, { recursive: true, mode: 0o700 });
  chmodSync(agentHome, 0o700);
  writeFileSync(
    publicWalletConfig,
    `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        provider: "circle-agent-wallet",
        circleCliVersion: CIRCLE_VERSION,
        chain: chain.name,
        chainId: chain.chainId,
        address: wallet.address,
        secretsStoredBy: "circle-cli",
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(publicWalletConfig, 0o600);
}

/**
 * Circle Agent Wallets deploy lazily and Circle refuses to sign for an
 * undeployed wallet. Returns DEPLOYED, UNDEPLOYED or UNKNOWN (RPC unreachable).
 */
async function walletDeployment(chain, address) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(chain.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [address, "latest"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      if (typeof body.result === "string") {
        return body.result !== "0x" ? "DEPLOYED" : "UNDEPLOYED";
      }
    } catch {
      // Retry below; public RPCs rate-limit bursts.
    }
    await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
  }
  return "UNKNOWN";
}

function deploymentIdempotencyKey(chain, address) {
  const digest = createHash("sha256")
    .update(`arcals-wallet-deploy:${chain.name}:${address.toLowerCase()}`)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function deploymentData(deployment) {
  return {
    deployment,
    ...(deployment === "UNDEPLOYED"
      ? {
          nextAction: "DEPLOY_WALLET",
          deploymentNote:
            "Circle signs only for deployed wallets. deploy-wallet sends a zero-value self-transfer: no assets move and Circle pays the Gas, so it works before funding. A confirmed first Mint also deploys automatically.",
        }
      : {}),
  };
}

function formatNative(value) {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

async function main() {
  const command = process.argv[2] ?? "check";
  const parsed = parseArguments(command, process.argv.slice(3));
  const chain = requiredChain(parsed.values);

  if (command === "check") {
    const version = circleVersion();
    const supported = atLeastVersion(version, CIRCLE_MINIMUM_VERSION);
    output(command, supported ? "READY" : "NEEDS_INSTALL", {
      nodeVersion: process.versions.node,
      nodeSupported: nodeSupported(),
      circleCliVersion: version,
      testedCircleCliVersion: CIRCLE_VERSION,
      minimumCircleCliVersion: CIRCLE_MINIMUM_VERSION,
      circleVersionSupported: supported,
      arcalsRuntime: runtimeStatus(),
      officialCircleSkills: OFFICIAL_CIRCLE_SKILLS,
    });
    return;
  }

  if (command === "install-circle") {
    if (!nodeSupported()) {
      fail(
        "NODE_VERSION_UNSUPPORTED",
        "Circle CLI requires Node.js 20.18.2 or later.",
      );
    }
    const current = circleVersion();
    if (atLeastVersion(current, CIRCLE_MINIMUM_VERSION)) {
      output(command, "ALREADY_INSTALLED", {
        circleCliVersion: current,
      });
      return;
    }
    if (!parsed.flags.has("--confirm-install")) {
      output(command, "NEEDS_USER_AUTH", {
        mutation: "GLOBAL_NPM_INSTALL",
        package: `@circle-fin/cli@${CIRCLE_VERSION}`,
        warning: "This changes software in the user's Agent environment.",
      });
      return;
    }
    const installed = spawnSync(
      npmBin,
      ["install", "-g", `@circle-fin/cli@${CIRCLE_VERSION}`],
      { stdio: "inherit", timeout: 300_000, env: process.env },
    );
    if (
      installed.status !== 0 ||
      !atLeastVersion(circleVersion(), CIRCLE_MINIMUM_VERSION)
    ) {
      fail(
        "CIRCLE_INSTALL_FAILED",
        "The pinned Circle CLI installation did not complete successfully.",
      );
    }
    output(command, "INSTALLED", { circleCliVersion: CIRCLE_VERSION });
    return;
  }

  if (command === "install-circle-skills") {
    const tool = parsed.values["--tool"];
    if (tool === undefined || !CIRCLE_SKILL_TOOLS.has(tool)) {
      fail(
        "INVALID_TOOL",
        "--tool must be amp, claude-code, codex, cursor, or opencode",
      );
    }
    if (!parsed.flags.has("--confirm-install")) {
      output(command, "NEEDS_USER_AUTH", {
        mutation: "INSTALL_OFFICIAL_CIRCLE_SKILLS",
        source: "https://github.com/circlefin/skills",
        tool,
        skills: OFFICIAL_CIRCLE_SKILLS,
      });
      return;
    }
    if (requireCircle(command) === null) return;
    const termsState = terms();
    if (!termsState.accepted) {
      output(
        command,
        "TERMS_CONFIRMATION_REQUIRED",
        termsConfirmationData(chain, termsState),
      );
      return;
    }
    for (const skill of OFFICIAL_CIRCLE_SKILLS) {
      const installed = spawnSync(
        circleBin,
        ["skill", "install", "--tool", tool, "--name", skill],
        { stdio: "inherit", timeout: 120_000, env: process.env },
      );
      if (installed.status !== 0) {
        fail(
          "CIRCLE_SKILL_INSTALL_FAILED",
          `Circle did not install the official ${skill} skill.`,
        );
      }
    }
    output(command, "INSTALLED", {
      source: "circlefin/skills",
      tool,
      skills: OFFICIAL_CIRCLE_SKILLS,
    });
    return;
  }

  if (command === "accept-terms") {
    if (requireCircle(command) === null) return;
    const termsState = terms();
    if (termsState.accepted) {
      output(command, "ALREADY_ACCEPTED", {
        currentVersion: termsState.currentVersion,
      });
      return;
    }
    if (
      !parsed.flags.has("--confirm-user-accepted") ||
      parsed.values["--terms-version"] === undefined
    ) {
      output(
        command,
        "TERMS_CONFIRMATION_REQUIRED",
        termsConfirmationData(chain, termsState),
      );
      return;
    }
    if (
      termsState.currentVersion === null ||
      parsed.values["--terms-version"] !== termsState.currentVersion
    ) {
      fail(
        "TERMS_VERSION_MISMATCH",
        "The confirmed Circle Terms version does not match the current version; present the current links again.",
      );
    }
    const accepted = spawnSync(
      circleBin,
      ["terms", "accept", "--output", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 1_048_576,
        env: process.env,
      },
    );
    if (accepted.status !== 0) {
      fail(
        "TERMS_ACCEPTANCE_FAILED",
        "Circle did not record the user's explicit Terms acceptance.",
      );
    }
    const recordedTerms = terms();
    if (
      !recordedTerms.accepted ||
      recordedTerms.currentVersion !== termsState.currentVersion
    ) {
      fail(
        "TERMS_ACCEPTANCE_NOT_RECORDED",
        "Circle returned without recording the confirmed Terms version.",
      );
    }
    output(command, "TERMS_ACCEPTED", {
      currentVersion: termsState.currentVersion,
      nextState: "EMAIL_REQUIRED",
    });
    return;
  }

  if (command === "wallet" || command === "onboarding") {
    const state = walletState(command, chain);
    if (state === null) return;
    if (state.state === "LOGIN_REQUIRED") {
      output(command, "EMAIL_REQUIRED", emailRequiredData(chain));
      return;
    }
    output(command, state.state, {
      chain: chain.name,
      chainId: chain.chainId,
      ...(state.wallet === undefined ? {} : { wallet: state.wallet }),
      ...(state.wallets === undefined ? {} : { wallets: state.wallets }),
      ...(state.state === "WALLET_READY"
        ? deploymentData(await walletDeployment(chain, state.wallet.address))
        : {}),
    });
    return;
  }

  if (command === "deploy-wallet") {
    const state = walletState(command, chain);
    if (state === null) return;
    if (state.state !== "WALLET_READY") {
      output(command, state.state, { chain: chain.name });
      return;
    }
    const address = state.wallet.address;
    if ((await walletDeployment(chain, address)) === "DEPLOYED") {
      output(command, "WALLET_DEPLOYED", {
        chain: chain.name,
        chainId: chain.chainId,
        wallet: state.wallet,
        alreadyDeployed: true,
      });
      return;
    }
    const transfer = capture(
      circleBin,
      [
        "wallet",
        "transfer",
        address,
        "--amount",
        "0",
        "--address",
        address,
        "--chain",
        chain.name,
        "--idempotency-key",
        deploymentIdempotencyKey(chain, address),
        "--output",
        "json",
      ],
      120_000,
    );
    if (transfer.status !== 0) {
      fail(
        "WALLET_DEPLOYMENT_FAILED",
        "Circle did not accept the zero-value deployment transfer. Retry deploy-wallet; the same idempotency key prevents duplicates.",
      );
    }
    const waitMs = Number(process.env.ARCALS_DEPLOYMENT_WAIT_MS ?? "90000");
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if ((await walletDeployment(chain, address)) === "DEPLOYED") {
        output(command, "WALLET_DEPLOYED", {
          chain: chain.name,
          chainId: chain.chainId,
          wallet: state.wallet,
          alreadyDeployed: false,
        });
        return;
      }
      await new Promise((done) => setTimeout(done, 2_000));
    }
    fail(
      "WALLET_UNDEPLOYED",
      "The deployment transfer was accepted but wallet code did not appear in time. Retry deploy-wallet.",
    );
  }

  if (command === "login") {
    if (requireCircle(command) === null) return;
    const termsState = terms();
    if (!termsState.accepted) {
      output(
        command,
        "TERMS_CONFIRMATION_REQUIRED",
        termsConfirmationData(chain, termsState),
      );
      return;
    }
    const suppliedEmail = parsed.values["--email"];
    if (suppliedEmail === undefined && !process.stdin.isTTY) {
      output(command, "EMAIL_REQUIRED", emailRequiredData(chain));
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail(
        "INTERACTIVE_TTY_REQUIRED",
        "Use login-start and login-complete for the official non-interactive Agent flow.",
      );
    }
    let email = suppliedEmail;
    if (email === undefined) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      email = (await prompt.question("Circle login email: ")).trim();
      prompt.close();
    }
    validateEmail(email);
    const login = spawnSync(
      circleBin,
      ["wallet", "login", email, "--type", "agent", ...chain.loginFlags],
      { stdio: "inherit", timeout: 600_000, env: process.env },
    );
    if (login.status !== 0) {
      fail(
        "CIRCLE_LOGIN_FAILED",
        "Circle authentication did not complete. No wallet secret was stored by Arcals.",
      );
    }
    const state = discoverWallet(chain);
    if (state.state !== "WALLET_READY") {
      fail(
        "CIRCLE_WALLET_NOT_READY",
        "Login completed but exactly one Arc Agent Wallet was not discoverable.",
      );
    }
    savePublicWallet(chain, state.wallet);
    output(command, "WALLET_READY", {
      chain: chain.name,
      chainId: chain.chainId,
      wallet: state.wallet,
      publicConfigPath: publicWalletConfig,
    });
    return;
  }

  if (command === "login-start") {
    if (requireCircle(command) === null) return;
    const termsState = terms();
    if (!termsState.accepted) {
      output(
        command,
        "TERMS_CONFIRMATION_REQUIRED",
        termsConfirmationData(chain, termsState),
      );
      return;
    }
    const email = parsed.values["--email"];
    if (email === undefined) {
      output(command, "EMAIL_REQUIRED", emailRequiredData(chain));
      return;
    }
    validateEmail(email);
    const started = capture(
      circleBin,
      [
        "wallet",
        "login",
        email,
        "--type",
        "agent",
        ...chain.loginFlags,
        "--init",
        "--output",
        "json",
      ],
      LOGIN_TIMEOUT_MS,
    );
    if (started.status !== 0) {
      fail(
        "CIRCLE_LOGIN_START_FAILED",
        "Circle did not start the Agent Wallet login request.",
      );
    }
    const requestId = requestIdFromLoginOutput(started.stdout);
    if (requestId === null) {
      fail(
        "CIRCLE_LOGIN_REQUEST_MISSING",
        "Circle started login without returning a usable request ID.",
      );
    }
    output(command, "OTP_REQUIRED", otpRequiredData(chain, requestId));
    return;
  }

  if (command === "login-complete") {
    if (requireCircle(command) === null) return;
    const requestId = parsed.values["--request-id"];
    const otp = parsed.values["--otp"];
    if (requestId === undefined || otp === undefined) {
      fail(
        "LOGIN_INPUT_REQUIRED",
        "login-complete requires the active --request-id and one-time --otp.",
      );
    }
    validateRequestId(requestId);
    validateLoginOtp(otp);
    const completed = capture(
      circleBin,
      [
        "wallet",
        "login",
        "--type",
        "agent",
        ...chain.loginFlags,
        "--request",
        requestId,
        "--otp",
        otp,
        "--output",
        "json",
      ],
      LOGIN_TIMEOUT_MS,
    );
    if (completed.status !== 0) {
      fail(
        "CIRCLE_LOGIN_FAILED",
        "Circle rejected or expired the one-time login request. Start a fresh request before retrying.",
      );
    }
    const state = discoverWallet(chain);
    if (state.state !== "WALLET_READY") {
      fail(
        "CIRCLE_WALLET_NOT_READY",
        "Login completed but exactly one Arc Agent Wallet was not discoverable.",
      );
    }
    savePublicWallet(chain, state.wallet);
    output(command, "WALLET_READY", {
      chain: chain.name,
      chainId: chain.chainId,
      wallet: state.wallet,
      publicConfigPath: publicWalletConfig,
      otpRetained: false,
      ...deploymentData(await walletDeployment(chain, state.wallet.address)),
    });
    return;
  }

  if (command === "funding-plan") {
    const mintsText = parsed.values["--mints"] ?? "1";
    if (!/^[1-9][0-9]*$/u.test(mintsText)) {
      fail("INVALID_MINT_COUNT", "--mints must be a positive integer");
    }
    const mints = Number(mintsText);
    if (!Number.isSafeInteger(mints) || mints > 1_000) {
      fail("INVALID_MINT_COUNT", "--mints must be between 1 and 1000");
    }
    const state = walletState(command, chain);
    if (state === null) return;
    if (state.state !== "WALLET_READY") {
      if (state.state === "LOGIN_REQUIRED") {
        output(command, "EMAIL_REQUIRED", emailRequiredData(chain));
        return;
      }
      output(command, state.state, { chain: chain.name });
      return;
    }
    const requiredNative = BigInt(mints) * MINT_FEE_NATIVE;
    const gasReserveNative =
      BigInt(mints) * GAS_RESERVE_PER_MINT_NATIVE[chain.name];
    const recommendedNative = requiredNative + gasReserveNative;
    output(command, "FUNDING_REQUIRED", {
      chain: chain.name,
      chainId: chain.chainId,
      address: state.wallet.address,
      maxMints: mints,
      projectValueNative: requiredNative.toString(),
      projectValueUsdc: formatNative(requiredNative),
      gas: "CIRCLE_SPONSORED_OR_ADDITIONAL; VERIFY_AT_PREFLIGHT",
      gasReserveNative: gasReserveNative.toString(),
      recommendedFundingNative: recommendedNative.toString(),
      recommendedFundingUsdc: formatNative(recommendedNative),
      explorerAddressUrl: `${chain.explorer}/address/${state.wallet.address}`,
      recommendedFundingMethod:
        chain.name === "ARC-TESTNET"
          ? "CIRCLE_TESTNET_FAUCET"
          : "BOUNDED_EXTERNAL_TRANSFER",
      circleFundingCommand:
        chain.name === "ARC-TESTNET"
          ? `circle wallet fund --address ${state.wallet.address} --chain ARC-TESTNET`
          : null,
      ...(process.env.ARCALS_SETUP_BASE_URL === undefined
        ? { fundingUrl: null }
        : {
            fundingUrl: `${process.env.ARCALS_SETUP_BASE_URL}?wallet=${encodeURIComponent(state.wallet.address)}&mints=${String(mints)}`,
          }),
      ...(process.env.ARCALS_TRACKER_BASE_URL === undefined
        ? { arcalsTrackerUrl: null }
        : {
            arcalsTrackerUrl: `${process.env.ARCALS_TRACKER_BASE_URL}?wallet=${encodeURIComponent(state.wallet.address)}`,
          }),
      automaticTransfer: false,
      warning:
        "Fund only the operational budget you intend the Agent Wallet to use.",
    });
    return;
  }

  fail(
    "UNKNOWN_COMMAND",
    "Expected check, install-circle, install-circle-skills, onboarding, accept-terms, wallet, login, login-start, login-complete, deploy-wallet, or funding-plan.",
  );
}

await main();
