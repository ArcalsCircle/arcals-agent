# Arcals setup and Agent Wallet onboarding

Use this reference when a user asks their Agent to install Arcals, create or
recover an Agent Wallet, fund it, or check whether setup is ready.

## Execution model

The Arcals Skill, Arcals CLI and Circle CLI run inside the user's persistent
personal Agent environment. Circle creates a user-controlled Agent Wallet for
that user. The Arcals backend never receives the email OTP, MPC share, Circle
session, private key, or wallet password.

Do not install one shared Circle session on an Arcals application server for
multiple users. A stateless chat without a persistent filesystem and secure
interactive input cannot own this wallet flow.

## Deterministic setup helper

Resolve this path relative to the installed skill:

```text
scripts/setup-agent-wallet.mjs
```

The helper emits one JSON object. It accepts a user-provided login email, a
version-bound assertion that the user explicitly accepted the displayed Terms,
and a one-time Circle **login** OTP for an active request. It never persists or
echoes that OTP and never accepts spending-policy OTPs, private keys, sessions
or other persistent wallet secrets.

Every example uses Circle chain `ARC` (Arc Mainnet); always pass `--chain ARC`
explicitly. The helper also accepts `--chain ARC-TESTNET` for development.

Start read-only:

```text
node scripts/setup-agent-wallet.mjs check --chain ARC
```

If it returns `NEEDS_INSTALL`, show the exact mutation
`npm install -g @circle-fin/cli@1.1.3`. Only after the user explicitly approves
that software installation, run:

```text
node scripts/setup-agent-wallet.mjs install-circle --chain ARC --confirm-install
```

Never silently replace a different installed Circle CLI version. Circle
enforces a minimum version on its own servers and refuses wallet operations
from older CLIs with `VERSION_BLOCKED`; an installation at or above the
minimum is accepted as is, and one below it is upgraded with `circle update`
only after the user approves.

## Conversation-first onboarding

Start or resume the state machine with:

```text
node scripts/setup-agent-wallet.mjs onboarding --chain ARC
```

The Agent asks for one missing input at a time and resumes the original setup
request automatically:

```text
CHECK
→ TERMS_CONFIRMATION_REQUIRED
→ EMAIL_REQUIRED
→ OTP_REQUIRED
→ WALLET_READY
→ FUNDING_REQUIRED
```

Read the [host interaction contract](host-interaction.md) before collecting
input. Users do not need to understand or copy Circle CLI commands.

## Human authentication boundary

Check public readiness with:

```text
node scripts/setup-agent-wallet.mjs wallet --chain ARC
```

Handle states as follows:

| State                         | Agent action                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `TERMS_CONFIRMATION_REQUIRED` | Present live notice, exact version and URLs; ask in conversation; never infer acceptance |
| `EMAIL_REQUIRED`              | Ask for the Circle login email in conversation                                           |
| `OTP_REQUIRED`                | Ask for the active login OTP, use it once immediately, then discard it                   |
| `WALLET_SELECTION_REQUIRED`   | Show only public addresses and ask which wallet to use                                   |
| `WALLET_READY`                | Report full address and chain, then offer a funding plan                                 |

`WALLET_READY` also reports `deployment`. A new Circle Agent Wallet is
`UNDEPLOYED` until its first transaction, and Circle refuses to sign for it.
Either let the first confirmed Mint deploy it (the Mint preview lists the
deployment step), or run the free, asset-free deployment during setup after
telling the user what it does:

```text
node scripts/setup-agent-wallet.mjs deploy-wallet --chain ARC
```

It sends one zero-value self-transfer with a fixed idempotency key and returns
`WALLET_DEPLOYED` once wallet code exists. It works before funding because
Circle pays its Gas.

After the user explicitly accepts the exact displayed version, the Agent may
record that decision:

```text
node scripts/setup-agent-wallet.mjs accept-terms \
  --chain ARC \
  --terms-version <displayed-version> \
  --confirm-user-accepted
```

This command does not make the legal decision. It is invalid without the
user's immediately preceding version-bound confirmation.

Use Circle's official two-step non-interactive Agent flow:

```text
node scripts/setup-agent-wallet.mjs login-start \
  --chain ARC \
  --email <user-provided-email>
```

The helper returns `OTP_REQUIRED`, a request ID and a ten-minute window. Ask for
the OTP and immediately run:

```text
node scripts/setup-agent-wallet.mjs login-complete \
  --chain ARC \
  --request-id <active-request-id> \
  --otp <one-time-code>
```

Do not write the OTP to a ledger, file, transcript summary or telemetry. If it
fails or expires, tell the user before starting one fresh request. Circle
Mainnet and Testnet sessions are separate.

## Funding is not Mint authorization

After exactly one wallet is ready, calculate a bounded plan:

```text
node scripts/setup-agent-wallet.mjs funding-plan --chain ARC --mints 1
```

Use Circle's `fund-agent-wallet` flow, or tell the user to send USDC on Arc for
the Mints they want (0.1 USDC each plus a small margin) to the Agent Wallet
address from any wallet or exchange they control. Never connect a wallet or
build a funding transaction on the user's behalf.

Show:

- full Agent Wallet address and chain ID;
- exact project value, `0.1 Native USDC × maxMints`;
- Gas as sponsored or additional pending preflight evidence;
- public explorer address link;
- the warning that funding does not authorize Mint or asset transfer.

The user funds their own Agent Wallet from a wallet or onramp they control. Do
not automatically transfer funds, infer a larger budget, or treat a wallet
balance as permission to spend it.

## Arcals runtime availability

`check` reports `arcalsRuntime.status`:

- `READY`: the checkout that contains this skill has a built CLI at `cliPath`.
  The CLI verifies the RandomX worker itself: it downloads the platform release
  build named by the manifest and checks its SHA-256 before use.
- `CONFIGURED`: `ARCALS_CLI_BIN` points to an installed Arcals CLI.
- `CLI_NOT_BUILT`: the CLI is not built. After software-install confirmation,
  follow the installation steps in [SKILL.md](../SKILL.md) at the release tag.

Never build a worker and edit the manifest to trust it, install from an
unpinned branch, or download a binary that the manifest does not name.

## What the user can observe

After setup, return the public explorer link immediately. During Mint, the
personal Agent reports local phases. Once a transaction exists, return its
public transaction link. Confirmed ownership and Arcal IDs are public chain
state for the Agent Wallet address, readable from the explorer or the Arcals
API (`apiUrl` in the manifest). Never place Circle session material in a link.
