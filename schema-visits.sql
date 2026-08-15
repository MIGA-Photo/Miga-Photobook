-- Miga-Photobook — Visitor log migration
-- ---------------------------------------------------------------------
-- Adds a "visits" table for the admin panel's visitor counter + log.
-- Does not touch any existing table.
--
-- Run once:
--   wrangler d1 execute mega_prompt_users_db --remote --file=./schema-visits.sql
--
-- ALREADY ran an older version of this file (without visitor_id)?
-- Run this one line instead, then you're done:
--   wrangler d1 execute mega_prompt_users_db --remote --command="ALTER TABLE visits ADD COLUMN visitor_id TEXT;"
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visited_at  INTEGER NOT NULL,   -- epoch ms
  path        TEXT,
  country     TEXT,               -- ISO country code from Cloudflare's edge (request.cf.country)
  user_agent  TEXT,
  visitor_id  TEXT                -- long-lived anonymous ID from the browser's localStorage, for unique-visitor counts
);

CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_visitor_id ON visits(visitor_id);
