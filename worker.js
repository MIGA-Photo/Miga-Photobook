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
 *   POST     /orders/mark-thanked  (admin only)
 *   POST     /reviews/submit       GET /reviews/list      GET /reviews/pending
 *   POST     /reviews/approve
 *   POST     /visits/log (public)  GET  /visits/stats (admin only)
 *   POST     /auth/register        POST /auth/login       GET /auth/me
 *   POST     /auth/social/google   POST /auth/social/apple   POST /auth/social/facebook
 *   POST     /auth/webauthn/register-options   POST /auth/webauthn/register-verify
 *   POST     /auth/webauthn/login-options      POST /auth/webauthn/login-verify
 *   POST     /admin/verify
 *   POST     /admin/upload-image   GET  /images/:key
 *   GET      /showcase              POST /admin/showcase (admin only)
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
  const stored = await env.MEGA_KV.get("admin_password");
  if (stored) {
    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return false;
    }
    const { hash: candidateHash } = await hashPassword(password, parsed.salt);
    return safeEqual(candidateHash, parsed.hash);
  }
  // No password has been set in KV yet — fall back to the ADMIN_PASSWORD
  // secret (the original setup) and migrate it into KV on first successful
  // login, so /admin/change-password works from then on without needing a
  // new secret deploy.
  if (!env.ADMIN_PASSWORD) return false; // fail closed if nothing is configured
  const ok = await safeEqual(password, env.ADMIN_PASSWORD);
  if (ok) {
    const { hash, salt } = await hashPassword(password);
    await env.MEGA_KV.put("admin_password", JSON.stringify({ hash, salt }));
  }
  return ok;
}

// ============================================================================
// Admin sessions — the admin's real password is only ever checked once, at
// /admin/verify. Every other admin-only route below checks a short-lived,
// revocable session token instead, stored server-side in KV. A leaked/stolen
// token from a compromised browser only ever exposes that one token (which
// can be revoked via /admin/logout or by letting it expire) — never the
// master ADMIN_PASSWORD itself.
// ============================================================================
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, sliding

async function createAdminSession(env) {
  const token = randomHex(32);
  await env.MEGA_KV.put(`admin_session:${token}`, "1", { expirationTtl: ADMIN_SESSION_TTL_SECONDS });
  return token;
}

async function verifyAdminSession(env, token) {
  if (!token) return false;
  const raw = await env.MEGA_KV.get(`admin_session:${token}`);
  if (!raw) return false;
  // Sliding expiration: a session that's still being used stays alive,
  // instead of silently expiring on the admin mid-workday.
  await env.MEGA_KV.put(`admin_session:${token}`, "1", { expirationTtl: ADMIN_SESSION_TTL_SECONDS });
  return true;
}

async function revokeAdminSession(env, token) {
  if (!token) return;
  await env.MEGA_KV.delete(`admin_session:${token}`);
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
  // Only present once a visitor is logged into a customer account when the
  // visit is logged — anonymous browsing stays anonymous, nothing is guessed.
  const userName = typeof body.userName === "string" ? body.userName.slice(0, 120) : null;
  const userEmail = typeof body.userEmail === "string" ? body.userEmail.slice(0, 160) : null;

  try {
    await env.MEGA_DB.prepare(
      `INSERT INTO visits (visited_at, path, country, user_agent, visitor_id, user_name, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(Date.now(), path, country, userAgent, visitorId, userName, userEmail)
      .run();
  } catch (e) {
    // Table may not exist yet (migration not run), or D1 hiccup — never fail the request over this.
  }
  return json({ ok: true });
}

async function getVisitStats(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdminSession(env, url.searchParams.get("token")))) return err("Wrong password", 401);

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
      .prepare(`SELECT visited_at, path, country, user_name, user_email FROM visits ORDER BY visited_at DESC LIMIT 100`)
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
  if (order.orderType === "prompt" && !order.promptText) {
    const productRaw = await env.MEGA_KV.get(`product:${order.productId}`);
    if (productRaw) {
      const product = JSON.parse(productRaw);
      order.promptText = product.prompt || null;
    }
  }
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
/** Normalises a transfer reference so trivial variations ("48219-60573",
 * " 4821960573 ") cannot be used to file the same receipt twice. */
function normaliseRef(ref) {
  return String(ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A reference is only plausible if it is reasonably long and contains at
 * least one digit — every InstaPay / Vodafone Cash receipt number does. This
 * is the server-side twin of the check in the storefront, and it is this one
 * that actually counts, since a browser-side check can always be bypassed. */
function isPlausibleRef(ref) {
  const cleaned = normaliseRef(ref);
  return cleaned.length >= 4 && cleaned.length <= 60 && /[0-9]/.test(cleaned);
}

/** How many orders from this phone number the admin has already rejected.
 * Kept as its own counter so the check costs one KV read rather than a scan
 * of every order ever placed. */
async function rejectedCountForPhone(env, phone) {
  const raw = await env.MEGA_KV.get(`rejects:${phone}`);
  return parseInt(raw || "0", 10) || 0;
}

const MAX_REJECTS_BEFORE_BLOCK = 3;

/**
 * Pushes a new-order alert to Telegram.
 *
 * This is the only alert channel that reaches the owner when the storefront
 * is not open in a browser tab. iOS Safari will not raise web notifications
 * for a website, so the in-page bell can never be relied on for a phone that
 * is locked or asleep — this can.
 *
 * Deliberately best-effort: a Telegram outage, a revoked token, or missing
 * configuration must never stop a paying customer's order from being saved.
 * Every failure path is swallowed and the order still goes through.
 */
async function notifyOwnerOfOrder(env, order) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;           // not configured — silently skip

  const mono = (v) => "`" + String(v || "—") + "`";
  const lines = [
    "🔔 *طلب جديد*",
    "",
    "*المنتج:* " + order.productTitle,
    "*السعر:* " + order.price + " EGP",
    "*النوع:* " + (order.orderType === "prompt" ? "برومبت" : "تحويل صورة"),
    "*الموبايل:* " + order.phone,
    "*وسيلة الدفع:* " + (order.appUsed || "—"),
    "*رقم العملية:* " + mono(order.ref),
    "*كود الطلب:* " + mono(order.code),
  ];
  if (order.buyerName || order.buyerEmail) {
    lines.push(("*العميل:* " + (order.buyerName || "") + " " + (order.buyerEmail || "")).trim());
  }

  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    // Alerting is a convenience, never a condition of taking an order.
  }
}

// Very small best-effort per-IP rate limiter using KV with a short TTL.
// Wrapped so that ANY KV error here (most likely cause: the account's daily
// KV write-operation cap, which is separate from — and much lower than —
// the read cap, and easy to hit during a heavy testing session) fails OPEN
// rather than throwing. Rate limiting is a defense-in-depth nicety; it must
// never be the reason a legitimate admin login (or any other real request)
// comes back as a hard 500 with no explanation.
async function rateLimit(env, request, key, limit, windowSeconds) {
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const k = `ratelimit:${key}:${ip}`;
    const current = parseInt((await env.MEGA_KV.get(k)) || "0", 10);
    if (current >= limit) return false;
    await env.MEGA_KV.put(k, String(current + 1), { expirationTtl: windowSeconds });
    return true;
  } catch (e) {
    return true; // fail open — never block real traffic over a KV hiccup
  }
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
  if (!(await verifyAdminSession(env, url.searchParams.get("token")))) return err("Wrong password", 401);
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
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);

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
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
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

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB — phone camera photos routinely exceed the old 5MB cap
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function uploadImage(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

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
// Homepage before/after circle showcase  (GET /showcase, POST /admin/showcase)
// Stores the 9 image URLs (1 center "before" photo + 8 "after" results) shown
// in the circular showcase under the hero. Public GET so the homepage can
// render it; admin-only POST to change it from the admin panel. If nothing
// has been saved yet, GET returns {} and the frontend just keeps whatever
// default images are already baked into its HTML.
// ============================================================================

async function getShowcase(env) {
  const raw = await env.MEGA_KV.get("config:showcase");
  return json(raw ? JSON.parse(raw) : {});
}

async function saveShowcase(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!body.center || typeof body.center !== "string") return err("Missing 'center' image URL");
  if (!Array.isArray(body.items) || body.items.length !== 8 || body.items.some((u) => typeof u !== "string" || !u)) {
    return err("Expected 'items' to be an array of exactly 8 image URLs");
  }

  await env.MEGA_KV.put("config:showcase", JSON.stringify({ center: body.center, items: body.items }));
  return json({ ok: true });
}

// ============================================================================
// Site design switch  (GET /site-config — public, POST /admin/set-design)
// Lets the admin panel switch which customer-facing storefront visitors see,
// without touching any code on the frontend. Every design calls the exact
// same backend — products, orders, packages, transform, reviews — so
// switching never duplicates or diverges any actual data. The admin panel
// itself always stays on Design MIGA 1 regardless of which design is live
// for customers.
//
// This registry is the ONE place a future design gets added: drop in a new
// entry (id + folder + display names) once its files exist in the repo, and
// it appears in the admin dropdown automatically — no other code changes.
// ============================================================================

const DESIGN_REGISTRY = {
  v1: { id: "v1", folder: "", nameAr: "Design MIGA 1 — التصميم الأصلي", nameEn: "Design MIGA 1 — Original Design" },
  v2: { id: "v2", folder: "v2", nameAr: "Design MIGA 2 — سلايدر وفلاتر", nameEn: "Design MIGA 2 — Slider & Filters" },
  v3: { id: "v3", folder: "v3", nameAr: "Design MIGA 3 — أفضل ما في التصميمين", nameEn: "Design MIGA 3 — Best of Both" },
  // v4: { id: "v4", folder: "v4", nameAr: "Design MIGA 4", nameEn: "Design MIGA 4" },
};

async function getSiteConfig(env) {
  const raw = await env.MEGA_KV.get("config:activeDesign");
  const activeDesign = raw && DESIGN_REGISTRY[raw] ? raw : "v1"; // unknown/removed id falls back safely
  return json({
    activeDesign,
    availableDesigns: Object.values(DESIGN_REGISTRY),
    heroModes: await getHeroModes(env),
  });
}

async function setSiteDesign(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!DESIGN_REGISTRY[body.design]) {
    return err(`Unknown design id. Available: ${Object.keys(DESIGN_REGISTRY).join(", ")}`, 400);
  }

  await env.MEGA_KV.put("config:activeDesign", body.design);
  return json({ ok: true, activeDesign: body.design });
}

// ============================================================================
// Per-design hero showcase mode  (included in GET /site-config, set via
// POST /admin/set-hero-mode)
// Each design's hero can show EITHER the orbiting "circle" showcase (Design
// MIGA 1's original visual) OR the interactive drag "slider" (Design MIGA
// 2/3's visual) — independently per design, chosen from the admin panel.
// Falls back to each design's original look if nothing has been chosen yet,
// so this is fully backward-compatible with every design already deployed.
// ============================================================================

const HERO_MODES = ["circle", "slider"];
const HERO_MODE_DEFAULTS = { v1: "circle", v2: "slider", v3: "slider" };

async function getHeroModes(env) {
  const raw = await env.MEGA_KV.get("config:heroMode");
  const saved = raw ? JSON.parse(raw) : {};
  const modes = {};
  for (const id of Object.keys(DESIGN_REGISTRY)) {
    modes[id] = HERO_MODES.includes(saved[id]) ? saved[id] : (HERO_MODE_DEFAULTS[id] || "circle");
  }
  return modes;
}

async function setHeroMode(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }

  // Accepts either a single { design, mode } update, or a batched
  // { modes: { v1:"circle", v2:"slider", ... } } update covering every
  // design at once. The admin panel's "save all" button uses the batched
  // form specifically so one click means exactly one KV read + one KV
  // write, instead of firing one request per design back-to-back — three
  // rapid-fire writes to the same KV key was tripping Cloudflare's KV
  // write-rate limit, which read to the visitor as a random server error.
  const updates = body.modes && typeof body.modes === "object" ? body.modes : { [body.design]: body.mode };

  for (const [design, mode] of Object.entries(updates)) {
    if (!DESIGN_REGISTRY[design]) {
      return err(`Unknown design id. Available: ${Object.keys(DESIGN_REGISTRY).join(", ")}`, 400);
    }
    if (!HERO_MODES.includes(mode)) {
      return err(`Unknown hero mode. Available: ${HERO_MODES.join(", ")}`, 400);
    }
  }

  const raw = await env.MEGA_KV.get("config:heroMode");
  const saved = raw ? JSON.parse(raw) : {};
  Object.assign(saved, updates);
  await env.MEGA_KV.put("config:heroMode", JSON.stringify(saved));

  // Build the response from what we already have in memory rather than
  // re-reading the key we just wrote — one less KV operation per save.
  const heroModes = {};
  for (const id of Object.keys(DESIGN_REGISTRY)) {
    heroModes[id] = HERO_MODES.includes(saved[id]) ? saved[id] : (HERO_MODE_DEFAULTS[id] || "circle");
  }
  return json({ ok: true, heroModes });
}

// ============================================================================
// Homepage promo rotating-image display  (GET /promo-images, POST /admin/promo-images)
// Stores up to 20 image URLs used to replace the promo video with a rotating
// 3-panel display in the exact same frame. Public GET so the homepage can
// render it; admin-only POST to change it. If nothing has been saved yet,
// GET returns {} and the frontend just keeps showing the video.
// ============================================================================

async function getPromoImages(env) {
  const raw = await env.MEGA_KV.get("config:promoImages");
  return json(raw ? JSON.parse(raw) : {});
}

async function savePromoImages(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!Array.isArray(body.items) || body.items.length < 3 || body.items.length > 20 || body.items.some((u) => typeof u !== "string" || !u)) {
    return err("Expected 'items' to be an array of 3 to 20 image URLs");
  }

  await env.MEGA_KV.put("config:promoImages", JSON.stringify({ items: body.items }));
  return json({ ok: true });
}

// ============================================================================
// Orders  (POST /orders/create, GET /orders/track, GET /orders/list, POST /orders/approve)
// ============================================================================

// Package pricing is fixed here, server-side — a client-sent price for a
// package order is never trusted (unlike an individual product, whose price
// comes from its own KV record, a package has no such record to check
// against, so the price must be pinned in code instead).
// Package prices, keyed by photo-count (each size must be unique across
// both one-time packages AND the "monthly" subscription-style packages
// below, since a single size is what the client sends to identify which
// one it's buying — validated here server-side regardless of what price
// the client claims). Subscription tiers are NOT auto-recurring billing —
// the site has no payment gateway wired up, only manual InstaPay/Vodafone
// Cash transfers — so a "monthly" package is just a package the customer
// is expected to manually re-purchase each month; same underlying credits
// mechanism as the one-time packages, just marketed with a monthly framing.
const PACKAGE_PRICES = {
  3: 59,    // Starter (one-time)
  15: 259,  // Pro (one-time)
  30: 419,  // Premium (one-time)
  10: 149,  // Monthly subscription — 10 photos/month
  20: 299,  // Monthly subscription — 20 photos/month
};

async function createOrder(env, request) {
  if (!(await rateLimit(env, request, "orders-create", 6, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { productId, productTitle, price, phone, appUsed, ref, buyerName, buyerEmail, orderType, packageSize } = body;
  if (!productId || !productTitle || !phone) return err("Missing required fields");
  if (String(phone).length > 40) return err("Invalid phone");
  // Egyptian mobile numbers: 11 digits, starting 010/011/012/015. This is the
  // real safeguard against fake/junk orders (a UI-side check alone can always
  // be bypassed) — "......", "2222222", or any non-mobile-shaped number is
  // rejected before an order ever reaches the admin's review queue.
  const cleanedPhone = String(phone).trim();
  if (!/^01[0125][0-9]{8}$/.test(cleanedPhone)) {
    return err("Please enter a valid Egyptian mobile number (e.g. 01xxxxxxxxx)", 400);
  }

  const isPackageOrder = orderType === "package";
  let normalizedPackageSize = null;
  let finalPrice = Number(price) || 0;
  if (isPackageOrder) {
    normalizedPackageSize = Number(packageSize);
    if (!PACKAGE_PRICES[normalizedPackageSize]) return err("Invalid package size", 400);
    finalPrice = PACKAGE_PRICES[normalizedPackageSize]; // ignore whatever price the client sent
  }

  // A visitor who never transferred has no receipt number to give, so this is
  // the single most effective filter against "I've paid" being clicked
  // speculatively. Enforced here, not only in the page.
  if (!isPlausibleRef(ref)) {
    return err("Please enter the transfer reference number from your payment receipt", 400);
  }

  // The same receipt can only ever back one order. Without this, one genuine
  // transfer could be replayed to claim several products.
  const refKey = `orderref:${normaliseRef(ref)}`;
  if (await env.MEGA_KV.get(refKey)) {
    return err("This transfer reference has already been used for another order", 409);
  }

  // Repeat offenders: once the admin has rejected several orders from a
  // number, that number stops being able to file new ones.
  if ((await rejectedCountForPhone(env, cleanedPhone)) >= MAX_REJECTS_BEFORE_BLOCK) {
    return err("Ordering from this number has been suspended after repeated unpaid orders. Please contact support.", 403);
  }

  const code = randomCode(8);
  const order = {
    code,
    // 'transform' (buys one AI photo transformation), 'prompt' (buys the text
    // of the professional prompt behind a photo), or 'package' (buys a block
    // of transform credits usable across any products, not tied to one).
    orderType: orderType === "prompt" ? "prompt" : isPackageOrder ? "package" : "transform",
    productId: String(productId).slice(0, 200),
    productTitle: String(productTitle).slice(0, 300),
    price: finalPrice,
    phone: String(phone).slice(0, 40),
    appUsed: appUsed ? String(appUsed).slice(0, 60) : "",
    ref: ref ? String(ref).slice(0, 120) : "",
    buyerName: buyerName ? String(buyerName).slice(0, 120) : "",
    buyerEmail: buyerEmail ? String(buyerEmail).slice(0, 160) : "",
    status: "pending",
    createdAt: Date.now(),
    transformUsed: false,
    resultUrl: null,
    promptText: null,
    // Package-only fields — left undefined for 'transform'/'prompt' orders.
    packageSize: isPackageOrder ? normalizedPackageSize : undefined,
    creditsRemaining: isPackageOrder ? normalizedPackageSize : undefined,
    usedItems: isPackageOrder ? [] : undefined,
  };
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  await env.MEGA_KV.put(refKey, code);

  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(code);
  await env.MEGA_KV.put("orders:index", JSON.stringify(index));

  await notifyOwnerOfOrder(env, order);

  return json({ code });
}

async function trackOrder(env, request) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!code) return err("Missing code");
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  const response = { code: order.code, productId: order.productId, status: order.status, createdAt: order.createdAt, orderType: order.orderType || "transform" };
  if (order.orderType === "prompt" && order.status === "approved") {
    response.promptText = order.promptText || null;
  }
  if (order.orderType === "package") {
    response.packageSize = order.packageSize;
    response.creditsRemaining = order.creditsRemaining;
    response.usedItems = order.usedItems || [];
  }
  return json(response);
}

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
    transformUsed: false,
    resultUrl: null,
  };
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(code);
  await env.MEGA_KV.put("orders:index", JSON.stringify(index));

  return json({ code });
}

async function markOrderThanked(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
  const code = (body.code || "").toUpperCase().trim();
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  if (!order.thankedAt) {
    order.thankedAt = Date.now();
    await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  }
  return json({ ok: true, thankedAt: order.thankedAt });
}

async function listOrders(env, request) {
  const url = new URL(request.url);
  if (!(await verifyAdminSession(env, url.searchParams.get("token")))) return err("Wrong password", 401);
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const orders = (
    await Promise.all(index.map((code) => env.MEGA_KV.get(`order:${code}`)))
  )
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
  return json({ value: JSON.stringify(orders) });
}

async function getProductPopularity(env) {
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const orders = (
    await Promise.all(index.map((code) => env.MEGA_KV.get(`order:${code}`)))
  )
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
  const counts = {};
  for (const o of orders) {
    if (o.status !== "approved") continue;
    counts[o.productId] = (counts[o.productId] || 0) + 1;
  }
  return json({ counts });
}

async function approveOrder(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
  const code = (body.code || "").toUpperCase().trim();
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  order.status = "approved";
  if (order.orderType === "prompt" && !order.promptText) {
    const productRaw = await env.MEGA_KV.get(`product:${order.productId}`);
    if (productRaw) {
      const product = JSON.parse(productRaw);
      order.promptText = product.prompt || null;
    }
  }
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  return json({ ok: true });
}

async function rejectOrder(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
  const code = (body.code || "").toUpperCase().trim();
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  if (order.status === "approved") return err("This order was already approved and can't be rejected", 409);
  const alreadyRejected = order.status === "rejected";
  order.status = "rejected";
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));

  if (!alreadyRejected) {
    const phone = String(order.phone || "").trim();
    if (phone) {
      await env.MEGA_KV.put(`rejects:${phone}`, String((await rejectedCountForPhone(env, phone)) + 1));
    }
    if (order.ref) await env.MEGA_KV.delete(`orderref:${normaliseRef(order.ref)}`);
  }
  return json({ ok: true });
}

async function deleteOrder(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
  const code = (body.code || "").toUpperCase().trim();
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  if (order.status !== "rejected") return err("Only a rejected order can be deleted", 409);
  await env.MEGA_KV.delete(`order:${code}`);
  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  await env.MEGA_KV.put("orders:index", JSON.stringify(index.filter((c) => c !== code)));
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
  const { token, rating, comment, resultImageUrl } = body;
  if (!token) return err("Login required", 401);
  const user = await getUserBySession(env, token);
  if (!user) return err("Login required", 401);

  const ratingNum = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  const commentText = String(comment || "").slice(0, 600).trim();
  if (!commentText) return err("Comment required");

      const pendingRaw = await env.MEGA_KV.get("reviews:pending");
    const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
    const nextId = (parseInt((await env.MEGA_KV.get("reviews:nextId")) || "1", 10));
    pending.push({ id: nextId, rating: ratingNum, comment: commentText, resultImageUrl: resultImageUrl || null, user_name: user.name, createdAt: Date.now() });
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
  if (!(await verifyAdminSession(env, url.searchParams.get("token")))) return err("Wrong password", 401);
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
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
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

// Permanently removes a review — whether it's still pending or already
// approved/published. Checks both lists since a review's id is unique across
// both (shared reviews:nextId counter), so the admin doesn't need to know
// which list it's currently sitting in.
async function deleteReview(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!(await verifyAdminSession(env, body.token))) return err("Wrong password", 401);
  const id = parseInt(body.id, 10);

  const pendingRaw = await env.MEGA_KV.get("reviews:pending");
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  const pendingIdx = pending.findIndex((r) => r.id === id);
  if (pendingIdx !== -1) {
    pending.splice(pendingIdx, 1);
    await env.MEGA_KV.put("reviews:pending", JSON.stringify(pending));
    return json({ ok: true });
  }

  const approvedRaw = await env.MEGA_KV.get("reviews:approved");
  const approved = approvedRaw ? JSON.parse(approvedRaw) : [];
  const approvedIdx = approved.findIndex((r) => r.id === id);
  if (approvedIdx !== -1) {
    approved.splice(approvedIdx, 1);
    await env.MEGA_KV.put("reviews:approved", JSON.stringify(approved));
    return json({ ok: true });
  }

  return err("Review not found", 404);
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
// Social login — Google, Apple, Facebook
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
      email: me.email || `${me.id}@facebook.local`,
      name: me.name,
      provider: "facebook",
    });
    return json(result);
  } catch (e) {
    return err("Facebook sign-in failed: " + e.message, 401);
  }
}

// ============================================================================
// WebAuthn / Passkeys
// ============================================================================

function webauthnRpId(env) {
  const origin = (env.ALLOWED_ORIGIN || "").split(",")[0].trim();
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}

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

  if (majorType === 0) {
    const { len, pos: p } = readLength(info);
    return { value: len, pos: p };
  }
  if (majorType === 1) {
    const { len, pos: p } = readLength(info);
    return { value: -1 - len, pos: p };
  }
  if (majorType === 2) {
    const { len, pos: p } = readLength(info);
    return { value: bytes.slice(p, p + len), pos: p + len };
  }
  if (majorType === 3) {
    const { len, pos: p } = readLength(info);
    return { value: new TextDecoder().decode(bytes.slice(p, p + len)), pos: p + len };
  }
  if (majorType === 4) {
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
  if (majorType === 5) {
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
  if (majorType === 7) {
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

function parseAuthenticatorData(bytes) {
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = (bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36];
  const result = { rpIdHash, flags, signCount: signCount >>> 0, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04) };
  const attestedDataPresent = !!(flags & 0x40);
  if (attestedDataPresent) {
    let pos = 37;
    pos += 16;
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

function coseKeyToJwk(coseKeyMap) {
  const kty = coseKeyMap.get(1);
  const alg = coseKeyMap.get(3);
  if (kty === 2) {
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

function derEcdsaSignatureToRaw(der) {
  let pos = 2;
  function readInt() {
    if (der[pos] !== 0x02) throw new Error("Expected INTEGER in DER signature");
    pos++;
    let len = der[pos];
    pos++;
    let bytes = der.slice(pos, pos + len);
    pos += len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
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
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
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
  await env.MEGA_KV.delete(`webauthn-challenge:${body.challengeToken}`);
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
    /* email is optional */
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
    allowCredentials,
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
  await env.MEGA_KV.delete(`webauthn-challenge:${body.challengeToken}`);
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
  if (!(await rateLimit(env, request, "admin-verify", 40, 600))) {
    return err("Too many attempts, please wait a few minutes", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  // Restoring a previously-issued session (e.g. after a page refresh) —
  // the real password is never sent again for this path.
  if (body.token) {
    const ok = await verifyAdminSession(env, body.token);
    return json({ ok });
  }
  // Fresh login — the one moment the real password is ever checked.
  const ok = await verifyAdmin(env, body.password);
  if (!ok) return json({ ok: false });
  const token = await createAdminSession(env);
  return json({ ok: true, token });
}

async function adminLogout(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  await revokeAdminSession(env, body.token);
  return json({ ok: true });
}

/** Change the admin password. Requires a valid session token (proves the
 * caller is already logged in) AND the current password (proves they're not
 * just riding a stolen/leaked session token). Stores the new password as a
 * salted PBKDF2 hash in KV — never as plain text, never as a secret that
 * needs a redeploy to rotate. */
async function changeAdminPassword(env, request) {
  if (!(await rateLimit(env, request, "admin-change-password", 10, 600))) {
    return err("Too many attempts, please wait a few minutes", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { token, currentPassword, newPassword } = body;
  if (!(await verifyAdminSession(env, token))) return err("Session expired, please log in again", 401);
  if (!currentPassword || !newPassword) return err("Missing currentPassword or newPassword");
  if (String(newPassword).length < 8) return err("New password must be at least 8 characters", 400);
  if (!(await verifyAdmin(env, currentPassword))) return err("Current password is incorrect", 401);

  const { hash, salt } = await hashPassword(newPassword);
  await env.MEGA_KV.put("admin_password", JSON.stringify({ hash, salt }));
  return json({ ok: true });
}

// ============================================================================
// Payments — Paymob (card) / Fawry
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
        amount: Math.round(amount * 100),
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
  if (!env.PAYMOB_HMAC_SECRET) return err("Server misconfigured: PAYMOB_HMAC_SECRET not set", 500);
  try {
    const url = new URL(request.url);
    const body = await request.json().catch(() => null);
    const obj = body?.obj || body;
    const hmacFromPaymob = url.searchParams.get("hmac");
    const orderedFields = [
      obj?.amount_cents, obj?.created_at, obj?.currency, obj?.error_occured,
      obj?.has_parent_transaction, obj?.id, obj?.integration_id, obj?.is_3d_secure,
      obj?.is_auth, obj?.is_capture, obj?.is_refunded, obj?.is_standalone_payment,
      obj?.is_voided, obj?.order?.id, obj?.owner, obj?.pending, obj?.source_data?.pan,
      obj?.source_data?.sub_type, obj?.source_data?.type, obj?.success,
    ].map((v) => (v === undefined || v === null ? "" : String(v))).join("");
    const computedHmac = await sha256Hex(orderedFields + env.PAYMOB_HMAC_SECRET);

    if (!hmacFromPaymob || computedHmac !== hmacFromPaymob) {
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
  if (!env.FAWRY_SECURITY_KEY) return err("Server misconfigured: FAWRY_SECURITY_KEY not set", 500);
  try {
    const body = await request.json().catch(() => null);
    if (!body) return err("Invalid payload", 400);
    const { fawryRefNumber, merchantRefNumber, paymentAmount, orderAmount, orderStatus, paymentMethod, messageSignature } = body;
    if (!messageSignature) return err("Missing signature", 401);
    const raw = `${fawryRefNumber ?? ""}${merchantRefNumber ?? ""}${paymentAmount ?? ""}${orderAmount ?? ""}${orderStatus ?? ""}${paymentMethod ?? ""}${env.FAWRY_SECURITY_KEY}`;
    const computed = await sha256Hex(raw);
    if (computed !== messageSignature) return err("Signature verification failed", 401);
    if (orderStatus === "PAID" && merchantRefNumber) {
      await approveOrderByCode(env, merchantRefNumber);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Webhook processing error", detail: String(e) }, 500);
  }
}

// ============================================================================
// AI photo transform  (POST /transform)
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
  if (order.orderType === "prompt") return err("This order is for the prompt text, not an image transform", 403);

  const isPackage = order.orderType === "package";

  if (!isPackage) {
    // Individual order: locked to the one product it was bought for, and
    // good for exactly one generation.
    if (order.productId !== productId) return err("This order code does not match this product", 403);
    if (order.transformUsed) {
      if (order.resultUrl) return json({ imageUrl: order.resultUrl, cached: true });
      return err("This order has already been used to generate an image", 409);
    }
  } else {
    // Package order: not tied to any single product — any productId is
    // valid as long as credits remain. Re-requesting a product already
    // redeemed within this package returns the same cached result instead
    // of spending a second credit on it.
    if (!(order.creditsRemaining > 0)) return err("This package has no remaining credits", 409);
    const already = (order.usedItems || []).find((u) => u.productId === productId);
    if (already) return json({ imageUrl: already.resultUrl, cached: true });
  }

  // Locking per (code, productId) rather than just per code lets two
  // *different* products under the same package be generated back-to-back
  // without a stale lock from one blocking the other, while still stopping
  // a double-submit of the same product.
  const lockKey = `transform-lock:${code}:${productId}`;
  if (await env.MEGA_KV.get(lockKey)) {
    return err("A generation for this order is already in progress", 409);
  }
  await env.MEGA_KV.put(lockKey, "1", { expirationTtl: 90 });

  const productRaw = await env.MEGA_KV.get(`product:${productId}`);
  if (!productRaw) {
    await env.MEGA_KV.delete(lockKey);
    return err("Product not found", 404);
  }
  const product = JSON.parse(productRaw);

  if (!env.FAL_KEY) {
    await env.MEGA_KV.delete(lockKey);
    return err("AI transform is not configured yet (missing FAL_KEY)", 501);
  }

  try {
    const falBody = {
      prompt: product.prompt,
      image_urls: [image],
      resolution: "4K",
      output_format: "png",
    };
    if (product.negativePrompt) falBody.negative_prompt = product.negativePrompt;

    const falRes = await fetch("https://fal.run/fal-ai/nano-banana-2/edit", {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(falBody),
    });

    if (!falRes.ok) {
      const detail = await falRes.text();
      await env.MEGA_KV.delete(lockKey);
      return json({ error: "Image generation request failed", detail }, 502);
    }
    const data = await falRes.json();
    const outputUrl = data?.images?.[0]?.url;
    if (!outputUrl) {
      await env.MEGA_KV.delete(lockKey);
      return json({ error: "No image returned from the generation service", detail: data }, 502);
    }

    let responseExtra = {};
    if (!isPackage) {
      order.transformUsed = true;
      order.resultUrl = outputUrl;
      order.transformedAt = Date.now();
    } else {
      order.usedItems = order.usedItems || [];
      order.usedItems.push({ productId, resultUrl: outputUrl, transformedAt: Date.now() });
      order.creditsRemaining = (typeof order.creditsRemaining === "number" ? order.creditsRemaining : order.packageSize) - 1;
      responseExtra = { creditsRemaining: order.creditsRemaining };
    }
    await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
    await env.MEGA_KV.delete(lockKey);

    return json({ imageUrl: outputUrl, ...responseExtra });
  } catch (e) {
    await env.MEGA_KV.delete(lockKey);
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
      else if (pathname === "/products/popularity" && request.method === "GET") response = await getProductPopularity(env);
      else if (pathname === "/orders/approve" && request.method === "POST") response = await approveOrder(env, request);
      else if (pathname === "/orders/reject" && request.method === "POST") response = await rejectOrder(env, request);
      else if (pathname === "/orders/delete" && request.method === "POST") response = await deleteOrder(env, request);
      else if (pathname === "/orders/mark-thanked" && request.method === "POST") response = await markOrderThanked(env, request);
      else if (pathname === "/reviews/submit" && request.method === "POST") response = await submitReview(env, request);
      else if (pathname === "/reviews/list" && request.method === "GET") response = await listApprovedReviews(env);
      else if (pathname === "/reviews/pending" && request.method === "GET") response = await listPendingReviews(env, request);
      else if (pathname === "/reviews/approve" && request.method === "POST") response = await approveReview(env, request);
      else if (pathname === "/reviews/delete" && request.method === "POST") response = await deleteReview(env, request);
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
      else if (pathname === "/admin/logout" && request.method === "POST") response = await adminLogout(env, request);
      else if (pathname === "/admin/change-password" && request.method === "POST") response = await changeAdminPassword(env, request);
      else if (pathname === "/payment/paymob/create" && request.method === "POST") response = await paymobCreate(env, request);
      else if (pathname === "/payment/paymob/webhook" && request.method === "POST") response = await paymobWebhook(env, request);
      else if (pathname === "/payment/fawry/create" && request.method === "POST") response = await fawryCreate(env, request);
      else if (pathname === "/payment/fawry/webhook" && request.method === "POST") response = await fawryWebhook(env, request);
      else if (pathname === "/transform" && request.method === "POST") response = await transformImage(env, request);
      else if (pathname === "/showcase" && request.method === "GET") response = await getShowcase(env);
      else if (pathname === "/admin/showcase" && request.method === "POST") response = await saveShowcase(env, request);
      else if (pathname === "/site-config" && request.method === "GET") response = await getSiteConfig(env);
      else if (pathname === "/admin/set-design" && request.method === "POST") response = await setSiteDesign(env, request);
      else if (pathname === "/admin/set-hero-mode" && request.method === "POST") response = await setHeroMode(env, request);
      else if (pathname === "/promo-images" && request.method === "GET") response = await getPromoImages(env);
      else if (pathname === "/admin/promo-images" && request.method === "POST") response = await savePromoImages(env, request);
      else response = err("Not found", 404);

      const merged = new Headers(response.headers);
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (e) {
      return json({ error: "Internal error" }, 500, headers);
    }
  },
};
