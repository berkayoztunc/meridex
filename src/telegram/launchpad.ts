import type { Env } from "../env";
import { netConfig } from "../env";
import * as api from "./api";
import { esc } from "./api";
import * as db from "../db";
import { bal, compact, fmt, head, kb, kv, msg, netName, num } from "./ui";
import { getAccount, getFee, submitTx, HorizonError, explainError } from "../stellar/horizon";
import { summarize } from "../stellar/balances";
import { toStroops } from "../stellar/amount";
import { signTx } from "../stellar/tx";
import { minOut } from "../aqua/api";
import { prepareInvoke, waitForResult, SorobanError } from "../stellar/soroban";
import { unlockSecret } from "../service";
import {
  CURVE_STATUS, buyArgs, coinBalance, explainLp, fitBuy, getConfig, getCurve, getMeta, lpEnabled, progressBps,
  quoteBuy, quoteSell, sellArgs, spotPrice, unsupportedReason,
} from "../stelfun/launchpad";

interface Ctx {
  chat: number;
  from: number;
}

const FEE_MARGIN = 500_000n; // 0.05 XLM kept for Soroban fees
const ONE = 10_000_000n;
const short = (c: string) => `${c.slice(0, 5)}…${c.slice(-4)}`;

async function pick(env: Env, tg: number, coin: string, action: string, text: string) {
  const id = await db.createPending(env, tg, "tok", { lp: coin, action }, 900);
  return { text, data: `pk:${id}` };
}

export interface Holding {
  coin: string;
  symbol: string;
  balance: bigint;
  valueXlm: number;
}

/** Launchpad coins this user bought through the bot and still holds. Soroban tokens are invisible to Horizon, so they come from the trade log + on-chain balance. */
export async function launchpadHoldings(env: Env, tg: number, acc: Awaited<ReturnType<typeof getAccount>>): Promise<Holding[]> {
  const net = netConfig(env);
  if (!lpEnabled(net) || !acc) return [];
  const coins = (await db.launchpadCoins(env, tg)).slice(0, 10);
  const out = await Promise.all(
    coins.map(async (coin): Promise<Holding | null> => {
      try {
        const [meta, balance, curve] = await Promise.all([getMeta(net, acc, coin), coinBalance(net, acc, coin, acc.id), getCurve(net, acc, coin)]);
        if (balance <= 0n) return null;
        return { coin, symbol: meta.symbol, balance, valueXlm: curve ? (Number(balance) / 1e7) * spotPrice(curve) : 0 };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((h): h is Holding => h !== null);
}

/** Wallet-screen block, empty string when there is nothing to show. */
export function holdingsText(hs: Holding[]): string {
  if (!hs.length) return "";
  let t = "\n\n<b>Launchpad coins</b>";
  for (const h of hs) t += `\n<b>${esc(h.symbol)}</b>  ${bal(h.balance)}  (~${compact(h.valueXlm)} XLM)`;
  return t;
}

/** Rows of held coins; tapping one opens its trade card. */
export async function heldLaunchpadRows(env: Env, tg: number, acc: Awaited<ReturnType<typeof getAccount>>, action = "sell") {
  const rows: { text: string; data: string }[][] = [];
  for (const h of await launchpadHoldings(env, tg, acc)) rows.push([await pick(env, tg, h.coin, action, `${h.symbol} (${fmt(h.balance)})`)]);
  return rows;
}

/** /positions: launchpad holdings with value, each opening its trade card. */
export async function positions(env: Env, c: Ctx): Promise<void> {
  const w = await db.activeWallet(env, c.from);
  const acc = w && (await getAccount(netConfig(env), w.public_key).catch(() => null));
  if (!w || !acc) return void (await api.sendMessage(env, c.chat, "No active wallet, or it is not activated yet. Send /start or fund the wallet."));
  const hs = await launchpadHoldings(env, c.from, acc);
  if (!hs.length) return void (await api.sendMessage(env, c.chat, head("Positions", "No launchpad coins yet.", "Paste a coin address or use /buy.")));
  const total = hs.reduce((a, h) => a + h.valueXlm, 0);
  await api.sendMessage(env, c.chat, `${head("Positions", `<b>Total ~${compact(total)} XLM</b>`, `${esc(w.label)} · ${hs.length} coin${hs.length > 1 ? "s" : ""}`)}${holdingsText(hs)}\n\n<i>Tap a coin to trade it.</i>`, {
    markup: kb(await heldLaunchpadRows(env, c.from, acc, "trade")),
  });
}

/** Opens the trade card if `coin` is a coin of the launchpad. False when it is not (caller falls through). */
export async function launchpadCard(env: Env, c: Ctx, coin: string, edit?: number): Promise<boolean> {
  const net = netConfig(env);
  if (!lpEnabled(net)) return false;
  const w = await db.activeWallet(env, c.from);
  if (!w) return void (await api.sendMessage(env, c.chat, "No wallet yet. Send /start to create one.")), true;
  const acc = await getAccount(net, w.public_key).catch(() => null);
  if (!acc) return void (await api.sendMessage(env, c.chat, "Wallet not activated yet. Fund it first.")), true;
  const curve = await getCurve(net, acc, coin);
  if (!curve) return false;
  if (!(await db.rateLimit(env, c.from, "quote", 20, 60))) return void (await api.sendMessage(env, c.chat, "Too many requests. Wait a minute and try again.")), true;
  const mid = edit ?? (await api.sendMessage(env, c.chat, "Loading launchpad coin…"));
  const show = (t: string, m?: Record<string, unknown>) => (mid ? api.editMessage(env, c.chat, mid, t, m) : api.sendMessage(env, c.chat, t, { markup: m }).then(() => {}));
  try {
    const [cfg, meta, hold, prog] = await Promise.all([getConfig(net, acc), getMeta(net, acc, coin), coinBalance(net, acc, coin, acc.id), progressBps(net, acc, coin)]);
    const bad = unsupportedReason(net, cfg, meta);
    if (bad) return await show(head(esc(meta.symbol), "Not tradable here", bad)), true;
    const s = summarize(acc);
    const price = spotPrice(curve);
    const mc = (Number(meta.totalSupply) / 1e7) * price;
    const base = net.isTestnet ? "testnet" : "public";
    const progress = curve.status === 2 ? "Graduated. Trading on the DEX pool." : `${CURVE_STATUS[curve.status] ?? "?"} ${(prog / 100).toFixed(1)}% to graduation`;
    let t = head(
      `${esc(meta.name)} (${esc(meta.symbol)}) · ${netName(net.isTestnet)}`,
      `<b>${num(price)} XLM</b>`,
      `Market cap ~${compact(mc)} XLM · Supply ${compact(Number(meta.totalSupply) / 1e7)}`,
    );
    t += "\n\n" + kv([
      ["Source", `Stelfun launchpad · <a href="https://stellar.expert/explorer/${base}/contract/${coin}">${short(coin)}</a>`],
      ["Curve", progress],
      ["Reserves", `${compact(Number(curve.realQuote) / 1e7)} XLM / ${compact(Number(curve.realToken) / 1e7)} ${esc(meta.symbol)}`],
      ["Fee", `${cfg.feeBps / 100}%`],
    ]);
    t += "\n\n" + kv([
      ["Wallet", esc(w.label)],
      ["Available", `<b>${bal(s.available)} XLM</b>`],
      ["Holding", `<b>${bal(hold)} ${esc(meta.symbol)}</b>` + (hold > 0n ? ` (~${compact((Number(hold) / 1e7) * price)} XLM)` : "")],
    ]);
    const maxXlm = s.available > FEE_MARGIN ? s.available - FEE_MARGIN : 0n;
    const tid = await db.createPending(env, c.from, "tok", { lp: coin, action: "trade" }, 1800);
    const rows: { text: string; data: string }[][] = [];
    const fixed = [10, 50, 100].filter((n) => maxXlm >= BigInt(n) * ONE);
    if (fixed.length) rows.push(fixed.map((n) => ({ text: `Buy ${n} XLM`, data: `lb:${tid}:${n}` })));
    if (maxXlm > 0n) rows.push([25, 50, 100].map((p) => ({ text: `Buy ${p === 100 ? "Max" : p + "%"}`, data: `lp:${tid}:${p}` })));
    if (hold > 0n) rows.push([25, 50, 75, 100].map((p) => ({ text: `Sell ${p}%`, data: `ls:${tid}:${p}` })));
    const custom = [{ text: "Buy custom", data: `lx:${tid}:b` }];
    if (hold > 0n) custom.push({ text: "Sell custom", data: `lx:${tid}:s` });
    rows.push(custom);
    rows.push([{ text: `Slippage ${(await db.getSlippage(env, c.from)) / 100}%`, data: "sgm" }, { text: "Refresh", data: `lr:${tid}` }]);
    await show(t, kb(rows));
  } catch (e) {
    await show(head("Could not load this coin", esc(e instanceof SorobanError ? explainLp(e.message) : explainError(e))));
  }
  return true;
}

async function quoteCard(env: Env, c: Ctx, coin: string, side: "buy" | "sell", amount: bigint, all = false): Promise<void> {
  await db.setState(env, c.from, null);
  const net = netConfig(env);
  const w = await db.activeWallet(env, c.from);
  const acc = w && (await getAccount(net, w.public_key).catch(() => null));
  if (!w || !acc) return void (await api.sendMessage(env, c.chat, "Wallet not activated yet. Fund it first."));
  if (!(await db.rateLimit(env, c.from, "quote", 20, 60))) return void (await api.sendMessage(env, c.chat, "Too many quotes. Wait a minute and try again."));
  const s = summarize(acc);
  if (s.available < FEE_MARGIN) return void (await api.sendMessage(env, c.chat, "Not enough XLM for the network fee. Add a little XLM and retry."));
  const pid = await api.sendMessage(env, c.chat, "Getting the price…");
  const edit = (t: string, m?: Record<string, unknown>) => (pid ? api.editMessage(env, c.chat, pid, t, m) : api.sendMessage(env, c.chat, t, { markup: m }).then(() => {}));
  try {
    const [cfg, meta] = await Promise.all([getConfig(net, acc), getMeta(net, acc, coin)]);
    const bps = await db.getSlippage(env, c.from);
    let payload: Record<string, unknown>;
    let t: string;
    if (side === "buy") {
      const budget = s.available - FEE_MARGIN;
      let quoteIn = amount;
      let q = all ? null : await quoteBuy(net, acc, coin, quoteIn);
      if (all || (q && q.quoteUsed + q.fee > budget)) {
        const fit = await fitBuy(net, acc, cfg, coin, all ? budget : s.available - FEE_MARGIN);
        if (!fit) return void (await edit("Not enough XLM. A small amount is kept for fees."));
        ({ quoteIn, q } = { quoteIn: fit.quoteIn, q: fit.q });
      }
      if (!q || q.tokensOut <= 0n) return void (await edit("Amount too small. Try a larger amount."));
      // per quote_buy docs: send quote_used (not the quoted amount) so min_out stays a real bound on a refund
      const min = minOut(q.tokensOut, bps);
      payload = { side, coin, symbol: meta.symbol, amountIn: q.quoteUsed.toString(), minOut: min.toString() };
      t = msg(
        head("Buy preview", `<b>Pay ${fmt(q.quoteUsed + q.fee)} XLM · get ~${fmt(q.tokensOut)} ${esc(meta.symbol)}</b>`, `Minimum ${fmt(min)} ${esc(meta.symbol)} at ${bps / 100}% slippage`),
        kv([
          ["Wallet", esc(w.label)],
          ["Fee", `${fmt(q.fee)} XLM`],
          ["Rate", `1 ${esc(meta.symbol)} ≈ ${num(Number(q.quoteUsed) / Number(q.tokensOut))} XLM`],
          q.refund > 0n && ["Refund", `${fmt(q.refund)} XLM (curve completes)`],
        ].filter(Boolean) as [string, string][]),
      );
    } else {
      const hold = await coinBalance(net, acc, coin, acc.id);
      if (amount > hold) return void (await edit(`Not enough balance. You have ${fmt(hold)} ${esc(meta.symbol)}.`));
      const q = await quoteSell(net, acc, coin, amount);
      const min = minOut(q.quoteOut, bps);
      payload = { side, coin, symbol: meta.symbol, amountIn: amount.toString(), minOut: min.toString() };
      t = msg(
        head("Sell preview", `<b>Sell ${fmt(amount)} ${esc(meta.symbol)} · get ~${fmt(q.quoteOut)} XLM</b>`, `Minimum ${fmt(min)} XLM at ${bps / 100}% slippage`),
        kv([
          ["Wallet", esc(w.label)],
          ["Fee", `${fmt(q.fee)} XLM (included)`],
          ["Rate", `1 ${esc(meta.symbol)} ≈ ${num(Number(q.quoteOut) / Number(amount))} XLM`],
        ]),
      );
    }
    const id = await db.createPending(env, c.from, "tx", { type: "lpswap", walletId: w.id, ...payload }, 120);
    await edit(msg(t, `Coin  <code>${short(coin)}</code>`, "Expires in 2 minutes."), kb([[{ text: "Confirm", data: `ok:${id}` }, { text: "Cancel", data: `no:${id}` }], [{ text: "Slippage", data: "sgm" }]]));
  } catch (e) {
    await edit(esc(e instanceof SorobanError ? explainLp(e.message) : explainError(e)));
  }
}

export async function handleLaunchpadState(env: Env, c: Ctx, st: any, text: string): Promise<boolean> {
  if (st.step !== "lp_buy_amount" && st.step !== "lp_sell_amount") return false;
  const v = toStroops(text);
  if (v === null) return void (await api.sendMessage(env, c.chat, "Invalid amount. Use a positive number with up to 7 decimals.")), true;
  await quoteCard(env, c, st.coin, st.step === "lp_buy_amount" ? "buy" : "sell", v);
  return true;
}

const LP_CB = new Set(["lb", "lp", "ls", "lx", "lr"]);

export async function handleLaunchpadCallback(env: Env, c: Ctx & { id: string; msgId: number }, k: string, a?: string, b?: string): Promise<boolean> {
  if (k === "pk") {
    const p = await db.peekPending(env, c.from, a ?? "", "tok");
    if (!p?.lp) return false;
    await api.answerCallback(env, c.id);
    await api.editMessage(env, c.chat, c.msgId, `Selected <b>${esc(short(p.lp))}</b>`);
    await launchpadCard(env, c, p.lp);
    return true;
  }
  if (!LP_CB.has(k)) return false;
  const p = await db.peekPending(env, c.from, a ?? "", "tok");
  if (!p?.lp) return void (await api.answerCallback(env, c.id, "Expired. Reopen the coin.")), true;
  const coin: string = p.lp;
  if (k === "lr") {
    await api.answerCallback(env, c.id, "Refreshing");
    await launchpadCard(env, c, coin, c.msgId);
    return true;
  }
  const net = netConfig(env);
  const w = await db.activeWallet(env, c.from);
  const acc = w && (await getAccount(net, w.public_key).catch(() => null));
  if (!w || !acc) return void (await api.answerCallback(env, c.id, "Wallet not activated")), true;
  const s = summarize(acc);
  await api.answerCallback(env, c.id);
  const maxXlm = s.available > FEE_MARGIN ? s.available - FEE_MARGIN : 0n;
  if (k === "lx") {
    if (b === "b") {
      await db.setState(env, c.from, { step: "lp_buy_amount", walletId: w.id, coin });
      await api.sendMessage(env, c.chat, msg(head("Buy", `Available <b>${bal(s.available)} XLM</b>`), "Send the amount of <b>XLM</b> to spend."));
    } else {
      const hold = await coinBalance(net, acc, coin, acc.id).catch(() => 0n);
      if (hold <= 0n) return void (await api.sendMessage(env, c.chat, "You hold none of this coin. Nothing to sell.")), true;
      await db.setState(env, c.from, { step: "lp_sell_amount", walletId: w.id, coin });
      await api.sendMessage(env, c.chat, msg(head("Sell", `Sellable <b>${bal(hold)}</b>`), "Send the amount of coins to sell."));
    }
    return true;
  }
  if (k === "lb") await quoteCard(env, c, coin, "buy", BigInt(b ?? "0") * ONE);
  else if (k === "lp") {
    const pct = BigInt(b ?? "0");
    if (maxXlm <= 0n) return void (await api.sendMessage(env, c.chat, "Not enough available XLM. Add XLM or pick a smaller amount.")), true;
    await quoteCard(env, c, coin, "buy", pct === 100n ? maxXlm : (maxXlm * pct) / 100n, pct === 100n);
  } else if (k === "ls") {
    const hold = await coinBalance(net, acc, coin, acc.id).catch(() => 0n);
    if (hold <= 0n) return void (await api.sendMessage(env, c.chat, "You hold none of this coin. Nothing to sell.")), true;
    const pct = BigInt(b ?? "0");
    await quoteCard(env, c, coin, "sell", pct === 100n ? hold : (hold * pct) / 100n);
  }
  return true;
}

export async function executeLaunchpad(env: Env, tg: number, p: any): Promise<string> {
  const net = netConfig(env);
  const w = await db.activeWallet(env, tg);
  if (!w || w.id !== p.walletId) return "Active wallet changed, so this was cancelled. Start again.";
  const secret = await unlockSecret(env, w);
  const base = net.isTestnet ? "https://stellar.expert/explorer/testnet" : "https://stellar.expert/explorer/public";
  const buy = p.side === "buy";
  const amountIn = BigInt(p.amountIn);
  const trade = { tg, walletId: w.id, side: p.side, selling: buy ? "XLM" : p.coin, buying: buy ? p.coin : "XLM", amount: p.amountIn, minOut: p.minOut };
  let acc = await getAccount(net, w.public_key);
  if (!acc) return "Wallet not activated. Fund it first.";
  if (summarize(acc).available < FEE_MARGIN) return "Not enough XLM for the network fee. Add a little XLM and retry.";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // simulation enforces min_out (error #104) and the balance checks; nothing is submitted if it fails
        const args = buy ? buyArgs(acc.id, p.coin, amountIn, BigInt(p.minOut)) : sellArgs(acc.id, p.coin, amountIn, BigInt(p.minOut));
        const tx = await prepareInvoke(net, acc, "10000", net.launchpad, buy ? "buy" : "sell", args);
        const hash = await submitTx(net, signTx(tx, secret));
        const got = (await waitForResult(net, hash).catch(() => null)) as bigint | null;
        await db.recordTrade(env, { ...trade, amountOut: got?.toString(), status: "success", txHash: hash });
        await db.audit(env, tg, "swap", w.public_key, hash);
        const [paid, recv] = buy ? ["XLM", p.symbol] : [p.symbol, "XLM"];
        return (
          msg(
            head(`${buy ? "Buy" : "Sell"} complete`, got !== null ? `<b>Received ${fmt(got)} ${esc(recv)}</b>` : "<b>Order submitted</b>", `${buy ? "Spent" : "Sold"} ${fmt(amountIn)} ${esc(paid)}`),
            `<a href="${base}/tx/${hash}">View transaction</a>`,
          )
        );
      } catch (e) {
        if (e instanceof HorizonError && e.txCode === "tx_bad_seq" && attempt === 0) {
          acc = (await getAccount(net, w.public_key))!;
          continue;
        }
        throw e;
      }
    }
    return "Order failed. Please try again.";
  } catch (e) {
    await db.recordTrade(env, { ...trade, status: "failed" }).catch(() => {});
    if (e instanceof SorobanError) return msg(head("Order rejected", esc(explainLp(e.message))), "No funds were moved.");
    if (e instanceof HorizonError && (e.opCodes ?? []).some((o) => o.includes("invoke_host_function")))
      return msg(head("Rejected on-chain", "The price moved past your slippage."), "No funds were moved.");
    return esc(explainError(e));
  }
}
