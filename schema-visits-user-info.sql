-- Miga-Photobook — adds logged-in customer name/email to the visits log
-- ---------------------------------------------------------------------
-- Run this once against the SAME D1 database the site already uses
-- (mega_prompt_users_db). Two ways to run it, pick whichever is easier:
--
-- A) Cloudflare Dashboard (no CLI needed):
--    Workers & Pages → D1 → mega_prompt_users_db → "Console" tab →
--    paste the two ALTER TABLE lines below (one at a time) → Execute.
--
-- B) wrangler CLI, if you ever get it working:
--    wrangler d1 execute mega_prompt_users_db --remote --file=./schema-visits-user-info.sql
-- ---------------------------------------------------------------------

ALTER TABLE visits ADD COLUMN user_name TEXT;
ALTER TABLE visits ADD COLUMN user_email TEXT;
