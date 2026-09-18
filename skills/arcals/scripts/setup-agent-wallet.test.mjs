import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "arcals-skill-"));
const fakeCircle = join(directory, "circle.mjs");
const setup = new URL("./setup-agent-wallet.mjs", import.meta.url).pathname;
const loginRequestId = "123e4567-e89b-42d3-a456-426614174000";

writeFileSync(
  fakeCircle,
  `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(process.env.FAKE_CIRCLE_VERSION ?? "1.1.3"); process.exit(0); }
if (args[0] === "terms") {
  if (args[1] === "accept") {
    if (process.env.FAKE_TERMS_FILE) writeFileSync(process.env.FAKE_TERMS_FILE, "accepted");
    console.log(JSON.stringify({data:{accepted:true,currentVersion:"1"}}));
    process.exit(0);
  }
  const accepted = process.env.FAKE_TERMS === "1" || (process.env.FAKE_TERMS_FILE && existsSync(process.env.FAKE_TERMS_FILE));
  console.log(JSON.stringify({data:{accepted,...(process.env.FAKE_NO_TERMS_VERSION === "1" ? {} : {currentVersion:"1"}),termsOfUseUrl:"https://agents.circle.com/terms-of-use",privacyPolicyUrl:"https://circle.com/privacy",termsNotice:"Review the live Circle terms."}}));
  process.exit(0);
}
if (args[0] === "wallet" && args[1] === "login") {
  if (args.includes("--init")) {
    console.log(JSON.stringify({data:{message:"OTP sent. Request ID: ${loginRequestId}"}}));
    process.exit(0);
  }
  if (args.includes("--request") && args.includes("--otp")) {
    if (process.env.FAKE_LOGIN_FILE) writeFileSync(process.env.FAKE_LOGIN_FILE, "logged-in");
    console.log(JSON.stringify({data:{message:"Logged in"}}));
    process.exit(0);
  }
}
if (args[0] === "wallet" && args[1] === "transfer") {
  if (process.env.FAKE_DEPLOYED_FILE) writeFileSync(process.env.FAKE_DEPLOYED_FILE, "deployed");
  if (process.env.FAKE_TRANSFER_LOG) writeFileSync(process.env.FAKE_TRANSFER_LOG, JSON.stringify(args));
  console.log(JSON.stringify({data:{state:"COMPLETE"}}));
  process.exit(0);
}
if (args[0] === "wallet" && args[1] === "list") {
  if (process.env.FAKE_LOGIN !== "1" && !(process.env.FAKE_LOGIN_FILE && existsSync(process.env.FAKE_LOGIN_FILE))) {
    console.log(JSON.stringify({error:{code:"AUTH_REQUIRED",message:"login"}}));
    process.exit(1);
  }
  const chain = args[args.indexOf("--chain") + 1];
  console.log(JSON.stringify({data:{wallets:[{type:"agent",address:"0x2000000000000000000000000000000000000002",blockchain:chain}]}}));
  process.exit(0);
}
process.exit(2);
`,
  { mode: 0o700 },
);
chmodSync(fakeCircle, 0o700);

after(() => rmSync(directory, { recursive: true, force: true }));

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [setup, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARCALS_CIRCLE_BIN: fakeCircle,
      ARCALS_AGENT_HOME: join(directory, "home"),
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("reports the pinned Circle dependency without mutating", () => {
  const result = run(["check"]);
  assert.equal(result.state, "READY");
  assert.equal(result.data.circleCliVersion, "1.1.3");
  assert.ok(
    ["READY", "CLI_NOT_BUILT"].includes(result.data.arcalsRuntime.status),
  );
});

test("refuses a Circle CLI below the version Circle itself requires", () => {
  const result = run(["check"], { FAKE_CIRCLE_VERSION: "1.1.0" });
  assert.equal(result.state, "NEEDS_INSTALL");
  assert.equal(result.data.circleVersionSupported, false);
  assert.equal(result.data.minimumCircleCliVersion, "1.1.3");
});

test("accepts a Circle CLI newer than the tested one", () => {
  const result = run(["check"], { FAKE_CIRCLE_VERSION: "1.2.0" });
  assert.equal(result.state, "READY");
  assert.equal(result.data.circleVersionSupported, true);
});

test("reports an explicitly configured Arcals CLI", () => {
  const result = run(["check"], { ARCALS_CLI_BIN: fakeCircle });
  assert.equal(result.data.arcalsRuntime.status, "CONFIGURED");
  assert.equal(result.data.arcalsRuntime.path, fakeCircle);
});

test("requires explicit consent before a global package install", () => {
  const differentCircle = join(directory, "missing-circle");
  const result = spawnSync(process.execPath, [setup, "install-circle"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARCALS_CIRCLE_BIN: differentCircle,
      ARCALS_AGENT_HOME: join(directory, "home"),
    },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).state, "NEEDS_USER_AUTH");
});

test("discloses every official Circle skill before installing them", () => {
  const result = run(["install-circle-skills", "--tool", "codex"]);
  assert.equal(result.state, "NEEDS_USER_AUTH");
  assert.equal(result.data.source, "https://github.com/circlefin/skills");
  assert.deepEqual(result.data.skills, [
    "use-circle-cli",
    "use-agent-wallet",
    "fund-agent-wallet",
    "agent-wallet-policy",
    "use-arc",
  ]);
});

test("returns conversation-first Terms and email requests", () => {
  const termsResult = run(["onboarding", "--chain", "ARC"]);
  assert.equal(termsResult.state, "TERMS_CONFIRMATION_REQUIRED");
  assert.equal(termsResult.data.currentVersion, "1");
  assert.equal(termsResult.data.requiredInput.kind, "confirmation");
  assert.equal(termsResult.data.requiredInput.secret, false);
  assert.equal(termsResult.data.termsNotice, "Review the live Circle terms.");
  const emailResult = run(["onboarding", "--chain", "ARC"], {
    FAKE_TERMS: "1",
  });
  assert.equal(emailResult.state, "EMAIL_REQUIRED");
  assert.equal(emailResult.data.requiredInput.kind, "text");
  assert.equal(emailResult.data.nextState, "OTP_REQUIRED");
});

test("records only an explicit version-bound Terms acceptance", () => {
  const termsFile = join(directory, "terms-accepted");
  const preview = run(["accept-terms", "--chain", "ARC-TESTNET"], {
    FAKE_TERMS_FILE: termsFile,
  });
  assert.equal(preview.state, "TERMS_CONFIRMATION_REQUIRED");
  const accepted = run(
    [
      "accept-terms",
      "--chain",
      "ARC-TESTNET",
      "--terms-version",
      "1",
      "--confirm-user-accepted",
    ],
    { FAKE_TERMS_FILE: termsFile },
  );
  assert.equal(accepted.state, "TERMS_ACCEPTED");
  assert.equal(accepted.data.currentVersion, "1");
  assert.equal(accepted.data.nextState, "EMAIL_REQUIRED");
});

test("refuses a stale Terms confirmation", () => {
  const result = spawnSync(
    process.execPath,
    [
      setup,
      "accept-terms",
      "--chain",
      "ARC-TESTNET",
      "--terms-version",
      "2",
      "--confirm-user-accepted",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ARCALS_CIRCLE_BIN: fakeCircle,
        ARCALS_AGENT_HOME: join(directory, "home"),
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "TERMS_VERSION_MISMATCH");
});

test("refuses to request acceptance without a Terms version", () => {
  const result = spawnSync(
    process.execPath,
    [setup, "onboarding", "--chain", "ARC-TESTNET"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ARCALS_CIRCLE_BIN: fakeCircle,
        ARCALS_AGENT_HOME: join(directory, "home"),
        FAKE_NO_TERMS_VERSION: "1",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(
    JSON.parse(result.stdout).error.code,
    "TERMS_PRESENTATION_UNAVAILABLE",
  );
});

test("discovers the public wallet and calculates an exact bounded budget", () => {
  const result = run(["funding-plan", "--chain", "ARC", "--mints", "3"], {
    FAKE_TERMS: "1",
    FAKE_LOGIN: "1",
    ARCALS_SETUP_BASE_URL: "https://example.test/agent/setup/",
  });
  assert.equal(result.state, "FUNDING_REQUIRED");
  assert.equal(
    result.data.address,
    "0x2000000000000000000000000000000000000002",
  );
  assert.equal(result.data.projectValueNative, "300000000000000000");
  assert.equal(result.data.projectValueUsdc, "0.3");
  assert.equal(result.data.gasReserveNative, "60000000000000000");
  assert.equal(result.data.recommendedFundingUsdc, "0.36");
  assert.match(result.data.explorerAddressUrl, /explorer\.arc\.io/u);
  assert.equal(
    result.data.fundingUrl,
    "https://example.test/agent/setup/?wallet=0x2000000000000000000000000000000000000002&mints=3",
  );
  assert.equal(result.data.arcalsTrackerUrl, null);

  const testnet = run(
    ["funding-plan", "--chain", "ARC-TESTNET", "--mints", "1"],
    { FAKE_TERMS: "1", FAKE_LOGIN: "1" },
  );
  assert.equal(testnet.data.recommendedFundingMethod, "CIRCLE_TESTNET_FAUCET");
  assert.equal(testnet.data.gasReserveNative, "20000000000000000");
  assert.equal(
    testnet.data.circleFundingCommand,
    "circle wallet fund --address 0x2000000000000000000000000000000000000002 --chain ARC-TESTNET",
  );
});

test("asks for email before the official two-step Agent login", () => {
  const result = run(["login-start", "--chain", "ARC"], {
    FAKE_TERMS: "1",
  });
  assert.equal(result.state, "EMAIL_REQUIRED");
  assert.equal(result.data.requiredInput.modelVisible, true);
  const fundingResult = run(
    ["funding-plan", "--chain", "ARC", "--mints", "1"],
    { FAKE_TERMS: "1" },
  );
  assert.equal(fundingResult.state, "EMAIL_REQUIRED");
});

test("runs Circle's official ephemeral OTP login without retaining the code", () => {
  const loginFile = join(directory, "login-complete");
  const started = run(
    [
      "login-start",
      "--chain",
      "ARC-TESTNET",
      "--email",
      "secretary@example.test",
    ],
    { FAKE_TERMS: "1", FAKE_LOGIN_FILE: loginFile },
  );
  assert.equal(started.state, "OTP_REQUIRED");
  assert.equal(started.data.requestId, loginRequestId);
  assert.equal(started.data.requiredInput.modelVisible, true);
  assert.equal(started.data.requiredInput.ephemeral, true);
  assert.equal(started.data.requiredInput.persist, false);
  assert.doesNotMatch(JSON.stringify(started), /secretary@example\.test/u);

  const completed = run(
    [
      "login-complete",
      "--chain",
      "ARC-TESTNET",
      "--request-id",
      loginRequestId,
      "--otp",
      "A1B-123456",
    ],
    { FAKE_TERMS: "1", FAKE_LOGIN_FILE: loginFile },
  );
  assert.equal(completed.state, "WALLET_READY");
  assert.equal(completed.data.otpRetained, false);
  assert.doesNotMatch(JSON.stringify(completed), /A1B-123456/u);
});

test("scopes login OTPs and still rejects persistent session fields", () => {
  const cases = [
    { args: ["login-start", "--otp", "123456"], code: "OTP_SCOPE_INVALID" },
    {
      args: ["login-complete", "--session-token", "value"],
      code: "SECRET_ARGUMENT_REJECTED",
    },
    {
      args: ["login-complete", "--request-id", loginRequestId, "--otp", "bad"],
      code: "INVALID_LOGIN_OTP",
    },
  ];
  for (const item of cases) {
    const result = spawnSync(process.execPath, [setup, ...item.args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARCALS_CIRCLE_BIN: fakeCircle,
        ARCALS_AGENT_HOME: join(directory, "home"),
        FAKE_TERMS: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, item.code);
  }
});

test("reports an undeployed wallet and deploys it with one zero-value self-transfer", async () => {
  const deployedFile = join(directory, "deployed");
  const transferLog = join(directory, "transfer.json");
  const rpcScript = join(directory, "rpc.mjs");
  writeFileSync(
    rpcScript,
    `import { createServer } from "node:http";
import { existsSync } from "node:fs";
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const { id } = JSON.parse(body);
    const result = existsSync(process.env.FAKE_DEPLOYED_FILE) ? "0x6080" : "0x";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
  );
  const rpc = spawn(process.execPath, [rpcScript], {
    env: { ...process.env, FAKE_DEPLOYED_FILE: deployedFile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const port = await new Promise((done) =>
      rpc.stdout.once("data", (chunk) => done(String(chunk).trim())),
    );
    const env = {
      FAKE_TERMS: "1",
      FAKE_LOGIN: "1",
      FAKE_DEPLOYED_FILE: deployedFile,
      FAKE_TRANSFER_LOG: transferLog,
      ARCALS_ARC_RPC_URL: `http://127.0.0.1:${port}`,
    };
    const before = run(["wallet", "--chain", "ARC"], env);
    assert.equal(before.state, "WALLET_READY");
    assert.equal(before.data.deployment, "UNDEPLOYED");
    assert.equal(before.data.nextAction, "DEPLOY_WALLET");

    const deployed = run(["deploy-wallet", "--chain", "ARC"], env);
    assert.equal(deployed.state, "WALLET_DEPLOYED");
    assert.equal(deployed.data.alreadyDeployed, false);
    const args = JSON.parse(readFileSync(transferLog, "utf8"));
    assert.equal(args[2], "0x2000000000000000000000000000000000000002");
    assert.equal(args[args.indexOf("--amount") + 1], "0");
    assert.equal(
      args[args.indexOf("--address") + 1],
      "0x2000000000000000000000000000000000000002",
    );

    const again = run(["deploy-wallet", "--chain", "ARC"], env);
    assert.equal(again.data.alreadyDeployed, true);
    const after = run(["wallet", "--chain", "ARC"], env);
    assert.equal(after.data.deployment, "DEPLOYED");
    assert.equal(after.data.nextAction, undefined);
  } finally {
    rpc.kill();
  }
});
