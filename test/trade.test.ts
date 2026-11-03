import { describe, it, expect } from "vitest";
import { minOut, contractId, swapArgs } from "../src/aqua/api";
import { bal, compact, num } from "../src/telegram/ui";
import { netConfig } from "../src/env";
import { Keypair } from "@stellar/stellar-base";

const net = netConfig({ NETWORK: "public" } as any);

describe("trade math", () => {
  it("applies slippage with BigInt", () => {
    expect(minOut(1_000_000n, 100)).toBe(990_000n);
    expect(minOut(5_855_452_956n, 50)).toBe(5_826_175_691n);
    expect(minOut(1n, 100)).toBe(0n);
  });
  it("formats numbers", () => {
    expect(num(1234.5678)).toBe("1,234.57");
    expect(num(0.000123456)).toBe("0.0001235");
    expect(compact(80_078_527_508)).toBe("80.08B");
    expect(compact(2_500_000)).toBe("2.50M");
  });
  it("formats balances", () => {
    expect(bal(100_908_454_502n)).toBe("10,090.8454");
    expect(bal(20_000_000n)).toBe("2");
    expect(bal(65_953_278_492n)).toBe("6,595.3278");
    expect(bal(82_743_013n)).toBe("8.2743");
    expect(bal(5n)).toBe("0.0000005");
    expect(bal(0n)).toBe("0");
  });
  it("computes native SAC id and builds swap args", () => {
    expect(contractId(net, { code: "XLM" })).toBe("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA");
    const q = { amountOut: 1n, swapChainXdr: "AAAAEAAAAAEAAAAA", pools: [], tokens: [], tokenAddresses: [] };
    const args = swapArgs(net, Keypair.random().publicKey(), q, { code: "XLM" }, 10_000_000n, 9_900_000n);
    expect(args.length).toBe(5);
  });
});

import { matchToken } from "../src/telegram/trade";

describe("token detection", () => {
  const iss = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
  it("matches CODE:ISSUER and CODE-ISSUER", () => {
    expect(matchToken(`AQUA:${iss}`)).toEqual({ asset: { code: "AQUA", issuer: iss } });
    expect(matchToken(`look at AQUA-${iss}-1 now`)).toEqual({ asset: { code: "AQUA", issuer: iss } });
    expect(matchToken(`https://stellar.expert/explorer/public/asset/AQUA-${iss}`)).toEqual({ asset: { code: "AQUA", issuer: iss } });
  });
  it("matches a contract id", () => {
    const c = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";
    expect(matchToken(c)).toEqual({ contract: c });
  });
  it("ignores plain text and bare accounts", () => {
    expect(matchToken("hello there")).toBeNull();
    expect(matchToken(iss)).toBeNull();
    expect(matchToken("AQUA:GINVALID")).toBeNull();
  });
});
