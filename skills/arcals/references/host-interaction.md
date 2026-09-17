# Agent host interaction contract

Use this reference when the Agent host must collect Circle onboarding input.
The preferred experience stays inside the Agent conversation: the Agent asks,
waits, performs the next command, and resumes automatically.

This state and `requiredInput` schema belongs to the Arcals orchestration
wrapper. It is not returned by Circle and does not fork or patch Circle CLI.
The wrapper invokes the unmodified official `@circle-fin/cli` for Terms,
authentication, MPC wallet/session storage and wallet operations.

## Required input modes

| Mode           | Examples                             | Model visibility |                Persistence |
| -------------- | ------------------------------------ | ---------------: | -------------------------: |
| `confirmation` | exact Circle Terms version and links |          allowed |         consent event only |
| `text`         | Circle login email                   |          allowed | only when the user chooses |
| `otp`          | active Circle Agent Wallet login     |     allowed once |                  forbidden |

Circle's official `use-agent-wallet` flow treats the login OTP as safe for the
active Agent conversation. Use it immediately with the request ID, then discard
it. Never write it to a file, ledger, summary, log, fixture or telemetry, and do
not reuse it after success or failure.

This exception is narrow. OTPs used to set or reset wallet spending policies
are password-equivalent under Circle's official `agent-wallet-policy` flow and
must go directly to the user's terminal. Private keys, mnemonics, MPC shares,
sessions and passwords also never enter Agent chat.

Do not collect any OTP through an Arcals public API or public setup page.

## Conversation state machine

```text
CHECK
→ TERMS_CONFIRMATION_REQUIRED
→ EMAIL_REQUIRED
→ OTP_REQUIRED
→ WALLET_READY
→ FUNDING_REQUIRED
```

At `TERMS_CONFIRMATION_REQUIRED`, show the current version and both URLs. The
user's explicit version-bound answer is the decision. Only then may the Agent
run `accept-terms --terms-version <version> --confirm-user-accepted`; never
infer consent from installation or a Mint request.

At `EMAIL_REQUIRED`, ask for the email and run `login-start`. At
`OTP_REQUIRED`, ask for the one-time code and run `login-complete` immediately.
The request ID expires after ten minutes and is single-use; do not retry an
expired request silently.

After `WALLET_READY`, continue automatically to the bounded funding plan. Do
not require the user to repeat the original request after each input.
