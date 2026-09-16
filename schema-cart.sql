-- Miga-Photobook — D1 schema migration
-- ---------------------------------------------------------------------
-- Adds the account-backed cart table used by the new "cart inside the
-- hamburger drawer" feature (Sept 15 2026). Exactly the same shape as the
-- existing `favorites` table (user_id + product_id + created_at, one row
-- per selection) — no price/quantity columns, since the cart only remembers
-- WHICH products a signed-in customer picked; their live title/price/photo
-- are always looked up fresh from /products when rendering, and checkout
-- still goes through the existing single-item /orders/create + payment flow
-- per item, never a combined payment.
--
-- Run once:
--   wrangler d1 execute mega_prompt_users_db --remote --file=./schema-cart.sql
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  product_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items(user_id);
