import type { HorizonAccount } from "./horizon";
import { parseHorizon } from "./amount";

const BASE_RESERVE = 5_000_000n; // 0.5 XLM

export interface TokenBalance {
  code: string;
  issuer: string;
  balance: bigint;
  limit: bigint | null;
}

export interface Summary {
  xlm: bigint;
  reserve: bigint;
  available: bigint;
  tokens: TokenBalance[];
}

export function summarize(a: HorizonAccount): Summary {
  const native = a.balances.find((b) => b.asset_type === "native");
  const xlm = native ? parseHorizon(native.balance) : 0n;
  const sellLiab = native?.selling_liabilities ? parseHorizon(native.selling_liabilities) : 0n;
  const entries = BigInt(2 + a.subentry_count + (a.num_sponsoring ?? 0) - (a.num_sponsored ?? 0));
  const reserve = entries * BASE_RESERVE;
  const avail = xlm - reserve - sellLiab;
  const tokens = a.balances
    .filter((b) => b.asset_code && b.asset_issuer)
    .map((b) => ({
      code: b.asset_code!,
      issuer: b.asset_issuer!,
      balance: parseHorizon(b.balance),
      limit: b.limit ? parseHorizon(b.limit) : null,
    }));
  return { xlm, reserve, available: avail > 0n ? avail : 0n, tokens };
}
