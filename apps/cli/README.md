# Arcals CLI

`@arcals/cli` is the `arcals` command-line client. It verifies a trusted
environment manifest, runs RandomX Fast work through the native worker, submits
Mint and conversion calls through a wallet adapter, and records every operation
in a durable local recovery ledger. All commands can emit a single versioned
JSON envelope for Agent use.

The conversational adapter is the [`arcals` Agent Skill](../../skills/arcals/SKILL.md).
It maps natural-language intent to this CLI's deterministic JSON workflow
without weakening wallet confirmation or recovery rules.

## Build and test

Node.js 22.22 or newer and pnpm are required. From the repository root:

```text
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @arcals/cli build
pnpm --filter @arcals/cli test
```

The entrypoint is `apps/cli/dist/main.js`.

## Commands

```text
arcals preflight --json
arcals wallet setup --json
arcals mine --once [--with-content] [--confirm] --json
arcals authorize [--session] --max-mints N --mint-budget NATIVE_INTEGER \
  --gas-budget NATIVE_INTEGER --until RFC3339 --json
arcals run --json
arcals status --json
arcals stop --json
arcals verify-receipt --tx 0x... --json
arcals content register --id ID [--confirm] --json
arcals form liquify --id ID [--confirm] --json
arcals form reform --expected-head ID [--confirm] --json
```

Every operational invocation also requires:

- `--manifest PATH`: a trusted, non-secret environment manifest;
- `--wallet-address 0x...`: the public address of the executing wallet;
- `--wallet-provider circle` for Circle Agent Wallets;
- `--ledger PATH`: the local recovery ledger (default
  `~/.arcals/ledger.sqlite`).

A typical Arc Mainnet invocation:

```text
node apps/cli/dist/main.js status \
  --manifest manifests/arc-mainnet.json \
  --wallet-provider circle --wallet-address 0x... \
  --ledger "$HOME/.arcals/circle-arc-mainnet-ledger.sqlite" --json
```

State-changing commands without `--confirm` return a non-spending preview in
state `NEEDS_USER_AUTH`. Private keys, mnemonics, seeds and OTPs are rejected
as command arguments. Human output is a rendering of the same envelope, not a
second state machine. The `CliEnvelope` schema is versioned in
`@arcals/protocol`, and `packages/test-fixtures/cli` holds one offline story per
command plus the one-Mint Agent preview.

### Live progress

`--progress jsonl` writes one JSON object per stage to stderr
(`{"type":"progress","stage":...}`) while stdout still carries only the final
envelope. Stages include `WALLET_DEPLOYING`, `AUTHENTICATING`, `COMPUTING`,
`VERIFYING`, `CERTIFICATE_READY`, `WALLET_SUBMITTING`, `TX_CONFIRMED`,
`CONTENT_REGISTERING` and `COMPLETE`. Consumers ignore stderr lines that are
not progress objects.

## Manifest trust

The manifest parser binds `environmentId` to `chainId + Core`, validates every
address, digest and URL, recomputes the WorkConfig digest and Epoch key, and
rejects API-provided Target or anchor tampering. Only an `arc-mainnet` manifest
may set `productionAuthorized: true`. The API, chat and websites cannot supply
or override contract addresses, worker URLs or worker hashes.

## RandomX worker

Users do not compile a trusted worker. The manifest's `worker.platforms` lists
one `binarySha256` and HTTPS `binaryUrl` per published platform (`linux-x64`,
`linux-arm64`, `darwin-arm64`, `win32-x64`). The URLs point to GitHub Release assets of
`ArcalsCircle/arcals-agent`, built by that repository's public GitHub Actions
workflow from the pinned worker source.

The CLI selects the entry for `${process.platform}-${process.arch}`, downloads
it into `~/.arcals/workers/<sha256>/`, and verifies the SHA-256 before making
the file executable. A mismatching download is never written or executed. When
no entry matches, the CLI stops with `WORKER_PLATFORM_UNSUPPORTED`; a failed
download returns `WORKER_DOWNLOAD_FAILED`. Intel macOS and Windows builds are
not published.

macOS workers are not Developer ID signed or notarized. The CLI downloads them
without the browser quarantine attribute, trust comes from the manifest hash,
and the linker's ad-hoc signature satisfies the Apple Silicon code-signing
requirement.

## Wallet adapters

| `--wallet-provider` | Manifest modes               | Purpose                                            |
| ------------------- | ---------------------------- | -------------------------------------------------- |
| `circle`            | `arc-testnet`, `arc-mainnet` | Circle Agent Wallet through Circle CLI 1.1.0       |
| `rpc-unlocked`      | `local-fixture` only         | Unlocked local node account for tests and fixtures |

The Circle adapter validates wallet identity, authenticates with
sign-message, sends the exact Native `--amount` with a documented
`--idempotency-key`, decodes typed Arcals calls, preserves provider operation
handles and keeps a durable public-input recovery journal beside the ledger.
Circle owns the session; Arcals only receives the public wallet address.
Circle Agent Wallets cannot pass `bytes32[]`, so content registration is routed
through the manifest's `contentRegistrar` after the CLI verifies on-chain that
it forwards to the trusted Mirror. The user's wallet still sends and pays.

On Arc Mainnet the adapter supports manual one-Mint confirmation. Unattended
mode stays disabled. Circle currently sponsors Agent Wallet Gas on Arc Mainnet,
but the CLI never assumes it: every operation record reports
`gasSpentNative`, `networkGasCostNative`, `gasSponsor` and
`sponsorshipStatus` (`SPONSORED`, `WALLET_PAID` or `UNKNOWN`).

The library also exposes `EoaWalletAdapter` (pre-signs so the hash and nonce
are journaled before broadcast), `ExternalWalletAdapter` (per-operation
confirmation bridge), `ProviderWalletAdapter` and `UserOperationWalletAdapter`
(preserves EntryPoint, userOpHash and account nonce).

References: Circle
[supported chains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains),
[contract execution](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/execute-contract)
and [CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference).

## Recovery and budget model

The SQLite ledger uses WAL, full synchronous commits and `0600` file mode. A
wallet or provider request ID and any precomputed EOA transaction hash and nonce
are written before broadcast. `transaction`, `provider-operation` and
`user-operation` handles stay distinct. An unknown outcome remains reserved and
blocks another Mint until the original receipt hash, handle or nonce is
resolved. Certificate expiry never cancels recovery of a transaction already
submitted. Only one CLI process may hold a ledger; a second returns
`LOCAL_LEDGER_BUSY`.

`stop` blocks new submissions and continues tracking pending work. It never
claims that an on-chain transaction was cancelled. A reverted Mint releases the
0.1 Native USDC project-fee reservation but retains actual Gas in the budget.
If a confirmed transaction has no available Gas receipt, the ledger
conservatively books the submitted maximum instead of zero. Content
registration is a separate child operation, so a content failure never causes
another Mint.

Continuous `run` needs an authorization. `authorize` without `--session`
requires the wallet or account to apply, and return evidence for, chain, native
value, ERC-721 receipt, authentication, contract and selector restrictions,
per-call and cumulative value, Mint count, Gas, expiry, revocation and
idempotent submission.

`authorize --session` covers wallets that cannot enforce those limits
themselves. The CLI then enforces the count, spend, Gas budget and expiry in its
durable ledger, so a restart cannot reset them and `stop` revokes them at once.
A session is deliberately small: at most 100 Mints and 6 hours. Every response
states which layer enforces the batch in `enforcement` and `enforcedBy`; never
present a session as wallet enforcement.
