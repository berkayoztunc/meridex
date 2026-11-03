// Testnet only: create a coin on the Stelfun launchpad with a throwaway key, then exercise buy/sell.
// Usage: node scripts/create-test-coin.mjs [SYMBOL]   (key kept in scripts/.testkey, import it into the bot to trade)
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, XdrLargeInt, scValToNative, xdr } from "@stellar/stellar-base";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const LAUNCHPAD = "CBYA2GA737D66LWIUXMA2UXSTYZR2XMN54DI52MXASEFZGCDRJJLTKXQ";
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const KEYFILE = new URL(".testkey", import.meta.url).pathname;

const kp = existsSync(KEYFILE) ? Keypair.fromSecret(readFileSync(KEYFILE, "utf8").trim()) : Keypair.random();
if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, kp.secret() + "\n", { mode: 0o600 });
console.log("wallet:", kp.publicKey());

const rpc = async (method, params) => {
  const j = await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const seq = async () => (await (await fetch(`${HORIZON}/accounts/${kp.publicKey()}`)).json()).sequence;
const addr = (a) => new Address(a).toScVal();
const i128 = (v) => new XdrLargeInt("i128", v.toString()).toI128();
const str = (s) => xdr.ScVal.scvString(s);

function returnOf(r) {
  if (r.returnValue) return scValToNative(xdr.ScVal.fromXDR(r.returnValue, "base64"));
  const meta = xdr.TransactionMeta.fromXDR(r.resultMetaXdr, "base64");
  const inner = meta.switch() === 4 ? meta.v4() : meta.v3();
  const rv = inner.sorobanMeta()?.returnValue?.();
  return rv ? scValToNative(rv) : null;
}

async function call(fn, args, send = true) {
  const build = (auth, fee = "10000") =>
    new TransactionBuilder(new Account(kp.publicKey(), await0), { fee, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.invokeContractFunction({ contract: LAUNCHPAD, function: fn, args, auth })).setTimeout(60).build();
  const await0 = await seq();
  const sim = await rpc("simulateTransaction", { transaction: build().toXDR() });
  if (sim.error) throw new Error(`${fn} simulation: ${sim.error}`);
  const ret = sim.results?.[0]?.xdr ? scValToNative(xdr.ScVal.fromXDR(sim.results[0].xdr, "base64")) : null;
  if (!send) return ret;
  const auth = (sim.results?.[0]?.auth ?? []).map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"));
  const tx = TransactionBuilder.cloneFrom(build(auth), { fee: (10000n + BigInt(sim.minResourceFee)).toString(), sorobanData: sim.transactionData }).build();
  tx.sign(kp);
  const sent = await rpc("sendTransaction", { transaction: tx.toXDR() });
  if (sent.status === "ERROR") throw new Error(`${fn} send: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 30; i++) {
    const r = await rpc("getTransaction", { hash: sent.hash });
    if (r.status === "SUCCESS") return { hash: sent.hash, ret: returnOf(r) };
    if (r.status === "FAILED") throw new Error(`${fn} failed on-chain: ${sent.hash}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`${fn}: timed out (${sent.hash})`);
}

const fx = (v) => (Number(v) / 1e7).toLocaleString(undefined, { maximumFractionDigits: 7 });

// 1) fund
if ((await fetch(`${HORIZON}/accounts/${kp.publicKey()}`)).status === 404) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
  console.log("funded via friendbot");
}

// 2) create coin with a first buy
const symbol = process.argv[2] ?? "TST" + Math.floor(Math.random() * 900 + 100);
const created = await call("create", [addr(kp.publicKey()), str(`Test ${symbol}`), str(symbol), str("https://example.com/test.json"), xdr.ScVal.scvBytes(randomBytes(32)), i128(100_000_000n), i128(0n)]);
const coin = created.ret;
console.log(`created ${symbol}: ${coin}\n  tx ${created.hash}`);

// 3) read back + quote + buy + sell
const curve = await call("curve", [addr(coin)], false);
console.log("curve status:", curve.status, "v_quote:", fx(curve.v_quote), "v_token:", fx(curve.v_token));
const [tokensOut, used, fee, refund] = await call("quote_buy", [addr(coin), i128(100_000_000n)], false);
console.log(`quote_buy 10 XLM -> ${fx(tokensOut)} ${symbol} (used ${fx(used)}, fee ${fx(fee)}, refund ${fx(refund)})`);
const bought = await call("buy", [addr(kp.publicKey()), addr(coin), i128(used), i128(tokensOut * 99n / 100n)]);
console.log(`buy ok: got ${fx(bought.ret)} ${symbol}\n  tx ${bought.hash}`);
const half = bought.ret / 2n;
const [qOut, qFee] = await call("quote_sell", [addr(coin), i128(half)], false);
console.log(`quote_sell ${fx(half)} -> ${fx(qOut)} XLM (fee ${fx(qFee)})`);
const sold = await call("sell", [addr(kp.publicKey()), addr(coin), i128(half), i128(qOut * 99n / 100n)]);
console.log(`sell ok: got ${fx(sold.ret)} XLM\n  tx ${sold.hash}`);
console.log(`\nDONE. Coin to test in the bot: ${coin}`);
