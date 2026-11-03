import type { Env } from "../env";

export const now = () => Math.floor(Date.now() / 1000);

export interface WalletRow {
  id: number;
  tg_id: number;
  public_key: string;
  enc_secret: string;
  iv: string;
  salt: string;
  key_version: number;
  label: string;
  is_active: number;
}

/** Returns true if the user row was newly created. */
export async function upsertUser(env: Env, id: number, username: string | null): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO users (tg_id, username, created_at) VALUES (?, ?, ?)")
    .bind(id, username, now())
    .run();
  const isNew = (r.meta.changes ?? 0) > 0;
  if (!isNew) await env.DB.prepare("UPDATE users SET username = ? WHERE tg_id = ?").bind(username, id).run();
  return isNew;
}

export async function getState(env: Env, id: number): Promise<any | null> {
  const r = await env.DB.prepare("SELECT state FROM users WHERE tg_id = ?").bind(id).first<{ state: string | null }>();
  return r?.state ? JSON.parse(r.state) : null;
}

export async function setState(env: Env, id: number, s: unknown | null): Promise<void> {
  await env.DB.prepare("UPDATE users SET state = ? WHERE tg_id = ?")
    .bind(s ? JSON.stringify(s) : null, id)
    .run();
}

export async function listWallets(env: Env, id: number): Promise<WalletRow[]> {
  const r = await env.DB.prepare("SELECT * FROM wallets WHERE tg_id = ? ORDER BY id").bind(id).all<WalletRow>();
  return r.results;
}

export async function activeWallet(env: Env, id: number): Promise<WalletRow | null> {
  return env.DB.prepare("SELECT * FROM wallets WHERE tg_id = ? AND is_active = 1").bind(id).first<WalletRow>();
}

export async function setActive(env: Env, tg: number, walletId: number): Promise<boolean> {
  const w = await env.DB.prepare("SELECT id FROM wallets WHERE id = ? AND tg_id = ?").bind(walletId, tg).first();
  if (!w) return false;
  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET is_active = 0 WHERE tg_id = ?").bind(tg),
    env.DB.prepare("UPDATE wallets SET is_active = 1 WHERE id = ?").bind(walletId),
  ]);
  return true;
}

export async function audit(env: Env, tg: number, action: string, pub?: string, tx?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (tg_id, action, public_key, tx_hash, ts) VALUES (?,?,?,?,?)")
    .bind(tg, action, pub ?? null, tx ?? null, now())
    .run();
}

/** Returns true if allowed. Fixed window counter. */
export async function rateLimit(env: Env, tg: number, bucket: string, max: number, windowSec: number): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (tg_id, bucket, window_start, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(tg_id, bucket) DO UPDATE SET
       count = CASE WHEN ?3 - window_start >= ?4 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?3 - window_start >= ?4 THEN ?3 ELSE window_start END
     RETURNING count`,
  )
    .bind(tg, bucket, t, windowSec)
    .first<{ count: number }>();
  return (r?.count ?? 1) <= max;
}

export async function markUpdate(env: Env, updateId: number): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id, ts) VALUES (?, ?)")
    .bind(updateId, now())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function createPending(env: Env, tg: number, kind: string, payload: unknown, ttlSec: number): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("INSERT INTO pending_actions (id, tg_id, kind, payload, expires_at) VALUES (?,?,?,?,?)")
    .bind(id, tg, kind, JSON.stringify(payload), now() + ttlSec)
    .run();
  return id;
}

/** Atomically consume a pending action owned by tg. Null if missing/expired/used. */
export async function consumePending(env: Env, tg: number, id: string, kind: string): Promise<any | null> {
  const r = await env.DB.prepare(
    "UPDATE pending_actions SET status = 'done' WHERE id = ? AND tg_id = ? AND kind = ? AND status = 'pending' AND expires_at > ? RETURNING payload",
  )
    .bind(id, tg, kind, now())
    .first<{ payload: string }>();
  return r ? JSON.parse(r.payload) : null;
}

export async function cancelPending(env: Env, tg: number, id: string): Promise<void> {
  await env.DB.prepare("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND tg_id = ? AND status = 'pending'")
    .bind(id, tg)
    .run();
}

export async function dueDeletes(env: Env): Promise<{ id: string; tg_id: number; payload: string }[]> {
  const r = await env.DB.prepare(
    "SELECT id, tg_id, payload FROM pending_actions WHERE kind = 'delete_msg' AND status = 'pending' AND expires_at <= ? LIMIT 50",
  )
    .bind(now())
    .all<{ id: string; tg_id: number; payload: string }>();
  return r.results;
}

export async function finishPending(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE pending_actions SET status = 'done' WHERE id = ?").bind(id).run();
}

export async function cleanup(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM processed_updates WHERE ts < ?").bind(t - 86400),
    env.DB.prepare("DELETE FROM pending_actions WHERE status != 'pending' AND expires_at < ?").bind(t - 3600),
  ]);
}

// ---------- Referrals ----------

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(len = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

export async function ensureReferralCode(env: Env, tg: number): Promise<string> {
  const cur = await env.DB.prepare("SELECT referral_code FROM users WHERE tg_id = ?").bind(tg).first<{ referral_code: string | null }>();
  if (cur?.referral_code) return cur.referral_code;
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    try {
      const r = await env.DB.prepare("UPDATE users SET referral_code = ? WHERE tg_id = ? AND referral_code IS NULL")
        .bind(code, tg)
        .run();
      if ((r.meta.changes ?? 0) > 0) return code;
      return (await env.DB.prepare("SELECT referral_code FROM users WHERE tg_id = ?").bind(tg).first<{ referral_code: string }>())!.referral_code;
    } catch {
      // unique collision, retry with a new code
    }
  }
  throw new Error("Could not allocate referral code");
}

/** Attach referrer to a brand-new user. Returns referrer tg_id if attributed. */
export async function attributeReferral(env: Env, newUser: number, code: string): Promise<number | null> {
  if (!/^[A-Z0-9]{6,12}$/i.test(code)) return null;
  const ref = await env.DB.prepare("SELECT tg_id FROM users WHERE referral_code = ?").bind(code.toUpperCase()).first<{ tg_id: number }>();
  if (!ref || ref.tg_id === newUser) return null;
  const r = await env.DB.prepare("UPDATE users SET referred_by = ?, referred_at = ? WHERE tg_id = ? AND referred_by IS NULL")
    .bind(ref.tg_id, now(), newUser)
    .run();
  return (r.meta.changes ?? 0) > 0 ? ref.tg_id : null;
}

export async function referralCount(env: Env, tg: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by = ?").bind(tg).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- Trading ----------

export async function getSlippage(env: Env, tg: number): Promise<number> {
  const r = await env.DB.prepare("SELECT slippage_bps FROM users WHERE tg_id = ?").bind(tg).first<{ slippage_bps: number }>();
  return r?.slippage_bps ?? 100;
}

export async function setSlippage(env: Env, tg: number, bps: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET slippage_bps = ? WHERE tg_id = ?").bind(bps, tg).run();
}

/** Read a pending row without consuming it (reusable pick buttons). */
export async function peekPending(env: Env, tg: number, id: string, kind: string): Promise<any | null> {
  const r = await env.DB.prepare("SELECT payload FROM pending_actions WHERE id = ? AND tg_id = ? AND kind = ? AND expires_at > ?")
    .bind(id, tg, kind, now())
    .first<{ payload: string }>();
  return r ? JSON.parse(r.payload) : null;
}

export async function recordTrade(
  env: Env,
  t: { tg: number; walletId: number; side: string; selling: string; buying: string; amount: string; minOut: string; amountOut?: string; status: string; txHash?: string },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO trades (tg_id, wallet_id, side, selling_asset, buying_asset, amount, limit_price, amount_out, status, tx_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(t.tg, t.walletId, t.side, t.selling, t.buying, t.amount, t.minOut, t.amountOut ?? null, t.status, t.txHash ?? null, now())
    .run();
}

/** Launchpad coin contracts this user bought through the bot (newest first). */
export async function launchpadCoins(env: Env, tg: number): Promise<string[]> {
  const r = await env.DB.prepare(
    "SELECT buying_asset AS c, MAX(created_at) AS t FROM trades WHERE tg_id=? AND side='buy' AND status='success' AND buying_asset LIKE 'C%' GROUP BY buying_asset ORDER BY t DESC LIMIT 20",
  )
    .bind(tg)
    .all<{ c: string }>();
  return (r.results ?? []).map((x) => x.c);
}
