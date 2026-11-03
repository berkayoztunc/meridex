import { Networks } from "@stellar/stellar-base";

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  WEBHOOK_PATH: string;
  MASTER_KEY: string;
  NETWORK?: string;
  HORIZON_URL?: string;
  /** Stelfun launchpad contract id for the active network. */
  LAUNCHPAD_ID?: string;
}

export interface NetConfig {
  isTestnet: boolean;
  passphrase: string;
  horizon: string;
  rpc: string;
  aquaApi: string;
  aquaRouter: string;
  launchpad: string;
}

export function netConfig(env: Env): NetConfig {
  const isTestnet = (env.NETWORK ?? "testnet") !== "public";
  return {
    isTestnet,
    passphrase: isTestnet ? Networks.TESTNET : Networks.PUBLIC,
    horizon:
      env.HORIZON_URL ||
      (isTestnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org"),
    rpc: isTestnet ? "https://soroban-testnet.stellar.org" : "https://mainnet.sorobanrpc.com",
    aquaApi: isTestnet
      ? "https://amm-api-testnet.aqua.network/api/external/v2"
      : "https://amm-api.aqua.network/api/external/v2",
    aquaRouter: isTestnet
      ? "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"
      : "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    launchpad: env.LAUNCHPAD_ID ?? "",
  };
}
