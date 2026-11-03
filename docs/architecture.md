# Meridex architecture

Meridex is one Cloudflare Worker plus a D1 database. Telegram talks to it over a webhook; the Worker talks to Stellar (Horizon and Soroban RPC), the Aquarius router and the Stelfun launchpad contract.

## System overview

```mermaid
flowchart LR
    U[Telegram user] -->|messages, buttons| T[Telegram Bot API]
    T -->|webhook with secret header| W

    subgraph CF[Cloudflare]
        W[Worker<br/>src/index.ts] --> R[Router<br/>src/telegram]
        R --> K[Key service<br/>AES-GCM + HKDF]
        R --> DB[(D1<br/>users, encrypted wallets,<br/>pending actions, trades, audit)]
        A[Static assets<br/>meridex.trade landing page] --- W
        C[Cron every minute<br/>delete expired key messages] --> DB
    end

    R -->|balances, fees, submit| H[Horizon]
    R -->|simulate, prepare, wait| S[Soroban RPC]
    R -->|best route| Q[Aquarius find-path API]
    S --> AR[Aquarius router contract]
    S --> SF[Stelfun launchpad contract]
    R -->|contract to asset lookup| X[Stellar Expert API]
    R -->|reply, photo, edit, delete| T
```

## Swap flow (confirmed by the user)

```mermaid
sequenceDiagram
    participant U as User
    participant B as Meridex Worker
    participant Q as Aquarius API
    participant S as Soroban RPC
    participant H as Horizon

    U->>B: /buy and token
    B->>Q: find-path (strict send)
    Q-->>B: route and expected output
    B-->>U: swap preview, minimum after slippage
    U->>B: Confirm (single-use, valid 2 minutes)
    B->>B: re-validate balance, trustline, reserve
    B->>Q: re-quote, refuse if below approved minimum
    B->>S: simulate transaction
    B->>B: decrypt key in memory and sign
    B->>H: submit transaction
    H-->>B: result
    B-->>U: swap complete, received amount
```

## Components

| Component | Responsibility | Code |
|---|---|---|
| Worker entry | Webhook auth (secret header and path), replay protection, cron | `src/index.ts` |
| Router | Commands, callbacks, confirmation flows, message layout | `src/telegram/` |
| Key service | Per-wallet key from `MASTER_KEY` + salt (HKDF-SHA256), AES-256-GCM with AAD | `src/crypto/keys.ts`, `src/service.ts` |
| Database | Users, wallets, pending actions (single-use), rate limits, audit log, trades | `src/db/`, `migrations/` |
| Stellar clients | Accounts, fees, transaction build and signing, Soroban simulate and submit | `src/stellar/` |
| Swaps | Route lookup, swap arguments, minimum output, market data | `src/aqua/`, `src/telegram/trade.ts` |
| Launchpad | Bonding-curve quotes, buy and sell calls | `src/stelfun/`, `src/telegram/launchpad.ts` |

## Trust boundaries

- The Worker is the only component that ever sees a plaintext private key, in memory, for the length of one signing call.
- D1 holds only encrypted keys. Without `MASTER_KEY` (a Worker secret) they cannot be decrypted.
- Telegram, Horizon, Soroban RPC, Aquarius and Stellar Expert are external and untrusted; every amount, balance and trustline is re-checked at confirmation time.

Planned changes (see the roadmap in the README): KMS-backed master key with rotation, more liquidity venues behind a provider interface, resolution of contract addresses through Soroban RPC instead of a third-party lookup.
