CREATE TABLE users (
  tg_id      INTEGER PRIMARY KEY,
  username   TEXT,
  state      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE wallets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL REFERENCES users(tg_id),
  public_key  TEXT NOT NULL UNIQUE,
  enc_secret  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  salt        TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  label       TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_wallets_user ON wallets(tg_id);

CREATE TABLE pending_actions (
  id         TEXT PRIMARY KEY,
  tg_id      INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_expiry ON pending_actions(kind, status, expires_at);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  tg_id        INTEGER NOT NULL,
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (tg_id, bucket)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id      INTEGER NOT NULL,
  action     TEXT NOT NULL,
  public_key TEXT,
  tx_hash    TEXT,
  ts         INTEGER NOT NULL
);

-- Phase 2 (unused in phase 1)
CREATE TABLE trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL,
  wallet_id     INTEGER NOT NULL,
  side          TEXT NOT NULL,
  selling_asset TEXT NOT NULL,
  buying_asset  TEXT NOT NULL,
  amount        TEXT NOT NULL,
  limit_price   TEXT,
  status        TEXT NOT NULL,
  tx_hash       TEXT,
  created_at    INTEGER NOT NULL
);
