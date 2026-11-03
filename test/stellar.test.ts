import { describe, it, expect } from "vitest";
import { Networks, Keypair, TransactionBuilder } from "@stellar/stellar-base";
import { toStroops, fromStroops, parseHorizon, trim } from "../src/stellar/amount";
import { summarize } from "../src/stellar/balances";
import { buildTx, paymentOp, createAccountOp, changeTrustOp, signTx } from "../src/stellar/tx";
import { parseAssetSpec, isValidAddress, generateWallet } from "../src/stellar/wallet";
import { netConfig } from "../src/env";
import { qrPng } from "../src/qr/png";

describe("amount", () => {
  it("parses valid", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("12,5")).toBe(125_000_000n);
  });
  it("rejects invalid", () => {
    for (const s of ["0", "0.00000001", "1e3", "-1", "abc", "", "1.", ".5", "1 2"]) expect(toStroops(s)).toBeNull();
  });
  it("formats", () => {
    expect(fromStroops(125_000_000n)).toBe("12.5000000");
    expect(trim("12.5000000")).toBe("12.5");
    expect(trim("10.0000000")).toBe("10");
    expect(parseHorizon("9990.9999400")).toBe(99_909_999_400n);
  });
});

describe("balances", () => {
  it("computes available", () => {
    const s = summarize({
      id: "G", sequence: "1", subentry_count: 2,
      balances: [
        { balance: "10.0000000", asset_type: "native", selling_liabilities: "1.0000000" },
        { balance: "5.0000000", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GX", limit: "100.0000000" },
      ],
    });
    expect(s.reserve).toBe(20_000_000n); // (2+2)*0.5
    expect(s.available).toBe(70_000_000n); // 10 - 2 - 1
    expect(s.tokens[0].balance).toBe(50_000_000n);
  });
});

describe("wallet/tx", () => {
  it("validates", () => {
    const w = generateWallet();
    expect(isValidAddress(w.publicKey)).toBe(true);
    expect(isValidAddress("GABC")).toBe(false);
    expect(parseAssetSpec(`USDC:${w.publicKey}`)).toEqual({ code: "USDC", issuer: w.publicKey });
    expect(parseAssetSpec("USDC")).toBeNull();
  });
  it("builds and signs payment / createAccount / changeTrust", () => {
    const a = Keypair.random(), b = Keypair.random(), iss = Keypair.random();
    const src = { id: a.publicKey(), sequence: "100", subentry_count: 0, balances: [] };
    const net = netConfig({ NETWORK: "testnet" } as any);
    for (const op of [
      paymentOp(b.publicKey(), { code: "XLM" }, 10_000_000n),
      paymentOp(b.publicKey(), { code: "USDC", issuer: iss.publicKey() }, 5n),
      createAccountOp(b.publicKey(), 10_000_000n),
      changeTrustOp({ code: "USDC", issuer: iss.publicKey() }),
    ]) {
      const xdr = signTx(buildTx({ source: src, net, fee: "100", memo: "hi" }, [op]), a.secret());
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      expect(tx.signatures.length).toBe(1);
    }
  });
});

describe("qr", () => {
  it("makes a valid PNG", () => {
    const p = qrPng(generateWallet().publicKey);
    expect(Array.from(p.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(p.length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(p.slice(-8, -4))).toBe("IEND");
  });
});
