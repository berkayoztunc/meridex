import type { Transaction } from "@stellar/stellar-base";
import type { AssetRef } from "../stellar/tx";

/** Phase 2: token buy/sell. Not implemented in phase 1. */
export interface Quote {
  sell: AssetRef;
  buy: AssetRef;
  sellAmount: bigint;
  buyAmount: bigint;
  path: AssetRef[];
}

export interface TradeProvider {
  quote(sell: AssetRef, buy: AssetRef, sellAmount: bigint): Promise<Quote>;
  buildSwapTx(sourcePublicKey: string, quote: Quote, slippageBps: number): Promise<Transaction>;
}
