-- Miga-Photobook — D1 schema migration
-- ---------------------------------------------------------------------
-- Adds customer profile fields (phone number + avatar photo) to the
-- existing users table, used by the account drawer / profile editor.
--
-- NOTE: This migration was already run directly against the live
-- database via the D1 Console (Cloudflare Dashboard → Workers & Pages →
-- miga-photobook-api → Bindings → mega_prompt_users_db → Console) on
-- 2026-09-03. This file exists only to keep the schema history complete
-- and reproducible — running it again is safe (D1/SQLite will error on
-- a duplicate column, which just confirms it's already applied).
--
-- Run once (if not already applied):
--   wrangler d1 execute mega_prompt_users_db --remote --file=./schema-profile-fields.sql
-- ---------------------------------------------------------------------

ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
