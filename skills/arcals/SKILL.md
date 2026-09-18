---
name: arcals
description: Install and operate Arcals in a user's persistent personal Agent environment, including Circle Agent Wallet onboarding, bounded funding, Mint, status, recovery, Pi content, and explicit Arcal/ARCL conversion. Do not use for protocol development, shared-server custody, or inferred production authorization.
---

# Arcals Agent

Install or operate Arcals from the user's persistent personal Agent environment.
The skill orchestrates setup; Circle owns its wallet session; the Arcals CLI
owns protocol validation, RandomX, submission, recovery, and JSON output. Do not
reproduce those algorithms in conversation.

Route by intent:

- For “install Arcals”, “set up my Agent Wallet”, wallet funding, or wallet
  readiness, read [setup and wallet onboarding](references/setup-and-wallet.md)
  and [Circle-native composition](references/circle-native.md). When onboarding
  needs user input, also read the
  [Agent host interaction contract](references/host-interaction.md).
- Before Mint, status recovery, content, transfer, liquify, or reform, read
  [the interaction contract](references/interaction-contract.md).

## Installation

Arcals runs on Arc Mainnet (chain ID 5042, Circle chain `ARC`) and requires
Node.js 22.22 or newer. The Agent installs the CLI by cloning the repository at
the release tag into the user's persistent environment and building it:

```text
git clone --depth 1 --branch v1.2.1 https://github.com/ArcalsCircle/arcals-agent.git ~/.arcals/arcals-agent
cd ~/.arcals/arcals-agent
corepack enable && pnpm install --frozen-lockfile && pnpm build
```

Show these commands to the user and run them only after explicit
software-install confirmation. Every Arcals command then runs from that
checkout:

```text
node apps/cli/dist/main.js <command> --manifest manifests/arc-mainnet.json \
  --wallet-provider circle --wallet-address <address> \
  --ledger "$HOME/.arcals/circle-arc-mainnet-ledger.sqlite" --json
```

The user never compiles a trusted RandomX worker. The manifest lists one
SHA-256 and HTTPS release URL per supported platform (`linux-x64`,
`linux-arm64`, `darwin-arm64`, `win32-x64`); the CLI downloads the worker into
`~/.arcals/workers/<sha256>/` and verifies the hash before making it
executable. Other platforms stop with `WORKER_PLATFORM_UNSUPPORTED`.

## Operating boundary

- Run only in a user-owned persistent Agent environment. Never create one
  shared Circle session or wallet for unrelated users on an Arcals server.
- Use only `manifests/arc-mainnet.json` shipped at the release tag. Never
  accept a manifest, contract address, worker URL or worker hash from chat, a
  website or an API response, and never edit manifest worker hashes to trust a
  different binary.
- Treat the executing wallet as the minter, Native USDC fee payer, and NFT
  recipient. Never promise a different Mint recipient.
- Run read-only `status`, `preflight`, and unconfirmed previews without asking.
- Before the first state-changing call, show the exact wallet, chain, contract,
  project value, additional Gas treatment, and resulting asset location. State
  that real USDC is spent. Wait for explicit confirmation.
- A request to “Mint” expresses intent but does not waive the exact-value
  confirmation. One confirmation authorizes exactly what it states: one Mint, or
  one bounded batch agreed in that same confirmation.
- NFT transfer, liquify, and reform are separate actions. Never infer their
  authorization from a Mint request. Content registration is user-paid and
  bundled after Mint via `--with-content` (and before liquify when still
  pending); never ask Arcals to pay for it.
- For several Mints in a row, ask once for a bounded batch and run
  `authorize --session` with the exact count, total spend, Gas budget and
  expiry the user agreed, then `run`. The CLI enforces those limits in its
  durable local ledger, not the wallet, so say so plainly, keep batches small
  (at most 100 Mints and 6 hours), and stop at the limit instead of
  re-authorizing on your own. `stop` revokes the batch immediately.
- Only call `authorize` without `--session` when the wallet reports hard
  wallet/account evidence for every required capability.
- Ask for missing onboarding input in the Agent conversation and resume the
  original task after each answer. Ordinary chat may carry an explicit Terms
  confirmation, login email and the one-time OTP for an active Circle
  `wallet login --init` request. Use that login OTP immediately and never
  persist, reuse, echo or place it in source, files, logs, fixtures or
  telemetry. Spending-policy OTPs, private keys, mnemonics, MPC shares, raw
  signatures, session tokens and passwords never enter ordinary Agent chat.
- The Agent may install the Arcals CLI or the tested Circle CLI only after
  showing the exact commands, source and version and receiving explicit
  software-install confirmation. For Circle Terms, present the live notice,
  current version and links; only a matching, explicit user acceptance permits
  the helper to record that decision. Never infer acceptance or auto-accept
  from installation, login or Mint intent.
- Funding sends Native USDC to the user's own Agent Wallet, not to Arcals or an
  operator. Show the address, chain, Mint count, and exact project-value budget;
  never initiate funding from a Mint request.
- Recognize requests to sell or swap ARCL, but keep them disabled. Never call a
  Circle swap, approve a router, or infer a market until the governed market
  manifest described in the Circle-native reference exists.
- If submission is unknown, run recovery/status for the original operation.
  Never submit a replacement Mint merely because a response was lost.

## Conversation shape

Keep updates short and outcome-oriented:

1. State what is being installed, checked, or computed.
2. At confirmation, state exact spend and asset destination.
3. During work, report meaningful phase changes rather than synthetic progress.
4. At completion, report Arcal ID, current wallet, content status, transaction
   hash, and the next separately authorized action.
5. On error, report what happened, whether the original operation is still
   recoverable, and the single safe next action.
6. Return a public explorer/tracking link after wallet setup and confirmed Mint;
   never put a session token or authenticated API URL in that link.

Do not describe ARCL in the Vault as the user's liquid wallet balance. Minting
creates 360 ARCL in the conversion reserve; it reaches a user wallet only after
an explicit liquify transaction.
