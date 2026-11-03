<div align="center">

<img src="public/logo.png" alt="Meridex" width="140" height="140">

# Meridex

**Stellar wallet and trading, inside Telegram.**
Create a wallet in one tap, send and receive, swap on Aquarius and trade Stelfun launchpad coins without leaving chat.

[![CI](https://github.com/berkayoztunc/meridex/actions/workflows/ci.yml/badge.svg)](https://github.com/berkayoztunc/meridex/actions/workflows/ci.yml)
[![CodeQL](https://github.com/berkayoztunc/meridex/actions/workflows/codeql.yml/badge.svg)](https://github.com/berkayoztunc/meridex/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)](LICENSE)
![Tests](https://img.shields.io/badge/tests-22%20passing-10c98f)
![Network](https://img.shields.io/badge/network-Stellar%20testnet-3b82f6)

[Website](https://meridex.trade) · [Bot](https://t.me/MeridexTradeBot) · [Security policy](SECURITY.md)

</div>

---

> **Status: MVP on Stellar testnet.** Meridex is a hosted (custodial) wallet: keys are encrypted at rest, but the server can sign for users. Do not store real funds. No independent audit has been done yet.

## What it does

| Area | Features |
|---|---|
| Wallets | Up to 5 wallets per Telegram user, active-wallet switching, testnet auto-funding via friendbot |
| Balances | XLM (available vs reserved) and every trustline token |
| Transfers | XLM and token send with address, amount, memo and a confirmation card; QR code for receiving |
| Tokens | Add a trustline with `/trust CODE:ISSUER`, or paste a contract address or asset to open a trade card |
| Swaps | `/buy` and `/sell` through the Aquarius router with a quote, minimum output, slippage control (0.1% to 3%) and on-chain `out_min` protection |
| Launchpad | Buy and sell Stelfun launchpad coins with curve price, progress and fees shown before you confirm |
| Market data | `/price` shows price, estimated market cap, supply and pool depth |
| Growth | Referral link and invite count |
| Safety | Spoiler-protected private-key export that deletes itself after 60 seconds |

## Test results

`npm test` (Vitest 3.2.7), run on 2026-11-03:

```
 ✓ test/crypto.test.ts     (4 tests)
 ✓ test/launchpad.test.ts  (4 tests)
 ✓ test/stellar.test.ts    (7 tests)
 ✓ test/trade.test.ts      (7 tests)

 Test Files  4 passed (4)
      Tests  22 passed (22)
```

| Suite | Covers |
|---|---|
| crypto | Encryption round trip; rejects wrong AAD, tampered ciphertext and wrong master key |
| stellar | Amount parsing (BigInt stroops), balance and reserve maths, transaction build and signing, QR PNG validity |
| trade | Slippage maths (BigInt), number and balance formatting, native SAC id and swap arguments, token and contract detection in chat |
| launchpad | Buy and sell arguments, contract error decoding, disabled until `LAUNCHPAD_ID` is set, spot price |

`npm run typecheck` is clean and `npm audit --omit=dev` reports 0 vulnerabilities. CI runs typecheck, tests, a dependency audit, CodeQL and a secret scan on every push and pull request.

## Architecture

Diagrams and trust boundaries: [docs/architecture.md](docs/architecture.md).

```
Telegram ──webhook──▶ Cloudflare Worker ──▶ D1 (encrypted keys, users, referrals, audit, trades)
                           │
                           ├──▶ Horizon        balances, fees, transaction submission
                           ├──▶ Soroban RPC    simulate, prepare, wait for result
                           ├──▶ Aquarius API   best swap route, router contract call
                           ├──▶ Stelfun        launchpad contract (bonding curve)
                           └──▶ Telegram Bot API
Cron (every minute) ──▶ delete expired key messages, clean up
```

- **Runtime:** one Cloudflare Worker (`nodejs_compat`), entry point `src/index.ts`. Webhook only, no polling. Updates are acknowledged immediately and processed with `ctx.waitUntil`.
- **Stellar:** `@stellar/stellar-base` builds and signs; network calls are plain `fetch`.
- **State:** the Worker is stateless, so conversation state lives in D1 (`users.state`).
- **Landing page:** static assets in `public/`, served by the same Worker (`run_worker_first = ["/webhook/*"]`).
- **QR codes:** `qrcode-generator` makes the matrix and a small hand-written PNG encoder (`src/qr/png.ts`) renders it, because Telegram does not accept GIF as a photo.

## Security design

| Topic | Implementation |
|---|---|
| Key encryption | AES-256-GCM. A 32-byte `MASTER_KEY` (Worker secret) plus a random 16-byte salt per wallet go through HKDF-SHA256 to give a per-wallet key. Random 12-byte IV |
| Binding | `userId\|walletId\|publicKey` is used as AAD, so ciphertext moved to another row or user will not decrypt |
| If D1 leaks | Encrypted keys are useless without `MASTER_KEY` |
| Key versioning | `key_version` column exists for future master-key rotation |
| Plaintext | Private keys live only in memory inside a function; never logged or stored |
| Webhook | Constant-time check of `X-Telegram-Bot-Api-Secret-Token` plus a secret URL path. Wrong value gives 403/404 |
| Replay | `processed_updates` ensures an `update_id` is handled once |
| Private chats only | Group and channel messages are ignored |
| Confirmations | Every transfer, trustline and swap needs a confirmation card; the pending record lasts 2 minutes and is single-use (`UPDATE ... WHERE status='pending' RETURNING`), so a double tap cannot double-send |
| Re-validation | At confirm time address, amount (BigInt, no floats), balance, trustline and reserve are checked again |
| Export | Confirmation button, spoiler, `protect_content`, auto-delete after 60 seconds, audit-logged |
| Audit log | Action, public key, transaction hash, time. No secrets |
| Rate limits | D1-backed, per user (see Limits) |

**Known limits (MVP):** a single master secret with no rotation tool yet, no withdrawal limits or second factor, no independent audit, one swap router. These are the planned hardening work. If `MASTER_KEY` is lost, wallets cannot be recovered, so back it up in a password manager. Anyone with access to the Cloudflare account and `wrangler secret` can decrypt keys; protect that account with 2FA.

## Bot commands

| Command | Description |
|---|---|
| `/start` | Create a wallet on first use and show the address with a QR code; `?start=CODE` records a referral |
| `/balance` | XLM and token balances |
| `/receive` | Address and QR code |
| `/send` | Choose asset, address, amount, optional memo, confirm |
| `/trust [CODE:ISSUER]` | Add a token (trustline) |
| `/price [token]` | Price, market cap, pool depth |
| `/buy [token]` | Buy a token with XLM |
| `/sell` | Sell a token for XLM |
| `/slippage` | Swap slippage tolerance |
| `/wallets` | List, switch or create wallets |
| `/referral` | Invite link and count |
| `/export` | Export the private key |
| `/menu`, `/help`, `/cancel` | Menu, help, abort current action |

Messages share one layout (title, key figure, context, then detail rows, at most one emoji), documented in `src/telegram/ui.ts`.

**Transfer rules:** a new destination account needs at least 1 XLM (XLM only); token transfers need a trustline on the destination; sending to yourself is blocked; memo is at most 28 bytes; fee is the Horizon `fee_stats` p70 (100 to 100,000 stroops) with one automatic retry on `tx_bad_seq`.

## Swaps (Aquarius)

| Network | Router | API |
|---|---|---|
| mainnet | `CBQDHNBF…C6QUK` | `https://amm-api.aqua.network/api/external/v2` |
| testnet | `CBCFTQSP…5A6GD` | `https://amm-api-testnet.aqua.network/api/external/v2` |

1. The user picks a token (or pastes `CODE:ISSUER` / a contract address) and an amount.
2. `findPath` (strict-send) returns a quote: pay, expected, **minimum** after slippage, rate, route.
3. On confirm: add the trustline if needed, re-quote and refuse if the price fell below the approved minimum, `simulateTransaction`, sign, submit, read the received amount from the transaction meta.
4. The on-chain `out_min` check also rejects the swap if the price moves.

Price and market cap are **estimates** (`src/aqua/market.ts`); USD is shown on mainnet only. Testnet liquidity is thin and noisy.

## Quick start

Requirements: Node 20+, a Cloudflare account, a bot token from @BotFather.

```sh
git clone https://github.com/berkayoztunc/meridex.git
cd meridex
npm install
cp .dev.vars.example .dev.vars        # fill in; never commit this file
npm run gen:key                        # paste output as MASTER_KEY
npm run db:migrate:local
npm run dev                            # http://localhost:8787
npm test && npm run typecheck
```

Deploy:

```sh
npx wrangler login
npx wrangler d1 create stellar-wallet-bot       # put the database_id in wrangler.toml
npm run db:migrate:remote
npx wrangler secret put MASTER_KEY              # back it up
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put WEBHOOK_PATH
npm run deploy

export BOT_TOKEN=... WEBHOOK_SECRET=... WEBHOOK_PATH=... WORKER_URL=https://your-domain
npm run webhook:set && npm run webhook:commands && npm run webhook:info
```

| Secret | Purpose |
|---|---|
| `MASTER_KEY` | Base64 32-byte root of all key encryption |
| `BOT_TOKEN` | Telegram bot token |
| `WEBHOOK_SECRET` | Secret header Telegram sends on every request |
| `WEBHOOK_PATH` | Secret part of the webhook URL |

To try the webhook locally: `POST http://localhost:8787/webhook/<WEBHOOK_PATH>` with header `X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>` and a Telegram update JSON body.

## Limits

| Constant | Value |
|---|---|
| General rate limit | 30 requests / minute / user |
| Transfer confirmations | 5 / minute / user |
| Key export | 3 / hour / user |
| Quote requests | 20 / minute / user |
| Confirmation card lifetime | 2 minutes |
| Export message auto-delete | 60 seconds |
| Default slippage | 1% |
| Wallets per user | 5 |
| Memo | 28 bytes |
| Minimum new-account funding | 1 XLM |
| Base reserve | 0.5 XLM |

## Project layout

```
wrangler.toml          Worker, D1 binding, cron, assets, routes
migrations/            0001 init, 0002 referrals, 0003 trading
public/                landing page (meridex.trade)
scripts/webhook.mjs    set | info | commands
src/
  index.ts             fetch (webhook) and scheduled (cron)
  env.ts               Env type and network config
  service.ts           wallet creation and key unlock
  crypto/keys.ts       AES-GCM + HKDF
  db/index.ts          all D1 queries
  telegram/            api, router, trade, launchpad, ui
  stellar/             horizon, soroban, tx, wallet, balances, amount
  aqua/                Aquarius route and market data
  stelfun/             launchpad contract client
  qr/png.ts            QR to PNG
test/                  Vitest unit tests
```

## Roadmap

1. **Hardening:** key-management redesign and rotation tool, send limits, trading-safety warnings (low liquidity, price impact, unknown issuer), dependency fallbacks, more tests.
2. **Liquidity:** more venues (Soroswap, Phoenix, Stellar DEX) behind the provider interface with best-price comparison.
3. **Mainnet:** independent audit, deployment, metrics.
4. Later: limit orders, price alerts, portfolio value, optional disclosed trade fee.

## Team

| Developer | Role | Links |
|---|---|---|
| Berkay Öztunç | Co-founder, developer | [GitHub @berkayoztunc](https://github.com/berkayoztunc) · [LinkedIn](https://www.linkedin.com/in/berkayoztunc/) |
| Emre Arslan | Co-founder, developer | [GitHub @yemrearslan](https://github.com/yemrearslan) · [LinkedIn](https://www.linkedin.com/in/emre-arslan-42b7a977/) |

### Previous open-source work

| Project | What it is |
|---|---|
| [Orquestra](https://github.com/berkayoztunc/orquestra) | Open-source platform that turns Solana Anchor and Codama IDLs into a hosted API, AI-ready docs and MCP tools |
| [orquestra-cli](https://github.com/berkayoztunc/orquestra-cli) | Rust CLI that turns IDL instructions into interactive prompts, builds transactions and optionally signs and sends them |
| [orquestra-signer-mcp](https://github.com/berkayoztunc/orquestra-signer-mcp) | MCP server for signing Solana transactions and messages with any `@solana/keychain` backend |
| [LocalWallet](https://github.com/berkayoztunc/LocalWallet) | Local Solana wallet manager: keys encrypted on your machine and never leave it |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
