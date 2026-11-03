import { StrKey } from "@stellar/stellar-base";
import type { NetConfig } from "../env";
import type { HorizonAccount } from "../stellar/horizon";
import { readContract } from "../stellar/soroban";
import { contractId, findPath, type Quote } from "./api";
import type { AssetRef } from "../stellar/tx";

const XLM: AssetRef = { code: "XLM" };
export const USDC_MAINNET: AssetRef = { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };
export const AQUA_MAINNET: AssetRef = { code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" };

export const AQUA_TESTNET: AssetRef = { code: "AQUA", issuer: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER" };
export const USDC_TESTNET: AssetRef = { code: "USDC", issuer: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER" };

export interface TokenInfo {
  asset: AssetRef;
  priceXlm: number;
  priceUsd: number | null;
  supply: number | null;
  mcXlm: number | null;
  mcUsd: number | null;
  route: string[];
  poolCount: number;
  depth: { labelA: string; labelB: string; a: number; b: number } | null;
}

const isNative = (a: AssetRef) => a.code === "XLM" && !a.issuer;

export async function xlmUsd(net: NetConfig): Promise<number | null> {
  if (net.isTestnet) return null;
  const q = await findPath(net, XLM, USDC_MAINNET, 1_000_0000000n).catch(() => null);
  return q ? Number(q.amountOut) / 1e10 : null;
}

/** Spot-ish price: quote selling 1 token (retry bigger sizes for dust-priced tokens). */
async function priceInXlm(net: NetConfig, a: AssetRef): Promise<{ price: number; q: Quote } | null> {
  for (const units of [1n, 1_000n, 1_000_000n]) {
    const inn = units * 10_000_000n;
    const q = await findPath(net, a, XLM, inn).catch(() => null);
    if (!q) continue;
    if (q.amountOut >= 1000n) return { price: Number(q.amountOut) / Number(inn), q };
  }
  return null;
}

async function supplyOf(net: NetConfig, a: AssetRef): Promise<number | null> {
  try {
    const r = await fetch(`${net.horizon}/assets?asset_code=${a.code}&asset_issuer=${a.issuer}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rec = ((await r.json()) as any)._embedded?.records?.[0];
    if (!rec) return null;
    const v = Number(rec.balances?.authorized ?? rec.amount ?? 0) + Number(rec.contracts_amount ?? 0);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

const label = (t: string) => (t === "native" ? "XLM" : t.split(":")[0]);

export async function getTokenInfo(net: NetConfig, a: AssetRef, src: HorizonAccount | null): Promise<TokenInfo | null> {
  const usd = await xlmUsd(net);
  if (isNative(a)) {
    return { asset: a, priceXlm: 1, priceUsd: usd, supply: null, mcXlm: null, mcUsd: null, route: [], poolCount: 0, depth: null };
  }
  const p = await priceInXlm(net, a);
  if (!p) return null;
  const supply = await supplyOf(net, a);
  let depth: TokenInfo["depth"] = null;
  if (src && p.q.pools[0]) {
    try {
      const r = (await readContract(net, src, p.q.pools[0], "get_reserves")) as bigint[];
      const [t0, t1] = p.q.tokenAddresses;
      // reserves come in contract-sorted token order
      const first = Buffer.compare(StrKey.decodeContract(t0), StrKey.decodeContract(t1)) <= 0;
      const [ra, rb] = first ? [r[0], r[1]] : [r[1], r[0]];
      depth = { labelA: label(p.q.tokens[0]), labelB: label(p.q.tokens[1]), a: Number(ra) / 1e7, b: Number(rb) / 1e7 };
    } catch {}
  }
  return {
    asset: a,
    priceXlm: p.price,
    priceUsd: usd ? p.price * usd : null,
    supply,
    mcXlm: supply ? supply * p.price : null,
    mcUsd: supply && usd ? supply * p.price * usd : null,
    route: p.q.tokens.map(label),
    poolCount: p.q.pools.length,
    depth,
  };
}

export { contractId };
