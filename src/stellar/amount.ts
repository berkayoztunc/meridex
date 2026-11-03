const STROOPS = 10_000_000n;
const RE = /^\d+(\.\d{1,7})?$/;

/** Parse decimal string (max 7 dp) to stroops. Returns null if invalid or <= 0. */
export function toStroops(s: string): bigint | null {
  const t = s.trim().replace(",", ".");
  if (!RE.test(t)) return null;
  const [i, f = ""] = t.split(".");
  const v = BigInt(i) * STROOPS + BigInt(f.padEnd(7, "0"));
  if (v <= 0n || v > 9_223_372_036_854_775_807n) return null;
  return v;
}

export function fromStroops(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = `${a / STROOPS}.${(a % STROOPS).toString().padStart(7, "0")}`;
  return neg ? `-${s}` : s;
}

/** Horizon decimal string ("12.5000000") to stroops, allows zero. */
export function parseHorizon(s: string): bigint {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * STROOPS + BigInt(f.padEnd(7, "0").slice(0, 7));
}

export function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
