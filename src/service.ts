import type { Env } from "./env";
import { netConfig } from "./env";
import { encryptSecret, decryptSecret } from "./crypto/keys";
import { generateWallet } from "./stellar/wallet";
import { friendbot } from "./stellar/horizon";
import { now, audit, setActive, type WalletRow } from "./db";

export const MAX_WALLETS = 5;

/** Create wallet: insert row first (id feeds the key context), then encrypt+store secret. */
export async function createWallet(env: Env, tg: number): Promise<WalletRow> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM wallets WHERE tg_id = ?").bind(tg).first<{ n: number }>();
  const n = count?.n ?? 0;
  if (n >= MAX_WALLETS) throw new Error(`Wallet limit reached (${MAX_WALLETS}).`);
  const { publicKey, secret } = generateWallet();
  const ins = await env.DB.prepare(
    "INSERT INTO wallets (tg_id, public_key, enc_secret, iv, salt, label, is_active, created_at) VALUES (?,?,?,?,?,?,0,?) RETURNING id",
  )
    .bind(tg, publicKey, "", "", "", `Wallet ${n + 1}`, now())
    .first<{ id: number }>();
  const id = ins!.id;
  try {
    const e = await encryptSecret(env.MASTER_KEY, secret, { userId: tg, walletId: id, publicKey });
    await env.DB.prepare("UPDATE wallets SET enc_secret = ?, iv = ?, salt = ?, key_version = ? WHERE id = ?")
      .bind(e.encSecret, e.iv, e.salt, e.keyVersion, id)
      .run();
  } catch (err) {
    await env.DB.prepare("DELETE FROM wallets WHERE id = ?").bind(id).run();
    throw err;
  }
  await setActive(env, tg, id);
  await audit(env, tg, "wallet_create", publicKey);
  if (netConfig(env).isTestnet) await friendbot(publicKey);
  return (await env.DB.prepare("SELECT * FROM wallets WHERE id = ?").bind(id).first<WalletRow>())!;
}

export async function unlockSecret(env: Env, w: WalletRow): Promise<string> {
  return decryptSecret(
    env.MASTER_KEY,
    { encSecret: w.enc_secret, iv: w.iv, salt: w.salt, keyVersion: w.key_version },
    { userId: w.tg_id, walletId: w.id, publicKey: w.public_key },
  );
}
