import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-base";
import { buyArgs, sellArgs, explainLp, lpEnabled, spotPrice } from "../src/stelfun/launchpad";
import { netConfig } from "../src/env";

const coin = StrKey.encodeContract(Buffer.alloc(32, 7));

describe("stelfun launchpad", () => {
  it("builds buy/sell args (address, address, i128, i128)", () => {
    const u = Keypair.random().publicKey();
    expect(buyArgs(u, coin, 10_000_000n, 1n).map((a) => a.switch().name)).toEqual(["scvAddress", "scvAddress", "scvI128", "scvI128"]);
    expect(sellArgs(u, coin, 5n, 1n).length).toBe(4);
  });
  it("decodes contract error codes", () => {
    expect(explainLp("HostError: Error(Contract, #104)")).toMatch(/slippage/);
    expect(explainLp("HostError: Error(Contract, #3)")).toMatch(/balance/);
  });
  it("is disabled until LAUNCHPAD_ID is set", () => {
    expect(lpEnabled(netConfig({ NETWORK: "public" } as any))).toBe(false);
    expect(lpEnabled(netConfig({ NETWORK: "public", LAUNCHPAD_ID: coin } as any))).toBe(true);
  });
  it("spot price is v_quote / v_token", () => {
    expect(spotPrice({ vQuote: 200n, vToken: 400n } as any)).toBe(0.5);
  });
});
