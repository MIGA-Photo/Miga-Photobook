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
 *   POST     /visits/log (public)  GET  /visits/stats (admin only)  GET /visits/public-count (public)
 *   POST     /auth/register        POST /auth/login       GET /auth/me
 *   POST     /auth/social/google   POST /auth/social/apple   POST /auth/social/facebook
 *   POST     /auth/webauthn/register-options   POST /auth/webauthn/register-verify
 *   POST     /auth/webauthn/login-options      POST /auth/webauthn/login-verify
 *   POST     /admin/verify
 *   POST     /admin/upload-image   GET  /images/:key
 *   GET      /showcase              POST /admin/showcase (admin only)
 *   POST     /payment/paymob/create   POST /payment/paymob/webhook   (real, already working)
 *   POST     /payment/fawry/create    POST /payment/fawry/webhook    (real, already working)
 *   POST     /payment/fawaterk/create POST /payment/fawaterk/webhook (real, needs one live test)
 *   POST     /transform                                              (real, via fal.ai — model admin-selectable, see MODEL_REGISTRY)
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

/** Public, no-auth: the storefront's own visible visitor-count badge calls
 * this directly (see loadVisitorCount() in app.js). This route never
 * existed on this Worker before — the frontend has been calling
 * /visits/public-count since it was written, but nothing here ever
 * answered it, so every call 404'd and the badge silently stayed hidden
 * (its own fetch is wrapped in try/catch, so this never broke the page —
 * it just meant the badge could never appear, no matter what the
 * frontend's init-ordering logic did). Deliberately returns ONLY the
 * total count — no path, country, name, or email — since this is public
 * and reachable by anyone, unlike /visits/stats above which is
 * admin-password-gated and returns the full detail rows.
 */
const TRANSFORM_COUNT_KEY = "stats:transformCount";

/** عدد الصور المحوّلة. أول مرة تتنادى بعد نشر الكود ده، العدّاد مش
 *  هيكون موجود — فبنحسبه مرة واحدة من سجل الطلبات القديم ونخزّنه،
 *  عشان الأرقام اللي اتعملت قبل إضافة العدّاد ما تضيعش. بعد كده
 *  بيزيد بواحد مع كل تحويل ناجح، فالقراءة بتفضل قراءة واحدة. */
async function getTransformCount(env) {
  const raw = await env.MEGA_KV.get(TRANSFORM_COUNT_KEY);
  if (raw !== null && raw !== undefined) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  let count = 0;
  try {
    const idxRaw = await env.MEGA_KV.get("orders:index");
    const codes = idxRaw ? JSON.parse(idxRaw) : [];
    for (const code of (Array.isArray(codes) ? codes : [])) {
      const oRaw = await env.MEGA_KV.get(`order:${code}`);
      if (!oRaw) continue;
      const o = JSON.parse(oRaw);
      if (o.transformUsed) count++;
      if (Array.isArray(o.usedItems)) count += o.usedItems.length;
    }
  } catch (e) { /* لو الحساب فشل، نخزّن صفر بدل ما نعيد المحاولة كل مرة */ }
  await env.MEGA_KV.put(TRANSFORM_COUNT_KEY, String(count));
  return count;
}

/** إحصاءات عامة للبادج على الصفحة الرئيسية — بدون مصادقة.
 *  كل جزء في try/catch بمفرده: فشل أي مصدر بيرجّع صفر بدل ما يوقّع
 *  الباقي، والواجهة بتخفي البادج اللي رقمه صفر. */
async function getPublicVisitCount(env) {
  let total = 0, transforms = 0, reviewCount = 0, reviewAvg = 0;
  try {
    const totalRow = await env.MEGA_DB.prepare(`SELECT COUNT(*) as c FROM visits`).first();
    total = totalRow?.c || 0;
  } catch (e) { /* جدول الزيارات مش جاهز — البادج يفضل مخفي */ }
  try {
    transforms = await getTransformCount(env);
  } catch (e) { /* تجاهل */ }
  try {
    const raw = await env.MEGA_KV.get("reviews:approved");
    const reviews = raw ? JSON.parse(raw) : [];
    const rated = reviews.filter((r) => typeof r.rating === "number" && r.rating > 0);
    reviewCount = rated.length;
    if (reviewCount) {
      reviewAvg = Math.round((rated.reduce((a, r) => a + r.rating, 0) / reviewCount) * 10) / 10;
    }
  } catch (e) { /* تجاهل */ }
  return json({ total, transforms, reviewCount, reviewAvg });
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

/** True HMAC-SHA256 (not the same thing as sha256Hex(data+secret) used by
 * Paymob/Fawry above) — Fawaterk's own docs specify the real HMAC
 * construction for webhook signature verification, so this can't reuse
 * sha256Hex without silently producing the wrong signature. */
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Payment integrity (added 2026-09-15)
// =========================================================================
// One rule, everywhere an order gets approved: CLIENT NEVER DECIDES THE
// PRICE OR WHETHER PAYMENT IS VERIFIED. `order.requiredAmount` (same value
// as `order.price`, which was already server-computed at createOrder() —
// see finalPrice there) is the only number this file ever compares a
// payment against. A manual InstaPay/Vodafone Cash "payment" is only ever
// verified by an authenticated admin typing in the amount they personally
// confirmed arrived (see approveOrder()); a gateway payment (Paymob/Fawry/
// Fawaterk) is only ever verified from the amount inside a signature-checked
// webhook payload (see paymobWebhook/fawryWebhook/fawaterkWebhook below) —
// never from anything the browser sends. Both paths funnel through this one
// function so there is exactly one place that decides "was this paid".
const PAYMENT_AMOUNT_EPSILON = 0.01; // float-rounding tolerance, in EGP

function isPaymentSufficient(requiredAmount, verifiedAmount) {
  return (
    Number.isFinite(requiredAmount) &&
    Number.isFinite(verifiedAmount) &&
    verifiedAmount >= requiredAmount - PAYMENT_AMOUNT_EPSILON
  );
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Cumulative-payment ledger (added 2026-09-15: Underpaid → Remaining
 * Payment → Full Verification). `order.payments` is an append-only array of
 * {id, provider, providerTransactionId, amount, method, reference,
 * verifiedAt, verifiedBy} entries — every successfully-verified payment
 * against this order, never overwritten or removed. `id` is the idempotency
 * key (`${provider}:${providerTransactionId}` for a gateway webhook, or
 * `manual:${paymentId}` for an admin-verified manual transfer) that makes a
 * re-delivered webhook or a double-submitted admin approval a safe no-op
 * instead of double-counting — see recordPaymentVerification() below.
 *
 * Works for orders created before this ledger existed too: if `order.payments`
 * doesn't exist yet, this synthesizes ONE entry from the order's old
 * single-shot verification fields (verifiedPaidAmount/paymentProvider/
 * providerTransactionId/...) the first time the order is touched again, so a
 * legacy order's already-verified total is never silently lost. An old order
 * that is NEVER touched again keeps working exactly as it did before this
 * change, because /transform's payment gate (see transformImage()) reads
 * order.paymentStatus/order.verifiedPaidAmount directly and this migration
 * only ever runs inside recordPaymentVerification(), not on every read. */
function ensurePaymentLedger(order) {
  if (Array.isArray(order.payments)) return;
  order.payments = [];
  const legacyAmount = Number(order.verifiedPaidAmount);
  if (Number.isFinite(legacyAmount) && legacyAmount > 0) {
    order.payments.push({
      id:
        order.providerTransactionId && order.paymentProvider
          ? `${order.paymentProvider}:${order.providerTransactionId}`
          : `legacy:${order.code || "unknown"}`,
      provider: order.paymentProvider || "legacy",
      providerTransactionId: order.providerTransactionId || null,
      amount: legacyAmount,
      method: order.paymentMethod || null,
      reference: order.paymentReference || null,
      verifiedAt: order.paymentVerifiedAt || Date.now(),
      verifiedBy: order.paymentVerifiedBy || null,
    });
  }
}

/** Server-computed totals only — never trusts anything from the browser.
 * Works whether or not `order.payments` has been migrated yet (falls back to
 * the legacy single-shot `verifiedPaidAmount` for a read-only summary, e.g.
 * orderToPublicResponse(), without mutating/persisting anything). */
function computePaymentTotals(order) {
  const requiredAmount = Number(order.requiredAmount ?? order.price) || 0;
  const totalVerifiedPaid = round2(
    Array.isArray(order.payments)
      ? order.payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
      : Number(order.verifiedPaidAmount) || 0
  );
  const remainingAmount = Math.max(0, round2(requiredAmount - totalVerifiedPaid));
  const overpaidAmount = Math.max(0, round2(totalVerifiedPaid - requiredAmount));
  return { requiredAmount, totalVerifiedPaid, remainingAmount, overpaidAmount };
}

/** Mutates `order` in place to record ONE verified payment (a single
 * webhook delivery, or one admin-confirmed manual transfer) and returns
 * {ok, reason, ...totals}. Never called with client-supplied trust — every
 * caller must derive `verifiedAmount` itself (admin manual entry, or a
 * provider webhook amount, already signature-verified by the time it gets
 * here) and must supply an idempotency key: `provider`+`providerTransactionId`
 * for a gateway webhook, or `paymentId` for a manual admin approval.
 *
 * Supports MULTIPLE payments per order (added 2026-09-15: Underpaid →
 * Remaining Payment): each call appends to order.payments if its id hasn't
 * been seen before, then recomputes totalVerifiedPaid/remainingAmount fresh
 * from the whole ledger. `order.status` only ever becomes "approved" once
 * the cumulative total reaches requiredAmount — a partial second payment
 * (e.g. 200 + 50 against 259) stays paymentStatus:"underpaid".
 *
 * Idempotent per-transaction: the SAME (provider, providerTransactionId) or
 * the SAME paymentId delivered twice is recognized and reported ok WITHOUT
 * being counted a second time (see TEST 14/22/23 in the Sept-15
 * payment-integrity request, extended for the ledger in this round). This
 * intentionally no longer short-circuits on "already fully verified" the
 * way the single-shot version did — that old shortcut would have silently
 * dropped a genuine NEW payment (e.g. an overpayment) arriving after an
 * order was already approved; every distinct transaction is now recorded. */
function recordPaymentVerification(order, { verifiedAmount, method, provider, providerTransactionId, reference, verifiedBy, paymentId }) {
  ensurePaymentLedger(order);
  const requiredAmount = Number(order.requiredAmount ?? order.price) || 0;

  // Free / soft-launch orders (requiredAmount === 0) have nothing to verify —
  // see claimFreeOrder(), the only place a real order can ever have price 0.
  if (requiredAmount === 0) {
    order.paymentStatus = "verified";
    order.verifiedPaidAmount = 0;
    order.totalVerifiedPaid = 0;
    order.remainingAmount = 0;
    order.overpaidAmount = 0;
    order.paymentVerifiedAt = order.paymentVerifiedAt || Date.now();
    order.status = "approved";
    return { ok: true, requiredAmount, totalVerifiedPaid: 0, remainingAmount: 0, overpaidAmount: 0 };
  }

  const amount = Number(verifiedAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "invalid-amount", ...computePaymentTotals(order) };
  }

  const idempotencyId =
    providerTransactionId && provider ? `${provider}:${providerTransactionId}` : paymentId ? `manual:${paymentId}` : null;
  if (!idempotencyId) {
    // Every payment MUST be uniquely identified, or a retried request could
    // double-count it — refuse rather than guess one.
    return { ok: false, reason: "missing-idempotency-key", ...computePaymentTotals(order) };
  }

  const alreadyRecorded = order.payments.find((p) => p.id === idempotencyId);
  if (alreadyRecorded) {
    // Exact same transaction delivered again (duplicate webhook, or the same
    // admin approval retried) — report ok without double-counting anything.
    return { ok: true, duplicate: true, ...computePaymentTotals(order) };
  }

  order.payments.push({
    id: idempotencyId,
    provider: provider || "manual",
    providerTransactionId: providerTransactionId || null,
    amount,
    method: method || null,
    reference: reference || null,
    verifiedAt: Date.now(),
    verifiedBy: verifiedBy || null,
  });

  if (method) order.paymentMethod = method;
  if (provider) order.paymentProvider = provider;
  if (reference) order.paymentReference = reference;
  if (providerTransactionId) order.providerTransactionId = providerTransactionId;

  const totals = computePaymentTotals(order);
  order.totalVerifiedPaid = totals.totalVerifiedPaid;
  order.remainingAmount = totals.remainingAmount;
  order.overpaidAmount = totals.overpaidAmount;
  // verifiedPaidAmount stays a live alias of totalVerifiedPaid so the
  // UNCHANGED /transform payment gate (transformImage(), which reads
  // verifiedPaidAmount directly and is not touched by this change) keeps
  // working correctly under the new cumulative model.
  order.verifiedPaidAmount = totals.totalVerifiedPaid;

  if (totals.remainingAmount <= PAYMENT_AMOUNT_EPSILON) {
    order.paymentStatus = "verified";
    order.paymentVerifiedAt = Date.now();
    order.paymentVerifiedBy = verifiedBy || order.paymentVerifiedBy || null;
    order.status = "approved";
  } else {
    order.paymentStatus = "underpaid";
    // status is intentionally left NOT "approved" here.
  }

  return { ok: true, ...totals };
}

/** Provider-webhook approval path (Paymob/Fawry/Fawaterk). `verification` MUST
 * carry the amount as reported inside that provider's own signature-verified
 * webhook payload — never anything from the browser. Also enforces that one
 * provider transaction can only ever verify one order (see section 12/TEST 15
 * of the Sept-15 payment-integrity request): a transaction id already spent
 * on a different order is refused rather than silently re-approving. */
async function approveOrderByCode(env, code, verification) {
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return false;
  const order = JSON.parse(raw);

  if (verification?.providerTransactionId && verification?.provider) {
    const txnKey = `providertxn:${verification.provider}:${verification.providerTransactionId}`;
    const existingOwner = await env.MEGA_KV.get(txnKey);
    if (existingOwner && existingOwner !== code) {
      // This exact provider transaction already paid for a DIFFERENT order —
      // never let it verify a second one.
      return false;
    }
    if (!existingOwner) await env.MEGA_KV.put(txnKey, code);
  }

  const result = recordPaymentVerification(order, verification || {});

  if (result.ok && order.orderType === "prompt" && !order.promptText) {
    const productRaw = await env.MEGA_KV.get(`product:${order.productId}`);
    if (productRaw) {
      const product = JSON.parse(productRaw);
      order.promptText = product.prompt || null;
    }
  }

  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  return result.ok;
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

// ============================================================================
// Per-product share links  (GET /share?product=<id>)
// ----------------------------------------------------------------------------
// Product links use a "#product=<id>" hash so the SPA can open the right
// modal client-side — but a hash is never sent to the server, so Facebook/
// WhatsApp/Instagram crawlers (which don't run JS) always see the site's
// generic og-image.png instead of the actual product photo.
//
// This route gives crawlers something real to read: it looks the product up,
// returns a tiny standalone HTML page with OG/Twitter tags for THAT product's
// title + photo, and immediately forwards real visitors (via meta-refresh and
// a JS redirect, so it works with or without JS) to the normal
// "https://miga-photobook.com/#product=<id>" SPA link. It only ever answers
// GET /share — every other path on the domain is untouched, so this cannot
// affect the live storefront even if something here is wrong.
// ============================================================================

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// WhatsApp's link-preview fetcher is far stricter than Facebook's about image
// size — in practice it silently drops the preview image (falling back to a
// plain text-only card, exactly like the generic "og-image.png" case this
// endpoint was built to avoid) once the image is much past ~300KB. Product
// photos here come straight from the admin's original upload (up to 5MB,
// no compression — see uploadImage above), which is fine for Facebook but
// routinely too big for WhatsApp. This routes the OG/Twitter image through
// wsrv.nl (formerly images.weserv.nl — a free, widely-used public image
// resizing proxy) to guarantee a small, correctly-sized JPEG regardless of
// the source file's size, while leaving the original stored image untouched for every other
// use (product cards, the transform flow, etc.). Explicit width/height are
// declared to match exactly, since WhatsApp is also known to rely on those
// tags rather than reliably measuring the image itself.
const SHARE_IMAGE_WIDTH = 1200;
const SHARE_IMAGE_HEIGHT = 630;
function buildShareImageUrl(sourceUrl) {
  const params = new URLSearchParams({
    url: sourceUrl,
    w: String(SHARE_IMAGE_WIDTH),
    h: String(SHARE_IMAGE_HEIGHT),
    fit: "cover",
    a: "attention",
    output: "jpg",
    q: "80",
  });
  return `https://wsrv.nl/?${params.toString()}`;
}

async function renderShareCard(env, request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("product");
  const siteUrl = "https://miga-photobook.com/";
  if (!id) return Response.redirect(siteUrl, 302);

  const target = `${siteUrl}#product=${encodeURIComponent(id)}`;
  // The canonical URL declared to crawlers (og:url) — deliberately this /share
  // link itself, NOT the "#product=" target. Facebook keys its scrape cache off
  // og:url: if it pointed at the hash link, any earlier scrape of that same
  // plain link (from before this endpoint existed, back when it only showed the
  // generic site image) would keep being served forever, since Facebook would
  // treat "og:url" as the identity of this share and reuse the old cached
  // preview instead of the fresh one below. Every product gets its own
  // never-before-seen /share URL, so there is nothing stale to collide with.
  const canonical = `${siteUrl}share?product=${encodeURIComponent(id)}`;
  const raw = await env.MEGA_KV.get(`product:${id}`);
  if (!raw) return Response.redirect(target, 302);

  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return Response.redirect(target, 302);
  }

  const title = escapeHtml(p.title || "Miga-Photobook");
  const description = "حوّل صورتك العادية لتحفة فنية بالذكاء الاصطناعي — miga-photobook.com";
  const originalImage = p.image || `${siteUrl}og-image.png`;
  const image = escapeHtml(buildShareImageUrl(originalImage));
  const safeTarget = escapeHtml(target);
  const safeCanonical = escapeHtml(canonical);

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Miga-Photobook</title>
<meta property="og:site_name" content="Miga-Photobook">
<meta property="og:type" content="website">
<meta property="og:url" content="${safeCanonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="${SHARE_IMAGE_WIDTH}">
<meta property="og:image:height" content="${SHARE_IMAGE_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${image}">
<!-- No <meta http-equiv="refresh">: Facebook/WhatsApp/Instagram's crawler follows
     that kind of redirect immediately and reads whatever is at the OTHER end
     instead of the tags above — which is exactly why every earlier version of
     this page kept showing the generic site preview no matter what was set here.
     The JS redirect below only runs in a real browser (crawlers don't execute
     JS), so people still land on the product instantly, while crawlers stop
     here and read this page's own tags. -->
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
<p>جارٍ التحويل لصفحة المنتج… <a href="${safeTarget}">اضغط هنا لو الصفحة معملتش تحويل تلقائي</a></p>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
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
    outputResolution: await getOutputResolution(env),
    aiModel: await getAiModel(env),
    availableModels: Object.values(MODEL_REGISTRY),
    colorTheme: await getColorTheme(env),
    headerMode: await getHeaderMode(env),
    promptLibraryMode: await getPromptLibraryMode(env),
  });
}

// ============================================================================
// AI output resolution  (included in GET /site-config, set via
// POST /admin/set-resolution)
// The admin panel's resolution dropdown and its "حفظ الدقة" button already
// existed in app.js, but the matching backend was never actually built here —
// every generation silently stayed hardcoded to "4K" no matter what the admin
// picked, quietly costing ~13 EGP/image instead of ~4 EGP/image at "2K".
// This wires the setting all the way through: saved here, read by
// getSiteConfig for the admin dropdown, and read again at the actual fal.ai
// call site below so a saved choice really changes what gets billed.
// ============================================================================

const OUTPUT_RESOLUTIONS = ["2K", "4K"];

async function getOutputResolution(env) {
  const raw = await env.MEGA_KV.get("config:outputResolution");
  return OUTPUT_RESOLUTIONS.includes(raw) ? raw : "2K"; // cheaper option is the safe default
}

async function setOutputResolution(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!OUTPUT_RESOLUTIONS.includes(body.resolution)) {
    return err(`Unknown resolution. Available: ${OUTPUT_RESOLUTIONS.join(", ")}`, 400);
  }

  await env.MEGA_KV.put("config:outputResolution", body.resolution);
  return json({ ok: true, outputResolution: body.resolution });
}

// ============================================================================
// AI model selection  (included in GET /site-config, set via
// POST /admin/set-ai-model)
// Magdy asked whether he could pick which fal.ai model does the actual
// generation instead of it being permanently hardcoded to nano-banana-2.
// Every model below was checked against fal.ai's own published API schema
// before being added — the INPUT shape differs a lot between providers
// (resolution vs image_size, "2K" vs "auto_2K" vs "1k", negative_prompt
// supported or not), and getting one wrong silently 502s every generation a
// paying customer tries to make. buildFalRequest() below shapes the request
// per model's paramStyle. Adding a future model is: one entry here (plus a
// new paramStyle branch in buildFalRequest only if its shape is genuinely
// new) — no other code changes, same pattern as OUTPUT_RESOLUTIONS above.
// ============================================================================

const MODEL_REGISTRY = {
  "nano-banana-2": {
    id: "nano-banana-2",
    slug: "fal-ai/nano-banana-2/edit",
    nameAr: "Nano Banana 2 (الحالي)",
    nameEn: "Nano Banana 2 (current)",
    paramStyle: "nanoBanana",
  },
  "nano-banana-pro": {
    id: "nano-banana-pro",
    slug: "fal-ai/nano-banana-pro/edit",
    nameAr: "Nano Banana Pro (أعلى جودة)",
    nameEn: "Nano Banana Pro (higher quality)",
    paramStyle: "nanoBananaPro", // same family as nano-banana-2 but pricier ($0.15/$0.30) — Google's own higher tier
  },
  "flux-2-pro": {
    id: "flux-2-pro",
    slug: "fal-ai/flux-2-pro/edit",
    nameAr: "Flux 2 Pro",
    nameEn: "Flux 2 Pro",
    paramStyle: "fluxAuto", // no 2K/4K tiers on this endpoint — the admin's resolution choice is ignored for this model specifically
  },
  "seedream-4.5": {
    id: "seedream-4.5",
    slug: "fal-ai/bytedance/seedream/v4.5/edit",
    nameAr: "Seedream 4.5",
    nameEn: "Seedream 4.5",
    paramStyle: "seedreamAuto",
  },
  "seedream-5-lite": {
    id: "seedream-5-lite",
    slug: "fal-ai/bytedance/seedream/v5/lite/edit",
    nameAr: "Seedream 5 Lite",
    nameEn: "Seedream 5 Lite",
    paramStyle: "seedreamAuto",
  },
  "grok-imagine": {
    id: "grok-imagine",
    slug: "xai/grok-imagine-image/edit",
    nameAr: "Grok Imagine",
    nameEn: "Grok Imagine",
    paramStyle: "grok", // tops out at "2k" — there is no 4K tier for this model
  },
  "gpt-image-2": {
    id: "gpt-image-2",
    slug: "openai/gpt-image-2/edit",
    nameAr: "GPT Image 2 (OpenAI)",
    nameEn: "GPT Image 2 (OpenAI)",
    paramStyle: "gptImage2", // no 2K/4K tiers — the admin's resolution choice maps to a quality level instead
  },
};

async function getAiModel(env) {
  const raw = await env.MEGA_KV.get("config:aiModel");
  return MODEL_REGISTRY[raw] ? raw : "nano-banana-2"; // unknown/removed id falls back to the known-good default
}

async function setAiModel(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!MODEL_REGISTRY[body.model]) {
    return err(`Unknown model. Available: ${Object.keys(MODEL_REGISTRY).join(", ")}`, 400);
  }

  await env.MEGA_KV.put("config:aiModel", body.model);
  return json({ ok: true, aiModel: body.model });
}

/** Shapes the fal.ai request body for one model's paramStyle. Every model
 * here returns its output the same way (images[0].url — checked for each
 * one), but the INPUT fields differ enough between providers that a single
 * shared body would silently break most of them. See MODEL_REGISTRY comment
 * above for why each style exists. */
function buildFalRequest(modelCfg, { prompt, negativePrompt, imageDataUri, resolution }) {
  const falBody = { prompt, image_urls: [imageDataUri] };
  switch (modelCfg.paramStyle) {
    case "fluxAuto":
      falBody.image_size = "auto"; // preserves the input photo's own aspect ratio/size
      falBody.output_format = "png";
      break;
    case "seedreamAuto":
      falBody.image_size = resolution === "4K" ? "auto_4K" : "auto_2K";
      break;
    case "grok":
      falBody.resolution = resolution === "4K" ? "2k" : "1k";
      falBody.output_format = "png";
      break;
    case "nanoBananaPro":
      falBody.resolution = resolution; // "2K"/"4K" pass straight through — this endpoint's own enum matches ours exactly
      falBody.output_format = "png";
      break;
    case "gptImage2":
      falBody.image_size = "auto"; // preserves the input photo's own aspect ratio/size
      falBody.quality = resolution === "4K" ? "high" : "medium"; // no K-tiers on this endpoint — maps to its quality enum instead
      falBody.output_format = "png";
      break;
    case "nanoBanana":
    default:
      falBody.resolution = resolution;
      falBody.output_format = "png";
      if (negativePrompt) falBody.negative_prompt = negativePrompt;
      break;
  }
  return falBody;
}

// ============================================================================
// Header color theme + header layout  (included in GET /site-config, set via
// POST /admin/set-color-theme and POST /admin/set-header-mode)
// Same story as outputResolution above: the admin panel's controls and save
// buttons already existed in app.js, but nothing on this end ever stored the
// choice — every save silently 404'd. This wires storage + retrieval only.
// NOTE: saving now succeeds and the value round-trips through /site-config,
// but nothing on the customer-facing frontend (index.html/styles.css/app.js)
// reads colorTheme/headerMode yet to actually change what customers see —
// that's a separate, larger frontend task, not covered by this fix.
// ============================================================================

const COLOR_THEMES = ["black", "brown", "emerald", "wine", "navy", "red"];
const HEADER_MODES = ["classic", "compact"];

async function getColorTheme(env) {
  const raw = await env.MEGA_KV.get("config:colorTheme");
  return COLOR_THEMES.includes(raw) ? raw : "black";
}

async function getHeaderMode(env) {
  const raw = await env.MEGA_KV.get("config:headerMode");
  return HEADER_MODES.includes(raw) ? raw : "classic";
}

async function setColorTheme(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!COLOR_THEMES.includes(body.theme)) {
    return err(`Unknown color theme. Available: ${COLOR_THEMES.join(", ")}`, 400);
  }

  await env.MEGA_KV.put("config:colorTheme", body.theme);
  return json({ ok: true, colorTheme: body.theme });
}

async function setHeaderMode(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (!HEADER_MODES.includes(body.mode)) {
    return err(`Unknown header mode. Available: ${HEADER_MODES.join(", ")}`, 400);
  }

  await env.MEGA_KV.put("config:headerMode", body.mode);
  return json({ ok: true, headerMode: body.mode });
}

// ============================================================================
// Prompt Library for Professionals mode  (included in GET /site-config, set
// via POST /admin/set-prompt-library-mode)
// Off by default (current behaviour: 'luxury' is an ordinary, currently-empty
// category). When turned on, the frontend repurposes that same 'luxury' slot
// into a derived view aggregating every OTHER category's real products as
// prompt-only cards, grouped by their real category — nothing here
// duplicates, moves, or deletes any product data; this flag only tells the
// frontend which way to render what's already there. Fully reversible from
// the admin panel with zero data loss either direction.
// ============================================================================

async function getPromptLibraryMode(env) {
  const raw = await env.MEGA_KV.get("config:promptLibraryMode");
  return raw === "true";
}

/* ---------- ترجمة آلية لاسم المنتج (عربي → إنجليزي) ----------
 * ليه في الووركر مش في المتصفح؟ عشان Workers AI بيتنادى بـ binding
 * (env.AI) من غير أي مفتاح API — فمفيش سر بيتحط في كود الصفحة، ومفيش
 * خدمة خارجية ولا CORS.
 *
 * بتتنادى **مرة واحدة وقت إضافة المنتج** من لوحة الإدارة، والنتيجة
 * بتتحفظ في titleEn في قاعدة البيانات. الزوار عمرهم ما بيشغّلوا الموديل
 * — فمفيش تكلفة ولا بطء على الصفحة العامة.
 *
 * محمية بتوكن الأدمن عن قصد: من غير كده الـendpoint ده بيبقى خدمة ترجمة
 * مجانية مفتوحة للعالم على حساب الـneurons بتاعك.
 *
 * لو الـAI binding مش مضاف من لوحة Cloudflare، بترجّع 503 برسالة واضحة
 * بدل ما ترمي 500 غامض — والواجهة بتفضل شغالة بالقاموس المحلي عادي. */
const BRAND_FIXUPS = [
  [/\bMega\b/g, 'Miga'],
  [/\bMiga\s*Photo\s*Book\b/gi, 'Miga-Photobook'],
];

async function translateTitle(env, request) {
  const url = new URL(request.url);
  let body = {};
  try { body = await request.json(); } catch { /* الجسم اختياري */ }

  const token =
    body.token ||
    url.searchParams.get("token") ||
    request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  const text = String(body.text || "").trim();
  if (!text) return err("text is required", 400);
  if (text.length > 200) return err("text too long", 400);

  if (!env.AI || typeof env.AI.run !== "function") {
    return json(
      { ok: false, reason: "ai_binding_missing",
        message: "Workers AI binding (AI) is not configured for this Worker." },
      503
    );
  }

  try {
    const res = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text,
      source_lang: "arabic",
      target_lang: "english",
    });
    let out = String((res && (res.translated_text || res.result || res.response)) || "").trim();
    if (!out) return json({ ok: false, reason: "empty_result" }, 502);

    // الموديل بيترجم "ميجا" لـ"Mega" — واسم البراند مش بيتترجم.
    for (const [re, to] of BRAND_FIXUPS) out = out.replace(re, to);
    out = out.replace(/\s+/g, " ").trim();

    return json({ ok: true, text: out, model: "@cf/meta/m2m100-1.2b" });
  } catch (e) {
    return json({ ok: false, reason: "ai_error", message: String(e && e.message || e) }, 502);
  }
}

async function setPromptLibraryMode(env, request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  if (!(await verifyAdminSession(env, token))) return err("Wrong password", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  if (typeof body.enabled !== "boolean") {
    return err("enabled must be true or false", 400);
  }

  await env.MEGA_KV.put("config:promptLibraryMode", body.enabled ? "true" : "false");
  return json({ ok: true, promptLibraryMode: body.enabled });
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

// Fixed price for buying a product's text prompt (not the transformed photo
// itself) — the same amount regardless of which product it belongs to. Must
// be kept in sync by hand with PROMPT_PRICE in app.js: the frontend has no
// way to read this backend value, and this backend has no way to read that
// frontend one, so a future price change needs both edited together.
const PROMPT_PRICE = 10;

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
  const isPromptOrder = !isPackageOrder && orderType === "prompt";
  let normalizedPackageSize = null;
  // Overwritten below for EVERY order type — the client-submitted price is
  // never trusted as-is, only used as this initial placeholder.
  let finalPrice = Number(price) || 0;
  if (isPackageOrder) {
    normalizedPackageSize = Number(packageSize);
    if (!PACKAGE_PRICES[normalizedPackageSize]) return err("Invalid package size", 400);
    finalPrice = PACKAGE_PRICES[normalizedPackageSize]; // ignore whatever price the client sent
  } else if (isPromptOrder) {
    // Prompt purchases are a single fixed price regardless of product.
    finalPrice = PROMPT_PRICE; // ignore whatever price the client sent
  } else {
    // Individual "transform" orders (fixed 2026-09-14, final completion
    // pass): this used to just trust Number(price) straight from the
    // request body with ZERO server-side check against a real catalog
    // price — a client could submit any productId together with any price
    // and the stored order would say that's what it cost. In practice this
    // was never exploitable for a free result, because every payment here
    // is a manual bank transfer that Magdy personally reviews against the
    // real transferred amount before releasing anything — but the order
    // record itself could still lie about the true price. Fixed the same
    // way PACKAGE_PRICES already works: look the product up server-side and
    // ignore whatever price the client claims.
    const productRaw = await env.MEGA_KV.get(`product:${productId}`);
    if (!productRaw) return err("Product not found", 404);
    const catalogPrice = Number(JSON.parse(productRaw).price);
    if (!Number.isFinite(catalogPrice) || catalogPrice <= 0) {
      return err("This product is not currently available for purchase", 409);
    }
    finalPrice = catalogPrice; // ignore whatever price the client sent
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

  // Cross-device account sync (added 2026-09-14): if the buyer is logged in,
  // link this order to their real account so it shows up on every device —
  // WITHOUT changing anything about guest checkout. Identity comes ONLY from
  // the server-verified session token, exactly like authMe() — never from
  // any field the client could put in the request body. A guest (no token,
  // or an expired/invalid one) still checks out exactly as before: authedUserId
  // just stays null and the order is stored the same way it always was.
  let authedUserId = null;
  try {
    const authHeader = request.headers.get("Authorization") || "";
    const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (sessionToken) {
      const sessionUser = await getUserBySession(env, sessionToken);
      if (sessionUser) authedUserId = sessionUser.id;
    }
  } catch (e) {
    authedUserId = null; // never let account-linking break checkout
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
    userId: authedUserId, // null for guest checkout — unchanged behavior
    status: "pending",
    createdAt: Date.now(),
    transformUsed: false,
    resultUrl: null,
    promptText: null,
    // Package-only fields — left undefined for 'transform'/'prompt' orders.
    packageSize: isPackageOrder ? normalizedPackageSize : undefined,
    creditsRemaining: isPackageOrder ? normalizedPackageSize : undefined,
    usedItems: isPackageOrder ? [] : undefined,

    // --- Payment integrity fields (added 2026-09-15) -------------------------
    // `price` above is already the server-computed, non-negotiable amount —
    // it always has been (see finalPrice above, which never trusts the
    // client). `requiredAmount` is just a same-value, explicitly-named alias
    // going forward, so new code never has to wonder whether `price` is
    // trusted (it is) — see recordPaymentVerification() for how this is used.
    requiredAmount: finalPrice,
    // Nothing has been verified yet for a real (non-free) order — see
    // claimFreeOrder() for the free/soft-launch path, which sets these
    // straight to their "verified" values since there is nothing to check.
    paymentStatus: "pending", // pending | underpaid | verified | rejected | failed
    verifiedPaidAmount: null,
    paymentMethod: null,
    paymentProvider: null, // 'manual' (InstaPay/Vodafone Cash) | 'paymob' | 'fawry' | 'fawaterk'
    paymentReference: null,
    providerTransactionId: null,
    paymentVerifiedAt: null,
    paymentVerifiedBy: null,
    // --- Cumulative payment ledger (added 2026-09-15: Underpaid → Remaining
    // Payment → Full Verification) — see recordPaymentVerification(). A
    // brand-new order always starts with an explicit empty ledger, so it
    // never needs the legacy migration in ensurePaymentLedger() at all —
    // that path exists only for orders created before this change.
    payments: [],
    totalVerifiedPaid: 0,
    remainingAmount: finalPrice,
    overpaidAmount: 0,
    // Pending manual-transfer references submitted against THIS order that
    // an admin hasn't verified yet — the original checkout `ref` above is
    // the first one; POST /orders/submit-remaining-payment appends more here
    // when the customer pays the rest without creating a new order. Purely
    // informational (what the customer CLAIMS they paid) — never a source of
    // truth on its own; only an admin's verifiedAmount (approveOrder) or a
    // signature-verified gateway webhook ever moves money into `payments`.
    pendingReferences: [],
  };
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));
  await env.MEGA_KV.put(refKey, code);

  const indexRaw = await env.MEGA_KV.get("orders:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(code);
  await env.MEGA_KV.put("orders:index", JSON.stringify(index));

  // Best-effort index write for "list my orders" (D1 can query by user_id;
  // the KV blob above can't). If this fails for any reason, the order itself
  // is already safely saved above — it just won't show in cross-device sync
  // until the customer's next order, same as any other best-effort sync step
  // already in this codebase (see addFavoriteOnServer client-side).
  if (authedUserId) {
    try {
      await env.MEGA_DB.prepare(
        "INSERT OR IGNORE INTO user_orders (user_id, order_code, created_at) VALUES (?, ?, ?)"
      )
        .bind(authedUserId, code, order.createdAt)
        .run();
    } catch (e) {
      /* order already placed successfully; index write is best-effort */
    }
  }

  await notifyOwnerOfOrder(env, order);

  return json({ code });
}

async function trackOrder(env, request) {
  // Added 2026-09-14: every other endpoint in this file rate-limits itself;
  // this one didn't. Order codes are 8 chars from a 32-char alphabet (see
  // randomCode()) — a 32^8 (~1.1 trillion) keyspace, so this isn't a
  // realistic brute-force target — but a successful guess does return
  // another customer's package credit balance, usage history, and (for
  // approved prompt orders) the paid prompt text, and an unlimited GET here
  // is free abuse/scraping surface either way. 900/hour per IP comfortably
  // covers the real worst case (a customer leaving the pending-order panel
  // open polls every 6s = up to ~600/hour from one IP) plus normal
  // "My Orders" history bursts, while still bounding automated abuse.
  if (!(await rateLimit(env, request, "orders-track", 900, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!code) return err("Missing code");
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found", 404);
  const order = JSON.parse(raw);
  return json(orderToPublicResponse(order));
}

// Shared by trackOrder (one code) and listAccountOrders (all of a logged-in
// user's codes) so the two response shapes can't drift apart — same fields,
// same "only reveal promptText once approved" rule, in one place.
function orderToPublicResponse(order) {
  const response = { code: order.code, productId: order.productId, status: order.status, createdAt: order.createdAt, orderType: order.orderType || "transform" };
  if (order.orderType === "prompt" && order.status === "approved") {
    response.promptText = order.promptText || null;
  }
  if (order.orderType === "package") {
    response.packageSize = order.packageSize;
    response.creditsRemaining = order.creditsRemaining;
    response.usedItems = order.usedItems || [];
  }
  // Underpaid → Remaining Payment (added 2026-09-15): computed fresh from
  // the ledger every time, in-memory only (this function never writes to
  // KV) — so the customer's own status panel (polling this every 6s) always
  // reflects the true server-side total, and survives a refresh/close/
  // return-later exactly because it's read straight from the stored order,
  // never from anything kept only in the browser.
  if (order.paymentStatus) {
    const totals = computePaymentTotals(order);
    response.paymentStatus = order.paymentStatus;
    response.requiredAmount = totals.requiredAmount;
    response.totalVerifiedPaid = totals.totalVerifiedPaid;
    response.remainingAmount = totals.remainingAmount;
  }
  return response;
}

async function notifyOwnerOfRemainingPayment(env, order, ref) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const mono = (v) => "`" + String(v || "—") + "`";
  const totals = computePaymentTotals(order);
  const lines = [
    "💰 *دفعة متبقية جديدة*",
    "",
    "*كود الطلب:* " + mono(order.code),
    "*المنتج:* " + order.productTitle,
    "*رقم العملية الجديد:* " + mono(ref),
    "*إجمالي المطلوب:* " + totals.requiredAmount + " EGP",
    "*تم تأكيده سابقًا:* " + totals.totalVerifiedPaid + " EGP",
    "*يحتاج مراجعة الآن:* " + totals.remainingAmount + " EGP",
  ];
  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "Markdown", disable_web_page_preview: true }),
    });
  } catch (e) {
    // Alerting is a convenience, never a condition of accepting the reference.
  }
}

/** Customer-facing endpoint (added 2026-09-15: Underpaid → Remaining
 * Payment) — lets a customer whose order is still `paymentStatus:"underpaid"`
 * submit a NEW manual-transfer reference for the remaining amount against
 * their EXISTING order, without ever creating a second order. No admin
 * token required (this mirrors the trust level of the original checkout
 * submission: a transfer reference alone is a claim, never proof — see
 * isPlausibleRef()), and no amount is accepted from the client at all: the
 * only numbers ever compared against money are computed server-side by
 * computePaymentTotals()/recordPaymentVerification(). This only records that
 * "the customer says they made another transfer, ref X" — an admin still has
 * to verify the real amount via approveOrder() (or a gateway webhook) before
 * anything moves the order toward approved, exactly like the original `ref`
 * captured at checkout. */
async function submitRemainingPayment(env, request) {
  if (!(await rateLimit(env, request, "orders-remaining-payment", 10, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const code = String(body.code || "").toUpperCase().trim();
  if (!code) return err("Missing order code", 400);
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return err("Order not found — please re-enter your order code", 404);
  const order = JSON.parse(raw);

  if (!isPlausibleRef(body.ref)) {
    return err("Please enter the transfer reference number from your payment receipt", 400);
  }

  // Same order can't be approved without genuinely reaching requiredAmount —
  // computed fresh here, never from anything the client believes it owes.
  const totals = computePaymentTotals(order);
  if (totals.remainingAmount <= PAYMENT_AMOUNT_EPSILON) {
    return err("This order has already been fully paid", 409);
  }

  // The same global reference-reuse guard as the original checkout: one
  // transfer receipt can only ever be claimed once, on one order.
  const refKey = `orderref:${normaliseRef(body.ref)}`;
  if (await env.MEGA_KV.get(refKey)) {
    return err("This transfer reference has already been used for another order", 409);
  }
  await env.MEGA_KV.put(refKey, code);

  const ref = String(body.ref).trim().slice(0, 120);
  const appUsed = body.appUsed ? String(body.appUsed).slice(0, 60) : order.appUsed || "";
  if (!Array.isArray(order.pendingReferences)) order.pendingReferences = [];
  order.pendingReferences.push({ ref, appUsed, submittedAt: Date.now() });
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));

  await notifyOwnerOfRemainingPayment(env, order, ref);

  return json({ ok: true, ...computePaymentTotals(order), paymentStatus: order.paymentStatus });
}

// ============================================================================
// Account sync (added 2026-09-14) — GET /account/orders, GET /account/favorites,
// POST /account/favorites/add, POST /account/favorites/remove,
// POST /account/update-profile
//
// Security rule that applies to EVERY function below, no exceptions: the
// account acted on is whoever the session TOKEN resolves to via
// getUserBySession() — never a field from the request body or query string.
// This is the same identity rule authMe() already uses; these just extend it
// to read/write instead of read-only. A request with no valid token gets a
// plain "Not logged in" 401 — never a different error for "user doesn't
// exist" vs "bad token" vs "expired", so a guest/attacker can't use the
// response to learn anything about which accounts exist.
// ============================================================================

async function getAuthedUserOrNull(env, request) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  return await getUserBySession(env, token); // null if invalid/expired — same helper authMe() uses
}

async function listAccountOrders(env, request) {
  if (!(await rateLimit(env, request, "account-orders", 120, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);

  const { results } = await env.MEGA_DB.prepare(
    "SELECT order_code FROM user_orders WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();

  const orders = [];
  for (const row of results || []) {
    const raw = await env.MEGA_KV.get(`order:${row.order_code}`);
    if (!raw) continue; // shouldn't happen, but a stale index row must never 500 the whole list
    orders.push(orderToPublicResponse(JSON.parse(raw)));
  }
  return json({ orders });
}

async function listAccountFavorites(env, request) {
  if (!(await rateLimit(env, request, "account-favorites", 120, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);

  const { results } = await env.MEGA_DB.prepare(
    "SELECT product_id FROM favorites WHERE user_id = ?"
  )
    .bind(user.id)
    .all();
  return json({ productIds: (results || []).map((r) => r.product_id) });
}

async function addAccountFavorite(env, request) {
  if (!(await rateLimit(env, request, "account-favorites-write", 60, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const productId = body && body.productId ? String(body.productId).slice(0, 200) : "";
  if (!productId) return err("Missing productId");

  await env.MEGA_DB.prepare(
    "INSERT OR IGNORE INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?)"
  )
    .bind(user.id, productId, Date.now())
    .run();
  return json({ ok: true });
}

async function removeAccountFavorite(env, request) {
  if (!(await rateLimit(env, request, "account-favorites-write", 60, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const productId = body && body.productId ? String(body.productId).slice(0, 200) : "";
  if (!productId) return err("Missing productId");

  await env.MEGA_DB.prepare("DELETE FROM favorites WHERE user_id = ? AND product_id = ?")
    .bind(user.id, productId)
    .run();
  return json({ ok: true });
}

async function updateAccountProfile(env, request) {
  if (!(await rateLimit(env, request, "account-update-profile", 20, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { name, phone } = body || {};
  if (!name || !String(name).trim()) return err("Missing name");
  const cleanedName = String(name).trim().slice(0, 120);

  let cleanedPhone = null;
  if (phone) {
    // Same Egyptian-mobile rule createOrder() already enforces, reused as-is
    // rather than a second, possibly-drifting copy of the pattern.
    cleanedPhone = String(phone).trim();
    if (!/^01[0125][0-9]{8}$/.test(cleanedPhone)) {
      return err("Please enter a valid Egyptian mobile number (e.g. 01xxxxxxxxx)", 400);
    }
  }

  await env.MEGA_DB.prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?")
    .bind(cleanedName, cleanedPhone, user.id)
    .run();
  return json({ ok: true, name: cleanedName, phone: cleanedPhone });
}

// ============================================================================
// Profile-photo upload (added 2026-09-14) — POST /account/upload-avatar
// ----------------------------------------------------------------------------
// Same identity rule as every other /account/* endpoint above: the account
// acted on is whoever the session token resolves to via getUserBySession(),
// never a field the client sends. Reuses the existing MEGA_IMAGES R2 bucket
// and the same ALLOWED_IMAGE_TYPES allowlist the admin product-photo
// uploader already uses (see uploadImage() above) — a second, separate
// image pipeline isn't needed for this. The frontend already downscales the
// chosen photo client-side to a 512×512 JPEG before it's ever sent, so the
// size cap below is generous headroom, not a real limit anyone should hit
// in practice; it exists purely so a directly-crafted request can't abuse
// this endpoint to stuff arbitrarily large files into R2.
// ============================================================================
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

async function uploadAccountAvatar(env, request) {
  if (!(await rateLimit(env, request, "account-avatar-upload", 20, 3600))) {
    return err("Too many requests, please try again later", 429);
  }
  const user = await getAuthedUserOrNull(env, request);
  if (!user) return err("Not logged in", 401);

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return err("Expected multipart/form-data with an 'avatar' field", 400);
  }
  const form = await request.formData();
  const file = form.get("avatar");
  if (!file || typeof file === "string") return err("Missing 'avatar' file field", 400);
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return err("Unsupported image type", 415);
  if (file.size > MAX_AVATAR_BYTES) return err("Image too large", 413);

  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[file.type];
  // Keyed by this account's own (session-verified) id — never anything the
  // client could choose — so one user can never overwrite another's photo.
  const key = `avatar_${user.id}_${Date.now()}_${randomHex(6)}.${ext}`;
  await env.MEGA_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
  });
  const avatarUrl = `${new URL(request.url).origin}/images/${key}`;

  // Best-effort cleanup of the previous avatar (if any) so R2 storage doesn't
  // grow unbounded across repeated re-uploads. Never lets a delete failure —
  // or a pre-existing avatar_url that isn't actually one of ours — block
  // saving the new photo; only ever deletes a key matching our own naming
  // scheme, never an arbitrary stored URL.
  try {
    const prevRow = await env.MEGA_DB.prepare("SELECT avatar_url FROM users WHERE id = ?").bind(user.id).first();
    const prevUrl = prevRow && prevRow.avatar_url;
    if (prevUrl) {
      const prevKey = String(prevUrl).split("/images/")[1];
      if (prevKey && prevKey.startsWith("avatar_")) await env.MEGA_IMAGES.delete(prevKey);
    }
  } catch (e) {
    // Cleanup is a nicety, never a condition of saving the new avatar.
  }

  await env.MEGA_DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").bind(avatarUrl, user.id).run();
  return json({ ok: true, avatarUrl });
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
    // A genuinely free order (env.SOFT_LAUNCH_MODE, a server-side toggle a
    // client can never set) has nothing to verify — marked verified/0 up
    // front so it reads unambiguously in the admin ledger and can never be
    // confused with a real paid order missing its verification step.
    requiredAmount: 0,
    paymentStatus: "verified",
    verifiedPaidAmount: 0,
    paymentMethod: null,
    paymentProvider: "free",
    paymentReference: null,
    providerTransactionId: null,
    paymentVerifiedAt: Date.now(),
    paymentVerifiedBy: "soft-launch",
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

/** Manual InstaPay/Vodafone Cash approval (added 2026-09-15: payment
 * integrity; extended 2026-09-15 for cumulative/remaining-payment support).
 * The website has no way to know what actually landed in Magdy's bank
 * account/wallet — a customer typing a transfer reference is not proof of
 * amount. So this endpoint REQUIRES the admin to type the amount they
 * personally confirmed arrived for THIS ONE transfer (verifiedAmount) —
 * never defaulted from anything the customer submitted at checkout — and
 * that amount is added to the order's payment ledger (recordPaymentVerification),
 * which compares the running TOTAL against order.requiredAmount (the same
 * server-computed price createOrder() already trusted, never the client's).
 * A still-insufficient total keeps the order paymentStatus:"underpaid" and
 * status not "approved"; /transform independently re-checks paymentStatus
 * too (see transformImage()), so even a bug here can't unlock a result on
 * its own.
 *
 * `body.paymentId` is a REQUIRED idempotency nonce (the admin UI generates
 * one per approval click/retry) so that a double-click or a retried request
 * can never add the same transfer to the ledger twice — see
 * recordPaymentVerification(). `body.reference` is optional and lets the
 * admin point at a SPECIFIC pending transfer reference (see
 * order.pendingReferences, populated by /orders/submit-remaining-payment)
 * when approving a second/later payment; it falls back to the order's
 * original `ref` for backward compatibility with the original one-payment
 * flow. */
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

  const requiredAmount = Number(order.requiredAmount ?? order.price) || 0;
  const verifiedAmount = Number(body.verifiedAmount);
  if (requiredAmount > 0 && !Number.isFinite(verifiedAmount)) {
    return err("Enter the amount you actually confirmed was received before approving", 400);
  }
  const paymentId = body.paymentId ? String(body.paymentId).slice(0, 120) : "";
  if (requiredAmount > 0 && !paymentId) {
    // Every manual verification needs its own idempotency key — refuse
    // rather than silently generating one server-side, which would defeat
    // the point (a retried request would just get counted twice again).
    return err("Missing paymentId — please refresh the admin page and try again", 400);
  }

  const result = recordPaymentVerification(order, {
    verifiedAmount,
    method: order.appUsed || undefined,
    provider: "manual",
    reference: body.reference ? String(body.reference).slice(0, 120) : order.ref || undefined,
    verifiedBy: "admin",
    paymentId: paymentId || undefined,
  });

  if (order.orderType === "prompt" && !order.promptText && result.ok && order.status === "approved") {
    const productRaw = await env.MEGA_KV.get(`product:${order.productId}`);
    if (productRaw) {
      const product = JSON.parse(productRaw);
      order.promptText = product.prompt || null;
    }
  }
  await env.MEGA_KV.put(`order:${code}`, JSON.stringify(order));

  if (!result.ok) {
    return err(
      result.reason === "missing-idempotency-key"
        ? "Missing paymentId — please refresh the admin page and try again"
        : "Enter a valid received amount before approving",
      400
    );
  }

  // This ONE transfer was successfully recorded into the ledger either way —
  // the HTTP status below is purely about whether the order's CUMULATIVE
  // total now clears requiredAmount, matching the original single-payment
  // contract (409 + underpaid:true) so the admin UI's existing underpaid
  // handling keeps working unchanged, now carrying the running totals too.
  if (order.paymentStatus === "underpaid") {
    return json(
      {
        error: "UNDERPAID",
        underpaid: true,
        duplicate: !!result.duplicate,
        requiredAmount: result.requiredAmount,
        verifiedAmount: result.totalVerifiedPaid, // cumulative, not just this transfer
        totalVerifiedPaid: result.totalVerifiedPaid,
        remainingAmount: result.remainingAmount,
      },
      409
    );
  }
  return json({
    ok: true,
    alreadyVerified: !!result.duplicate && order.status === "approved",
    duplicate: !!result.duplicate,
    paymentStatus: order.paymentStatus,
    requiredAmount: result.requiredAmount,
    totalVerifiedPaid: result.totalVerifiedPaid,
    remainingAmount: result.remainingAmount,
    overpaidAmount: result.overpaidAmount,
  });
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
  order.paymentStatus = "rejected";
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

  // Security fix (2026-09-14): resultImageUrl used to be stored completely
  // unvalidated, then rendered straight into an <img src="..."> in the ADMIN
  // panel's pending-reviews list with no escaping — any registered customer
  // (registration is free/instant, no email verification) could submit a
  // crafted string here that broke out of the src attribute and injected an
  // onerror handler, running arbitrary JS in the ADMIN's own browser session
  // the next time they opened that tab — including reading the admin session
  // token out of localStorage and exfiltrating it. This is now validated
  // server-side (must be null, or a genuine http(s) URL under 500 chars) —
  // anything else is silently dropped rather than failing the whole review,
  // since this field only decorates a review and a customer shouldn't lose
  // their review over a malformed value. The admin-panel rendering was ALSO
  // hardened to properly escape this field (defense in depth — see app.js).
  let safeResultImageUrl = null;
  if (typeof resultImageUrl === "string" && resultImageUrl.length > 0 && resultImageUrl.length <= 500) {
    try {
      const parsed = new URL(resultImageUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") safeResultImageUrl = parsed.href;
    } catch {
      safeResultImageUrl = null; // not a well-formed URL at all — drop it
    }
  }

      const pendingRaw = await env.MEGA_KV.get("reviews:pending");
    const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
    const nextId = (parseInt((await env.MEGA_KV.get("reviews:nextId")) || "1", 10));
    pending.push({ id: nextId, rating: ratingNum, comment: commentText, resultImageUrl: safeResultImageUrl, user_name: user.name, createdAt: Date.now() });
    await env.MEGA_KV.put("reviews:pending", JSON.stringify(pending));
    await env.MEGA_KV.put("reviews:nextId", String(nextId + 1));

    return json({ ok: true });
  }

async function listApprovedReviews(env) {
  const raw = await env.MEGA_KV.get("reviews:approved");
  const reviews = raw ? JSON.parse(raw) : [];
  // كان .slice(-30) بيقص آخر 30 تقييم بس ويسيب الباقي مش ظاهر خالص — مش
  // عداد حقيقي. اتشالت (14 سبتمبر 2026) عشان كل التقييمات المعتمدة تظهر.
  return json({ reviews: [...reviews].reverse() });
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
  // phone/avatarUrl are always empty right after registration — included so
  // the response shape matches loginUser()/authMe() exactly, since the
  // frontend stores whichever one it last received as the full profile.
  return json({ token, name, email, phone: "", avatarUrl: "" });
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
    "SELECT id, name, email, password_hash, salt, auth_provider, phone, avatar_url FROM users WHERE email = ?"
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
  // phone/avatarUrl added 2026-09-14 — previously missing here entirely,
  // which meant a returning user's saved phone/profile-photo never actually
  // came back on login (silently dropped, not just on this device: on ANY
  // device, since this is the one place login data comes from).
  return json({ token, name: user.name, email: user.email, phone: user.phone || "", avatarUrl: user.avatar_url || "" });
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
    `SELECT users.id, users.name, users.email, users.phone, users.avatar_url, sessions.expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email, phone: row.phone || null, avatarUrl: row.avatar_url || null };
}

async function authMe(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const user = await getUserBySession(env, token);
  if (!user) return err("Not logged in", 401);
  // phone/avatarUrl added 2026-09-14 — this endpoint is what every returning
  // visit calls (checkLoggedInUser() on page load) to rebuild currentUser,
  // so leaving these out meant the phone number and profile photo silently
  // reset to blank on every single page load, on every device, even though
  // both were saved correctly in D1 the whole time.
  return json({ name: user.name, email: user.email, phone: user.phone || "", avatarUrl: user.avatarUrl || "" });
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

  let user = await env.MEGA_DB.prepare("SELECT id, name, email, phone, avatar_url FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    const { hash, salt } = await hashPassword(randomHex(32));
    const result = await env.MEGA_DB.prepare(
      "INSERT INTO users (name, email, password_hash, salt, auth_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(name, email, hash, salt, provider, Date.now())
      .run();
    user = { id: result.meta.last_row_id, name, email, phone: null, avatar_url: null };
  }
  const token = await createSession(env, user.id);
  // phone/avatarUrl added 2026-09-14 — same fix as loginUser()/authMe(): a
  // returning social-login user's saved phone/photo were silently dropped
  // here before, on every device.
  return { token, name: user.name, email: user.email, phone: user.phone || "", avatarUrl: user.avatar_url || "" };
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

/** Shared by paymobCreate/fawryCreate/fawaterkCreate (fixed 2026-09-15:
 * Underpaid → Remaining Payment). Every payment-CREATION endpoint used to
 * trust `amount` straight from the request body — a customer's browser
 * could ask a gateway to create a payment intent for ANY amount, unrelated
 * to what the order actually needs. Now the server looks the order up
 * itself and returns its own computed remainingAmount; whatever `amount`
 * the client sent is never read by any of the three *Create functions
 * below. This also naturally supports the remaining-payment flow: a
 * customer paying off an underpaid order through a gateway (rather than a
 * manual transfer) is charged exactly serverCalculatedRemainingAmount, never
 * the original full price again. */
async function resolveServerChargeAmount(env, orderCode) {
  const code = String(orderCode || "").toUpperCase().trim();
  if (!code) return { error: err("Missing orderCode", 400) };
  const raw = await env.MEGA_KV.get(`order:${code}`);
  if (!raw) return { error: err("Order not found", 404) };
  const order = JSON.parse(raw);
  const totals = computePaymentTotals(order);
  if (totals.remainingAmount <= PAYMENT_AMOUNT_EPSILON) {
    return { error: err("This order has already been fully paid", 409) };
  }
  return { order, amount: totals.remainingAmount };
}

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
  const { orderCode, name, phone, email } = body;
  if (!orderCode) return err("Missing orderCode");
  const resolved = await resolveServerChargeAmount(env, orderCode);
  if (resolved.error) return resolved.error;
  const amount = resolved.amount; // server-computed remainingAmount — never the client's `amount`

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

    // Constant-time compare (2026-09-14 hardening) — a plain !== leaks how
    // many leading characters matched via response timing, in theory letting
    // an attacker brute-force the correct signature byte-by-byte over many
    // requests instead of needing the real PAYMOB_HMAC_SECRET outright.
    if (!hmacFromPaymob || !(await safeEqual(computedHmac, hmacFromPaymob))) {
      return err("HMAC verification failed", 401);
    }
    if (obj?.success && obj?.order?.merchant_order_id) {
      // Paymob reports amount_cents (EGP × 100) — never trust anything the
      // browser said the price was; this is the provider's own signed figure.
      const amountEgp = Number(obj?.amount_cents) / 100;
      await approveOrderByCode(env, obj.order.merchant_order_id, {
        verifiedAmount: amountEgp,
        provider: "paymob",
        providerTransactionId: obj?.id != null ? String(obj.id) : null,
      });
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
  const { orderCode, name, phone, email } = body;
  if (!orderCode || !phone) return err("Missing orderCode or phone");
  const resolved = await resolveServerChargeAmount(env, orderCode);
  if (resolved.error) return resolved.error;
  const amount = resolved.amount; // server-computed remainingAmount — never the client's `amount`

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
    // Constant-time compare (2026-09-14 hardening) — see paymobWebhook() for rationale.
    if (!(await safeEqual(computed, messageSignature))) return err("Signature verification failed", 401);
    if (orderStatus === "PAID" && merchantRefNumber) {
      // Fawry reports the amount it actually collected in paymentAmount —
      // orderAmount is what was requested, paymentAmount is what was paid;
      // verifying against the latter is what actually protects against a
      // partial/short payment being reported as PAID.
      await approveOrderByCode(env, merchantRefNumber, {
        verifiedAmount: Number(paymentAmount),
        provider: "fawry",
        providerTransactionId: fawryRefNumber != null ? String(fawryRefNumber) : null,
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Webhook processing error", detail: String(e) }, 500);
  }
}

async function fawaterkCreate(env, request) {
  if (!env.FAWATERK_API_KEY) {
    return err("Card payment via Fawaterk is not configured yet (missing FAWATERK_API_KEY)", 501);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const { orderCode, name, phone, email } = body;
  if (!orderCode) return err("Missing orderCode");
  const resolved = await resolveServerChargeAmount(env, orderCode);
  if (resolved.error) return resolved.error;
  const amount = resolved.amount; // server-computed remainingAmount — never the client's `amount`

  const fullName = (name || "Customer").trim();
  const spaceIdx = fullName.indexOf(" ");
  const firstName = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
  const lastName = spaceIdx === -1 ? "N/A" : fullName.slice(spaceIdx + 1);

  try {
    const origin = new URL(request.url).origin;
    const invoiceRes = await fetch("https://app.fawaterk.com/api/v2/createInvoiceLink", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FAWATERK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cartTotal: Number(amount).toFixed(2),
        currency: "EGP",
        customer: {
          first_name: firstName,
          last_name: lastName,
          email: email || "customer@example.com",
          phone: phone || "01000000000",
        },
        cartItems: [{ name: `Miga-Photobook order ${orderCode}`, price: Number(amount).toFixed(2), quantity: 1 }],
        payLoad: { orderCode },
        redirectionUrls: {
          successUrl: "https://miga-photobook.com/payment-success",
          failUrl: "https://miga-photobook.com/payment-failed",
          pendingUrl: "https://miga-photobook.com/payment-pending",
          webhookUrl: `${origin}/payment/fawaterk/webhook`,
        },
      }),
    });

    if (!invoiceRes.ok) {
      const detail = await invoiceRes.text();
      return json({ error: "Fawaterk invoice creation failed", detail }, 502);
    }
    const data = await invoiceRes.json();
    const checkoutUrl = data?.data?.url;
    if (!checkoutUrl) return json({ error: "No checkout url returned from Fawaterk", detail: data }, 502);
    return json({ checkoutUrl });
  } catch (e) {
    return json({ error: "Unexpected error creating Fawaterk payment", detail: String(e) }, 500);
  }
}

/** Fetches the invoice's server-side-authoritative amount/status from
 * Fawaterk's own API (added 2026-09-15, replacing a guessed webhook field —
 * see fawaterkWebhook() below for why). Per Fawaterk's official API
 * reference (fawaterak-api.readme.io/reference/get-transaction-data),
 * GET /api/v2/getInvoiceData/{invoice_id} returns
 * { data: { total, paid, invoice_id, invoice_key, payment_method, ... } }
 * where `total` is the invoice amount and `paid` is 1/0. Returns null on any
 * failure so the caller can fail closed. */
async function fawaterkFetchInvoiceData(env, invoiceId) {
  try {
    const res = await fetch(`https://app.fawaterk.com/api/v2/getInvoiceData/${encodeURIComponent(invoiceId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.FAWATERK_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const parsed = await res.json().catch(() => null);
    return parsed?.data || null;
  } catch {
    return null;
  }
}

async function fawaterkWebhook(env, request) {
  if (!env.FAWATERK_VENDOR_KEY) return err("Server misconfigured: FAWATERK_VENDOR_KEY not set", 500);
  if (!env.FAWATERK_API_KEY) return err("Server misconfigured: FAWATERK_API_KEY not set", 500);
  try {
    const body = await request.json().catch(() => null);
    if (!body) return err("Invalid payload", 400);
    const { hashKey, invoice_id, invoice_key, payment_method, invoice_status, pay_load } = body;
    if (!hashKey) return err("Missing signature", 401);
    const message = `InvoiceId=${invoice_id ?? ""}&InvoiceKey=${invoice_key ?? ""}&PaymentMethod=${payment_method ?? ""}`;
    const computed = await hmacSha256Hex(env.FAWATERK_VENDOR_KEY, message);
    // Constant-time compare (2026-09-14 hardening) — see paymobWebhook() for rationale.
    if (!(await safeEqual(computed, hashKey))) return err("Signature verification failed", 401);

    let orderCode = null;
    try {
      const parsedPayload = typeof pay_load === "string" ? JSON.parse(pay_load) : pay_load;
      orderCode = parsedPayload?.orderCode || null;
    } catch {
      orderCode = null;
    }
    if (invoice_status === "paid" && orderCode) {
      // FIXED 2026-09-15: Fawaterk's official webhook reference
      // (fawaterak-api.readme.io/reference/web-hook) documents this payload
      // as ONLY { hashKey, invoice_key, invoice_id, payment_method,
      // invoice_status, pay_load, referenceNumber } — there is genuinely NO
      // amount field in it at all. The previous code guessed at field names
      // (invoice_amount/amount/cartTotal/...) that are not part of the
      // documented payload, which is exactly what Magdy asked not to do
      // ("لا تخمّن"). Instead, after the signature above is verified, this
      // now calls Fawaterk's own "Get Transaction Data" API
      // (GET /api/v2/getInvoiceData/{invoice_id}, also officially
      // documented) to fetch the real, provider-confirmed invoice total and
      // paid flag — the actual amount from the payment provider, not a
      // guess and not anything from the browser.
      const invoiceData = await fawaterkFetchInvoiceData(env, invoice_id);
      if (!invoiceData || Number(invoiceData.paid) !== 1) {
        return err("Could not confirm this invoice as paid via Fawaterk's own API", 502);
      }
      // Defense-in-depth hardening (2026-09-15 security review): per
      // Fawaterk's own official webhook docs, the hashKey signature covers
      // ONLY InvoiceId+InvoiceKey+PaymentMethod — pay_load (which carries our
      // orderCode) is NOT part of the signed message. Forging a webhook that
      // reaches this point at all already requires FAWATERK_VENDOR_KEY (no
      // valid hashKey can be produced without it, regardless of pay_load), so
      // this is not independently exploitable today — but it means orderCode
      // binding otherwise rests entirely on an unsigned field. getInvoiceData
      // is documented to echo back the SAME pay_load Fawaterk itself recorded
      // when the invoice was created, fetched here directly from Fawaterk's
      // server with our own API key (never from the untrusted inbound
      // webhook body), so cross-checking it costs nothing and removes that
      // reliance entirely. Fails OPEN only when Fawaterk's API omits pay_load
      // (documented to happen — their own example response shows it as
      // null), and fails CLOSED on an actual mismatch.
      if (invoiceData.pay_load) {
        let confirmedOrderCode = null;
        try {
          const parsedConfirmed = typeof invoiceData.pay_load === "string" ? JSON.parse(invoiceData.pay_load) : invoiceData.pay_load;
          confirmedOrderCode = parsedConfirmed?.orderCode || null;
        } catch {
          confirmedOrderCode = null;
        }
        if (confirmedOrderCode && confirmedOrderCode !== orderCode) {
          return err("Invoice pay_load does not match the order this webhook claims to be for", 401);
        }
      }
      const verifiedAmount = Number(invoiceData.total);
      if (!Number.isFinite(verifiedAmount) || verifiedAmount <= 0) {
        return err("Fawaterk returned an invalid invoice amount", 502);
      }
      await approveOrderByCode(env, orderCode, {
        verifiedAmount,
        provider: "fawaterk",
        providerTransactionId: invoice_id != null ? String(invoice_id) : null,
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Webhook processing error", detail: String(e) }, 500);
  }
}

// ============================================================================
// AI photo transform  (POST /transform)
// ============================================================================

// Defensive cleanup: some products still have an OLD, manually-typed
// watermark/logo instruction saved in their prompt (e.g. the "royal king
// crown" text pasted before this became automatic, or later a text-based
// gold-icon instruction). None of that should ever reach the AI anymore —
// see applyLogoWatermark() below for why — so this strips out any sentence
// that mentions "watermark" or "logo" from a product's OWN prompt before it
// is sent to fal.ai. Safe to leave old text sitting in a product's prompt
// field; it will just be ignored. New products should just skip mentioning
// the logo entirely, to keep the field clean.
function stripLegacyWatermarkText(promptText) {
  if (!promptText) return "";
  return promptText
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/watermark|logo/i.test(sentence))
    .join(" ")
    .trim();
}

// ============================================================================
// Real logo watermarking (Cloudflare Images binding) — added 2026-09-07,
// replacing the old approach of asking the AI model to *draw* a logo from a
// text description. That never worked reliably: the model misspelled
// "Miga-Photobook", drew the wrong colors, and ignored every size
// instruction we gave it (tried 8%, 5%, 3%, "extremely tiny" — all still
// rendered far too large). This instead overlays the REAL logo file — exact
// shape, exact color, exact size, every time, no AI interpretation involved.
//
// How it works: after fal.ai generates the (logo-free) transformed photo,
// this fetches that image plus the real logo PNG, composites them with the
// Images binding at a fixed size/position, stores the composited result in
// the existing MEGA_IMAGES R2 bucket, and serves it through the existing
// /images/:key route (see uploadImage/serveImage above) — so `resultUrl`
// downstream is still just a normal https URL, exactly like before. Nothing
// else in the codebase (admin panel, WhatsApp share links, order records)
// needs to change.
//
// Setup this needs (one-time, done from the Cloudflare dashboard — outside
// what this code change alone can do):
//   1. Workers & Pages -> miga-photobook-api -> Settings -> Bindings ->
//      Add -> Images -> bind it as "IMAGES" (i.e. env.IMAGES).
//   2. Upload logo-watermark.png (transparent background, real logo) to the
//      GitHub repo root, next to index.html, so LOGO_WATERMARK_URL below
//      resolves to a real, permanently-hosted file.
// If the Images binding isn't set up yet, this fails safe: the customer
// still gets their (unwatermarked) photo rather than an error.
// ============================================================================
const LOGO_WATERMARK_URL = "https://miga-photobook.com/logo-watermark.png";
// Sized as a PERCENTAGE of the delivered photo's own width, not a fixed pixel
// count. A fixed pixel width (previously 110px) looks fine on one output
// resolution/aspect ratio but too small or too large on another — every
// product can use a different resolution setting from the admin panel, and
// this needs to look the same *relative* size on all of them. 0.10 = 10% of
// the photo's width.
const LOGO_WATERMARK_WIDTH_RATIO = 0.1;
// Floor so the logo never becomes illegibly tiny if a product's output
// resolution is unusually small.
const LOGO_WATERMARK_MIN_WIDTH_PX = 90;
// Gap from the bottom/right edges, as a fraction of the logo's OWN (already
// percentage-sized) width — so the margin scales together with the logo
// instead of looking cramped on a large logo or oversized on a small one.
const LOGO_WATERMARK_MARGIN_RATIO = 0.16;

async function applyLogoWatermark(env, sourceImageUrl, request) {
  if (!env.IMAGES) {
    // Images binding not added yet in the dashboard — don't break a real,
    // already-paid-for customer transform over a missing watermark.
    return sourceImageUrl;
  }
  const [sourceRes, logoRes] = await Promise.all([fetch(sourceImageUrl), fetch(LOGO_WATERMARK_URL)]);
  if (!sourceRes.ok) throw new Error(`Could not fetch generated image (HTTP ${sourceRes.status})`);
  if (!logoRes.ok) throw new Error(`Could not fetch logo-watermark.png (HTTP ${logoRes.status}) — is it uploaded to the site root?`);

  // .tee() the source photo's stream into two independent copies: one to read
  // its real width via .info() (free — no billing impact, per Cloudflare's
  // docs), and one to actually composite. A stream can only be consumed once,
  // so both need their own copy — this is the same .tee() pattern Cloudflare's
  // own "rounded corners" example uses to feed one source into multiple draws.
  const [infoStream, drawStream] = sourceRes.body.tee();
  const info = await env.IMAGES.info(infoStream);
  const overlayWidthPx = Math.max(LOGO_WATERMARK_MIN_WIDTH_PX, Math.round(info.width * LOGO_WATERMARK_WIDTH_RATIO));
  const marginPx = Math.round(overlayWidthPx * LOGO_WATERMARK_MARGIN_RATIO);

  // IMPORTANT: .output() returns a Promise — you must await it BEFORE calling
  // .response() on the resolved result (see Cloudflare's own docs example:
  // `(await env.IMAGES.input(...).output(...)).response()`). Calling
  // `.output(...).response()` without awaiting first calls `.response` on the
  // Promise object itself, which doesn't exist, and throws
  // "composited.response is not a function" on every single request — this
  // was the exact bug causing every real transform to fail after fal.ai
  // successfully generated the photo.
  const composited = (
    await env.IMAGES.input(drawStream)
      .draw(env.IMAGES.input(logoRes.body).transform({ width: overlayWidthPx }), {
        bottom: marginPx,
        right: marginPx,
      })
      .output({ format: "image/jpeg", quality: 92 })
  ).response();

  const compositedBytes = await composited.arrayBuffer();
  const key = `gen_${Date.now()}_${randomHex(6)}.jpg`;
  await env.MEGA_IMAGES.put(key, compositedBytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
  });
  const origin = new URL(request.url).origin;
  return `${origin}/images/${key}`;
}

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
  // Defense-in-depth (added 2026-09-15): status alone becoming "approved" is
  // now only ever set by recordPaymentVerification() after a sufficient
  // verified payment (or a genuinely free order) — see approveOrder()/
  // approveOrderByCode(). This re-checks that directly, so that even a future
  // bug that flips `status` without going through that function still can't
  // unlock a transform. Only enforced when paymentStatus is actually present
  // — an order created before this field existed keeps working exactly as it
  // did before, per the backward-compatibility rule for legacy orders (never
  // let a MISSING field become a bypass for a NEW order, but never punish an
  // OLD one for a field it was never given either).
  if (order.paymentStatus && order.paymentStatus !== "verified") {
    return err("This order's payment has not been verified yet", 403);
  }
  if (
    order.paymentStatus === "verified" &&
    Number(order.requiredAmount ?? order.price) > 0 &&
    !isPaymentSufficient(Number(order.requiredAmount ?? order.price), Number(order.verifiedPaidAmount))
  ) {
    return err("This order's payment could not be confirmed", 403);
  }
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
    const modelId = await getAiModel(env); // admin-configurable — see getSiteConfig/setAiModel/MODEL_REGISTRY above
    const modelCfg = MODEL_REGISTRY[modelId] || MODEL_REGISTRY["nano-banana-2"];
    const resolution = await getOutputResolution(env); // admin-configurable — see getSiteConfig/setOutputResolution above
    const falBody = buildFalRequest(modelCfg, {
      prompt: stripLegacyWatermarkText(product.prompt),
      negativePrompt: product.negativePrompt,
      imageDataUri: image,
      resolution,
    });

    const falRes = await fetch(`https://fal.run/${modelCfg.slug}`, {
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
    const rawOutputUrl = data?.images?.[0]?.url;
    if (!rawOutputUrl) {
      await env.MEGA_KV.delete(lockKey);
      return json({ error: "No image returned from the generation service", detail: data }, 502);
    }

    let outputUrl;
    try {
      outputUrl = await applyLogoWatermark(env, rawOutputUrl, request);
    } catch (e) {
      await env.MEGA_KV.delete(lockKey);
      return json({ error: "Logo watermarking failed", detail: String(e) }, 502);
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
    // عدّاد الصور المحوّلة — يزيد هنا فقط، بعد نجاح التحويل والحفظ.
    // مخزّن كعدد مستقل بدل ما يتحسب من كل الطلبات في كل طلب عرض:
    // القراءة بتبقى قراءة واحدة سريعة مهما كبر عدد الطلبات، والبادج
    // بيتحدّث كل دقيقة عند كل زائر — فالحساب المتكرر كان هيبقى غالي.
    // await مقصود: لو فشل، مش هيوقّع التحويل نفسه (جوه try/catch).
    try {
      const cRaw = await env.MEGA_KV.get(TRANSFORM_COUNT_KEY);
      const cur = parseInt(cRaw || "0", 10);
      await env.MEGA_KV.put(TRANSFORM_COUNT_KEY, String((Number.isFinite(cur) ? cur : 0) + 1));
    } catch (e) { /* العدّاد مش حرج — التحويل نجح وده الأهم */ }
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
      else if (pathname === "/orders/submit-remaining-payment" && request.method === "POST") response = await submitRemainingPayment(env, request);
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
      else if (pathname === "/visits/public-count" && request.method === "GET") response = await getPublicVisitCount(env);
      else if (pathname === "/auth/register" && request.method === "POST") response = await registerUser(env, request);
      else if (pathname === "/auth/login" && request.method === "POST") response = await loginUser(env, request);
      else if (pathname === "/auth/me" && request.method === "GET") response = await authMe(env, request);
      else if (pathname === "/account/orders" && request.method === "GET") response = await listAccountOrders(env, request);
      else if (pathname === "/account/favorites" && request.method === "GET") response = await listAccountFavorites(env, request);
      else if (pathname === "/account/favorites/add" && request.method === "POST") response = await addAccountFavorite(env, request);
      else if (pathname === "/account/favorites/remove" && request.method === "POST") response = await removeAccountFavorite(env, request);
      else if (pathname === "/account/update-profile" && request.method === "POST") response = await updateAccountProfile(env, request);
      else if (pathname === "/account/upload-avatar" && request.method === "POST") response = await uploadAccountAvatar(env, request);
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
      else if (pathname === "/payment/fawaterk/create" && request.method === "POST") response = await fawaterkCreate(env, request);
      else if (pathname === "/payment/fawaterk/webhook" && request.method === "POST") response = await fawaterkWebhook(env, request);
      else if (pathname === "/transform" && request.method === "POST") response = await transformImage(env, request);
      else if (pathname === "/showcase" && request.method === "GET") response = await getShowcase(env);
      else if (pathname === "/admin/showcase" && request.method === "POST") response = await saveShowcase(env, request);
      else if (pathname === "/site-config" && request.method === "GET") response = await getSiteConfig(env);
      else if (pathname === "/admin/set-design" && request.method === "POST") response = await setSiteDesign(env, request);
      else if (pathname === "/admin/set-hero-mode" && request.method === "POST") response = await setHeroMode(env, request);
      else if (pathname === "/admin/set-resolution" && request.method === "POST") response = await setOutputResolution(env, request);
      else if (pathname === "/admin/set-ai-model" && request.method === "POST") response = await setAiModel(env, request);
      else if (pathname === "/admin/set-color-theme" && request.method === "POST") response = await setColorTheme(env, request);
      else if (pathname === "/admin/set-header-mode" && request.method === "POST") response = await setHeaderMode(env, request);
      else if (pathname === "/admin/set-prompt-library-mode" && request.method === "POST") response = await setPromptLibraryMode(env, request);
      else if (pathname === "/admin/translate-title" && request.method === "POST") response = await translateTitle(env, request);
      else if (pathname === "/promo-images" && request.method === "GET") response = await getPromoImages(env);
      else if (pathname === "/admin/promo-images" && request.method === "POST") response = await savePromoImages(env, request);
      else if (pathname === "/share" && request.method === "GET") response = await renderShareCard(env, request);
      else response = err("Not found", 404);

      const merged = new Headers(response.headers);
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (e) {
      return json({ error: "Internal error" }, 500, headers);
    }
  },
};
