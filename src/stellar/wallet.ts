import { Keypair, StrKey } from "@stellar/stellar-base";

export function generateWallet(): { publicKey: string; secret: string } {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

export const isValidAddress = (a: string): boolean => StrKey.isValidEd25519PublicKey(a);

/** Parse "CODE:ISSUER" asset spec. */
export function parseAssetSpec(s: string): { code: string; issuer: string } | null {
  const [code, issuer, ...rest] = s.trim().split(":");
  if (rest.length || !code || !issuer) return null;
  if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !isValidAddress(issuer)) return null;
  return { code, issuer };
}
