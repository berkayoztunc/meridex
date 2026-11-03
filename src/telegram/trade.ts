import type { Env } from "../env";
import { netConfig } from "../env";
import * as api from "./api";
import { esc } from "./api";
import * as db from "../db";
import { bal, compact, fmt, fmtAsset, head, kb, kv, msg, netName, num } from "./ui";
import { StrKey } from "@stellar/stellar-base";
import { getAccount, getFee, submitTx, HorizonError, explainError } from "../stellar/horizon";
import { summarize } from "../stellar/balances";
import { toStroops } from "../stellar/amount";
import { isValidAddress, parseAssetSpec } from "../stellar/wallet";
import { buildTx, changeTrustOp, signTx, type AssetRef } from "../stellar/tx";
import { findPath, minOut, swapArgs, type Quote } from "../aqua/api";
import { AQUA_MAINNET, AQUA_TESTNET, USDC_MAINNET, USDC_TESTNET, getTokenInfo } from "../aqua/market";
import { prepareInvoke, waitForResult, SorobanError } from "../stellar/soroban";
import { unlockSecret } from "../service";
import { launchpadCard, handleLaunchpadState, handleLaunchpadCallback, heldLaunchpadRows } from "./launchpad";

interface Ctx {
  chat: number;
  from: number;
}

const XLM: AssetRef = { code: "XLM" };
const FEE_MARGIN = 500_000n; // 0.05 XLM kept for Soroban fees
const TRUST_RESERVE = 5_000_000n;

const specOf = (a: AssetRef) => (a.issuer ? `${a.code}:${a.issuer}` : "XLM");
const shortIssuer = (i?: string) => (i ? `${i.slice(0, 5)}…${i.slice(-4)}` : "");

function parseToken(text: string): AssetRef | null {
  const t = text.trim();
  if (/^(xlm|native)$/i.test(t)) return XLM;
  return parseAssetSpec(t);
}

async function needWallet(env: Env, c: Ctx) {
  const w = await db.activeWallet(env, c.from);
  if (!w) await api.sendMessage(env, c.chat, "No wallet yet. Send /start to create one.");
  return w;
}

async function pickRow(env: Env, tg: number, asset: AssetRef, action: string, text: string) {
  const id = await db.createPending(env, tg, "tok", { asset, action }, 900);
  return [{ text, data: `pk:${id}` }];
}

async function tokenPicker(env: Env, tg: number, action: string, withHeld: boolean) {
  const net = netConfig(env);
  const rows: { text: string; data: string }[][] = [];
  const aqua = net.isTestnet ? AQUA_TESTNET : AQUA_MAINNET;
  const usdc = net.isTestnet ? USDC_TESTNET : USDC_MAINNET;
  rows.push(await pickRow(env, tg, aqua, action, "AQUA"));
  rows.push(await pickRow(env, tg, usdc, action, "USDC"));
  if (withHeld) {
    const w = await db.activeWallet(env, tg);
    const acc = w && (await getAccount(net, w.public_key));
    if (acc)
      for (const k of summarize(acc).tokens.slice(0, 6)) {
        if (k.issuer === aqua.issuer && k.code === "AQUA") continue;
        if (k.issuer === usdc.issuer && k.code === "USDC") continue;
        rows.push(await pickRow(env, tg, { code: k.code, issuer: k.issuer }, action, k.code));
      }
  }
  return rows;
}

// ---------- Price ----------

export async function priceStart(env: Env, c: Ctx, arg: string): Promise<void> {
  if (arg) return showPrice(env, c, parseToken(arg));
  await db.setState(env, c.from, { step: "price_token" });
  const rows = await tokenPicker(env, c.from, "price", true);
  rows.unshift(await pickRow(env, c.from, XLM, "price", "XLM"));
  await api.sendMessage(
    env,
    c.chat,
    msg(head("Token price", "Pick a token below or send it as <code>CODE:ISSUER</code>."), "<i>/cancel to abort</i>"),
    { markup: kb(rows) },
  );
}

async function showPrice(env: Env, c: Ctx, asset: AssetRef | null): Promise<void> {
  await db.setState(env, c.from, null);
  if (!asset) return void (await api.sendMessage(env, c.chat, "Invalid token. Use <code>CODE:ISSUER</code> or <code>XLM</code>."));
  if (!(await db.rateLimit(env, c.from, "quote", 20, 60))) return void (await api.sendMessage(env, c.chat, "Too many price requests. Wait a minute and try again."));
  const pid = await api.sendMessage(env, c.chat, `Fetching ${esc(fmtAsset(asset))} market data…`);
  const net = netConfig(env);
  const w = await db.activeWallet(env, c.from);
  const src = w ? await getAccount(net, w.public_key).catch(() => null) : null;
  const info = await getTokenInfo(net, asset, src).catch(() => null);
  const done = (t: string, markup?: Record<string, unknown>) => (pid ? api.editMessage(env, c.chat, pid, t, markup) : api.sendMessage(env, c.chat, t, { markup }).then(() => {}));
  if (!info) return done(head("No Aquarius route found", "This token may have no liquidity."));
  const price = info.priceUsd !== null ? "$" + num(info.priceUsd) : num(info.priceXlm) + " XLM";
  const priceAlt = info.priceUsd !== null && asset.issuer ? `  (${num(info.priceXlm)} XLM)` : "";
  const mc = info.mcUsd !== null ? `~$${compact(info.mcUsd)}` : info.mcXlm !== null ? `~${compact(info.mcXlm)} XLM` : null;
  const t = msg(
    head(`${esc(fmtAsset(asset))}${asset.issuer ? ` · <code>${shortIssuer(asset.issuer)}</code>` : ""}`, `<b>${price}</b>${priceAlt}`, ...(mc ? [`Market cap ${mc}`] : [])),
    kv([
      ["Supply", info.supply !== null ? compact(info.supply) : null],
      ["Pool depth", info.depth && `${compact(info.depth.a)} / ${compact(info.depth.b)} (${esc(info.depth.labelA)}/${esc(info.depth.labelB)})`],
      ["Route", info.route.length ? `${info.route.map(esc).join(" → ")} (${info.poolCount} pool${info.poolCount > 1 ? "s" : ""})` : null],
    ]),
    "<i>Estimated from an Aquarius quote. Market cap = supply × price.</i>",
  );
  const rows = asset.issuer
    ? [[...(await pickRow(env, c.from, asset, "buy", "Buy")), ...(await pickRow(env, c.from, asset, "sell", "Sell"))]]
    : undefined;
  await done(t, rows ? kb(rows) : undefined);
}

// ---------- Buy ----------

export async function buyStart(env: Env, c: Ctx, arg: string): Promise<void> {
  const w = await needWallet(env, c);
  if (!w) return;
  if (arg) return buyInput(env, c, arg);
  await db.setState(env, c.from, { step: "buy_token", walletId: w.id });
  const rows = await tokenPicker(env, c.from, "buy", true);
  await api.sendMessage(
    env,
    c.chat,
    msg(head("Buy a token with XLM", "Pick a token or send it as <code>CODE:ISSUER</code>."), "Verify the issuer before buying. Fake tokens exist.\n<i>/cancel to abort</i>"),
    { markup: rows.length ? kb(rows) : undefined },
  );
}

async function buyInput(env: Env, c: Ctx, text: string): Promise<void> {
  if (matchToken(text) && (await tryOpenToken(env, c, text))) return void (await db.setState(env, c.from, null));
  return buyAsset(env, c, parseToken(text));
}

async function buyAsset(env: Env, c: Ctx, asset: AssetRef | null): Promise<void> {
  await db.setState(env, c.from, null);
  return tradeCard(env, c, asset);
}

// ---------- Sell ----------

export async function sellStart(env: Env, c: Ctx): Promise<void> {
  const w = await needWallet(env, c);
  if (!w) return;
  const acc = await getAccount(netConfig(env), w.public_key);
  const held = acc ? summarize(acc).tokens.filter((k) => k.balance > 0n) : [];
  const lpRows = await heldLaunchpadRows(env, c.from, acc);
  if (!held.length && !lpRows.length) return void (await api.sendMessage(env, c.chat, "You hold no tokens to sell. Use /buy first."));
  await db.setState(env, c.from, { step: "sell_token", walletId: w.id });
  const rows: { text: string; data: string }[][] = [];
  for (const k of held.slice(0, 8)) rows.push(await pickRow(env, c.from, { code: k.code, issuer: k.issuer }, "sell", `${k.code} (${fmt(k.balance)})`));
  rows.push(...lpRows);
  await api.sendMessage(env, c.chat, head("Sell a token for XLM", "Choose the token to sell."), { markup: kb(rows) });
}

async function sellAsset(env: Env, c: Ctx, asset: AssetRef): Promise<void> {
  await db.setState(env, c.from, null);
  return tradeCard(env, c, asset);
}

// ---------- Trade card ----------

function maxBuyStroops(s: ReturnType<typeof summarize>, needsTrust: boolean): bigint {
  const v = s.available - FEE_MARGIN - (needsTrust ? TRUST_RESERVE : 0n);
  return v > 0n ? v : 0n;
}

export async function tradeCard(env: Env, c: Ctx, asset: AssetRef | null, edit?: number): Promise<void> {
  if (!asset || !asset.issuer) return void (await api.sendMessage(env, c.chat, "Token not recognised. Send it as <code>CODE:ISSUER</code> (XLM is the base currency)."));
  const w = await needWallet(env, c);
  if (!w) return;
  if (!(await db.rateLimit(env, c.from, "quote", 20, 60))) return void (await api.sendMessage(env, c.chat, "Too many requests. Wait a minute and try again."));
  const net = netConfig(env);
  const mid = edit ?? (await api.sendMessage(env, c.chat, `Loading ${esc(asset.code)}…`));
  const show = (t: string, m?: Record<string, unknown>) =>
    mid ? api.editMessage(env, c.chat, mid, t, m) : api.sendMessage(env, c.chat, t, { markup: m }).then(() => {});
  const acc = await getAccount(net, w.public_key).catch(() => null);
  const s = acc ? summarize(acc) : null;
  const info = await getTokenInfo(net, asset, acc).catch(() => null);
  const link = `https://stellar.expert/explorer/${net.isTestnet ? "testnet" : "public"}/asset/${asset.code}-${asset.issuer}`;
  const title = `${esc(asset.code)} · ${shortIssuer(asset.issuer)} · ${netName(net.isTestnet)}`;
  if (!info) {
    return show(
      msg(
        head(title, "No Aquarius route found", "The token may have no liquidity" + (net.isTestnet ? " (testnet liquidity is limited)." : ".")),
        `<a href="${link}">Check on Stellar Expert</a>`,
      ),
    );
  }
  const price = info.priceUsd !== null ? "$" + num(info.priceUsd) : num(info.priceXlm) + " XLM";
  const mc = info.mcUsd !== null ? `~$${compact(info.mcUsd)}` : info.mcXlm !== null ? `~${compact(info.mcXlm)} XLM` : null;
  const sub = [mc && `Market cap ${mc}`, info.supply !== null && `Supply ${compact(info.supply)}`].filter(Boolean).join(" · ");
  let t = head(title, `<b>${price}</b>${info.priceUsd !== null ? ` · ${num(info.priceXlm)} XLM` : ""}`, ...(sub ? [sub] : []));
  t += "\n\n" + kv([
    ["Depth", info.depth && `${compact(info.depth.a)} / ${compact(info.depth.b)} (${esc(info.depth.labelA)}/${esc(info.depth.labelB)})`],
    ["Route", info.route.length ? info.route.map(esc).join(" → ") : null],
  ]);
  t += `\n<a href="${link}">Verify issuer</a>`;

  const tid = await db.createPending(env, c.from, "tok", { asset, action: "trade" }, 1800);
  const rows: { text: string; data: string }[][] = [];
  if (!s) {
    t += "\n\n" + kv([["Wallet", esc(w.label)], ["Status", "Not activated. Fund it first."]]);
  } else {
    const held = s.tokens.find((k) => k.code === asset.code && k.issuer === asset.issuer);
    const hold = held?.balance ?? 0n;
    const maxXlm = maxBuyStroops(s, !held);
    const price = info.priceXlm;
    t += "\n\n" + kv([
      ["Wallet", esc(w.label)],
      ["Available", `<b>${bal(s.available)} XLM</b>`],
      ["Can buy", `~<b>${maxXlm > 0n && price > 0 ? compact(Number(maxXlm) / 1e7 / price) : "0"} ${esc(asset.code)}</b>`],
      ["Holding", `<b>${bal(hold)} ${esc(asset.code)}</b>` + (hold > 0n ? ` (~${compact((Number(hold) / 1e7) * price)} XLM)` : "")],
    ]);
    const fixed = [10, 50, 100].filter((n) => maxXlm >= BigInt(n) * 10_000_000n);
    if (fixed.length) rows.push(fixed.map((n) => ({ text: `Buy ${n} XLM`, data: `tb:${tid}:${n}` })));
    if (maxXlm > 0n) rows.push([25, 50, 100].map((p) => ({ text: `Buy ${p === 100 ? "Max" : p + "%"}`, data: `tp:${tid}:${p}` })));
    if (hold > 0n) rows.push([25, 50, 75, 100].map((p) => ({ text: `Sell ${p}%`, data: `ts:${tid}:${p}` })));
    const custom = [{ text: "Buy custom", data: `tx:${tid}:b` }];
    if (hold > 0n) custom.push({ text: "Sell custom", data: `tx:${tid}:s` });
    rows.push(custom);
  }
  const bps = await db.getSlippage(env, c.from);
  rows.push([
    { text: `Wallet: ${w.label}`, data: `tw:${tid}` },
    { text: `Slippage ${bps / 100}%`, data: "sgm" },
    { text: "Refresh", data: `tr:${tid}` },
  ]);
  await show(t, kb(rows));
}

/** Plain-chat token detection: CODE:ISSUER, CODE-ISSUER[-n], or a contract id (resolved via Stellar Expert). */
export type TokenMatch = { asset: AssetRef } | { contract: string } | null;

export function matchToken(text: string): TokenMatch {
  const m = text.match(/(?:^|[^A-Za-z0-9])([A-Za-z0-9]{1,12})[:\-](G[A-Z2-7]{55})(?:-\d+)?(?![A-Za-z0-9])/);
  if (m && isValidAddress(m[2])) return { asset: { code: m[1], issuer: m[2] } };
  const cm = text.match(/(?:^|[^A-Za-z0-9])(C[A-Z2-7]{55})(?![A-Za-z0-9])/);
  if (cm && StrKey.isValidContract(cm[1])) return { contract: cm[1] };
  return null;
}

export async function tryOpenToken(env: Env, c: Ctx, text: string): Promise<boolean> {
  const hit = matchToken(text);
  if (!hit) return false;
  if ("asset" in hit) {
    await tradeCard(env, c, hit.asset);
    return true;
  }
  {
    const net = netConfig(env);
    if (await launchpadCard(env, c, hit.contract)) return true;
    try {
      const r = await fetch(`https://api.stellar.expert/explorer/${net.isTestnet ? "testnet" : "public"}/contract/${hit.contract}`, { signal: AbortSignal.timeout(10000) });
      const asset = r.ok ? (((await r.json()) as any).asset as string | undefined) : undefined;
      const am = asset?.match(/^([A-Za-z0-9]{1,12})-(G[A-Z2-7]{55})/);
      if (am) {
        await tradeCard(env, c, { code: am[1], issuer: am[2] });
        return true;
      }
      if (asset === "XLM") {
        await api.sendMessage(env, c.chat, "That is native XLM, the base currency. Pick a token with /buy.");
        return true;
      }
    } catch {}
    await api.sendMessage(env, c.chat, "Could not resolve this contract to a Stellar asset. Send the token as <code>CODE:ISSUER</code>.");
    return true;
  }
  return false;
}

// ---------- Quote card ----------

async function quoteCard(env: Env, c: Ctx, side: "buy" | "sell", inn: AssetRef, out: AssetRef, amountIn: bigint): Promise<void> {
  await db.setState(env, c.from, null);
  const w = await needWallet(env, c);
  if (!w) return;
  if (!(await db.rateLimit(env, c.from, "quote", 20, 60))) return void (await api.sendMessage(env, c.chat, "Too many quotes. Wait a minute and try again."));
  const net = netConfig(env);
  const acc = await getAccount(net, w.public_key);
  if (!acc) return void (await api.sendMessage(env, c.chat, "Wallet not activated yet. Fund it first."));
  const s = summarize(acc);
  if (side === "buy" && amountIn + FEE_MARGIN > s.available)
    return void (await api.sendMessage(env, c.chat, `Not enough XLM. Available: <b>${fmt(s.available)} XLM</b> (a small amount is kept for fees).`));
  if (side === "sell" && s.available < FEE_MARGIN) return void (await api.sendMessage(env, c.chat, "Not enough XLM for the network fee. Add a little XLM and retry."));
  const pid = await api.sendMessage(env, c.chat, "Getting the best price…");
  const q = await findPath(net, inn, out, amountIn).catch(() => null);
  const edit = (t: string, m?: Record<string, unknown>) => (pid ? api.editMessage(env, c.chat, pid, t, m) : api.sendMessage(env, c.chat, t, { markup: m }).then(() => {}));
  if (!q) return edit(head("No route found", "The token may have no liquidity" + (net.isTestnet ? " (testnet liquidity is limited)." : ".")));
  const bps = await db.getSlippage(env, c.from);
  const min = minOut(q.amountOut, bps);
  const id = await db.createPending(env, c.from, "tx", {
    type: "swap", walletId: w.id, side, inn, out, amountIn: amountIn.toString(), minOut: min.toString(), quotedOut: q.amountOut.toString(),
  }, 120);
  const token = side === "buy" ? out : inn;
  const needsTrust = side === "buy" && !s.tokens.some((k) => k.code === out.code && k.issuer === out.issuer);
  const rate = Number(q.amountOut) / Number(amountIn);
  const t = msg(
    head("Swap preview", `<b>Pay ${fmt(amountIn)} ${esc(fmtAsset(inn))} · get ~${fmt(q.amountOut)} ${esc(fmtAsset(out))}</b>`, `Minimum ${fmt(min)} ${esc(fmtAsset(out))} at ${bps / 100}% slippage`),
    kv([
      ["Wallet", esc(w.label)],
      ["Rate", `1 ${esc(fmtAsset(inn))} ≈ ${num(rate)} ${esc(fmtAsset(out))}`],
      ["Route", q.tokens.map((x) => esc(x === "native" ? "XLM" : x.split(":")[0])).join(" → ")],
      ["Token", `<code>${esc(token.code)}:${shortIssuer(token.issuer)}</code>`],
    ]),
    needsTrust && "First-time token: a trustline will be added (reserves 0.5 XLM).",
    "Expires in 2 minutes. No bot fee.",
  );
  await edit(t, kb([[{ text: "Confirm", data: `ok:${id}` }, { text: "Cancel", data: `no:${id}` }], [{ text: "Slippage", data: "sgm" }]]));
}

// ---------- Slippage ----------

export async function slippageMenu(env: Env, c: Ctx): Promise<void> {
  const cur = await db.getSlippage(env, c.from);
  const b = (bps: number) => ({ text: cur === bps ? `[${bps / 100}%]` : `${bps / 100}%`, data: `sg:${bps}` });
  await api.sendMessage(
    env,
    c.chat,
    msg(head("Slippage tolerance", `Current <b>${cur / 100}%</b>`), "A swap fails (and your funds stay put) if the price moves worse than this. Use low values for stable pairs, higher for illiquid tokens."),
    { markup: kb([[b(10), b(50), b(100), b(300)]]) },
  );
}

// ---------- Dispatch ----------

export async function handleTradeState(env: Env, c: Ctx, st: any, text: string): Promise<boolean> {
  if (await handleLaunchpadState(env, c, st, text)) return true;
  switch (st.step) {
    case "price_token":
      await showPrice(env, c, parseToken(text));
      return true;
    case "buy_token":
      await buyInput(env, c, text);
      return true;
    case "buy_amount": {
      const v = toStroops(text);
      if (v === null) return void (await api.sendMessage(env, c.chat, "Invalid amount. Use a positive number with up to 7 decimals.")), true;
      await quoteCard(env, c, "buy", XLM, st.asset, v);
      return true;
    }
    case "sell_token": {
      const a = parseToken(text);
      if (!a || !a.issuer) return void (await api.sendMessage(env, c.chat, "Token not recognised. Pick one from the buttons or send <code>CODE:ISSUER</code>.")), true;
      await sellAsset(env, c, a);
      return true;
    }
    case "sell_amount": {
      const v = toStroops(text);
      if (v === null) return void (await api.sendMessage(env, c.chat, "Invalid amount. Use a positive number with up to 7 decimals.")), true;
      if (v > BigInt(st.balance)) return void (await api.sendMessage(env, c.chat, `Not enough balance. You have ${fmt(BigInt(st.balance))} ${esc(st.asset.code)}.`)), true;
      await quoteCard(env, c, "sell", st.asset, XLM, v);
      return true;
    }
  }
  return false;
}

const TRADE_CB = new Set(["tb", "tp", "ts", "tx", "tw", "tk", "tr"]);

export async function handleTradeCallback(env: Env, c: Ctx & { id: string; msgId: number }, k: string, a?: string, b?: string): Promise<boolean> {
  if (await handleLaunchpadCallback(env, c, k, a, b)) return true;
  if (TRADE_CB.has(k)) {
    const p = await db.peekPending(env, c.from, a ?? "", "tok");
    if (!p) return void (await api.answerCallback(env, c.id, "Expired. Reopen the token.")), true;
    const asset: AssetRef = p.asset;
    if (k === "tr") {
      await api.answerCallback(env, c.id, "Refreshing");
      await tradeCard(env, c, asset, c.msgId);
      return true;
    }
    if (k === "tw") {
      const ws = await db.listWallets(env, c.from);
      await api.answerCallback(env, c.id);
      const rows = ws.map((w) => [{ text: `${w.is_active ? "• " : ""}${w.label} · ${w.public_key.slice(0, 6)}…${w.public_key.slice(-4)}`, data: `tk:${a}:${w.id}` }]);
      rows.push([{ text: "Back", data: `tr:${a}` }]);
      await api.editMessage(env, c.chat, c.msgId, head("Choose wallet", `For trading ${esc(asset.code)}`, "This also becomes your active wallet."), kb(rows));
      return true;
    }
    if (k === "tk") {
      const ok = await db.setActive(env, c.from, Number(b));
      await api.answerCallback(env, c.id, ok ? "Wallet switched" : "Not found");
      await tradeCard(env, c, asset, c.msgId);
      return true;
    }
    const w = await db.activeWallet(env, c.from);
    const acc = w && (await getAccount(netConfig(env), w.public_key).catch(() => null));
    if (!w || !acc) return void (await api.answerCallback(env, c.id, "Wallet not activated")), true;
    const s = summarize(acc);
    const held = s.tokens.find((x) => x.code === asset.code && x.issuer === asset.issuer);
    if (k === "tx") {
      await api.answerCallback(env, c.id);
      if (b === "b") {
        await db.setState(env, c.from, { step: "buy_amount", walletId: w.id, asset });
        await api.sendMessage(env, c.chat, msg(head(`Buy ${esc(asset.code)}`, `Available <b>${bal(s.available)} XLM</b>`), "Send the amount of <b>XLM</b> to spend."));
      } else if (held && held.balance > 0n) {
        await db.setState(env, c.from, { step: "sell_amount", walletId: w.id, asset, balance: held.balance.toString() });
        await api.sendMessage(env, c.chat, msg(head(`Sell ${esc(asset.code)}`, `Sellable <b>${bal(held.balance)} ${esc(asset.code)}</b>`), `Send the amount of <b>${esc(asset.code)}</b> to sell.`));
      }
      return true;
    }
    await api.answerCallback(env, c.id);
    if (k === "tb") return await quoteCard(env, c, "buy", XLM, asset, BigInt(b ?? "0") * 10_000_000n), true;
    if (k === "tp") {
      const pct = BigInt(b ?? "0");
      const max = maxBuyStroops(s, !held);
      const amt = pct === 100n ? max : (s.available * pct) / 100n;
      if (amt <= 0n) return void (await api.sendMessage(env, c.chat, "Not enough available XLM. Add XLM or pick a smaller amount.")), true;
      return await quoteCard(env, c, "buy", XLM, asset, amt), true;
    }
    if (k === "ts") {
      if (!held || held.balance <= 0n) return void (await api.sendMessage(env, c.chat, `No ${esc(asset.code)} in ${esc(w.label)}. Nothing to sell.`)), true;
      const pct = BigInt(b ?? "0");
      const amt = pct === 100n ? held.balance : (held.balance * pct) / 100n;
      return await quoteCard(env, c, "sell", asset, XLM, amt), true;
    }
    return true;
  }
  if (k === "pk") {
    const p = await db.peekPending(env, c.from, a ?? "", "tok");
    if (!p) return void (await api.answerCallback(env, c.id, "Expired. Run the command again.")), true;
    await api.answerCallback(env, c.id);
    await api.editMessage(env, c.chat, c.msgId, `Selected <b>${esc(fmtAsset(p.asset))}</b>`);
    if (p.action === "price") await showPrice(env, c, p.asset);
    else if (p.action === "buy") await buyAsset(env, c, p.asset);
    else if (p.action === "sell") await sellAsset(env, c, p.asset);
    return true;
  }
  if (k === "ba" || k === "sp") {
    const st = await db.getState(env, c.from);
    await api.answerCallback(env, c.id);
    if (k === "ba" && st?.step === "buy_amount") {
      await api.editMessage(env, c.chat, c.msgId, `${esc(a ?? "")} XLM`);
      await quoteCard(env, c, "buy", XLM, st.asset, BigInt(a ?? "0") * 10_000_000n);
    } else if (k === "sp" && st?.step === "sell_amount") {
      const amt = (BigInt(st.balance) * BigInt(a ?? "0")) / 100n;
      await api.editMessage(env, c.chat, c.msgId, `${esc(a ?? "")}% · ${fmt(amt)} ${esc(st.asset.code)}`);
      await quoteCard(env, c, "sell", st.asset, XLM, amt);
    } else await api.editMessage(env, c.chat, c.msgId, "Expired. Start again.");
    return true;
  }
  if (k === "sg") {
    const bps = Number(a);
    if (![10, 50, 100, 300].includes(bps)) return true;
    await db.setSlippage(env, c.from, bps);
    await api.answerCallback(env, c.id, `Slippage ${bps / 100}%`);
    await api.editMessage(env, c.chat, c.msgId, head("Slippage updated", `Now <b>${bps / 100}%</b>`));
    return true;
  }
  if (k === "sgm") {
    await api.answerCallback(env, c.id);
    await slippageMenu(env, c);
    return true;
  }
  return false;
}

// ---------- Execute ----------

export async function executeSwap(env: Env, tg: number, p: any): Promise<string> {
  const net = netConfig(env);
  const w = await db.activeWallet(env, tg);
  if (!w || w.id !== p.walletId) return "Active wallet changed, so this was cancelled. Start again.";
  const inn: AssetRef = p.inn;
  const out: AssetRef = p.out;
  const amountIn = BigInt(p.amountIn);
  const min = BigInt(p.minOut);
  const secret = await unlockSecret(env, w);
  const base = net.isTestnet ? "https://stellar.expert/explorer/testnet" : "https://stellar.expert/explorer/public";
  const trade = { tg, walletId: w.id, side: p.side, selling: specOf(inn), buying: specOf(out), amount: p.amountIn, minOut: p.minOut };

  let acc = await getAccount(net, w.public_key);
  if (!acc) return "Wallet not activated. Fund it first.";
  let s = summarize(acc);
  if (p.side === "buy" && amountIn + FEE_MARGIN > s.available) return `Insufficient balance. Available: <b>${fmt(s.available)} XLM</b>.`;
  if (p.side === "sell") {
    const held = s.tokens.find((k) => k.code === inn.code && k.issuer === inn.issuer);
    if (!held || held.balance < amountIn) return "Insufficient token balance. Use a smaller amount.";
    if (s.available < FEE_MARGIN) return "Not enough XLM for the network fee. Add a little XLM and retry.";
  }

  try {
    // 1) trustline for the token we receive
    if (out.issuer && !s.tokens.some((k) => k.code === out.code && k.issuer === out.issuer)) {
      if (s.available < amountIn + TRUST_RESERVE + FEE_MARGIN) return "Not enough XLM to add the token trustline (0.5 XLM reserve) and swap. Add XLM or use a smaller amount.";
      const tt = buildTx({ source: acc, net, fee: await getFee(net) }, [changeTrustOp(out)]);
      await submitTx(net, signTx(tt, secret));
      acc = (await getAccount(net, w.public_key))!;
      s = summarize(acc);
    }

    // 2) fresh route; abort if price moved below the approved minimum
    const q: Quote | null = await findPath(net, inn, out, amountIn);
    if (!q) return "Route no longer available. Get a new quote.";
    if (q.amountOut < min) return head("Price moved", "Beyond your slippage tolerance. Nothing was swapped.", "Get a new quote to try again.");

    // 3) swap (one retry on sequence conflict)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tx = await prepareInvoke(net, acc, "10000", net.aquaRouter, "swap_chained", swapArgs(net, acc.id, q, inn, amountIn, min));
        const hash = await submitTx(net, signTx(tx, secret));
        const got = (await waitForResult(net, hash).catch(() => null)) as bigint | null;
        await db.recordTrade(env, { ...trade, amountOut: got?.toString(), status: "success", txHash: hash });
        await db.audit(env, tg, "swap", w.public_key, hash);
        return (
          msg(
            head("Swap complete", got !== null ? `<b>Received ${fmt(got)} ${esc(fmtAsset(out))}</b>` : `<b>Swap submitted</b>`, `Paid ${fmt(amountIn)} ${esc(fmtAsset(inn))}`),
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
    return "Swap failed. Please try again.";
  } catch (e) {
    await db.recordTrade(env, { ...trade, status: "failed" }).catch(() => {});
    if (e instanceof SorobanError) return msg(head("Swap rejected", esc(e.message.slice(0, 120))), "No funds were moved.");
    if (e instanceof HorizonError && (e.opCodes ?? []).some((o) => o.includes("invoke_host_function")))
      return msg(head("Swap rejected on-chain", "The price moved past your slippage, or the pool could not fill it."), "No funds were moved.");
    return esc(explainError(e));
  }
}

