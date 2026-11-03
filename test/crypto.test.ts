import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/crypto/keys";

const master = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const ctx = { userId: 1, walletId: 7, publicKey: "GAAA" };

describe("keys", () => {
  it("roundtrips", async () => {
    const e = await encryptSecret(master, "SSECRET", ctx);
    expect(e.encSecret).not.toContain("SSECRET");
    expect(await decryptSecret(master, e, ctx)).toBe("SSECRET");
  });
  it("fails on wrong context (AAD/HKDF binding)", async () => {
    const e = await encryptSecret(master, "SSECRET", ctx);
    await expect(decryptSecret(master, e, { ...ctx, userId: 2 })).rejects.toThrow();
    await expect(decryptSecret(master, e, { ...ctx, publicKey: "GBBB" })).rejects.toThrow();
  });
  it("fails on tamper and wrong master", async () => {
    const e = await encryptSecret(master, "SSECRET", ctx);
    const bad = { ...e, encSecret: (e.encSecret[0] === "A" ? "B" : "A") + e.encSecret.slice(1) };
    await expect(decryptSecret(master, bad, ctx)).rejects.toThrow();
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    await expect(decryptSecret(other, e, ctx)).rejects.toThrow();
  });
  it("rejects bad master length", async () => {
    await expect(encryptSecret("AAAA", "x", ctx)).rejects.toThrow();
  });
});
