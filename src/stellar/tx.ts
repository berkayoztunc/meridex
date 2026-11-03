import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, Account, Memo } from "@stellar/stellar-base";
import type { Transaction, xdr } from "@stellar/stellar-base";
import type { NetConfig } from "../env";
import type { HorizonAccount } from "./horizon";
import { fromStroops } from "./amount";

export interface AssetRef {
  code: string; // "XLM" for native
  issuer?: string;
}

export const toAsset = (a: AssetRef): Asset => (a.code === "XLM" && !a.issuer ? Asset.native() : new Asset(a.code, a.issuer!));

interface BuildOpts {
  source: HorizonAccount;
  net: NetConfig;
  fee: string;
  memo?: string;
}

/** Generic builder: Phase 2 passes swap/offer ops here. */
export function buildTx(o: BuildOpts, ops: xdr.Operation[]): Transaction {
  const b = new TransactionBuilder(new Account(o.source.id, o.source.sequence), {
    fee: o.fee || BASE_FEE,
    networkPassphrase: o.net.passphrase,
  });
  for (const op of ops) b.addOperation(op);
  if (o.memo) b.addMemo(Memo.text(o.memo));
  return b.setTimeout(60).build();
}

export const paymentOp = (destination: string, asset: AssetRef, stroops: bigint) =>
  Operation.payment({ destination, asset: toAsset(asset), amount: fromStroops(stroops) });

export const createAccountOp = (destination: string, stroops: bigint) =>
  Operation.createAccount({ destination, startingBalance: fromStroops(stroops) });

export const changeTrustOp = (asset: AssetRef) => Operation.changeTrust({ asset: toAsset(asset) });

export function signTx(tx: Transaction, secret: string): string {
  tx.sign(Keypair.fromSecret(secret));
  return tx.toXDR();
}
