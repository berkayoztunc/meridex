import type { Env } from "../env";
import { netConfig } from "../env";
import * as api from "./api";
import { esc } from "./api";
import * as db from "../db";
import { createWallet, unlockSecret } from "../service";
import { getAccount, getFee, submitTx, HorizonError, explainError, type HorizonAccount } from "../stellar/horizon";
import { summarize } from "../stellar/balances";
import { toStroops } from "../stellar/amount";
import { isValidAddress, parseAssetSpec } from "../stellar/wallet";
import { buildTx, changeTrustOp, createAccountOp, paymentOp, signTx, type AssetRef } from "../stellar/tx";
import { qrPng } from "../qr/png";
import { bal, fmt, fmtAsset, head, kb, kv, msg, netName, shortKey } from "./ui";
import { executeLaunchpad, holdingsText, launchpadHoldings, positions } from "./launchpad";
import { buyStart, executeSwap, handleTradeCallback, handleTradeState, priceStart, sellStart, slippageMenu, tryOpenToken } from "./trade";

const MENU = {
  keyboard: [
    [{ text: "Balance" }, { text: "Receive" }, { text: "Send" }],
    [{ text: "Buy" }, { text: "Sell" }, { text: "Price" }],
    [{ text: "Wallets" }, { text: "Referral" }, { text: "Export key" }],
    [{ text: "Menu" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_MAP: Record<string, string> = {
  Balance: "/balance",
  Receive: "/receive",
  Send: "/send",
  Wallets: "/wallets",
  "Export key": "/export",
  Referral: "/referral",
  Buy: "/buy",
  Sell: "/sell",
  Price: "/price",
  Menu: "/menu",
};
// Keyboards sent before the emoji-free redesign are still pinned in old chats.
const LEGACY_MENU_MAP: Record<string, string> = {
  "💰 Balance": "/balance",
  "📥 Receive": "/receive",
  "📤 Send": "/send",
  "👛 Wallets": "/wallets",
  "🔑 Export key": "/export",
  "🎁 Referral": "/referral",
  "💱 Buy": "/buy",
  "💸 Sell": "/sell",
  "📈 Price": "/price",
  "🧭 Menu": "/menu",
};

const HELP = `<b>Meridex</b>
Stellar wallet and trading, inside Telegram.
Type a command or tap /menu.

<b>Wallet</b>
/balance  XLM and token balances
/receive  Your address and QR code
/send  Send XLM or a token
/wallets  List, switch or create wallets
/export  Back up your private key

<b>Trade</b>
/buy  Buy a token with XLM
/sell  Sell a token for XLM
/price  Price, market cap, pool depth
/slippage  Swap slippage tolerance
/trust  Add a token (trustline)

<b>More</b>
/menu  All actions in one place
/referral  Invite link and count
/cancel  Abort the current action`;

const MENU_TEXT = head("Main menu", "Pick an action below.");
const MENU_INLINE = kb([
  [{ text: "Balance", data: "mn:balance" }, { text: "Receive", data: "mn:receive" }, { text: "Send", data: "mn:send" }],
  [{ text: "Buy", data: "mn:buy" }, { text: "Sell", data: "mn:sell" }, { text: "Price", data: "mn:price" }],
  [{ text: "Add token", data: "mn:trust" }, { text: "Wallets", data: "mn:wallets" }, { text: "Referral", data: "mn:referral" }],
  [{ text: "Slippage", data: "mn:slippage" }, { text: "Export key", data: "mn:export" }, { text: "Positions", data: "mn:positions" }],
  [{ text: "Help", data: "mn:help" }],
]);
const MENU_CMDS = new Set(["balance", "receive", "send", "buy", "sell", "price", "trust", "wallets", "referral", "slippage", "export", "help"]);

export interface Msg {
  chat: number;
  from: number;
  username: string | null;
  text: string;
}

export async function handleMessage(env: Env, m: Msg): Promise<void> {
  const isNew = await db.upsertUser(env, m.from, m.username);
  if (!(await db.rateLimit(env, m.from, "general", 30, 60))) {
    await api.sendMessage(env, m.chat, head("Too many requests", "Wait a minute, then try again."));
    return;
  }
  // Plain-text keyboard labels only act as shortcuts when no flow is waiting for typed input.
  const state0 = LEGACY_MENU_MAP[m.text] || !MENU_MAP[m.text] ? null : await db.getState(env, m.from);
  let text = LEGACY_MENU_MAP[m.text] ?? (state0 ? m.text.trim() : MENU_MAP[m.text] ?? m.text.trim());
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    await runCommand(env, m, cmd.split("@")[0].toLowerCase(), rest.join(" "), isNew);
    return;
  }
  const state = await db.getState(env, m.from);
  if (state) return handleState(env, m, state, text);
  if (await tryOpenToken(env, m, text)) return;
  await api.sendMessage(env, m.chat, head("Not sure what to do?", "Use the menu below or send /help."), { markup: MENU });
}

async function runCommand(env: Env, m: Msg, cmd: string, arg: string, isNew = false): Promise<void> {
  if (cmd !== "/send" && cmd !== "/trust") await db.setState(env, m.from, null);
  switch (cmd) {
    case "/start": {
      await db.ensureReferralCode(env, m.from);
      if (isNew && arg) {
        const referrer = await db.attributeReferral(env, m.from, arg.trim());
        if (referrer) await api.sendMessage(env, referrer, head("New referral", "Someone joined with your invite link.", "See your count with /referral."));
      }
      let w = await db.activeWallet(env, m.from);
      const net = netConfig(env);
      const badge = netName(net.isTestnet);
      if (!w) {
        const pid = await api.sendMessage(env, m.chat, head("Creating your wallet", "Generating and encrypting your keys."));
        w = await createWallet(env, m.from);
        if (pid) await api.editMessage(env, m.chat, pid, head("Wallet created", `${esc(w.label)} on ${badge}`));
        await api.sendMessage(
          env,
          m.chat,
          msg(
            head("Welcome to Meridex", `Wallet ready on ${badge}`, net.isTestnet ? "Funded with free test XLM." : "Send at least 1 XLM to activate it."),
            `<b>Your address</b>\n<code>${w.public_key}</code>`,
            "Keys are encrypted on our servers. Back yours up any time with /export.",
          ),
          { markup: MENU },
        );
      } else {
        await api.sendMessage(env, m.chat, head("Welcome back", `${esc(w.label)} · ${badge}`, "Pick an action below."), { markup: MENU });
      }
      return receive(env, m);
    }
    case "/menu":
      return void (await api.sendMessage(env, m.chat, MENU_TEXT, { markup: MENU_INLINE }));
    case "/help":
      return void (await api.sendMessage(env, m.chat, HELP, { markup: MENU }));
    case "/balance":
      return balance(env, m);
    case "/receive":
      return receive(env, m);
    case "/wallets":
      return wallets(env, m);
    case "/referral":
      return referral(env, m);
    case "/send":
      return sendStart(env, m);
    case "/price":
      return priceStart(env, m, arg);
    case "/buy":
      return buyStart(env, m, arg);
    case "/sell":
      return sellStart(env, m);
    case "/slippage":
      return slippageMenu(env, m);
    case "/trust":
      return trustStart(env, m, arg);
    case "/export":
      return exportStart(env, m);
    case "/cancel":
      return void (await api.sendMessage(env, m.chat, head("Cancelled", "Nothing was changed."), { markup: MENU }));
    default:
      return void (await api.sendMessage(env, m.chat, head("Unknown command", "Send /help to see what Meridex can do.")));
  }
}

async function needWallet(env: Env, m: { chat: number; from: number }) {
  const w = await db.activeWallet(env, m.from);
  if (!w) await api.sendMessage(env, m.chat, head("No wallet yet", "Send /start to create one."));
  return w;
}

async function buildBalance(env: Env, tg: number): Promise<{ text: string; markup: Record<string, unknown> } | null> {
  const w = await db.activeWallet(env, tg);
  if (!w) return null;
  const net = netConfig(env);
  const label = esc(w.label);
  const netLabel = netName(net.isTestnet);
  const acc = await getAccount(net, w.public_key);
  const actions = [
    { text: "Send", data: "mn:send" },
    { text: "Receive", data: "mn:receive" },
    { text: "Buy", data: "mn:buy" },
  ];
  const tools = [
    { text: "Refresh", data: "bl:r" },
    { text: "Copy address", data: "bl:a" },
  ];
  if (!acc) {
    return {
      text: msg(head("Wallet not activated", `${label} · ${netLabel}`, "Send at least 1 XLM to activate it."), kv([["Address", `<code>${w.public_key}</code>`]])),
      markup: kb([[{ text: "Receive", data: "mn:receive" }, ...tools]]),
    };
  }
  const s = summarize(acc);
  const lp = await launchpadHoldings(env, tg, acc);
  const count = s.tokens.length + lp.length;
  const lines = s.tokens.map((k) => `${esc(k.code)}  <b>${bal(k.balance)}</b>  <i>${k.issuer.slice(0, 4)}…${k.issuer.slice(-4)}</i>`);
  const t = msg(
    head(`💰 ${label} · ${netLabel}`, `<b>${bal(s.xlm)} XLM</b>`, `${bal(s.available)} available, ${bal(s.reserve)} reserved`),
    lines.length > 0 && `<b>Tokens</b>\n${lines.join("\n")}`,
    holdingsText(lp).trim() || null,
    !count && "No tokens yet. Add one with /trust or buy with /buy.",
    kv([["Address", shortKey(w.public_key)]]),
  );
  return { text: t, markup: kb([actions, tools]) };
}

async function balance(env: Env, m: Msg): Promise<void> {
  const r = await buildBalance(env, m.from);
  if (!r) return void (await api.sendMessage(env, m.chat, head("No wallet yet", "Send /start to create one.")));
  await api.sendMessage(env, m.chat, r.text, { markup: r.markup });
}

async function receive(env: Env, m: Msg): Promise<void> {
  const w = await needWallet(env, m);
  if (!w) return;
  await api.sendPhoto(env, m.chat, qrPng(w.public_key), msg(head("Receive", `${esc(w.label)} · ${netName(netConfig(env).isTestnet)}`, "Tap the address to copy, or scan the QR."), `<code>${w.public_key}</code>`));
}

let botUsername: string | null = null;
async function getBotUsername(env: Env): Promise<string | null> {
  if (botUsername) return botUsername;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) }).then((x) => x.json()).catch(() => null) as any;
  botUsername = r?.result?.username ?? null;
  return botUsername;
}

async function referral(env: Env, m: Msg): Promise<void> {
  const code = await db.ensureReferralCode(env, m.from);
  const count = await db.referralCount(env, m.from);
  const name = await getBotUsername(env);
  const link = name ? `https://t.me/${name}?start=${code}` : null;
  await api.sendMessage(
    env,
    m.chat,
    msg(
      head("Referral", `${count} ${count === 1 ? "person" : "people"} invited`, "Share your link. Anyone who starts the bot with it becomes your referral."),
      kv([["Invite code", `<code>${code}</code>`], ["Invite link", link && `<code>${link}</code>`]]),
    ),
  );
}

async function wallets(env: Env, m: Msg): Promise<void> {
  const ws = await db.listWallets(env, m.from);
  const rows = ws.map((w) => [{ text: `${w.is_active ? "Active · " : ""}${w.label} · ${w.public_key.slice(0, 6)}…${w.public_key.slice(-4)}`, data: `w:sw:${w.id}` }]);
  rows.push([{ text: "New wallet", data: "w:new" }]);
  await api.sendMessage(env, m.chat, head("Your wallets", `${ws.length} total`, "Tap one to make it active."), { markup: kb(rows) });
}

// ---------- Send ----------

async function sendStart(env: Env, m: Msg): Promise<void> {
  const w = await needWallet(env, m);
  if (!w) return;
  const acc = await getAccount(netConfig(env), w.public_key);
  if (!acc) return void (await api.sendMessage(env, m.chat, head("Wallet not activated", "Fund it with at least 1 XLM first.")));
  const s = summarize(acc);
  const rows = [[{ text: `XLM (${fmt(s.available)})`, data: "s:a:0" }]];
  s.tokens.forEach((k, i) => k.balance > 0n && rows.push([{ text: `${k.code} (${fmt(k.balance)})`, data: `s:a:${i + 1}` }]));
  await db.setState(env, m.from, { step: "asset", walletId: w.id });
  await api.sendMessage(env, m.chat, head("Send", "Which asset do you want to send?"), { markup: kb(rows) });
}

async function trustStart(env: Env, m: Msg, arg: string): Promise<void> {
  if (!(await needWallet(env, m))) return;
  if (arg) return trustConfirm(env, m, arg);
  await db.setState(env, m.from, { step: "trust" });
  await api.sendMessage(env, m.chat, msg(head("Add a token", "Send it as CODE:ISSUER."), "Example\n<code>USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5</code>"));
}

async function trustConfirm(env: Env, m: Msg, spec: string): Promise<void> {
  const a = parseAssetSpec(spec);
  if (!a) return void (await api.sendMessage(env, m.chat, head("Invalid format", "Use <code>CODE:ISSUER</code>.")));
  const w = await needWallet(env, m);
  if (!w) return;
  await db.setState(env, m.from, null);
  const id = await db.createPending(env, m.from, "tx", { type: "trust", walletId: w.id, asset: a }, 120);
  await api.sendMessage(env, m.chat, msg(head("Add token", `<b>${esc(a.code)}</b>`, "Reserves 0.5 XLM while the trustline exists."), kv([["Issuer", `<code>${a.issuer}</code>`]])), {
    markup: kb([[{ text: "Confirm", data: `ok:${id}` }, { text: "Cancel", data: `no:${id}` }]]),
  });
}

async function handleState(env: Env, m: Msg, st: any, text: string): Promise<void> {
  if (await handleTradeState(env, m, st, text)) return;
  switch (st.step) {
    case "trust":
      return trustConfirm(env, m, text);
    case "addr": {
      const addr = text.trim();
      if (!isValidAddress(addr)) return void (await api.sendMessage(env, m.chat, head("Invalid address", "It must start with G and be 56 characters.", "Try again or send /cancel.")));
      await db.setState(env, m.from, { ...st, step: "amount", dest: addr });
      return void (await api.sendMessage(env, m.chat, head("Amount", `How much ${esc(fmtAsset(st.asset))} do you want to send?`)));
    }
    case "amount": {
      const v = toStroops(text);
      if (v === null) return void (await api.sendMessage(env, m.chat, head("Invalid amount", "Use a positive number with up to 7 decimals.")));
      await db.setState(env, m.from, { ...st, step: "memo", stroops: v.toString() });
      return void (await api.sendMessage(env, m.chat, head("Memo (optional)", "Up to 28 bytes. Some exchanges require one."), { markup: kb([[{ text: "Skip", data: "s:nomemo" }]]) }));
    }
    case "memo": {
      if (new TextEncoder().encode(text).length > 28) return void (await api.sendMessage(env, m.chat, head("Memo too long", "Keep it under 28 bytes.")));
      return sendConfirm(env, m.chat, m.from, st, text);
    }
  }
  await db.setState(env, m.from, null);
}

async function sendConfirm(env: Env, chat: number, tg: number, st: any, memo?: string): Promise<void> {
  await db.setState(env, tg, null);
  const w = await db.activeWallet(env, tg);
  if (!w || w.id !== st.walletId) return void (await api.sendMessage(env, chat, head("Active wallet changed", "Start again with /send.")));
  if (st.dest === w.public_key) return void (await api.sendMessage(env, chat, head("Same address", "You can't send to your own address.")));
  const payload = { type: "pay", walletId: w.id, asset: st.asset, dest: st.dest, stroops: st.stroops, memo: memo ?? null };
  const id = await db.createPending(env, tg, "tx", payload, 120);
  await api.sendMessage(
    env,
    chat,
    msg(
      head("Confirm transfer", `<b>${fmt(BigInt(st.stroops))} ${esc(fmtAsset(st.asset))}</b>`, "Expires in 2 minutes."),
      kv([["From", esc(w.label)], ["To", `<code>${st.dest}</code>`], ["Memo", memo ? esc(memo) : null]]),
    ),
    { markup: kb([[{ text: "Confirm", data: `ok:${id}` }, { text: "Cancel", data: `no:${id}` }]]) },
  );
}

async function executeTx(env: Env, tg: number, p: any): Promise<string> {
  if (p.type === "swap") return executeSwap(env, tg, p);
  if (p.type === "lpswap") return executeLaunchpad(env, tg, p);
  const net = netConfig(env);
  const w = await db.activeWallet(env, tg);
  if (!w || w.id !== p.walletId) return head("Active wallet changed", "Request cancelled.");
  const secret = await unlockSecret(env, w);
  for (let attempt = 0; attempt < 2; attempt++) {
    const acc = await getAccount(net, w.public_key);
    if (!acc) return head("Wallet not activated", "Fund it with at least 1 XLM first.");
    const s = summarize(acc);
    const fee = await getFee(net);
    let ops, memo: string | undefined;
    if (p.type === "trust") {
      if (s.available < 5_000_000n + 1000n) return head("Not enough XLM", "A new trustline needs a 0.5 XLM reserve.");
      ops = [changeTrustOp(p.asset)];
    } else {
      const amt = BigInt(p.stroops);
      const asset: AssetRef = p.asset;
      memo = p.memo ?? undefined;
      const dest = await getAccount(net, p.dest);
      if (asset.issuer) {
        const mine = s.tokens.find((k) => k.code === asset.code && k.issuer === asset.issuer);
        if (!mine || mine.balance < amt) return head("Insufficient balance", "You don't hold enough of this token.");
        if (s.available < 100_000n) return head("Not enough XLM", "You need a little XLM to pay the network fee.");
        if (!dest) return head("Destination not activated", "That account can't receive tokens yet.");
        if (p.dest !== asset.issuer && !dest.balances.some((b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer))
          return head("No trustline", "The destination must add this token first.");
        ops = [paymentOp(p.dest, asset, amt)];
      } else {
        if (amt + 100_000n > s.available) return head("Insufficient balance", `Available: ${fmt(s.available)} XLM.`);
        if (!dest) {
          if (amt < 10_000_000n) return head("Destination not activated", "The first transfer to a new account must be at least 1 XLM.");
          ops = [createAccountOp(p.dest, amt)];
        } else ops = [paymentOp(p.dest, asset, amt)];
      }
    }
    try {
      const tx = buildTx({ source: acc as HorizonAccount, net, fee, memo }, ops);
      const hash = await submitTx(net, signTx(tx, secret));
      await db.audit(env, tg, p.type === "trust" ? "trust" : "pay", w.public_key, hash);
      const amt0 = p.type === "trust" ? 0n : BigInt(p.stroops);
      const base = net.isTestnet ? "https://stellar.expert/explorer/testnet" : "https://stellar.expert/explorer/public";
      return p.type === "trust"
        ? msg(head("Token added", `<b>${esc(p.asset.code)}</b>`, "Trustline is active."), `<a href="${base}/tx/${hash}">View transaction</a>`)
        : msg(head("Transfer sent", `<b>${fmt(amt0)} ${esc(fmtAsset(p.asset))}</b>`, `To ${shortKey(p.dest)}`), `<a href="${base}/tx/${hash}">View transaction</a>`);
    } catch (e) {
      if (e instanceof HorizonError && e.txCode === "tx_bad_seq" && attempt === 0) continue;
      return head("Transaction failed", esc(explainError(e)));
    }
  }
  return head("Transaction failed", "Please try again.");
}

// ---------- Export ----------

async function exportStart(env: Env, m: Msg): Promise<void> {
  const w = await needWallet(env, m);
  if (!w) return;
  if (!(await db.rateLimit(env, m.from, "export", 3, 3600))) return void (await api.sendMessage(env, m.chat, head("Export limit reached", "Try again in an hour.")));
  const id = await db.createPending(env, m.from, "export", { walletId: w.id }, 60);
  await api.sendMessage(
    env,
    m.chat,
    msg(
      head("Export private key", esc(w.label), "Anyone with this key controls your funds. Never share it."),
      "The key appears behind a spoiler and is deleted after 60 seconds. Save it somewhere safe first.",
    ),
    { markup: kb([[{ text: "I understand, show key", data: `ex:${id}` }, { text: "Cancel", data: `no:${id}` }]]) },
  );
}

// ---------- Callbacks ----------

export interface Cb {
  id: string;
  chat: number;
  msgId: number;
  from: number;
  data: string;
}

export async function handleCallback(env: Env, c: Cb): Promise<void> {
  const m: Msg = { chat: c.chat, from: c.from, username: null, text: "" };
  if (!(await db.rateLimit(env, c.from, "general", 30, 60))) return void (await api.answerCallback(env, c.id, "Too many requests"));
  const [k, a, b] = c.data.split(":");
  if (await handleTradeCallback(env, { id: c.id, chat: c.chat, msgId: c.msgId, from: c.from }, k, a, b)) return;

  if (k === "bl") {
    if (a === "a") {
      const w = await db.activeWallet(env, c.from);
      await api.answerCallback(env, c.id);
      if (w) await api.sendMessage(env, c.chat, msg(head(esc(w.label), "Tap the address to copy."), `<code>${w.public_key}</code>`));
      return;
    }
    const r = await buildBalance(env, c.from);
    await api.answerCallback(env, c.id, "Updated");
    if (r) await api.editMessage(env, c.chat, c.msgId, r.text, r.markup);
    return;
  }
  if (k === "mn") {
    if (a === "positions") return await api.answerCallback(env, c.id), positions(env, m);
    if (!MENU_CMDS.has(a)) return void (await api.answerCallback(env, c.id));
    await api.answerCallback(env, c.id);
    return runCommand(env, m, `/${a}`, "");
  }
  if (k === "no") {
    await db.cancelPending(env, c.from, a);
    await api.answerCallback(env, c.id);
    return api.editMessage(env, c.chat, c.msgId, head("Cancelled", "Nothing was changed."));
  }
  if (k === "ok") {
    if (!(await db.rateLimit(env, c.from, "tx", 5, 60))) return void (await api.answerCallback(env, c.id, "Too many requests, wait a minute"));
    const p = await db.consumePending(env, c.from, a, "tx");
    if (!p) {
      await api.answerCallback(env, c.id, "Expired or already used");
      return api.editMessage(env, c.chat, c.msgId, head("Request expired", "It expired or was already processed."));
    }
    await api.answerCallback(env, c.id);
    await api.editMessage(env, c.chat, c.msgId, head("Submitting", "Waiting for the network to confirm."));
    const res = await executeTx(env, c.from, p).catch((e) => {
      console.log("executeTx error", e instanceof Error ? e.message : "unknown");
      return head("Something went wrong", "Please try again.");
    });
    return api.editMessage(env, c.chat, c.msgId, res);
  }
  if (k === "ex") {
    const p = await db.consumePending(env, c.from, a, "export");
    if (!p) {
      await api.answerCallback(env, c.id, "Expired");
      return api.editMessage(env, c.chat, c.msgId, head("Request expired", "Run /export again."));
    }
    const w = await db.activeWallet(env, c.from);
    if (!w || w.id !== p.walletId) return void (await api.answerCallback(env, c.id, "Wallet changed"));
    await api.answerCallback(env, c.id);
    const secret = await unlockSecret(env, w);
    const mid = await api.sendMessage(env, c.chat, msg(head(`${esc(w.label)} private key`, "Tap the spoiler to reveal, tap again to copy.", "Deletes itself in 60 seconds."), `<tg-spoiler><code>${secret}</code></tg-spoiler>`), { protect: true, markup: kb([[{ text: "Delete now", data: "dm" }]]) });
    await db.audit(env, c.from, "export", w.public_key);
    if (mid) await db.createPending(env, c.from, "delete_msg", { chat: c.chat, msgId: mid }, 60);
    return api.editMessage(env, c.chat, c.msgId, head("Key sent below", "Save it now."));
  }
  if (k === "dm") {
    const ok = await api.deleteMessage(env, c.chat, c.msgId);
    await api.answerCallback(env, c.id, ok ? "Deleted" : "Could not delete");
    if (ok) await api.sendMessage(env, c.chat, head("Private key deleted", "The message was removed from this chat."));
    return;
  }
  if (k === "w") {
    if (a === "sw") {
      const ok = await db.setActive(env, c.from, Number(b));
      await api.answerCallback(env, c.id, ok ? "Switched" : "Not found");
      return wallets(env, m);
    }
    if (a === "new") {
      await api.answerCallback(env, c.id, "Creating wallet");
      const pid = await api.sendMessage(env, c.chat, head("Creating a new wallet", "Generating and encrypting your keys."));
      try {
        const w = await createWallet(env, c.from);
        const text = msg(head("New wallet created", esc(w.label), "It is now your active wallet."), `<code>${w.public_key}</code>`);
        if (pid) await api.editMessage(env, c.chat, pid, text);
        else await api.sendMessage(env, c.chat, text);
        await receive(env, m);
      } catch (e) {
        const err = head("Could not create wallet", esc(e instanceof Error ? e.message : "Failed"));
        if (pid) await api.editMessage(env, c.chat, pid, err);
        else await api.sendMessage(env, c.chat, err);
      }
      return;
    }
  }
  if (k === "s") {
    const st = await db.getState(env, c.from);
    if (a === "a" && st?.step === "asset") {
      const w = await db.activeWallet(env, c.from);
      const acc = w && (await getAccount(netConfig(env), w.public_key));
      if (!w || !acc || w.id !== st.walletId) return void (await api.answerCallback(env, c.id, "Start again"));
      const idx = Number(b);
      const s = summarize(acc);
      const asset: AssetRef | undefined = idx === 0 ? { code: "XLM" } : s.tokens[idx - 1] && { code: s.tokens[idx - 1].code, issuer: s.tokens[idx - 1].issuer };
      if (!asset) return void (await api.answerCallback(env, c.id, "Start again"));
      await db.setState(env, c.from, { step: "addr", walletId: w.id, asset });
      await api.answerCallback(env, c.id);
      return api.editMessage(env, c.chat, c.msgId, head(`Send ${esc(fmtAsset(asset))}`, "Paste the destination address (starts with G).", "Send /cancel to abort."));
    }
    if (a === "nomemo" && st?.step === "memo") {
      await api.answerCallback(env, c.id);
      await api.editMessage(env, c.chat, c.msgId, "No memo.");
      return sendConfirm(env, c.chat, c.from, st);
    }
  }
  await api.answerCallback(env, c.id);
}

export async function runCron(env: Env): Promise<void> {
  for (const d of await db.dueDeletes(env)) {
    const p = JSON.parse(d.payload) as { chat: number; msgId: number };
    const ok = await api.deleteMessage(env, p.chat, p.msgId);
    if (ok) await api.sendMessage(env, p.chat, head("Private key deleted", "The message was removed from this chat."));
    await db.finishPending(env, d.id);
  }
  await db.cleanup(env);
}
