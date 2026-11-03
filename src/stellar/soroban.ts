import { Account, Operation, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-base";
import type { Transaction } from "@stellar/stellar-base";
import type { NetConfig } from "../env";
import type { HorizonAccount } from "./horizon";

export class SorobanError extends Error {}

async function rpc<T>(net: NetConfig, method: string, params: unknown): Promise<T> {
  const r = await fetch(net.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || !j.result) throw new SorobanError(j.error?.message ?? `RPC ${method} failed`);
  return j.result;
}

interface SimResult {
  error?: string;
  transactionData?: string;
  minResourceFee?: string;
  results?: { auth?: string[]; xdr?: string }[];
}

const invokeTx = (net: NetConfig, src: HorizonAccount, fee: string, contract: string, fn: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry[]) =>
  new TransactionBuilder(new Account(src.id, src.sequence), { fee, networkPassphrase: net.passphrase })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args, auth }))
    .setTimeout(60)
    .build();

async function simulate(net: NetConfig, tx: Transaction): Promise<SimResult> {
  const sim = await rpc<SimResult>(net, "simulateTransaction", { transaction: tx.toXDR() });
  if (sim.error) throw new SorobanError(sim.error);
  return sim;
}

/** Read-only contract call (simulation). Returns decoded native value. */
export async function readContract(net: NetConfig, src: HorizonAccount, contract: string, fn: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const sim = await simulate(net, invokeTx(net, src, "100", contract, fn, args));
  const ret = sim.results?.[0]?.xdr;
  return ret ? scValToNative(xdr.ScVal.fromXDR(ret, "base64")) : null;
}

/** Simulate, then rebuild with auth, resource fee and soroban data (unsigned). */
export async function prepareInvoke(net: NetConfig, src: HorizonAccount, bidFee: string, contract: string, fn: string, args: xdr.ScVal[]): Promise<Transaction> {
  const sim = await simulate(net, invokeTx(net, src, bidFee, contract, fn, args));
  const auth = (sim.results?.[0]?.auth ?? []).map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"));
  const withAuth = invokeTx(net, src, bidFee, contract, fn, args, auth);
  return TransactionBuilder.cloneFrom(withAuth, {
    fee: (BigInt(bidFee) + BigInt(sim.minResourceFee ?? "0")).toString(),
    sorobanData: sim.transactionData!,
  }).build();
}

/** Poll until the tx is on-ledger; returns native return value. */
export async function waitForResult(net: NetConfig, hash: string, timeoutMs = 25000): Promise<unknown> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc<{ status: string; returnValue?: string; resultMetaXdr?: string }>(net, "getTransaction", { hash });
    if (r.status === "SUCCESS") return returnOf(r);
    if (r.status === "FAILED") throw new SorobanError("Transaction failed on-chain");
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new SorobanError("Timed out waiting for confirmation");
}

function returnOf(r: { returnValue?: string; resultMetaXdr?: string }): unknown {
  try {
    if (r.returnValue) return scValToNative(xdr.ScVal.fromXDR(r.returnValue, "base64"));
    if (!r.resultMetaXdr) return null;
    const meta = xdr.TransactionMeta.fromXDR(r.resultMetaXdr, "base64") as any;
    const inner = meta.switch() === 4 ? meta.v4() : meta.v3();
    const rv = inner.sorobanMeta()?.returnValue?.();
    return rv ? scValToNative(rv) : null;
  } catch {
    return null;
  }
}
