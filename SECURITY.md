# Security policy

Meridex handles encrypted wallet keys, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
**Security tab > Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the impact. We aim to acknowledge reports within 72 hours.

## Scope

In scope: key encryption and handling (`src/crypto`, `src/service.ts`), transaction building and signing (`src/stellar`), the Telegram webhook (`src/index.ts`), confirmation and rate-limit logic, and swap or launchpad execution.

Out of scope: third-party services (Telegram, Cloudflare, Aquarius, Stelfun, Stellar Expert), social engineering, and issues that need a compromised Cloudflare account.

## Current status

- Meridex runs on **Stellar testnet** only. Do not store real funds.
- It is a hosted (custodial) wallet: keys are encrypted at rest with a server-side master key. See the README security section for the design and known limits.
- No independent audit has been done yet.

## Never commit secrets

`.dev.vars`, bot tokens, `MASTER_KEY` and API tokens must stay out of git. CI runs a secret scan on every push and pull request. If a secret was ever committed, rotate it immediately.
