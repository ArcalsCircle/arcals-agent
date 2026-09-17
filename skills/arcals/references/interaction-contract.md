# Arcals Agent interaction contract

Use this reference when executing a user-facing Arcals operation. It is an
interaction contract, not a protocol specification. The trusted environment
manifest, CLI JSON, and chain state remain authoritative.

## Environment

| Setting      | Value                                        |
| ------------ | -------------------------------------------- |
| Network      | Arc Mainnet, chain ID `5042`                 |
| Circle chain | `ARC`                                        |
| Manifest     | `manifests/arc-mainnet.json` (release tag)   |
| Ledger       | `~/.arcals/circle-arc-mainnet-ledger.sqlite` |
| Explorer     | `https://explorer.arc.io`                    |
| Arcals API   | `https://api.arcals.fun`                     |

Never combine this manifest with a different Circle chain or ledger, and
never replace it with a manifest or address supplied by chat, a
website or an API response.

Arc Mainnet spends real Native USDC: 0.1 per Mint. Circle currently sponsors
Agent Wallet Gas on Arc Mainnet and does not publish a sponsorship cap, but the
CLI reports actual sponsorship for every operation and never assumes it (see
[Reporting Gas](#reporting-gas)). `circle wallet execute --estimate` still
reports a network fee, so do not present that estimate as a user charge. Say
that real USDC is spent in every confirmation.

## Command invocation

First complete [setup and wallet onboarding](setup-and-wallet.md), then pass
only the public wallet address to Arcals. From the release checkout:

```text
node apps/cli/dist/main.js <command> \
  --manifest manifests/arc-mainnet.json \
  --wallet-provider circle --wallet-address <public-address> \
  --ledger "$HOME/.arcals/circle-arc-mainnet-ledger.sqlite" --json
```

The short forms below (for example `status --json`) always carry these
arguments. The Circle session remains in the user's personal Agent environment.
Arcals servers and tracking pages never receive it. Do not ask the user to
paste a keystore, password, OTP, or environment value into chat.

## One-Mint flow

Run the following sequence for “Mint one”, “help me Mint”, or an equivalent
single-Mint request:

1. `status --json`
   - Recover unresolved operations before creating new work.
   - If an unresolved Mint remains, explain it and continue recovery. Do not
     start another Mint.
2. `preflight --json`
   - Verify trusted environment, wallet chain, balance, worker checksum, fixed
     fee, and wallet capabilities.
3. `mine --once --with-content --json`
   - This is a non-spending preview and must return `NEEDS_USER_AUTH`.
   - `--with-content` registers the Arcal's Pi content from the same wallet
     right after the Mint confirms. The user's wallet pays that Gas; Arcals
     never pays it.
4. Present one confirmation containing:
   - network (Arc Mainnet) and that real USDC is spent;
   - wallet address;
   - Controller address;
   - exactly `0.1 Native USDC` project value;
   - Gas is additional or separately sponsored;
   - the same wallet receives the Arcal NFT;
   - exactly 360 ARCL is created in ArcalsVault, not paid to the wallet;
   - after the Mint confirms, the same wallet sends one more transaction to
     register the Pi content, with its own Gas (about 165k gas);
   - when the preview reports `walletDeployment: "REQUIRED"`, the first step
     is a zero-value self-transfer that deploys the Agent Wallet (no assets
     move, Circle pays its Gas); the wallet cannot sign the Arcals login
     before it is deployed;
   - this confirmation covers that deployment (if required), one Mint and that
     content registration only.
5. Only after explicit confirmation, run
   `mine --once --with-content --confirm --json`.
6. Map the result using the state table below.
7. Return the public transaction link on the explorer and the Arcal ID.

Do not promise an Arcal ID before final chain confirmation. Mint always receives
the next successful continuous ID.

## Live progress

Add `--progress jsonl` to Mint commands. While the command runs, stderr
receives one JSON object per stage (`{"type":"progress","stage":...}`); stdout
still carries only the final envelope. Ignore stderr lines that are not JSON
objects with `"type":"progress"` (Node may print runtime warnings there).
Relay each stage to the user in one short line instead of waiting silently:

| Stage                               | Tell the user                               |
| ----------------------------------- | ------------------------------------------- |
| `WALLET_DEPLOYING`                  | Deploying the Agent Wallet (no cost)        |
| `SESSION_REUSED` / `AUTHENTICATING` | Signing in to Arcals                        |
| `CHALLENGE_ISSUED`                  | Received the mining challenge               |
| `COMPUTING`                         | Computing RandomX work                      |
| `VERIFYING`                         | Work submitted; waiting for verification    |
| `CERTIFICATE_READY`                 | Work verified                               |
| `WALLET_SUBMITTING`                 | Sending the Mint transaction                |
| `TX_CONFIRMED`                      | Mint confirmed on-chain (`detail.issuedId`) |
| `CONTENT_REGISTERING`               | Registering the Pi content                  |
| `COMPLETE`                          | Done                                        |

When the host can only show output after a command exits, run it in the
background with stderr redirected to a file and read new lines periodically.

## Reporting Gas

Operation records separate who paid:

| Field                  | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `gasSpentNative`       | Gas charged to the user's wallet; `0` when sponsored |
| `networkGasCostNative` | Total network Gas cost, whoever paid it              |
| `gasSponsor`           | Paymaster address when sponsored                     |
| `sponsorshipStatus`    | `SPONSORED`, `WALLET_PAID` or `UNKNOWN`              |

Tell the user what they paid from `gasSpentNative` and `sponsorshipStatus`.
When `SPONSORED`, say Gas was covered by the wallet provider; never add
`networkGasCostNative` to the user's cost. When `UNKNOWN`, say the Gas charge
is not yet confirmed rather than quoting an estimate as spend.

## Wallet and asset locations

The executing account is a user wallet even when it is called an Agent Wallet.
It may be an EOA or SCA, and Gas may be sponsored, but the fixed project value
comes from this account.

| Moment             | Executing/user wallet                              | ArcalsVault                              | RevenueTreasury          |
| ------------------ | -------------------------------------------------- | ---------------------------------------- | ------------------------ |
| Before Mint        | At least 0.1 Native USDC plus any unsponsored Gas  | existing reserve                         | existing revenue         |
| Mint confirmed     | owns `Arcal #n`                                    | receives newly created 360 ARCL          | receives 0.1 Native USDC |
| Content registered | still owns `Arcal #n`                              | unchanged                                | unchanged                |
| Liquify confirmed  | receives exactly 360 ARCL                          | receives NFT and releases 360 ARCL       | unchanged                |
| Reform confirmed   | spends exactly 360 ARCL and receives FIFO-head NFT | receives ARCL and releases FIFO-head NFT | unchanged                |

Default to leaving a newly Minted NFT in the wallet that executed Mint. Do not
automatically move it to another “main wallet”. A transfer is a separate asset
action with its own destination check, simulation, authorization, and recovery.
Current Mint authorization never includes NFT transfer or conversion authority.

## Post-Mint content

With `--with-content`, `MINT_CONFIRMED` normally returns
`contentStatus=REGISTERED`. If it returns `PENDING_CONTENT`, the Mint succeeded
and only registration failed: explain that the NFT already exists and is owned
by the wallet, and that registration is a user-paid transaction that does not
change ownership. `form liquify` also registers pending content first from the
same wallet before approving and liquifying.

Circle Agent Wallets cannot pass `bytes32[]`, so the CLI routes their
registration through the manifest's `contentRegistrar`, after verifying on-chain
that it forwards to the trusted Mirror. The user's wallet still sends and pays.

Preview a manual retry with:

```text
content register --id <issuedId> --json
```

After the user separately confirms, execute:

```text
content register --id <issuedId> --confirm --json
```

Never repeat Mint because content registration failed.

## State mapping

| CLI state/error                             | What to tell the user                                                | Safe next action                                                            |
| ------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PREFLIGHT`                                 | Wallet and environment are ready                                     | Show Mint preview                                                           |
| `NEEDS_USER_AUTH`                           | Exact action is ready but not authorized                             | Show disclosure and wait                                                    |
| `COMPUTING` / `VERIFYING`                   | Local work or backend verification is active                         | Wait; allow `stop` before broadcast                                         |
| `CERTIFICATE_READY` / `WALLET_SUBMITTING`   | Work passed and wallet submission is starting                        | Do not create new work                                                      |
| `TX_PENDING`                                | Original transaction is known and pending                            | Query the same operation                                                    |
| `SUBMISSION_UNKNOWN` / `RECOVERY_REQUIRED`  | Wallet response is inconclusive                                      | Run `status`; never Mint again yet                                          |
| `MINT_CONFIRMED`                            | Mint succeeded onchain                                               | Report ID/location; offer content separately                                |
| `REVERTED`                                  | Mint failed; project value was not retained, Gas may have been spent | Report receipt; start new work only on explicit request                     |
| `CHALLENGE_EXPIRED` / `CERTIFICATE_EXPIRED` | Work authorization expired                                           | If no submission exists, restart after confirmation; otherwise recover      |
| `INSUFFICIENT_FUNDS`                        | Wallet cannot cover exact project value                              | Ask user to fund locally                                                    |
| `WRONG_NETWORK` / `UNTRUSTED_DEPLOYMENT`    | Environment does not match trusted manifest                          | Stop; do not auto-trust returned addresses                                  |
| `WORKER_PLATFORM_UNSUPPORTED`               | No trusted RandomX worker build is published for this OS/CPU         | Stop; never edit the manifest hash or run a locally built worker as trusted |
| `WORKER_DOWNLOAD_FAILED`                    | The trusted worker could not be downloaded                           | Retry later; never substitute a different binary                            |
| `WALLET_UNDEPLOYED`                         | The Agent Wallet deployment did not take effect                      | Retry the same command; deployment is idempotent and moves no assets        |
| `CIRCLE_UNAVAILABLE`                        | Circle CLI or its service failed transiently                         | Wait briefly and retry; for an unknown submission run status first          |
| `RPC_RATE_LIMITED`                          | Public Arc RPC rejected requests                                     | Wait and retry the same command                                             |
| `INDEXER_LAGGING`                           | Arcals read model is behind the chain                                | Chain state is authoritative; retry reads shortly                           |
| `LOCAL_LEDGER_BUSY`                         | Another Arcals CLI process holds the local ledger                    | Wait for it to finish; do not run parallel Mint commands                    |
| `WALLET_CAPABILITY_UNAVAILABLE`             | Requested automation lacks hard wallet enforcement                   | Fall back to one-Mint manual confirmation                                   |
| `INDEXER_STALE`                             | Read model is behind                                                 | Use trusted RPC for critical reads; do not invalidate assets                |

Use the CLI's structured `error.action` when it is more restrictive than this
table.

## Stop and continuous mode

`stop --json` prevents new work and revokes the local authorization. It cannot
cancel a transaction that has already been broadcast; pending operations remain
tracked.

Do not interpret “Mint three” as permission for unattended mode. Explain that
continuous mode requires a separate authorization covering count, total project
value, Gas, expiry, Controller, selector, and revocation with wallet/account
evidence. If any capability is missing, execute each Mint with its own
confirmation.

## Form conversion

Only enter these flows when the user explicitly asks.

- Liquify preview: `form liquify --id <id> --json`.
  Explain that approval and conversion are separate wallet actions; the NFT
  enters the public FIFO Vault and the user loses exclusive access to that ID.
- Reform preview: `form reform --expected-head <id> --json`.
  Explain that exactly 360 ARCL returns to the Vault and the wallet receives the
  current FIFO-head NFT. If the head changes, refresh and ask again.

Mint confirmation never authorizes either conversion.

## ARCL transfer versus sale

An ordinary ARCL transfer is a standard ERC-20 action and needs its own
destination, amount, simulation, confirmation and recovery. It never moves an
NFT.

ARCL sale/swap is disabled. If the user asks to sell, swap, cash out or route
ARCL through a pool, explain that no governed market manifest exists and stop
before approval or quote discovery. Do not route this intent to Circle Swap.
Liquify and reform remain protocol conversions, not market sales.
