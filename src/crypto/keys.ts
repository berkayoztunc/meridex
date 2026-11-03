const KEY_VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EncryptedSecret {
  encSecret: string;
  iv: string;
  salt: string;
  keyVersion: number;
}

export interface KeyContext {
  userId: number;
  walletId: number;
  publicKey: string;
}

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(masterKeyB64: string, salt: Uint8Array, ctx: KeyContext): Promise<CryptoKey> {
  const master = unb64(masterKeyB64);
  if (master.length !== 32) throw new Error("MASTER_KEY must be 32 bytes (base64)");
  const base = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`stw:v${KEY_VERSION}:${ctx.userId}:${ctx.walletId}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (ctx: KeyContext) => enc.encode(`${ctx.userId}|${ctx.walletId}|${ctx.publicKey}`);

export async function encryptSecret(masterKeyB64: string, secret: string, ctx: KeyContext): Promise<EncryptedSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(masterKeyB64, salt, ctx);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(ctx) }, key, enc.encode(secret));
  return { encSecret: b64(new Uint8Array(ct)), iv: b64(iv), salt: b64(salt), keyVersion: KEY_VERSION };
}

export async function decryptSecret(masterKeyB64: string, e: EncryptedSecret, ctx: KeyContext): Promise<string> {
  const key = await deriveKey(masterKeyB64, unb64(e.salt), ctx);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(ctx) },
    key,
    unb64(e.encSecret),
  );
  return dec.decode(pt);
}
