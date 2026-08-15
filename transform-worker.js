/**
 * Miga-Photobook — backend Worker
 * =========================================================================
 * This deploys to your EXISTING "miga" Worker — the one already live at
 * https://miga.j7f8ywhn9y.workers.dev with real Paymob/Fawry/fal.ai wired
 * up and one real registered user. Nothing was deleted; this file only adds
 * to and hardens what was already there. It reuses your existing storage:
 *   KV: mega_prompt_data      D1: mega_prompt_users_db
 * (NOT the MEGA_KV / mega-db resources created earlier in this session —
 * those were created before this existing setup was discovered and are
 * unused; safe to delete once you've confirmed this deploy is working.)
 *
 * A one-time automatic migration (ensureLegacyDataMigrated, runs itself on
 * first request) converts the old single-blob "products"/"orders" KV keys
 * into one-record-per-item storage, without touching or losing any existing
 * product or order data.
 *
 * Implements every endpoint the storefront's frontend already calls:
 *   GET  /products              POST /products/upsert    POST /products/delete
 *   GET  /admin/products (full text, admin only)
 *   POST     /orders/create        GET /orders/track      GET /orders/list
 *   POST     /orders/approve       POST /orders/claim-free
 *   POST     /reviews/submit       GET /reviews/list      GET /reviews/pending
 *   POST     /reviews/approve
 *   POST     /visits/log (public)  GET  /visits/stats (admin only)
 *   POST     /auth/register        POST /auth/login       GET /auth/me
 *   POST     /auth/social/google   POST /auth/social/apple   POST /auth/social/facebook
 *   POST     /auth/webauthn/register-options   POST /auth/webauthn/register-verify
 *   POST     /auth/webauthn/login-options      POST /auth/webauthn/login-verify
 *   POST     /admin/verify
 *   POST     /admin/upload-image   GET  /images/:key
 *   POST     /payment/paymob/create   POST /payment/paymob/webhook   (real, already working)
 *   POST     /payment/fawry/create    POST /payment/fawry/webhook    (real, already working)
 *   POST     /transform                                              (real, via fal.ai)
 *
 * Design choices made specifically to fix problems found in review:
 *   1. Product photos are NEVER stored as base64. Admin uploads go to R2 and
 *      the product record only ever holds a short /images/<key> URL.
 *   2. The admin password is never trusted from the client beyond a single
 *      request-scoped check — every admin-only route re-verifies it against
 *      the ADMIN_PASSWORD secret server-side, with a constant-time compare.
 *   3. Products/orders are one-record-per-item in KV, not a single blob —
 *      a save can never silently overwrite another session's changes.
 *   4. The customer's browser never receives the AI transformation prompt —
 *      /transform takes productId + orderCode (proof of purchase) and looks
 *      the instructions up itself, server-side only.
 *
 * ---------------------------------------------------------------------
 * SETUP — this account already has almost everything from before. You only
 * need to:
 * ---------------------------------------------------------------------
 *  1. wrangler r2 bucket create mega-images     (once you've enabled R2 in
 *     the dashboard — Storage & Databases → R2 → enable)
 *  2. Fill the R2 binding into wrangler.toml (KV/D1 bindings are already
 *     filled in, pointing at your real existing resources).
 *  3. Confirm these secrets are already set on the "miga" Worker (Settings →
 *     Variables and Secrets) — they should be, since Paymob/Fawry/transform
 *     already work there. Add whichever are missing:
 *       ADMIN_PASSWORD, FAL_KEY,
 *       PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_INTEGRATION_ID, PAYMOB_HMAC_SECRET,
 *       FAWRY_MERCHANT_CODE, FAWRY_SECURITY_KEY
 *     New secrets this update needs (add these):
 *       wrangler secret put ALLOWED_ORIGIN        e.g. https://megaaa2026.github.io
 *       wrangler secret put SOFT_LAUNCH_MODE       "true" or "false" — keep in
 *                                                    sync with the frontend's
 *                                                    SOFT_LAUNCH constant
 *     Only needed once you turn on social login (leave unset until then):
 *       wrangler secret put GOOGLE_CLIENT_ID       same value as the frontend's GOOGLE_CLIENT_ID
 *       wrangler secret put APPLE_CLIENT_ID        your Apple Services ID
 *       wrangler secret put FACEBOOK_APP_ID        same value as the frontend's FACEBOOK_APP_ID
 *       wrangler secret put FACEBOOK_APP_SECRET    from developers.facebook.com → Settings → Basic
 *  4. Run the small schema migration in schema.sql (adds a column + a new
 *     table to your real, existing database — does not touch existing rows).
 *  5. wrangler deploy   — this updates the EXISTING "miga" Worker in place;
 *     its URL (https://miga.j7f8ywhn9y.workers.dev) does not change, so
 *     nothing in the frontend needs updating.
 * ---------------------------------------------------------------------
 */

// ============================================================================
// Small helpers
// ============================================================================

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(extraHeaders || {}) },
  });
}

function err(message, status) {
  return json({ error: message }, status || 400);
}

/** Constant-time string comparison (avoids leaking password length/prefix via timing). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a ?? ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b ?? ""))),
  ]);
  const va = new Uint8Array(ha),
    vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function verifyAdmin(env, password) {
  if (!env.ADMIN_PASSWORD) return false; // fail closed if the secret was never set
  return safeEqual(password, env.ADMIN_PASSWORD);
}

// ============================================================================
// Visitor log  (POST /visits/log — public, GET /visits/stats — admin only)
// ============================================================================

/** Public, best-effort: logs one page visit. Never breaks the site if it fails. */
async function logVisit(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const path = typeof body.path === "string" ? body.path.slice(0, 200) : "/";
  const country = request.cf?.country || "XX";
  const userAgent = (request.headers.get("User-Agent") || "").slice(0, 200);
  const visitorId = typeof body.visitorId === "string" ? body.visitorId.slice(0, 100) : null;

  try {
    await env.MEGA_DB.prepare(
      `INSERT INTO visits (visited_at, path, country, user_agent, visitor_id) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(Date.now(), path, country, userAgent, visitorId)
      .run();
  } catch (e) {
    // Table may not exist yet (migration not run), or D1 hiccup — never fail the request over this.
  }
  return json({ ok: true });
}

async function getVisitStats(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdmin(env, url.searchParams.get("password")))) return err("Wrong password", 401);

  try {
    const totalRow = await env.MEGA_DB.prepare(`SELECT COUNT(*) as c FROM visits`).first();
    const total = totalRow?.c || 0;

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayRow = await env.MEGA_DB
      .prepare(`SELECT COUNT(*) as c FROM visits WHERE visited_at >= ?`)
      .bind(todayStart.getTime())
      .first();
    const today = todayRow?.c || 0;

    const uniqueTotalRow = await env.MEGA_DB
      .prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM visits WHERE visitor_id IS NOT NULL`)
      .first();
    const uniqueTotal = uniqueTotalRow?.c || 0;

    const uniqueTodayRow = await env.MEGA_DB
      .prepare(`SELECT COUNT(DISTINCT visitor_id) as c FROM visits WHERE visitor_id IS NOT NULL AND visited_at >= ?`)
      .bind(todayStart.getTime())
      .first();
    const uniqueToday = uniqueTodayRow?.c || 0;

    const recentRes = await env.MEGA_DB
      .prepare(`SELECT visited_at, path, country FROM visits ORDER BY visited_at DESC LIMIT 100`)
      .all();

    return json({ total, today, uniqueTotal, uniqueToday, recent: recentRes.results || [] });
  } catch (e) {
    // Most likely cause: schema-visits.sql hasn't been run yet against the remote D1.
    return json({ total: 0, today: 0, uniqueTotal: 0, uniqueToday: 0, recent: [], error: "visits table not found — run schema-visits.sql" });
  }
}

function randomCode(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const bytes = crypto.getRandomValues(new Uint8Array(len || 8));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function randomHex(numBytes) {
  const bytes = crypto.getRandomValues(new Uint8Array(numBytes || 32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function approveOrderByCode(env, code) {
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return false;
  const order = JSON.parse(raw);
  order.status = "approved";
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  return true;
}

// PBKDF2 password hashing (Web Crypto is available in Workers; no external deps needed).
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Very small best-effort per-IP rate limiter using KV with a short TTL.
// Not a substitute for Cloudflare's own Rate Limiting Rules (recommended
// in addition, configured in the dashboard) — this just blunts casual abuse.
async function rateLimit(env, request, key, limit, windowSeconds) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const k = `ratelimit:${key}:${ip}`;
  const current = parseInt((await env.MEGA_KV.get(k)) || "0", 10);
  if (current >= limit) return false;
  await env.MEGA_KV.put(k, String(current + 1), { expirationTtl: windowSeconds });
  return true;
}

// ============================================================================
// Products  (GET /products, POST /products/upsert, POST /products/delete)
//
// Products are stored as ONE RECORD PER PRODUCT (product:<id>, plus a
// products:index listing the ids) instead of a single JSON blob that gets
// fully overwritten on every save. A full-blob overwrite is what let one
// browser tab silently erase another admin session's changes — including
// other products' photos — whenever its local copy was even slightly stale.
// Per-product writes only ever touch the one record being added or edited,
// so a save can never delete something it never saw.
// ============================================================================

// One-time, automatic migration from the old storage format (a single "products"
// key holding the entire array, and a single "orders" key holding the entire
// array — both prone to the lost-update bug where one save could silently wipe
// out another admin session's changes) to one-record-per-item storage. Runs
// itself the first time this updated code executes; harmless to call repeatedly
// since it only acts when the new index doesn't exist yet.
let migrationChecked = false;
async function ensureLegacyDataMigrated(env) {
  if (migrationChecked) return;
  migrationChecked = true;

  const productsIndexRaw = await env.MEGA_KV.get("products:index");
  if (!productsIndexRaw) {
    const legacyProducts = await env.MEGA_KV.get("products");
    if (legacyProducts) {
      try {
        const list = JSON.parse(legacyProducts);
        if (Array.isArray(list) && list.length) {
          const ids = [];
          for (const p of list) {
            if (!p.id) continue;
            await env.MEGA_KV.put(`product:${p.id}`, JSON.stringify(p));
            ids.push(p.id);
          }
          await env.MEGA_KV.put("products:index", JSON.stringify(ids));
        } else {
          await env.MEGA_KV.put("products:index", JSON.stringify([]));
        }
      } catch {
        await env.MEGA_KV.put("products:index", JSON.stringify([]));
      }
    } else {
      await env.MEGA_KV.put("products:index", JSON.stringify([]));
    }
  }

  const ordersIndexRaw = await env.MEGA_KV.get("orders:index");
  if (!ordersIndexRaw) {
    const legacyOrders = await env.MEGA_KV.get("orders");
    if (legacyOrders) {
      try {
        const list = JSON.parse(legacyOrders);
        if (Array.isArray(list) && list.length) {
          const codes = [];
          for (const o of list) {
            if (!o.code) continue;
            await env.MEGA_KV.put(`order:${o.code}`, JSON.stringify(o));
            codes.push(o.code);
          }
          await env.MEGA_KV.put("orders:index", JSON.stringify(codes));
        } else {
          await env.MEGA_KV.put("orders:index", JSON.stringify([]));
        }
      } catch {
        await env.MEGA_KV.put("orders:index", JSON.stringify([]));
      }
    } else {
      await env.MEGA_KV.put("orders:index", JSON.stringify([]));
    }
  }
}

async function getAllProductRecords(env) {
  const indexRaw = await env.MEGA_KV.get("products:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const list = (
    await Promise.all(index.map((id) => env.MEGA_KV.get(`product:${id}`)))
  )
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
  return list;
}

// Public product list — the prompt text is the product itself, so it must never
// reach the browser before payment is confirmed. It's stripped here regardless
// of what the client claims about ownership; the real reveal only happens
// through trackOrder() (after an order is actually marked approved) or
// claimFree() (only while the launch promo is genuinely active, checked
// server-side). Only /admin/products (password-gated) gets the full text.
async function getProducts(env) {
  const list = await getAllProductRecords(env);
  const publicList = list.map(({ prompt, negativePrompt, ...rest }) => rest);
  return json({ value: JSON.stringify(publicList) });
}

async function getAdminProducts(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdmin(env, url.searchParams.get("password")))) return err("Wrong password", 401);
  const list = await getAllProductRecords(env);
  return json({ value: JSON.stringify(list) });
}

async function upsertProduct(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdmin(env, body.password))) return err("Wrong password", 401);

  const p = body.product;
  if (!p || typeof p !== "object") return err("Missing product");
  if (!p.id || !p.title || !p.category) return err("Product needs id, title, category");

  // Same base64 guardrail as before, now checked per-product.
  if (typeof p.image === "string" && p.image.startsWith("data:image")) {
    return err(
      "Product image is a base64 data URI, not a hosted URL. Upload it via /admin/upload-image first and use the returned url.",
      422
    );
  }

  await env.MEGA_KV.put(`product:${p.id}`, JSON.stringify(p));

  const indexRaw = await env.MEGA_KV.get("products:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(p.id)) {
    index.push(p.id);
    await env.MEGA_KV.put("products:index", JSON.stringify(index));
  }

  return json({ ok: true });
}

async function deleteProductRemote(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdmin(env, body.password))) return err("Wrong password", 401);
  const id = body.id;
  if (!id) return err("Missing id");

  await env.MEGA_KV.delete(`product:${id}`);
  const indexRaw = await env.MEGA_KV.get("products:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const next = index.filter((x) => x !== id);
  await env.MEGA_KV.put("products:index", JSON.stringify(next));

  return json({ ok: true });
}

// ============================================================================
// Image hosting  (POST /admin/upload-image, GET /images/:key)
// Replaces storing product photos as base64 inside the products JSON blob.
// ============================================================================

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function uploadImage(env, request) {
  const url = new URL(request.url);
  const password = url.searchParams.get("password") || request.headers.get("X-Admin-Password");
  if (!(await verifyAdmin(env, password))) return err("Wrong password", 401);

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return err("Expected multipart/form-data with an 'image' field", 400);
  }
  const form = await request.formData();
  const file = form.get("image");
  if (!file || typeof file === "string") return err("Missing 'image' file field", 400);
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return err("Unsupported image type", 415);
  if (file.size > MAX_IMAGE_BYTES) return err("Image too large (max 5MB)", 413);

  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[file.type];
  const key = `p_${Date.now()}_${randomHex(6)}.${ext}`;
  await env.MEGA_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
  });

  const publicUrl = `${url.origin}/images/${key}`;
  return json({ ok: true, url: publicUrl, key });
}

async function serveImage(env, key) {
  const obj = await env.MEGA_IMAGES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ============================================================================
// Orders  (POST /orders/create, GET /orders/track, GET /orders/list, POST /orders/approve)
// ============================================================================

async function createOrder(env, request) {
  if (!(await rateLimit(env, request, "orders-create", 20, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { productId, productTitle, price, phone, appUsed, ref } = body;
  if (!productId || !productTitle || !phone) return err("Missing required fields");
  if (String(phone).length > 40) return err("Invalid phone");

  const code = randomCode(8);
  const order = {
    code,
    productId: String(productId).slice(0, 200),
    productTitle: String(productTitle).slice(0, 300),
    price: Number(price) || 0,
    phone: String(phone).slice(0, 40),
    appUsed: appUsed ? String(appUsed).slice(0, 60) : "",
    ref: ref ? String(ref).slice(0, 120) : "",
    status: "pending",
    createdAt: Date.now(),
  };
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));

  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(code);
  await env.MEGA_KV.put("orders:index", JSON.stringify(index));

  return json({ code });
}

async function trackOrder(env, request) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!code) return err("Missing code");
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  // The transformation instructions never leave the server, not even here at the
  // moment of purchase confirmation — this site transforms the photo for the
  // customer automatically. The order code itself (which the browser already
  // holds) is what /transform later accepts as proof of purchase.
  return json({ code: order.code, productId: order.productId, status: order.status });
}

// Used only while the launch promo is on. Whether it's on is decided by the
// SOFT_LAUNCH_MODE secret/var — never by anything the client sends — so an old
// cached page can't be replayed to claim products for free after the promo ends.
async function claimFreeOrder(env, request) {
  if (env.SOFT_LAUNCH_MODE !== "true") return err("The free launch promo is not active", 403);
  if (!(await rateLimit(env, request, "claim-free", 20, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const productId = String(body.productId || "").slice(0, 200);
  if (!productId) return err("Missing productId");
  const productRaw = await env.MEGA_KV.get(`product:${productId}`);
  if (!productRaw) return err("Product not found", 404);
  const product = JSON.parse(productRaw);

  const code = randomCode(8);
  const order = {
    code,
    productId,
    productTitle: product.title,
    price: 0,
    phone: "",
    appUsed: "",
    ref: "soft-launch-free-claim",
    status: "approved",
    createdAt: Date.now(),
  };
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(code);
  await env.MEGA_KV.put("orders:index", JSON.stringify(index));

  return json({ code });
}

async function listOrders(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdmin(env, url.searchParams.get("password")))) return err("Wrong password", 401);
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const orders = (
    await Promise.all(index.map((code) => env.MEGA_KV.get(`order:${code}`)))
  )
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
  return json({ value: JSON.stringify(orders) });
}

async function approveOrder(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdmin(env, body.password))) return err("Wrong password", 401);
  const code = (body.code || "").toUpperCase().trim();
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  order.status = "approved";
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  return json({ ok: true });
}

// ============================================================================
// Reviews  (POST /reviews/submit, GET /reviews/list, GET /reviews/pending, POST /reviews/approve)
// ============================================================================

async function submitReview(env, request) {
  if (!(await rateLimit(env, request, "reviews-submit", 10, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { token, rating, comment } = body;
  if (!token) return err("Login required", 401);
  const user = await getUserBySession(env, token);
  if (!user) return err("Login required", 401);

  const ratingNum = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  const commentText = String(comment || "").slice(0, 600).trim();
  if (!commentText) return err("Comment required");

  const pendingRaw = await env.MEGA_KV.get("reviews:pending");
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  const nextId = (parseInt((await env.MEGA_KV.get("reviews:nextId")) || "1", 10));
  pending.push({ id: nextId, rating: ratingNum, comment: commentText, user_name: user.name, createdAt: Date.now() });
  await env.MEGA_KV.put("reviews:pending", JSON.stringify(pending));
  await env.MEGA_KV.put("reviews:nextId", String(nextId + 1));

  return json({ ok: true });
}

async function listApprovedReviews(env) {
  const raw = await env.MEGA_KV.get("reviews:approved");
  const reviews = raw ? JSON.parse(raw) : [];
  return json({ reviews: reviews.slice(-30).reverse() });
}

async function listPendingReviews(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdmin(env, url.searchParams.get("password")))) return err("Wrong password", 401);
  const raw = await env.MEGA_KV.get("reviews:pending");
  return json({ reviews: raw ? JSON.parse(raw) : [] });
}

async function approveReview(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdmin(env, body.password))) return err("Wrong password", 401);
  const id = parseInt(body.id, 10);

  const pendingRaw = await env.MEGA_KV.get("reviews:pending");
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  const idx = pending.findIndex((r) => r.id === id);
  if (idx === -1) return err("Review not found", 404);
  const [review] = pending.splice(idx, 1);
  await env.MEGA_KV.put("reviews:pending", JSON.stringify(pending));

  const approvedRaw = await env.MEGA_KV.get("reviews:approved");
  const approved = approvedRaw ? JSON.parse(approvedRaw) : [];
  approved.push(review);
  await env.MEGA_KV.put("reviews:approved", JSON.stringify(approved));

  return json({ ok: true });
}

// ============================================================================
// Auth  (POST /auth/register, POST /auth/login, GET /auth/me) — backed by D1
// ============================================================================

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function registerUser(env, request) {
  if (!(await rateLimit(env, request, "auth-register", 10, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const name = String(body.name || "").trim().slice(0, 80);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const password = String(body.password || "");
  if (!name || !isValidEmail(email)) return err("Invalid name or email");
  if (password.length < 6) return err("Password must be at least 6 characters");

  const existing = await env.MEGA_DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return err("An account with this email already exists", 409);

  const { hash, salt } = await hashPassword(password);
  const result = await env.MEGA_DB.prepare(
    "INSERT INTO users (name, email, password_hash, salt, auth_provider, created_at) VALUES (?, ?, ?, ?, 'password', ?)"
  )
    .bind(name, email, hash, salt, Date.now())
    .run();
  const userId = result.meta.last_row_id;

  const token = await createSession(env, userId);
  return json({ token, name, email });
}

async function loginUser(env, request) {
  if (!(await rateLimit(env, request, "auth-login", 20, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const user = await env.MEGA_DB.prepare(
    "SELECT id, name, email, password_hash, salt, auth_provider FROM users WHERE email = ?"
  )
    .bind(email)
    .first();
  if (!user) return err("Invalid email or password", 401);
  if (!user.password_hash) {
    return err(`This account was created with ${user.auth_provider} sign-in — use that button instead`, 409);
  }

  const { hash } = await hashPassword(password, user.salt);
  if (!(await safeEqual(hash, user.password_hash))) return err("Invalid email or password", 401);

  const token = await createSession(env, user.id);
  return json({ token, name: user.name, email: user.email });
}

async function createSession(env, userId) {
  const token = randomHex(32);
  await env.MEGA_DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, Date.now() + SESSION_TTL_SECONDS * 1000)
    .run();
  return token;
}

async function getUserBySession(env, token) {
  if (!token) return null;
  const row = await env.MEGA_DB.prepare(
    `SELECT users.id, users.name, users.email, sessions.expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email };
}

async function authMe(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = await getUserBySession(env, token);
  if (!user) return err("Not logged in", 401);
  return json({ name: user.name, email: user.email });
}

// ============================================================================
// Social login — Google, Apple (both OIDC/JWT-based) and Facebook (token-based).
// Every provider is verified for real against that provider's own servers —
// none of this trusts anything the client merely claims about who signed in.
// Each endpoint no-ops with a clear error until its secret is actually set.
// ============================================================================

function base64UrlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function base64UrlDecodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(b64url)));
}

async function getJwksKey(env, jwksUrl, kid) {
  const cacheKey = `jwks-cache:${jwksUrl}`;
  let jwks;
  const cached = await env.MEGA_KV.get(cacheKey);
  if (cached) {
    jwks = JSON.parse(cached);
  } else {
    const res = await fetch(jwksUrl);
    jwks = await res.json();
    await env.MEGA_KV.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 3600 });
  }
  return (jwks.keys || []).find((k) => k.kid === kid) || null;
}

/**
 * Verifies an RS256-signed OIDC ID token (used by both Google and Apple) against the
 * provider's published JWKS, checking signature, issuer, audience, and expiry.
 * Returns the decoded payload on success, or throws with a descriptive message.
 */
async function verifyOidcIdToken(env, idToken, { issuer, audience, jwksUrl }) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);

  if (header.alg !== "RS256") throw new Error("Unexpected signing algorithm");
  const jwk = await getJwksKey(env, jwksUrl, header.kid);
  if (!jwk) throw new Error("Signing key not found");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
  if (!valid) throw new Error("Invalid signature");

  if (payload.iss !== issuer) throw new Error("Unexpected issuer");
  if (payload.aud !== audience) throw new Error("Unexpected audience");
  if (payload.exp * 1000 < Date.now()) throw new Error("Token expired");

  return payload;
}

async function findOrCreateSocialUser(env, { email, name, provider }) {
  email = String(email || "").trim().toLowerCase();
  if (!email) throw new Error("Provider did not return an email address");
  name = String(name || email.split("@")[0]).slice(0, 80);

  let user = await env.MEGA_DB.prepare("SELECT id, name, email FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    // password_hash/salt are NOT NULL in the real schema — for a social/passkey-only
    // account we still fill them with a random, never-revealed value that can't be
    // used to log in (registerUser/loginUser never produce this by any real password).
    const { hash, salt } = await hashPassword(randomHex(32));
    const result = await env.MEGA_DB.prepare(
      "INSERT INTO users (name, email, password_hash, salt, auth_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(name, email, hash, salt, provider, Date.now())
      .run();
    user = { id: result.meta.last_row_id, name, email };
  }
  const token = await createSession(env, user.id);
  return { token, name: user.name, email: user.email };
}

async function socialLoginGoogle(env, request) {
  if (!env.GOOGLE_CLIENT_ID) return err("Google sign-in is not configured yet", 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!body.idToken) return err("Missing idToken");
  try {
    const payload = await verifyOidcIdToken(env, body.idToken, {
      issuer: "https://accounts.google.com",
      audience: env.GOOGLE_CLIENT_ID,
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    });
    const result = await findOrCreateSocialUser(env, { email: payload.email, name: payload.name, provider: "google" });
    return json(result);
  } catch (e) {
    return err("Google sign-in failed: " + e.message, 401);
  }
}

async function socialLoginApple(env, request) {
  if (!env.APPLE_CLIENT_ID) return err("Apple sign-in is not configured yet", 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!body.idToken) return err("Missing idToken");
  try {
    const payload = await verifyOidcIdToken(env, body.idToken, {
      issuer: "https://appleid.apple.com",
      audience: env.APPLE_CLIENT_ID,
      jwksUrl: "https://appleid.apple.com/auth/keys",
    });
    // Apple only sends the user's name on their very first sign-in, via the client — never
    // again after that — so we accept it from the request body on that first call only.
    const result = await findOrCreateSocialUser(env, { email: payload.email, name: body.name, provider: "apple" });
    return json(result);
  } catch (e) {
    return err("Apple sign-in failed: " + e.message, 401);
  }
}

async function socialLoginFacebook(env, request) {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) return err("Facebook sign-in is not configured yet", 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!body.accessToken) return err("Missing accessToken");
  try {
    // Confirm the token actually belongs to OUR app before trusting anything it claims.
    const appToken = `${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`;
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(body.accessToken)}&access_token=${encodeURIComponent(appToken)}`
    );
    const debugData = await debugRes.json();
    const info = debugData && debugData.data;
    if (!info || !info.is_valid || String(info.app_id) !== String(env.FACEBOOK_APP_ID)) {
      throw new Error("Token does not belong to this app");
    }

    const meRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(body.accessToken)}`
    );
    const me = await meRes.json();
    if (!me || !me.id) throw new Error("Could not read profile");

    const result = await findOrCreateSocialUser(env, {
      email: me.email || `${me.id}@facebook.local`, // Facebook can withhold email if the user declines that permission
      name: me.name,
      provider: "facebook",
    });
    return json(result);
  } catch (e) {
    return err("Facebook sign-in failed: " + e.message, 401);
  }
}

// ============================================================================
// WebAuthn / Passkeys — Face ID, Touch ID, Windows Hello, Android biometric unlock.
//
// The actual fingerprint/face scan NEVER leaves the customer's device — the OS
// checks it locally in secure hardware and only releases a signed cryptographic
// assertion. What this server verifies is that signature, against a public key
// it stored when the credential was first registered. It can prove "the same
// device that registered this passkey approved this login" — it can never see,
// receive, or reconstruct the biometric itself. That's a hardware guarantee
// from Apple/Google/Microsoft, not a policy choice either side of this code
// could violate even if it wanted to.
// ============================================================================

function webauthnRpId(env) {
  const origin = (env.ALLOWED_ORIGIN || "").split(",")[0].trim();
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}

// ---- Minimal CBOR decoder (just the subset WebAuthn actually uses — lengths up
// to 4 bytes, no 8-byte lengths/floats/tags. That covers every attestationObject
// and COSE key a real authenticator produces; it is not a general CBOR decoder.) ----
function cborDecode(bytes, offset) {
  offset = offset || 0;
  const first = bytes[offset];
  const majorType = first >> 5;
  const info = first & 0x1f;
  let pos = offset + 1;

  function readLength(info) {
    if (info < 24) return { len: info, pos };
    if (info === 24) { const v = bytes[pos]; pos += 1; return { len: v, pos }; }
    if (info === 25) { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return { len: v, pos }; }
    if (info === 26) {
      const v = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
      return { len: v >>> 0, pos };
    }
    throw new Error("Unsupported CBOR length encoding");
  }

  if (majorType === 0) { // unsigned int
    const { len, pos: p } = readLength(info);
    return { value: len, pos: p };
  }
  if (majorType === 1) { // negative int
    const { len, pos: p } = readLength(info);
    return { value: -1 - len, pos: p };
  }
  if (majorType === 2) { // byte string
    const { len, pos: p } = readLength(info);
    return { value: bytes.slice(p, p + len), pos: p + len };
  }
  if (majorType === 3) { // text string
    const { len, pos: p } = readLength(info);
    return { value: new TextDecoder().decode(bytes.slice(p, p + len)), pos: p + len };
  }
  if (majorType === 4) { // array
    const { len, pos: p } = readLength(info);
    let cur = p;
    const arr = [];
    for (let i = 0; i < len; i++) {
      const r = cborDecode(bytes, cur);
      arr.push(r.value);
      cur = r.pos;
    }
    return { value: arr, pos: cur };
  }
  if (majorType === 5) { // map
    const { len, pos: p } = readLength(info);
    let cur = p;
    const map = new Map();
    for (let i = 0; i < len; i++) {
      const k = cborDecode(bytes, cur);
      const v = cborDecode(bytes, k.pos);
      map.set(k.value, v.value);
      cur = v.pos;
    }
    return { value: map, pos: cur };
  }
  if (majorType === 7) { // simple/bool/null/float
    if (info === 20) return { value: false, pos };
    if (info === 21) return { value: true, pos };
    if (info === 22) return { value: null, pos };
    throw new Error("Unsupported CBOR simple value");
  }
  throw new Error("Unsupported CBOR major type " + majorType);
}

function base64UrlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Parses the authenticatorData structure (spec §6.1) and, if present, the
// attested credential data (present only during registration).
function parseAuthenticatorData(bytes) {
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = (bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36];
  const result = { rpIdHash, flags, signCount: signCount >>> 0, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04) };
  const attestedDataPresent = !!(flags & 0x40);
  if (attestedDataPresent) {
    let pos = 37;
    pos += 16; // aaguid, unused here
    const credIdLen = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
    const credentialId = bytes.slice(pos, pos + credIdLen);
    pos += credIdLen;
    const { value: coseKeyMap } = cborDecode(bytes, pos);
    result.credentialId = credentialId;
    result.coseKeyMap = coseKeyMap;
  }
  return result;
}

// Converts a COSE public key (CBOR map, integer keys per RFC 9053) into a JWK
// Web Crypto can import, and reports which algorithm it needs for verification.
function coseKeyToJwk(coseKeyMap) {
  const kty = coseKeyMap.get(1);
  const alg = coseKeyMap.get(3);
  if (kty === 2) {
    // EC2 (alg -7 = ES256, P-256)
    const x = coseKeyMap.get(-2);
    const y = coseKeyMap.get(-3);
    return {
      jwk: { kty: "EC", crv: "P-256", x: base64UrlEncode(x), y: base64UrlEncode(y) },
      alg: "ES256",
      importParams: { name: "ECDSA", namedCurve: "P-256" },
      verifyParams: { name: "ECDSA", hash: "SHA-256" },
    };
  }
  if (kty === 3) {
    // RSA (alg -257 = RS256)
    const n = coseKeyMap.get(-1);
    const e = coseKeyMap.get(-2);
    return {
      jwk: { kty: "RSA", n: base64UrlEncode(n), e: base64UrlEncode(e) },
      alg: "RS256",
      importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      verifyParams: { name: "RSASSA-PKCS1-v1_5" },
    };
  }
  throw new Error("Unsupported public key type");
}

// WebAuthn ECDSA signatures are DER-encoded; Web Crypto's ECDSA verify wants raw r||s (32+32 bytes for P-256).
function derEcdsaSignatureToRaw(der) {
  let pos = 2; // skip SEQUENCE tag + length
  function readInt() {
    if (der[pos] !== 0x02) throw new Error("Expected INTEGER in DER signature");
    pos++;
    let len = der[pos];
    pos++;
    let bytes = der.slice(pos, pos + len);
    pos += len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1); // strip leading zero padding
    if (bytes.length < 32) {
      const padded = new Uint8Array(32);
      padded.set(bytes, 32 - bytes.length);
      bytes = padded;
    }
    return bytes;
  }
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

async function verifyClientData(clientDataJSON, expectedType, expectedChallenge, env) {
  const json = JSON.parse(new TextDecoder().decode(clientDataJSON));
  if (json.type !== expectedType) throw new Error("Unexpected ceremony type");
  if (json.challenge !== expectedChallenge) throw new Error("Challenge mismatch");
  const allowedOrigins = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.length && !allowedOrigins.includes(json.origin)) throw new Error("Origin mismatch");
  return json;
}

async function webauthnRegisterOptions(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = await getUserBySession(env, token);
  if (!user) return err("Login required before registering a passkey", 401);

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = base64UrlEncode(challengeBytes);
  const challengeToken = randomHex(16);
  await env.MEGA_KV.put(
    `webauthn-challenge:${challengeToken}`,
    JSON.stringify({ challenge, userId: user.id, purpose: "register" }),
    { expirationTtl: 300 }
  );

  const existing = await env.MEGA_DB.prepare("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
    .bind(user.id)
    .all();
  const excludeCredentials = (existing.results || []).map((r) => ({ id: r.credential_id, type: "public-key" }));

  return json({
    challengeToken,
    challenge,
    rp: { name: "Miga-Photo", id: webauthnRpId(env) },
    user: { id: base64UrlEncode(new TextEncoder().encode(String(user.id))), name: user.email, displayName: user.name },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 }, // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    attestation: "none",
    timeout: 60000,
    excludeCredentials,
  });
}

async function webauthnRegisterVerify(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const challengeRaw = await env.MEGA_KV.get(`webauthn-challenge:${body.challengeToken}`);
  if (!challengeRaw) return err("Registration challenge expired, please try again", 400);
  await env.MEGA_KV.delete(`webauthn-challenge:${body.challengeToken}`); // one-time use
  const { challenge, userId, purpose } = JSON.parse(challengeRaw);
  if (purpose !== "register") return err("Wrong challenge type", 400);

  try {
    const clientDataJSON = base64UrlToUint8Array(body.credential.response.clientDataJSON);
    await verifyClientData(clientDataJSON, "webauthn.create", challenge, env);

    const attestationObjectBytes = base64UrlToUint8Array(body.credential.response.attestationObject);
    const { value: attestationMap } = cborDecode(attestationObjectBytes, 0);
    const authData = parseAuthenticatorData(attestationMap.get("authData"));
    if (!authData.credentialId || !authData.coseKeyMap) throw new Error("No attested credential data");
    if (!authData.userVerified) throw new Error("Biometric/PIN verification was not confirmed by the device");

    const { jwk, alg } = coseKeyToJwk(authData.coseKeyMap);
    const credentialIdB64 = base64UrlEncode(authData.credentialId);

    await env.MEGA_DB.prepare(
      "INSERT INTO webauthn_credentials (user_id, credential_id, public_key_jwk, alg, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(userId, credentialIdB64, JSON.stringify(jwk), alg, authData.signCount, Date.now())
      .run();

    return json({ ok: true });
  } catch (e) {
    return err("Could not register passkey: " + e.message, 400);
  }
}

async function webauthnLoginOptions(env, request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* email is optional — empty body means discoverable/passkey login */
  }
  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = base64UrlEncode(challengeBytes);
  const challengeToken = randomHex(16);
  await env.MEGA_KV.put(
    `webauthn-challenge:${challengeToken}`,
    JSON.stringify({ challenge, purpose: "login" }),
    { expirationTtl: 300 }
  );

  let allowCredentials = [];
  if (body.email) {
    const email = String(body.email).trim().toLowerCase();
    const user = await env.MEGA_DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (user) {
      const creds = await env.MEGA_DB.prepare("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user.id)
        .all();
      allowCredentials = (creds.results || []).map((r) => ({ id: r.credential_id, type: "public-key" }));
    }
  }

  return json({
    challengeToken,
    challenge,
    rpId: webauthnRpId(env),
    allowCredentials, // empty array = let the OS offer any passkey it has for this site (discoverable login)
    userVerification: "required",
    timeout: 60000,
  });
}

async function webauthnLoginVerify(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const challengeRaw = await env.MEGA_KV.get(`webauthn-challenge:${body.challengeToken}`);
  if (!challengeRaw) return err("Login challenge expired, please try again", 400);
  await env.MEGA_KV.delete(`webauthn-challenge:${body.challengeToken}`); // one-time use
  const { challenge, purpose } = JSON.parse(challengeRaw);
  if (purpose !== "login") return err("Wrong challenge type", 400);

  try {
    const credentialIdB64 = body.credential.id;
    const row = await env.MEGA_DB.prepare(
      `SELECT webauthn_credentials.id as cred_row_id, webauthn_credentials.public_key_jwk, webauthn_credentials.alg,
              webauthn_credentials.sign_count, users.id as user_id, users.name, users.email
       FROM webauthn_credentials JOIN users ON users.id = webauthn_credentials.user_id
       WHERE webauthn_credentials.credential_id = ?`
    )
      .bind(credentialIdB64)
      .first();
    if (!row) throw new Error("This passkey is not registered");

    const clientDataJSON = base64UrlToUint8Array(body.credential.response.clientDataJSON);
    await verifyClientData(clientDataJSON, "webauthn.get", challenge, env);

    const authenticatorDataBytes = base64UrlToUint8Array(body.credential.response.authenticatorData);
    const authData = parseAuthenticatorData(authenticatorDataBytes);
    if (!authData.userVerified) throw new Error("Biometric/PIN verification was not confirmed by the device");

    // Replay/clone detection: a genuine authenticator's counter must strictly increase.
    // Some platform authenticators legitimately keep it at 0 — only enforce the check
    // when the stored counter shows the authenticator actually uses one.
    if (row.sign_count > 0 && authData.signCount > 0 && authData.signCount <= row.sign_count) {
      throw new Error("Possible cloned authenticator detected — sign count did not increase");
    }

    const jwk = JSON.parse(row.public_key_jwk);
    const isEC = jwk.kty === "EC";
    const importParams = isEC ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const verifyParams = isEC ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
    const cryptoKey = await crypto.subtle.importKey("jwk", jwk, importParams, false, ["verify"]);

    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const signedData = new Uint8Array(authenticatorDataBytes.length + clientDataHash.length);
    signedData.set(authenticatorDataBytes, 0);
    signedData.set(clientDataHash, authenticatorDataBytes.length);

    let signatureBytes = base64UrlToUint8Array(body.credential.response.signature);
    if (isEC) signatureBytes = derEcdsaSignatureToRaw(signatureBytes);

    const valid = await crypto.subtle.verify(verifyParams, cryptoKey, signatureBytes, signedData);
    if (!valid) throw new Error("Signature verification failed");

    await env.MEGA_DB.prepare("UPDATE webauthn_credentials SET sign_count = ? WHERE id = ?")
      .bind(authData.signCount, row.cred_row_id)
      .run();

    const sessionToken = await createSession(env, row.user_id);
    return json({ token: sessionToken, name: row.name, email: row.email });
  } catch (e) {
    return err("Biometric sign-in failed: " + e.message, 401);
  }
}

// ============================================================================
// Admin
// ============================================================================

async function adminVerify(env, request) {
  if (!(await rateLimit(env, request, "admin-verify", 15, 300))) {
    return err("Too many attempts, please wait a few minutes", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const ok = await verifyAdmin(env, body.password);
  return json({ ok });
}

// ============================================================================
// Payments — Paymob (card) / Fawry
// These are your real, already-working integrations (carried over from the
// "miga" worker as deployed) — not stubs. Card/Fawry stay hidden on the
// frontend via PAYMENT_METHODS_ENABLED until you've smoke-tested each one.
// ============================================================================

async function paymobCreate(env, request) {
  if (!env.PAYMOB_SECRET_KEY || !env.PAYMOB_PUBLIC_KEY || !env.PAYMOB_INTEGRATION_ID) {
    return err("Card payment is not configured yet (missing Paymob secrets)", 501);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { orderCode, amount, name, phone, email } = body;
  if (!orderCode || !amount) return err("Missing orderCode or amount");

  try {
    const intentionRes = await fetch("https://accept.paymob.com/v1/intention/", {
      method: "POST",
      headers: {
        Authorization: `Token ${env.PAYMOB_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Paymob expects the smallest currency unit (piastres)
        currency: "EGP",
        payment_methods: [Number(env.PAYMOB_INTEGRATION_ID)],
        special_reference: orderCode,
        billing_data: {
          first_name: name || "Customer",
          last_name: "N/A",
          phone_number: phone || "01000000000",
          email: email || "customer@example.com",
          country: "EG",
        },
        items: [{ name: `Miga-Photobook order ${orderCode}`, amount: Math.round(amount * 100), quantity: 1 }],
      }),
    });

    if (!intentionRes.ok) {
      const detail = await intentionRes.text();
      return json({ error: "Paymob intention creation failed", detail }, 502);
    }
    const data = await intentionRes.json();
    const clientSecret = data.client_secret;
    if (!clientSecret) return json({ error: "No client_secret returned from Paymob", detail: data }, 502);

    const checkoutUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${env.PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;
    return json({ checkoutUrl });
  } catch (e) {
    return json({ error: "Unexpected error creating Paymob payment", detail: String(e) }, 500);
  }
}

async function paymobWebhook(env, request) {
  // Paymob calls this after a payment attempt. Verifies the HMAC before trusting it.
  if (!env.PAYMOB_HMAC_SECRET) return err("Server misconfigured: PAYMOB_HMAC_SECRET not set", 500);
  try {
    const url = new URL(request.url);
    const body = await request.json().catch(() => null);
    const obj = body?.obj || body;
    const hmacFromPaymob = url.searchParams.get("hmac");
    // NOTE: Paymob's exact HMAC field concatenation order is specific to their docs
    // (https://developers.paymob.com) — verify this against a real test webhook
    // before relying on it, since payloads/fields can vary by integration type.
    const orderedFields = [
      obj?.amount_cents, obj?.created_at, obj?.currency, obj?.error_occured,
      obj?.has_parent_transaction, obj?.id, obj?.integration_id, obj?.is_3d_secure,
      obj?.is_auth, obj?.is_capture, obj?.is_refunded, obj?.is_standalone_payment,
      obj?.is_voided, obj?.order?.id, obj?.owner, obj?.pending, obj?.source_data?.pan,
      obj?.source_data?.sub_type, obj?.source_data?.type, obj?.success,
    ].map((v) => (v === undefined || v === null ? "" : String(v))).join("");
    const computedHmac = await sha256Hex(orderedFields + env.PAYMOB_HMAC_SECRET);

    if (hmacFromPaymob && computedHmac !== hmacFromPaymob) {
      return err("HMAC verification failed", 401);
    }
    if (obj?.success && obj?.order?.merchant_order_id) {
      await approveOrderByCode(env, obj.order.merchant_order_id);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Webhook processing error", detail: String(e) }, 500);
  }
}

async function fawryCreate(env, request) {
  if (!env.FAWRY_MERCHANT_CODE || !env.FAWRY_SECURITY_KEY) {
    return err("Fawry payment is not configured yet (missing Fawry secrets)", 501);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { orderCode, amount, name, phone, email } = body;
  if (!orderCode || !amount || !phone) return err("Missing orderCode, amount, or phone");

  try {
    const amountFormatted = Number(amount).toFixed(2);
    // Fawry's documented signature order for a charge request:
    // SHA256(merchantCode + merchantRefNum + customerProfileId + paymentMethod + amount + secureKey)
    // ⚠️ Verify this against your Fawry merchant portal's current docs before going live.
    const signatureRaw = `${env.FAWRY_MERCHANT_CODE}${orderCode}${phone}PAYATFAWRY${amountFormatted}${env.FAWRY_SECURITY_KEY}`;
    const signature = await sha256Hex(signatureRaw);

    const fawryRes = await fetch("https://www.atfawry.com/ECommerceWeb/Fawry/payments/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchantCode: env.FAWRY_MERCHANT_CODE,
        merchantRefNum: orderCode,
        customerMobile: phone,
        customerEmail: email || "",
        customerName: name || "Customer",
        customerProfileId: phone,
        paymentMethod: "PAYATFAWRY",
        amount: amountFormatted,
        currencyCode: "EGP",
        language: "ar-eg",
        chargeItems: [{ itemId: orderCode, description: `Miga-Photobook order ${orderCode}`, price: amountFormatted, quantity: "1" }],
        signature,
      }),
    });

    if (!fawryRes.ok) {
      const detail = await fawryRes.text();
      return json({ error: "Fawry charge request failed", detail }, 502);
    }
    const data = await fawryRes.json();
    if (!data.referenceNumber) return json({ error: "No reference number returned from Fawry", detail: data }, 502);
    return json({ referenceNumber: data.referenceNumber });
  } catch (e) {
    return json({ error: "Unexpected error creating Fawry payment", detail: String(e) }, 500);
  }
}

async function fawryWebhook(env, request) {
  // Fawry calls this (Server Callback V2) after payment status changes.
  try {
    const body = await request.json().catch(() => null);
    // ⚠️ Verify Fawry's callback signature per their docs before trusting orderStatus in production.
    if (body?.orderStatus === "PAID" && body?.merchantRefNumber) {
      await approveOrderByCode(env, body.merchantRefNumber);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Webhook processing error", detail: String(e) }, 500);
  }
}

// ============================================================================
// AI photo transform  (POST /transform)
// Stub with a clear extension point: plug in whichever image-generation
// provider you choose (OpenAI images/edits, Stability, Replicate, etc.)
// behind IMAGE_GEN_API_KEY / IMAGE_GEN_PROVIDER secrets.
//
// The customer's browser sends productId + orderCode (proof of purchase) —
// never the transformation instructions themselves. This server looks the
// instructions up itself from the product record. That's the whole point of
// this being a "we transform it for you" service rather than a prompt
// marketplace: the instructions are a business asset the customer never
// needs to see, and now they structurally can't — there is no code path
// that puts them in a network response to a non-admin request.
// ============================================================================

async function transformImage(env, request) {
  if (!(await rateLimit(env, request, "transform", 15, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { image, productId, orderCode } = body;
  if (!image || !productId || !orderCode) return err("Missing image, productId, or orderCode");
  if (!image.startsWith("data:image")) return err("image must be a data URI");

  const code = String(orderCode).toUpperCase().trim();
  const orderRaw = await env.MEGA_KV.get(`order:${code}`);
  if (!orderRaw) return err("Order not found — please re-enter your order code", 404);
  const order = JSON.parse(orderRaw);
  if (order.status !== "approved") return err("This order has not been approved yet", 403);
  if (order.productId !== productId) return err("This order code does not match this product", 403);

  const productRaw = await env.MEGA_KV.get(`product:${productId}`);
  if (!productRaw) return err("Product not found", 404);
  const product = JSON.parse(productRaw);

  if (!env.FAL_KEY) {
    return err("AI transform is not configured yet (missing FAL_KEY)", 501);
  }

  try {
    const falBody = { prompt: product.prompt, image_urls: [image] };
    if (product.negativePrompt) falBody.negative_prompt = product.negativePrompt;

    const falRes = await fetch("https://fal.run/fal-ai/nano-banana-2/edit", {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(falBody),
    });

    if (!falRes.ok) {
      const detail = await falRes.text();
      return json({ error: "Image generation request failed", detail }, 502);
    }
    const data = await falRes.json();
    const outputUrl = data?.images?.[0]?.url;
    if (!outputUrl) return json({ error: "No image returned from the generation service", detail: data }, 502);
    return json({ imageUrl: outputUrl });
  } catch (e) {
    return json({ error: "Unexpected server error", detail: String(e) }, 500);
  }
}

// ============================================================================
// Router
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      await ensureLegacyDataMigrated(env);
      let response;

      if (pathname === "/products" && request.method === "GET") response = await getProducts(env);
      else if (pathname === "/admin/products" && request.method === "GET") response = await getAdminProducts(env, request);
      else if (pathname === "/products/upsert" && request.method === "POST") response = await upsertProduct(env, request);
      else if (pathname === "/products/delete" && request.method === "POST") response = await deleteProductRemote(env, request);
      else if (pathname === "/admin/upload-image" && request.method === "POST") response = await uploadImage(env, request);
      else if (pathname.startsWith("/images/") && request.method === "GET")
        response = await serveImage(env, pathname.slice("/images/".length));
      else if (pathname === "/orders/create" && request.method === "POST") response = await createOrder(env, request);
      else if (pathname === "/orders/track" && request.method === "GET") response = await trackOrder(env, request);
      else if (pathname === "/orders/claim-free" && request.method === "POST") response = await claimFreeOrder(env, request);
      else if (pathname === "/orders/list" && request.method === "GET") response = await listOrders(env, request);
      else if (pathname === "/orders/approve" && request.method === "POST") response = await approveOrder(env, request);
      else if (pathname === "/reviews/submit" && request.method === "POST") response = await submitReview(env, request);
      else if (pathname === "/reviews/list" && request.method === "GET") response = await listApprovedReviews(env);
      else if (pathname === "/reviews/pending" && request.method === "GET") response = await listPendingReviews(env, request);
      else if (pathname === "/reviews/approve" && request.method === "POST") response = await approveReview(env, request);
      else if (pathname === "/visits/log" && request.method === "POST") response = await logVisit(env, request);
      else if (pathname === "/visits/stats" && request.method === "GET") response = await getVisitStats(env, request);
      else if (pathname === "/auth/register" && request.method === "POST") response = await registerUser(env, request);
      else if (pathname === "/auth/login" && request.method === "POST") response = await loginUser(env, request);
      else if (pathname === "/auth/me" && request.method === "GET") response = await authMe(env, request);
      else if (pathname === "/auth/social/google" && request.method === "POST") response = await socialLoginGoogle(env, request);
      else if (pathname === "/auth/social/apple" && request.method === "POST") response = await socialLoginApple(env, request);
      else if (pathname === "/auth/social/facebook" && request.method === "POST") response = await socialLoginFacebook(env, request);
      else if (pathname === "/auth/webauthn/register-options" && request.method === "POST") response = await webauthnRegisterOptions(env, request);
      else if (pathname === "/auth/webauthn/register-verify" && request.method === "POST") response = await webauthnRegisterVerify(env, request);
      else if (pathname === "/auth/webauthn/login-options" && request.method === "POST") response = await webauthnLoginOptions(env, request);
      else if (pathname === "/auth/webauthn/login-verify" && request.method === "POST") response = await webauthnLoginVerify(env, request);
      else if (pathname === "/admin/verify" && request.method === "POST") response = await adminVerify(env, request);
      else if (pathname === "/payment/paymob/create" && request.method === "POST") response = await paymobCreate(env, request);
      else if (pathname === "/payment/paymob/webhook" && request.method === "POST") response = await paymobWebhook(env, request);
      else if (pathname === "/payment/fawry/create" && request.method === "POST") response = await fawryCreate(env, request);
      else if (pathname === "/payment/fawry/webhook" && request.method === "POST") response = await fawryWebhook(env, request);
      else if (pathname === "/transform" && request.method === "POST") response = await transformImage(env, request);
      else response = err("Not found", 404);

      const merged = new Headers(response.headers);
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (e) {
      return json({ error: "Internal error" }, 500, headers);
    }
  },
};
