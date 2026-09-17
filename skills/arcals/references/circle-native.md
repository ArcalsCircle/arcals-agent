# Circle-native composition

Use this reference for Circle Agent Wallet setup, funding, policy or transaction
operations. Arcals should compose Circle's maintained capabilities instead of
reimplementing their general wallet behavior.

## Official skills

When available, route to these skills from
[`circlefin/skills`](https://github.com/circlefin/skills):

| Intent                      | Official Circle skill | Arcals responsibility                                                                                               |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Install/login/create wallet | `use-agent-wallet`    | Require a persistent personal Agent environment; retain no secrets                                                  |
| Fund Agent Wallet           | `fund-agent-wallet`   | Calculate `0.1 Native USDC × maxMints`; show Arcals asset routing                                                   |
| Configure limits/allowlists | `agent-wallet-policy` | Supply only trusted Controller/contract addresses; keep unattended disabled until every required boundary is proven |
| Arc network behavior        | `use-arc`             | Bind to the trusted Arcals environment manifest                                                                     |
| Contract execution/recovery | `use-circle-cli`      | Encode frozen Arcals calls and preserve provider operation/idempotency records                                      |

The deterministic setup helper can install this exact set after explicit
software-install confirmation:

```text
node scripts/setup-agent-wallet.mjs install-circle-skills \
  --tool <codex|claude-code|cursor|opencode|amp> --confirm-install
```

Circle Terms must already be accepted by the user. Never set
`CIRCLE_ACCEPT_TERMS=1` or accept legal terms silently.

Follow Circle's official OTP split: the email OTP for an active Agent Wallet
login may be handled once in the current conversation and must be discarded
immediately. OTPs that set/reset spending policies never enter Agent context;
hand those interactive commands to the user exactly as Circle documents.

## Features Arcals must exercise

- user-controlled 2-of-2 MPC without exposing key shares to the Agent;
- separate Mainnet/Testnet sessions;
- Circle operation IDs and idempotency keys;
- Agent Wallet contract execution with Native value;
- sponsored Gas evidence, without assuming sponsorship is unlimited;
- Circle wallet balance/history for recovery and monitoring;
- Mainnet contract allowlist and bounded spending policies, with the human OTP
  change gate;
- Circle funding as the primary path, with a direct USDC transfer to the Agent
  Wallet as the fallback.

Policy support is not equivalent to Arcals unattended readiness. Circle's
documented contract allowlist and transfer budgets do not yet prove selector,
Mint-count, Gas and expiry enforcement for Arcals. Keep one-Mint confirmation
until live evidence covers every required boundary.

## Disabled market action

“Sell ARCL”, “swap ARCL”, “cash out”, or equivalent market intent is recognized
but disabled in the current release. Do not:

- call Circle swap;
- approve a DEX router;
- search for or select a third-party pool;
- construct a quote, minimum output or slippage value;
- imply that a liquid ARCL/USDC market exists.

Tell the user that market actions will open only after a governed manifest
freezes the token, chain, pool/router addresses, route, quote source, maximum
slippage, deadline, allowance policy and recovery behavior. This gate does not
block ordinary ARCL transfer, liquify or reform.
