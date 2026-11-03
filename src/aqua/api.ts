import { Address, StrKey, XdrLargeInt, xdr } from "@stellar/stellar-base";
import type { NetConfig } from "../env";
import { toAsset, type AssetRef } from "../stellar/tx";

export interface Quote {
  amountOut: bigint;
  swapChainXdr: string;
  pools: string[];
  tokens: string[];
  tokenAddresses: string[];
}

export const contractId = (net: NetConfig, a: AssetRef): string => toAsset(a).contractId(net.passphrase);

/** Strict-send quote: how much `out` for exactly `amount` of `inn`. Null when no route. */
export async function findPath(net: NetConfig, inn: AssetRef, out: AssetRef, amount: bigint): Promise<Quote | null> {
  const r = await fetch(`${net.aquaApi}/find-path/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_in_address: contractId(net, inn), token_out_address: contractId(net, out), amount: amount.toString() }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Aqua API ${r.status}`);
  // keep big numbers exact: grab "amount" from raw text
  const raw = await r.text();
  const j = JSON.parse(raw) as { success: boolean; swap_chain_xdr: string; pools: string[]; tokens: string[]; tokens_addresses: string[] };
  if (!j.success) return null;
  const m = raw.match(/"amount"\s*:\s*(\d+)/);
  const amountOut = BigInt(m ? m[1] : "0");
  if (amountOut <= 0n) return null;
  return { amountOut, swapChainXdr: j.swap_chain_xdr, pools: j.pools, tokens: j.tokens, tokenAddresses: j.tokens_addresses };
}

export const minOut = (out: bigint, slippageBps: number): bigint => (out * BigInt(10_000 - slippageBps)) / 10_000n;

/** Args for router.swap_chained(user, swaps_chain, token_in, in_amount, out_min). */
export function swapArgs(net: NetConfig, user: string, q: Quote, inn: AssetRef, amountIn: bigint, outMin: bigint): xdr.ScVal[] {
  return [
    new Address(user).toScVal(),
    xdr.ScVal.fromXDR(q.swapChainXdr, "base64"),
    Address.contract(StrKey.decodeContract(contractId(net, inn))).toScVal(),
    new XdrLargeInt("u128", amountIn.toString()).toU128(),
    new XdrLargeInt("u128", outMin.toString()).toU128(),
  ];
}
