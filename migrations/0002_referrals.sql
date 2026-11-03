ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by INTEGER;
ALTER TABLE users ADD COLUMN referred_at INTEGER;
CREATE UNIQUE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_referred_by ON users(referred_by);
