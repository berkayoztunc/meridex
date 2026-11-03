import { Address, StrKey, XdrLargeInt, xdr } from "@stellar/stellar-base";
import type { NetConfig } from "../env";
import type { HorizonAccount } from "../stellar/horizon";
import { readContract } from "../stellar/soroban";
import { toAsset } from "../stellar/tx";

/** Stelfun launchpad: bonding curve first, then the launchpad's own pool after graduation. Same buy/sell entrypoints throughout. */
export const CURVE_STATUS = ["Trading", "Complete", "Graduated"] as const;

export interface Curve {
  createdAt: bigint;
  creator: string;
  realQuote: bigint;
  realToken: bigint;
  status: number;
  vQuote: bigint;
  vToken: bigint;
}

export interface LpConfig {
  quote: string;
  quoteDecimals: number;
  feeBps: number;
  minFee: bigint;
  curveSupply: bigint;
}

export interface CoinMeta {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export const lpEnabled = (net: NetConfig) => StrKey.isValidContract(net.launchpad);

const addr = (a: string) => new Address(a).toScVal();
const i128 = (v: bigint) => new XdrLargeInt("i128", v.toString()).toI128();

const nativeSac = (net: NetConfig) => toAsset({ code: "XLM" }).contractId(net.passphrase);

/** Curve of `coin`, or null when it is not a coin of this launchpad. */
export async function getCurve(net: NetConfig, src: HorizonAccount, coin: string): Promise<Curve | null> {
  if (!lpEnabled(net)) return null;
  try {
    const c = (await readContract(net, src, net.launchpad, "curve", [addr(coin)])) as any;
    if (!c) return null;
    return {
      createdAt: BigInt(c.created_at),
      creator: String(c.creator),
      realQuote: BigInt(c.real_quote),
      realToken: BigInt(c.real_token),
      status: Number(c.status),
      vQuote: BigInt(c.v_quote),
      vToken: BigInt(c.v_token),
    };
  } catch {
    return null;
  }
}

export async function getConfig(net: NetConfig, src: HorizonAccount): Promise<LpConfig> {
  const c = (await readContract(net, src, net.launchpad, "config")) as any;
  return {
    quote: String(c.quote),
    quoteDecimals: Number(c.quote_decimals),
    feeBps: Number(c.fee_bps),
    minFee: BigInt(c.min_fee),
    curveSupply: BigInt(c.curve_supply),
  };
}

export async function getMeta(net: NetConfig, src: HorizonAccount, coin: string): Promise<CoinMeta> {
  const [name, symbol, decimals, totalSupply] = await Promise.all(
    ["name", "symbol", "decimals", "total_supply"].map((fn) => readContract(net, src, coin, fn)),
  );
  return { name: String(name), symbol: String(symbol), decimals: Number(decimals), totalSupply: BigInt(totalSupply as bigint) };
}

export async function coinBalance(net: NetConfig, src: HorizonAccount, coin: string, holder: string): Promise<bigint> {
  return BigInt((await readContract(net, src, coin, "balance", [addr(holder)])) as bigint);
}

export async function progressBps(net: NetConfig, src: HorizonAccount, coin: string): Promise<number> {
  return Number(await readContract(net, src, net.launchpad, "progress", [addr(coin)]));
}

/** The bot only handles 7-decimal coins quoted in native XLM; anything else is refused up front. */
export function unsupportedReason(net: NetConfig, cfg: LpConfig, meta: CoinMeta): string | null {
  if (cfg.quote !== nativeSac(net)) return "This launchpad is not quoted in XLM.";
  if (meta.decimals !== 7 || cfg.quoteDecimals !== 7) return "Only 7-decimal coins are supported.";
  return null;
}

/** XLM per whole coin from the reserves the price is computed from. */
export const spotPrice = (c: Curve): number => (c.vToken > 0n ? Number(c.vQuote) / Number(c.vToken) : 0);

export interface BuyQuote {
  tokensOut: bigint;
  quoteUsed: bigint;
  fee: bigint;
  refund: bigint;
}

export async function quoteBuy(net: NetConfig, src: HorizonAccount, coin: string, quoteIn: bigint): Promise<BuyQuote> {
  const [tokensOut, quoteUsed, fee, refund] = (await readContract(net, src, net.launchpad, "quote_buy", [addr(coin), i128(quoteIn)])) as bigint[];
  return { tokensOut, quoteUsed, fee, refund };
}

export async function quoteSell(net: NetConfig, src: HorizonAccount, coin: string, tokensIn: bigint): Promise<{ quoteOut: bigint; fee: bigint }> {
  const [quoteOut, fee] = (await readContract(net, src, net.launchpad, "quote_sell", [addr(coin), i128(tokensIn)])) as bigint[];
  return { quoteOut, fee };
}

/**
 * Largest `quote_in` whose cost (quote_in + fee) fits in `budget`, with the quote for it.
 * `buy` charges the fee on top of `quote_in`, so a plain "spend everything" would fail.
 */
export async function fitBuy(net: NetConfig, src: HorizonAccount, cfg: LpConfig, coin: string, budget: bigint): Promise<{ quoteIn: bigint; q: BuyQuote } | null> {
  let quoteIn = (budget * 10_000n) / (10_000n + BigInt(cfg.feeBps));
  for (let i = 0; i < 3 && quoteIn > 0n; i++) {
    const q = await quoteBuy(net, src, coin, quoteIn);
    const over = q.quoteUsed + q.fee - budget;
    if (over <= 0n) return { quoteIn, q };
    quoteIn -= over;
  }
  return null;
}

export const buyArgs = (buyer: string, coin: string, quoteIn: bigint, minOut: bigint): xdr.ScVal[] => [addr(buyer), addr(coin), i128(quoteIn), i128(minOut)];
export const sellArgs = (seller: string, coin: string, tokensIn: bigint, minOut: bigint): xdr.ScVal[] => [addr(seller), addr(coin), i128(tokensIn), i128(minOut)];

/** Launchpad error codes (100+) and coin error codes (1-9) surfaced in simulation errors. */
const LP_ERRORS: Record<number, string> = {
  101: "This coin is not on the launchpad.",
  102: "Curve is not complete yet.",
  103: "Amount too small.",
  104: "Price moved beyond your slippage.",
  105: "The curve doesn't hold enough XLM for this sell.",
  106: "Invalid recipient.",
  109: "Amount out of range.",
};

export function explainLp(msg: string): string {
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (!m) return msg.slice(0, 120);
  const n = Number(m[1]);
  return LP_ERRORS[n] ?? (n === 3 ? "Insufficient coin balance." : n === 1 ? "Coin is locked until graduation." : `Contract error #${n}`);
}
