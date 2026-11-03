import type { NetConfig } from "../env";

export interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
}

export interface HorizonAccount {
  id: string;
  sequence: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: HorizonBalance[];
}

export class HorizonError extends Error {
  constructor(
    message: string,
    public txCode?: string,
    public opCodes?: string[],
  ) {
    super(message);
  }
}

async function getJson(url: string): Promise<Response> {
  return fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
}

export async function getAccount(net: NetConfig, pub: string): Promise<HorizonAccount | null> {
  const r = await getJson(`${net.horizon}/accounts/${pub}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new HorizonError(`Horizon error ${r.status}`);
  return (await r.json()) as HorizonAccount;
}

/** Fee in stroops per operation: p70 of recent fees, min 100, capped at 100_000. */
export async function getFee(net: NetConfig): Promise<string> {
  try {
    const r = await getJson(`${net.horizon}/fee_stats`);
    if (r.ok) {
      const j = (await r.json()) as { fee_charged: { p70: string } };
      const f = Number(j.fee_charged.p70);
      if (Number.isFinite(f)) return String(Math.min(Math.max(f, 100), 100_000));
    }
  } catch {}
  return "100";
}

export async function submitTx(net: NetConfig, xdr: string): Promise<string> {
  const r = await fetch(`${net.horizon}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ tx: xdr }),
    signal: AbortSignal.timeout(30000),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (r.ok) return j.hash as string;
  const codes = j?.extras?.result_codes;
  throw new HorizonError(j?.title ?? `Horizon error ${r.status}`, codes?.transaction, codes?.operations);
}

export async function friendbot(addr: string): Promise<boolean> {
  try {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${addr}`, { signal: AbortSignal.timeout(20000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function explainError(e: unknown): string {
  if (!(e instanceof HorizonError)) return "Network error, please try again.";
  const op = e.opCodes?.find((c) => c !== "op_success");
  const map: Record<string, string> = {
    op_underfunded: "Insufficient balance.",
    op_low_reserve: "Below the minimum reserve (account must keep a reserve in XLM).",
    op_no_trust: "Destination has no trustline for this asset.",
    op_line_full: "Destination trustline limit would be exceeded.",
    op_no_destination: "Destination account does not exist.",
    op_not_authorized: "Destination is not authorized to hold this asset.",
    op_malformed: "Invalid operation.",
    tx_insufficient_balance: "Insufficient balance (reserve).",
    tx_bad_seq: "Sequence conflict, please retry.",
    tx_insufficient_fee: "Network busy, fee too low. Retry.",
  };
  return map[op ?? ""] ?? map[e.txCode ?? ""] ?? `Transaction failed (${op ?? e.txCode ?? e.message}).`;
}
