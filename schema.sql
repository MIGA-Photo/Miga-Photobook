-- Miga-Photobook — D1 schema migration
-- ---------------------------------------------------------------------
-- This is a MIGRATION against your real, existing mega_prompt_users_db
-- database (which already has real users/sessions/reviews tables and at
-- least one real registered user). It does NOT recreate or touch existing
-- rows — it only adds what's missing:
--   1. an auth_provider column on users (for social/passkey accounts)
--   2. a new webauthn_credentials table (for Face ID/Touch ID/fingerprint)
--
-- Run once:
--   wrangler d1 execute mega_prompt_users_db --remote --file=./schema.sql
-- ---------------------------------------------------------------------

ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password';

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  credential_id   TEXT NOT NULL UNIQUE,
  public_key_jwk  TEXT NOT NULL,
  alg             TEXT NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id);
