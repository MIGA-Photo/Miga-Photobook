-- Miga-Photobook — D1 schema migration
-- ---------------------------------------------------------------------
-- Adds password-reset ("forgot password") support (Sept 17 2026). One row
-- per reset request; the RAW token is never stored, only its SHA-256 hash
-- (token_hash) — the same principle as password_hash for account passwords:
-- if this table were ever leaked, no reset link could be reconstructed from
-- it. used_at is set once the token is redeemed so it can never be reused,
-- and expires_at enforces the 30-minute window (see
-- PASSWORD_RESET_TOKEN_TTL_MS in worker.js). Old/expired rows are harmless
-- to leave in place (they're already permanently unusable) — no cleanup job
-- is required, but one could DELETE FROM password_reset_tokens WHERE
-- expires_at < <now> periodically if the table's size ever becomes a
-- concern.
--
-- Run once:
--   wrangler d1 execute mega_prompt_users_db --remote --file=./schema-password-reset.sql
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
