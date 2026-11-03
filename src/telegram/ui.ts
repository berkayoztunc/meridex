import { fromStroops, trim } from "../stellar/amount";
import type { AssetRef } from "../stellar/tx";

export const kb = (rows: { text: string; data: string }[][]) => ({
  inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))),
});

export const fmtAsset = (a: AssetRef) => (a.issuer ? a.code : "XLM");
export const fmt = (v: bigint) => trim(fromStroops(v));

/** Human number: >=1 → 2dp, small → 4 significant digits. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  if (n === 0) return "0";
  return Number(n.toPrecision(4)).toString().includes("e") ? n.toFixed(8) : Number(n.toPrecision(4)).toString();
}

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return num(n);
}

/** Balance display: thousands separators, up to 4 decimals (full precision for dust). */
export function bal(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10_000_000n;
  const frac = (a % 10_000_000n).toString().padStart(7, "0");
  let f = frac.slice(0, 4).replace(/0+$/, "");
  if (whole === 0n && a > 0n && f === "") f = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${f ? "." + f : ""}`;
}

export const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-5)}`;

/**
 * Message style (keep every bot message consistent):
 *  - Line 1: what this is / what happened (bold). Line 2: the key figure. Line 3: context.
 *    Telegram's chat-list preview shows roughly the first two lines, so they must stand alone.
 *  - Then a blank line and `Label  value` detail rows. At most one emoji per message (auto-added by `head`), no box-drawing.
 *  - Errors start with the problem, then how to fix it. Button labels are plain text.
 */
/** One leading emoji per message, chosen from the title; unknown titles get none. */
const ICONS: [RegExp, string][] = [
  [/rejected|failed|invalid|insufficient|not enough|no route|could not|too long|too many|limit reached|expired|moved|not activated|changed|went wrong|no trustline|unknown|same address/i, "⚠️"],
  [/complete|sent|created|added|deleted|updated|switched/i, "✅"],
  [/preview|^buy|^sell/i, "💱"],
  [/private key|^export/i, "🔑"],
  [/welcome|main menu/i, "🧭"],
  [/^receive/i, "📥"],
  [/^send|confirm transfer/i, "📤"],
  [/referral/i, "🎁"],
  [/wallets/i, "👛"],
  [/positions/i, "📊"],
  [/price/i, "📈"],
  [/slippage/i, "⚙️"],
];
export const head = (title: string, ...sub: string[]) => {
  const icon = ICONS.find(([re]) => re.test(title.replace(/<[^>]+>/g, "")))?.[1];
  return [`${icon ? icon + " " : ""}<b>${title}</b>`, ...sub].join("\n");
};
export const kv = (rows: [string, string | null | undefined | false][]) =>
  rows.filter((r): r is [string, string] => !!r[1]).map(([k, v]) => `${k}  ${v}`).join("\n");
export const msg = (...parts: (string | null | undefined | false)[]) => parts.filter((p) => !!p).join("\n\n");
export const netName = (isTestnet: boolean) => (isTestnet ? "Testnet" : "Mainnet");
