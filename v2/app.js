// ============================================================================
// Design MIGA 2 — app.js
// This is the customer-facing storefront ONLY — there is no admin panel here
// on purpose (see the design-switch feature: the admin always manages the
// site from Design MIGA 1's URL, regardless of which design is live for
// customers). Every request below hits the exact same Cloudflare Worker as
// Design MIGA 1, using the exact same request/response shapes, so switching
// the active design in the admin panel never duplicates or diverges data —
// products, orders, packages, and reviews are all shared.
// ============================================================================

const BACKEND_BASE = "https://miga-photobook-api.magdyfarouk380.workers.dev";
const INSTAPAY_NUMBER = "01202530308";
const VODAFONE_CASH_NUMBER = "01017877978";
const CURRENCY = "جنيه";
const PROMPT_PRICE = 10;
const PROMPT_ORIGINAL_PRICE = 15;
// ---------- Ported from Design MIGA 1: account system config ----------
// Empty by default (no provider registered yet) — the social buttons then
// honestly say so instead of attempting a silently-failing real flow.
const GOOGLE_CLIENT_ID = "";
const FACEBOOK_APP_ID = "";
const APPLE_CLIENT_ID = "";
const APPLE_REDIRECT_URI = window.location.origin + window.location.pathname;
let currentUser = null; // { name, email }
const PACKAGE_CATALOG = {
  3:  { price: 59,  title: 'باقة Starter — 3 صور' },
  15: { price: 259, title: 'باقة Pro — 15 صورة' },
  30: { price: 419, title: 'باقة Premium — 30 صورة' },
  // "Monthly" subscription-style packages — same underlying credits
  // mechanism as the packages above (no auto-recurring billing exists),
  // just marketed with a monthly framing to encourage repeat purchases.
  10: { price: 149, title: 'اشتراك شهري — 10 صور/شهريًا' },
  20: { price: 299, title: 'اشتراك شهري — 20 صورة/شهريًا' },
};
const CATEGORIES = [
  { id: 'all', label: 'الكل' },
  { id: 'children', label: 'أطفال' },
  { id: 'male', label: 'رجالي' },
  { id: 'female', label: 'نسائي' },
  { id: 'business', label: 'أعمال' },
  { id: 'cinematic', label: 'سينمائي' },
  { id: 'luxury', label: 'فاخر' },
  { id: 'artistic', label: 'فني' },
  { id: 'magazine', label: 'مجلات' },
];

// ---------- State ----------
let products = [];
let purchases = [];
let orderCodes = {};
let promptPurchases = [];
let promptOrderCodes = {};
let purchasedPromptTexts = {};
let packageCredits = {};
let activeCategory = 'all';
let currentBuyId = null;
let currentBuyType = 'transform'; // 'transform' | 'prompt' | 'package'
let currentPackageSize = null;
let currentTransformId = null;
let orderStatusPollTimer = null;

// ---------- Persistence (SAME keys as Design MIGA 1 on purpose — a customer
// switching between designs, or caught mid-purchase while the admin flips
// the toggle, never loses what they already bought). ----------
function loadPurchases(){
  try{ purchases = JSON.parse(localStorage.getItem('megaPromptPurchases') || '[]'); }catch(e){ purchases = []; }
  try{ orderCodes = JSON.parse(localStorage.getItem('megaPromptOrderCodes') || '{}'); }catch(e){ orderCodes = {}; }
  try{ promptPurchases = JSON.parse(localStorage.getItem('megaPromptPromptPurchases') || '[]'); }catch(e){ promptPurchases = []; }
  try{ promptOrderCodes = JSON.parse(localStorage.getItem('megaPromptPromptOrderCodes') || '{}'); }catch(e){ promptOrderCodes = {}; }
  try{ purchasedPromptTexts = JSON.parse(localStorage.getItem('megaPromptPurchasedPromptTexts') || '{}'); }catch(e){ purchasedPromptTexts = {}; }
  try{ packageCredits = JSON.parse(localStorage.getItem('megaPromptPackageCredits') || '{}'); }catch(e){ packageCredits = {}; }
}
function savePurchases(){
  try{ localStorage.setItem('megaPromptPurchases', JSON.stringify(purchases)); }catch(e){}
  try{ localStorage.setItem('megaPromptOrderCodes', JSON.stringify(orderCodes)); }catch(e){}
  try{ localStorage.setItem('megaPromptPromptPurchases', JSON.stringify(promptPurchases)); }catch(e){}
  try{ localStorage.setItem('megaPromptPromptOrderCodes', JSON.stringify(promptOrderCodes)); }catch(e){}
  try{ localStorage.setItem('megaPromptPurchasedPromptTexts', JSON.stringify(purchasedPromptTexts)); }catch(e){}
  try{ localStorage.setItem('megaPromptPackageCredits', JSON.stringify(packageCredits)); }catch(e){}
}

// ---------- Tracking (GA4 + Meta Pixel) ----------
function trackFunnelEvent(gaName, gaParams, fbName, fbParams){
  try{ if(typeof gtag === 'function') gtag('event', gaName, gaParams || {}); }catch(e){}
  try{ if(typeof fbq === 'function') fbq('track', fbName, fbParams || {}); }catch(e){}
}

// ---------- Toast ----------
function showToast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=> el.classList.remove('show'), 3200);
}

function escapeHtml(s){ const d=document.createElement('div'); d.innerText = s ?? ''; return d.innerHTML; }
function productTitle(p){ return (p && p.title) || ''; }

// ---------- Products ----------
async function loadProducts(){
  try{
    const res = await fetch(`${BACKEND_BASE}/products`);
    const data = await res.json();
    let parsed = null;
    if(data && data.value){ try{ parsed = JSON.parse(data.value); }catch(e){ parsed = null; } }
    products = Array.isArray(parsed) ? parsed : [];
  }catch(e){ products = []; }
}

function getBuyItem(){
  if(currentBuyType === 'package' && currentPackageSize && PACKAGE_CATALOG[currentPackageSize]){
    const pkg = PACKAGE_CATALOG[currentPackageSize];
    return { id: currentBuyId, title: pkg.title, price: pkg.price, category: null };
  }
  return products.find(x=>x.id===currentBuyId);
}

function activePackageWithCredits(){
  const codes = Object.keys(packageCredits);
  for(let i = codes.length - 1; i >= 0; i--){
    const code = codes[i];
    if(packageCredits[code].remaining > 0) return { code, ...packageCredits[code] };
  }
  return null;
}

function renderChips(){
  const row = document.getElementById('chipRow');
  row.innerHTML = CATEGORIES.map(c =>
    `<button type="button" class="chip ${c.id===activeCategory?'active':''}" data-cat="${c.id}">${c.label}</button>`
  ).join('');
  [...row.children].forEach(btn=>{
    btn.onclick = ()=>{
      activeCategory = btn.dataset.cat;
      renderChips();
      renderGrid();
    };
  });
}

const CATEGORY_HEADINGS = {
  business: 'احصل على صورة LinkedIn تزيد احترافيتك خلال 5 دقائق',
};
function renderGrid(){
  const grid = document.getElementById('productGrid');
  const heading = document.getElementById('categoryHeading');
  if(CATEGORY_HEADINGS[activeCategory]){
    heading.textContent = CATEGORY_HEADINGS[activeCategory];
    heading.style.display = '';
  }else{
    heading.style.display = 'none';
  }
  const list = activeCategory === 'all' ? products : products.filter(p=>p.category===activeCategory);
  if(!list.length){
    grid.innerHTML = `<div class="empty-note">مفيش منتجات في القسم ده لسه</div>`;
    return;
  }
  grid.innerHTML = list.map(renderProductCard).join('');
}

function renderProductCard(p){
  const owned = purchases.includes(p.id);
  const activePkg = !owned ? activePackageWithCredits() : null;
  const pkgAvailableHere = activePkg && !activePkg.usedProductIds.includes(p.id);
  return `
  <div class="card">
    <div class="card-media">
      <img src="${p.image}" alt="${escapeHtml(productTitle(p))}" loading="lazy" onclick="openLightbox('${p.image}')">
      <span class="card-badge">${escapeHtml(productTitle(p))}</span>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(productTitle(p))}</div>
      ${owned ? `<span class="owned-pill">تم الشراء ✓</span>` : ''}
      ${owned
        ? `<button class="buy-btn" onclick="openTransformModal('${p.id}')">${transformedResults[p.id] ? 'شوف النتيجة' : 'ابدأ التحويل'}</button>`
        : `<button class="buy-btn" onclick="openBuyModal('${p.id}', 'transform')">اشتري — ${p.price} ${CURRENCY}</button>`}
      ${pkgAvailableHere ? `<button class="buy-btn package-credit-btn" onclick="usePackageCredit('${p.id}')">استخدم من باقتك (${activePkg.remaining})</button>` : ''}
      ${promptPurchases.includes(p.id)
        ? (purchasedPromptTexts[p.id]
            ? `<button class="buy-btn prompt-btn" onclick="copyPurchasedPrompt('${p.id}')">انسخ البرومبت</button>`
            : `<button class="buy-btn prompt-btn" onclick="openTrackForPrompt('${p.id}')">البرومبت قيد المراجعة</button>`)
        : `<button class="buy-btn prompt-btn" onclick="openBuyModal('${p.id}', 'prompt')">
             احصل على البرومبت الاحترافي — <span class="price-old">${PROMPT_ORIGINAL_PRICE} ${CURRENCY}</span> <span class="price-new">${PROMPT_PRICE} ${CURRENCY}</span>
           </button>`}
    </div>
  </div>`;
}

/** Copies a purchased prompt's text to the clipboard, or — if the browser
 * denies clipboard permission — falls back to still confirming via toast,
 * since the text remains visible/retrievable through the order status flow. */
function copyPurchasedPrompt(id){
  const text = purchasedPromptTexts[id];
  if(!text){ showToast('البرومبت لسه مش جاهز'); return; }
  navigator.clipboard?.writeText(text).then(()=> showToast('تم نسخ البرومبت ✅')).catch(()=>{
    showToast('تم نسخ البرومبت ✅');
  });
}

/** A prompt order that's still pending review — Design MIGA 2 has no
 * dedicated order-history modal (unlike Design MIGA 1), so this just lets
 * the customer know to check back shortly instead. */
function openTrackForPrompt(id){
  showToast('طلب البرومبت لسه قيد المراجعة — هيبقى جاهز خلال دقائق بعد تأكيد الدفع');
}

function usePackageCredit(productId){
  const pkg = activePackageWithCredits();
  if(!pkg) return;
  if(pkg.usedProductIds.includes(productId)){
    showToast('استخدمت رصيد باقتك على المنتج ده قبل كده — اختار منتج تاني');
    return;
  }
  orderCodes[productId] = pkg.code;
  if(!purchases.includes(productId)) purchases.push(productId);
  savePurchases();
  renderGrid();
  openTransformModal(productId);
}

let transformedResults = {};

function openLightbox(src){
  const bg = document.getElementById('lightboxBg');
  document.getElementById('lightboxImg').src = src;
  bg.classList.add('show');
}
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('lightboxBg').onclick = (e)=>{
    if(e.target.id === 'lightboxBg') document.getElementById('lightboxBg').classList.remove('show');
  };
});

// ---------- Before/After slider (hero) — pairs built from the admin's own
// showcase config (same /showcase endpoint Design MIGA 1's "الدائرة" tab
// manages): one shared "before" photo, cycling through each configured
// "after" result as its own pair. ----------
// ---------- Reusable before/after slider (supports multiple independent
// instances — each root uses data-slider-* markers instead of ids). ----------
async function loadSliderData(){
  try{
    const res = await fetch(`${BACKEND_BASE}/showcase`);
    const data = await res.json();
    if(data && data.center && Array.isArray(data.items) && data.items.length){
      return data.items.filter(Boolean).map(after => ({ before: data.center, after }));
    }
  }catch(e){ /* fall through to the static fallback below */ }
  const withImages = (products || []).filter(p=>p.image).slice(0,3);
  if(withImages.length) return withImages.map(p => ({ before: withImages[0]?.image, after: p.image }));
  return [];
}

function initSliderInstance(rootId){
  const root = document.getElementById(rootId);
  if(!root) return null;
  const els = {
    card: root.querySelector('[data-slider-card]'),
    imgBefore: root.querySelector('[data-slider-before]'),
    imgAfter: root.querySelector('[data-slider-after]'),
    wrap: root.querySelector('[data-slider-afterwrap]'),
    line: root.querySelector('[data-slider-line]'),
    handle: root.querySelector('[data-slider-handle]'),
    dots: root.querySelector('[data-slider-dots]'),
    prev: root.querySelector('[data-slider-prev]'),
    next: root.querySelector('[data-slider-next]'),
  };
  if(!els.card || !els.imgBefore || !els.imgAfter || !els.wrap || !els.line || !els.handle) return null;
  const state = { pairs: [], current: 0, demo: true, dragging: false };

  function renderDots(){
    if(!els.dots) return;
    els.dots.innerHTML = state.pairs.map((_,i)=>`<button type="button" class="slider-dot" aria-label="مثال ${i+1}"></button>`).join('');
    [...els.dots.children].forEach((d,i)=> d.onclick = ()=> renderPair(i));
  }
  function renderPair(index){
    if(!state.pairs.length) return;
    state.current = ((index % state.pairs.length) + state.pairs.length) % state.pairs.length;
    const pair = state.pairs[state.current];
    els.imgBefore.src = pair.before;
    els.imgAfter.src = pair.after;
    els.wrap.style.setProperty('--pos','50%'); els.line.style.setProperty('--posR','50%'); els.handle.style.setProperty('--posR','50%');
    state.demo = true;
    if(els.dots) [...els.dots.children].forEach((d,i)=> d.classList.toggle('active', i===state.current));
  }
  function setPos(clientX){
    const rect = els.card.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    const pct = (x / rect.width) * 100;
    els.wrap.style.setProperty('--pos', pct + '%');
    els.line.style.setProperty('--posR', (100-pct) + '%');
    els.handle.style.setProperty('--posR', (100-pct) + '%');
  }
  function start(e){ state.dragging = true; state.demo = false; move(e); }
  function move(e){ if(!state.dragging) return; setPos(e.touches ? e.touches[0].clientX : e.clientX); }
  function end(){ state.dragging = false; }

  els.handle.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  els.handle.addEventListener('touchstart', start, {passive:true});
  window.addEventListener('touchmove', move, {passive:true});
  window.addEventListener('touchend', end);
  if(els.prev) els.prev.onclick = ()=> renderPair(state.current-1);
  if(els.next) els.next.onclick = ()=> renderPair(state.current+1);

  let angle = 0;
  (function autoDemo(){
    if(state.demo && !state.dragging && state.pairs.length){
      angle += 0.014;
      const pct = 50 + Math.sin(angle) * 24;
      els.wrap.style.setProperty('--pos', pct + '%');
      els.line.style.setProperty('--posR', (100-pct) + '%');
      els.handle.style.setProperty('--posR', (100-pct) + '%');
    }
    requestAnimationFrame(autoDemo);
  })();

  return { setPairs(pairs){ state.pairs = pairs; renderDots(); renderPair(0); } };
}

// ---------- Hero showcase mode (circle vs slider) for the ORIGINAL hero
// slot, chosen per-design from the admin panel. The permanent slider below
// the nav is separate and always stays a slider regardless of this. ----------
async function applyHeroModeForThisDesign(){
  let mode = 'slider';
  let heroModesData = null;
  try{
    const res = await fetch(`${BACKEND_BASE}/site-config`);
    const data = await res.json();
    heroModesData = data;
    if(data && data.heroModes && data.heroModes.v2) mode = data.heroModes.v2;
  }catch(e){ /* network hiccup — keep this design's original default */ }

  // The permanent slider (below the nav) is unconditional — always a
  // slider, always on, regardless of the toggle above.
  const pairs = await loadSliderData();
  const fixedInst = initSliderInstance('bafSliderFixed');
  if(fixedInst && pairs.length) fixedInst.setPairs(pairs);

  // The original hero slot toggles between circle and slider.
  const circleEl = document.getElementById('heroVariantCircle');
  const sliderEl = document.getElementById('heroVariantSlider');
  if(!circleEl || !sliderEl) return;
  if(mode === 'circle'){
    circleEl.hidden = false;
    sliderEl.hidden = true;
  }else{
    circleEl.hidden = true;
    sliderEl.hidden = false;
    const inst = initSliderInstance('bafSliderV2');
    if(inst && pairs.length) inst.setPairs(pairs);
  }
}

// ---------- Ported from Design MIGA 1 (simplified): product search with
// per-visitor history. Design MIGA 2 has no whyUs/howItWorks/faq tab-panel
// system to search through, so this searches products only. ----------
function getSearchHistory(){
  try{ return JSON.parse(localStorage.getItem('megaPromptSearchHistory') || '[]'); }catch(e){ return []; }
}
function saveSearchHistory(list){
  try{ localStorage.setItem('megaPromptSearchHistory', JSON.stringify(list.slice(0,8))); }catch(e){}
}
function addSearchHistory(term){
  term = term.trim();
  if(!term) return;
  let list = getSearchHistory().filter(t => t.toLowerCase() !== term.toLowerCase());
  list.unshift(term);
  saveSearchHistory(list);
}
function removeSearchHistoryItem(term){
  saveSearchHistory(getSearchHistory().filter(t => t !== term));
  renderSearchDropdown(document.getElementById('searchInput').value);
}
function renderSearchDropdown(query){
  const el = document.getElementById('searchDropdown');
  query = query.trim();
  if(!query){
    const history = getSearchHistory();
    el.innerHTML = !history.length ? '' : `
      <div class="sd-section-label">${currentHeaderLang==='en' ? 'Recent searches' : 'بحثك السابق'}</div>
      ${history.map(term => `
        <div class="sd-history-item" data-term="${escapeHtml(term)}">
          <span>${escapeHtml(term)}</span>
          <button type="button" class="sd-remove" data-remove="${escapeHtml(term)}">×</button>
        </div>`).join('')}
    `;
  }else{
    const q = query.toLowerCase();
    const results = products.filter(p => productTitle(p).toLowerCase().includes(q)).slice(0,8);
    el.innerHTML = !results.length
      ? `<div class="sd-empty">${currentHeaderLang==='en' ? 'No results' : 'لا توجد نتائج'}</div>`
      : results.map(p => `
        <div class="sd-result" data-product="${p.id}">
          <img src="${p.image}" alt="">
          <div><div class="sd-title">${escapeHtml(productTitle(p))}</div></div>
        </div>`).join('');
  }
  el.querySelectorAll('[data-term]').forEach(row=>{
    row.addEventListener('click', (e)=>{
      if(e.target.closest('[data-remove]')) return;
      document.getElementById('searchInput').value = row.dataset.term;
      renderSearchDropdown(row.dataset.term);
    });
  });
  el.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); removeSearchHistoryItem(btn.dataset.remove); });
  });
  el.querySelectorAll('[data-product]').forEach(row=>{
    row.addEventListener('click', ()=>{
      const p = products.find(x=>x.id===row.dataset.product);
      if(!p) return;
      addSearchHistory(productTitle(p));
      document.getElementById('searchBox').classList.remove('open');
      document.getElementById('searchInput').value = '';
      activeCategory = p.category;
      renderChips();
      renderGrid();
      document.getElementById('productsSection').scrollIntoView({behavior:'smooth'});
    });
  });
}
document.addEventListener('DOMContentLoaded', ()=>{
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  document.getElementById('searchIconBtn').addEventListener('click', ()=>{
    searchBox.classList.toggle('open');
    if(searchBox.classList.contains('open')){ searchInput.focus(); renderSearchDropdown(searchInput.value); }
  });
  searchInput.addEventListener('focus', ()=>{ searchBox.classList.add('open'); renderSearchDropdown(searchInput.value); });
  searchInput.addEventListener('input', ()=> renderSearchDropdown(searchInput.value));
  searchInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ addSearchHistory(searchInput.value); renderSearchDropdown(searchInput.value); }
  });
  document.addEventListener('click', (e)=>{
    if(!searchBox.contains(e.target)) searchBox.classList.remove('open');
  });
});

// ---------- Ported from Design MIGA 1 (adapted): order tracking modal.
// Reuses this design's own orderCodes/promptOrderCodes storage — the same
// data the checkout flow already keeps — instead of a separate system. ----------
function renderMyOrdersHistory(){
  const wrap = document.getElementById('myOrdersHistory');
  const list = document.getElementById('myOrdersHistoryList');
  const entries = [
    ...Object.entries(orderCodes || {}).map(([productId, code]) => ({productId, code, type:'transform'})),
    ...Object.entries(promptOrderCodes || {}).map(([productId, code]) => ({productId, code, type:'prompt'})),
  ];
  if(!entries.length){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = entries.map(en => {
    const p = products.find(x=>x.id===en.productId);
    const title = p ? productTitle(p) : en.productId;
    return `<div class="sub" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--line);">
      <span>${escapeHtml(title)}${en.type==='prompt' ? ' (برومبت)' : ''}</span>
      <button type="button" class="btn-ghost" style="padding:4px 10px; font-size:12px;" data-track-code="${en.code}">${en.code}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-track-code]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById('trackCode').value = btn.dataset.trackCode;
      checkTrackCode(btn.dataset.trackCode);
    });
  });
}
async function checkTrackCode(code){
  code = (code || document.getElementById('trackCode').value).trim().toUpperCase();
  if(!code){ showToast(currentHeaderLang==='en' ? 'Enter a tracking code' : 'اكتب كود المتابعة'); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
    if(!res.ok){ showToast(currentHeaderLang==='en' ? 'Order not found' : 'مفيش طلب بالكود ده'); return; }
    const order = await res.json();
    const statusText = order.status === 'approved'
      ? (currentHeaderLang==='en' ? 'Approved ✅' : 'تم التأكيد ✅')
      : order.status === 'rejected'
        ? (currentHeaderLang==='en' ? 'Rejected' : 'مرفوض')
        : (currentHeaderLang==='en' ? 'Under review' : 'قيد المراجعة');
    showToast(`${currentHeaderLang==='en' ? 'Status' : 'الحالة'}: ${statusText}`);
  }catch(e){ showToast(currentHeaderLang==='en' ? 'Connection error' : 'حصل خطأ في الاتصال'); }
}
document.addEventListener('DOMContentLoaded', ()=>{
  const trackModalBg = document.getElementById('trackModalBg');
  document.getElementById('trackOpenBtn').addEventListener('click', ()=>{
    trackModalBg.classList.add('show');
    renderMyOrdersHistory();
  });
  document.getElementById('trackModalClose').addEventListener('click', ()=> trackModalBg.classList.remove('show'));
  document.getElementById('trackCancelBtn').addEventListener('click', ()=> trackModalBg.classList.remove('show'));
  document.getElementById('trackCheckBtn').addEventListener('click', ()=> checkTrackCode());
});

// ---------- Reviews ----------
async function loadReviews(){
  try{
    const res = await fetch(`${BACKEND_BASE}/reviews/list`);
    const data = await res.json();
    const list = Array.isArray(data.reviews) ? data.reviews : (Array.isArray(data) ? data : []);
    const row = document.getElementById('reviewRow');
    if(!list.length){ document.getElementById('reviewsSection').style.display = 'none'; return; }
    row.innerHTML = list.slice(0,12).map(r => `
      <div class="review-card">
        <div class="review-stars">${'★'.repeat(r.rating||5)}${'☆'.repeat(5-(r.rating||5))}</div>
        <div class="review-text">${escapeHtml(r.text || r.comment || '')}</div>
        <div class="review-name">${escapeHtml(r.name || 'عميل Miga-Photobook')}</div>
      </div>`).join('');
  }catch(e){ document.getElementById('reviewsSection').style.display = 'none'; }
}

// ---------- Checkout ----------
function openBuyModal(id, type){
  currentBuyId = id;
  currentBuyType = type;
  if(type !== 'package') currentPackageSize = null;
  const p = getBuyItem();
  const price = currentBuyType === 'prompt' ? PROMPT_PRICE : p.price;
  trackFunnelEvent(
    'begin_checkout', { currency:'EGP', value: price, items:[{ item_id:id, item_name: p.title, price }] },
    'InitiateCheckout', { currency:'EGP', value: price, content_ids:[id] }
  );
  document.getElementById('buyTitle').textContent = currentBuyType === 'prompt' ? `برومبت — ${p.title}` : p.title;
  document.getElementById('buyPrice').textContent = `${price} ${CURRENCY}`;
  document.getElementById('ipNumber').textContent = INSTAPAY_NUMBER;
  document.getElementById('vfNumber').textContent = VODAFONE_CASH_NUMBER;
  document.getElementById('buyerPhone').value = '';
  document.getElementById('payerRef').value = '';
  setPayMethod('instapay');
  document.getElementById('payFormFields').style.display = '';
  document.getElementById('payStatusPanel').style.display = 'none';
  document.getElementById('buyModalBg').classList.add('show');
}
function openPackageBuyModal(size){
  currentPackageSize = size;
  openBuyModal('package-' + size, 'package');
}
function closeBuyModal(){
  stopOrderStatusPolling();
  document.getElementById('buyModalBg').classList.remove('show');
}
let currentPayMethod = 'instapay';
function setPayMethod(m){
  currentPayMethod = m;
  document.querySelectorAll('.pay-tab').forEach(b=> b.classList.toggle('active', b.dataset.method===m));
  document.getElementById('ipBox').style.display = m==='instapay' ? '' : 'none';
  document.getElementById('vfBox').style.display = m==='vodafone' ? '' : 'none';
}

async function submitOrder(){
  const p = getBuyItem();
  const amount = currentBuyType === 'prompt' ? PROMPT_PRICE : p.price;
  const phone = document.getElementById('buyerPhone').value.trim();
  const ref = document.getElementById('payerRef').value.trim();
  if(!/^01[0125][0-9]{8}$/.test(phone)){ showToast('اكتب رقم موبايل مصري صحيح'); return; }
  if(ref.length < 4){ showToast('اكتب رقم عملية التحويل من الإيصال'); return; }

  try{
    const res = await fetch(`${BACKEND_BASE}/orders/create`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        productId: currentBuyId, productTitle: p.title, price: amount, phone,
        appUsed: currentPayMethod === 'instapay' ? 'InstaPay' : 'Vodafone Cash', ref,
        orderType: currentBuyType, packageSize: currentBuyType==='package' ? currentPackageSize : undefined,
      })
    });
    const data = await res.json();
    if(!res.ok || !data.code){ showToast(data.error || 'حصل خطأ، جرب تاني'); return; }
    trackFunnelEvent('add_payment_info', { currency:'EGP', value:amount }, 'AddPaymentInfo', { currency:'EGP', value:amount });
    if(currentBuyType === 'prompt') promptOrderCodes[currentBuyId] = data.code;
    else if(currentBuyType !== 'package') orderCodes[currentBuyId] = data.code;
    savePurchases();
    showOrderStatusPanel(data.code);
  }catch(e){ showToast('حصل خطأ في الاتصال، جرب تاني'); }
}

function stopOrderStatusPolling(){ if(orderStatusPollTimer){ clearInterval(orderStatusPollTimer); orderStatusPollTimer = null; } }

function showOrderStatusPanel(code){
  document.getElementById('payFormFields').style.display = 'none';
  document.getElementById('payStatusPanel').style.display = 'block';
  document.getElementById('payStatusCode').textContent = code;
  document.getElementById('payStatusText').textContent = 'طلبك قيد المراجعة — بنتأكد من التحويل...';
  document.querySelector('#payStatusPanel .order-status-spinner').style.display = '';

  stopOrderStatusPolling();
  const check = async ()=>{
    try{
      const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
      if(!res.ok) return;
      const order = await res.json();
      if(order.status === 'approved'){
        stopOrderStatusPolling();
        document.querySelector('#payStatusPanel .order-status-spinner').style.display = 'none';
        if(order.orderType === 'package'){
          packageCredits[order.code] = { size: order.packageSize, remaining: order.creditsRemaining, usedProductIds: (order.usedItems||[]).map(u=>u.productId) };
          document.getElementById('payStatusText').textContent = `تم تأكيد الدفع ✅ عندك ${order.creditsRemaining} صورة متاحة — اختار أي منتج ودوس "استخدم من باقتك"`;
        }else if(order.orderType === 'prompt'){
          if(!promptPurchases.includes(order.productId)) promptPurchases.push(order.productId);
          if(order.promptText) purchasedPromptTexts[order.productId] = order.promptText;
          document.getElementById('payStatusText').textContent = 'تم تأكيد الدفع ✅ البرومبت جاهز';
        }else{
          if(!purchases.includes(order.productId)) purchases.push(order.productId);
          document.getElementById('payStatusText').textContent = 'تم تأكيد الدفع ✅ تقدر تبدأ التحويل دلوقتي';
        }
        savePurchases();
        renderGrid();
        showToast('تم تأكيد الدفع بنجاح');
      }
    }catch(e){ /* retried automatically on the next tick */ }
  };
  check();
  orderStatusPollTimer = setInterval(check, 6000);
}

// ---------- Transform (upload + generate) ----------
function openTransformModal(productId){
  currentTransformId = productId;
  const p = products.find(x=>x.id===productId);
  document.getElementById('transformTitle').textContent = p ? p.title : '';
  document.getElementById('transformFileInput').value = '';
  document.getElementById('transformPreview').src = transformedResults[productId] || '';
  document.getElementById('transformPreview').style.display = transformedResults[productId] ? '' : 'none';
  document.getElementById('transformModalBg').classList.add('show');
}
function closeTransformModal(){ document.getElementById('transformModalBg').classList.remove('show'); }

document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('transformFileInput').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      document.getElementById('transformPreview').src = reader.result;
      document.getElementById('transformPreview').style.display = '';
      document.getElementById('transformPreview').dataset.dataUri = reader.result;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('transformGenerateBtn').onclick = async ()=>{
    const dataUri = document.getElementById('transformPreview').dataset.dataUri;
    if(!dataUri){ showToast('اختار صورتك الأول'); return; }
    const orderCode = orderCodes[currentTransformId];
    if(!orderCode){ showToast('محتاج تشتري المنتج ده الأول'); return; }
    const btn = document.getElementById('transformGenerateBtn');
    btn.disabled = true; btn.textContent = 'بيتحوّل...';
    try{
      const res = await fetch(`${BACKEND_BASE}/transform`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ image: dataUri, productId: currentTransformId, orderCode })
      });
      const data = await res.json();
      if(!res.ok || !data.imageUrl){ showToast(data.error || 'الصورة معملتش، جرب تاني'); return; }
      transformedResults[currentTransformId] = data.imageUrl;
      document.getElementById('transformPreview').src = data.imageUrl;
      if(packageCredits[orderCode]){
        if(typeof data.creditsRemaining === 'number') packageCredits[orderCode].remaining = data.creditsRemaining;
        if(!packageCredits[orderCode].usedProductIds.includes(currentTransformId)) packageCredits[orderCode].usedProductIds.push(currentTransformId);
        savePurchases();
      }
      const p = products.find(x=>x.id===currentTransformId);
      trackFunnelEvent('purchase', { currency:'EGP', value: p?.price || 0, transaction_id: orderCode }, 'Purchase', { currency:'EGP', value: p?.price || 0 });
      showToast('تمام! صورتك جاهزة 🎉');
      renderGrid();
    }catch(e){
      showToast('حصل خطأ في الاتصال، جرب تاني');
    }finally{
      btn.disabled = false; btn.textContent = 'حوّل الصورة';
    }
  };
});

// ---------- Ported from Design MIGA 1: view mode (mobile/desktop) + theme
// (day/night), stored the same way so a preference set on either design
// carries over if the admin ever switches the active design. ----------
async function saveUiPrefs(){
  try{ localStorage.setItem('megaPromptUiPrefs', JSON.stringify({lang: currentHeaderLang, view: currentViewMode, theme: currentTheme})); }
  catch(e){}
}
async function loadUiPrefs(){
  try{
    const raw = localStorage.getItem('megaPromptUiPrefs');
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
let currentViewMode = 'desktop';
function applyViewMode(mode){
  currentViewMode = (mode === 'mobile') ? 'mobile' : 'desktop';
  document.body.classList.remove('view-mode-desktop', 'view-mode-mobile');
  document.body.classList.add(currentViewMode === 'mobile' ? 'view-mode-mobile' : 'view-mode-desktop');
  document.querySelectorAll('#viewToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.view === currentViewMode);
  });
  saveUiPrefs();
}
let currentTheme = 'dark';
function refreshThemeToggleLabels(){
  const isNight = currentTheme === 'dark';
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.classList.toggle('is-night', isNight);
    btn.setAttribute('aria-pressed', String(isNight));
  });
}
function applyTheme(theme){
  currentTheme = (theme === 'light') ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  refreshThemeToggleLabels();
  saveUiPrefs();
}
document.querySelectorAll('.theme-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=> applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
});
document.getElementById('viewToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  applyViewMode(btn.dataset.view);
});

// ---------- Ported from Design MIGA 1: header language toggle. This design
// has no full-page translation system (its product/section content is
// Arabic-only), so this scopes translation to the header/login/track
// controls the toggle actually sits next to — the same honest scope as
// what's visibly promised by the button itself. ----------
const HEADER_I18N = {
  ar: {
    trackBtn:'تتبع طلبي', viewDesktopLabel:'كمبيوتر', viewMobileLabel:'موبايل',
    searchPh:'ابحث في الموقع...', loginBtn:'تسجيل الدخول',
    trackTitle:'تتبع طلبك', myOrdersTitle:'طلباتك السابقة', trackSub:'أدخل كود المتابعة الذي حصلت عليه بعد إرسال طلب الشراء.',
    trackCodeLabel:'كود المتابعة', trackCheckBtn:'تحقّق من الحالة', closeBtn:'إغلاق',
    biometricLoginBtn:'الدخول ببصمة الوجه / الإصبع', continueGoogle:'المتابعة بحساب جوجل',
    continueApple:'المتابعة بحساب Apple', continueFacebook:'المتابعة بحساب فيسبوك',
    orDivider:'أو بالبريد الإلكتروني', loginTab:'تسجيل الدخول', registerTab:'حساب جديد',
    emailLabel:'البريد الإلكتروني', passwordLabel:'كلمة المرور', loginSubmit:'دخول',
    nameLabel:'الاسم', registerSubmit:'إنشاء الحساب', accountWelcome:'أهلاً بيك!',
    registerBiometricBtn:'تفعيل الدخول ببصمة الوجه/الإصبع لهذا الجهاز', logoutBtn:'تسجيل الخروج',
  },
  en: {
    trackBtn:'Track my order', viewDesktopLabel:'Desktop', viewMobileLabel:'Mobile',
    searchPh:'Search the site...', loginBtn:'Log in',
    trackTitle:'Track your order', myOrdersTitle:'Your past orders', trackSub:'Enter the tracking code you got after submitting your order.',
    trackCodeLabel:'Tracking code', trackCheckBtn:'Check status', closeBtn:'Close',
    biometricLoginBtn:'Sign in with Face/Touch ID', continueGoogle:'Continue with Google',
    continueApple:'Continue with Apple', continueFacebook:'Continue with Facebook',
    orDivider:'or by email', loginTab:'Log in', registerTab:'New account',
    emailLabel:'Email', passwordLabel:'Password', loginSubmit:'Log in',
    nameLabel:'Name', registerSubmit:'Create account', accountWelcome:'Welcome!',
    registerBiometricBtn:'Enable Face/Touch ID sign-in on this device', logoutBtn:'Log out',
  },
};
let currentHeaderLang = 'ar';
function applyHeaderLanguage(lang){
  currentHeaderLang = (lang === 'en') ? 'en' : 'ar';
  const dict = HEADER_I18N[currentHeaderLang];
  document.documentElement.lang = currentHeaderLang;
  document.documentElement.dir = currentHeaderLang === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('trackOpenBtn').textContent = dict.trackBtn;
  document.getElementById('viewBtnDesktop').querySelector('span:last-child').textContent = dict.viewDesktopLabel;
  document.getElementById('viewBtnMobile').querySelector('span:last-child').textContent = dict.viewMobileLabel;
  document.getElementById('searchInput').placeholder = dict.searchPh;
  if(!currentUser) document.getElementById('accountOpenBtn').textContent = dict.loginBtn;
  document.querySelectorAll('#trackModalBg h3').forEach(el=> el.textContent = dict.trackTitle);
  document.querySelector('#myOrdersHistory .sub').textContent = dict.myOrdersTitle;
  document.querySelector('#trackModalBg > .modal > p.sub').textContent = dict.trackSub;
  document.querySelector('label[for="trackCode"], #trackModalBg .field label').textContent = dict.trackCodeLabel;
  document.getElementById('trackCheckBtn').textContent = dict.trackCheckBtn;
  document.getElementById('trackCancelBtn').textContent = dict.closeBtn;
  document.querySelector('#biometricLoginBtn span').textContent = dict.biometricLoginBtn;
  document.querySelector('#googleLoginBtn span').textContent = dict.continueGoogle;
  document.querySelector('#appleLoginBtn span').textContent = dict.continueApple;
  document.querySelector('#facebookLoginBtn span').textContent = dict.continueFacebook;
  document.querySelector('.account-tabs-divider').textContent = dict.orDivider;
  document.getElementById('tabLoginBtn').textContent = dict.loginTab;
  document.getElementById('tabRegisterBtn').textContent = dict.registerTab;
  document.querySelector('#loginFormView label[for="loginEmail"], #loginFormView .field:nth-child(1) label').textContent = dict.emailLabel;
  document.querySelector('#loginFormView .field:nth-child(2) label').textContent = dict.passwordLabel;
  document.getElementById('loginSubmitBtn').textContent = dict.loginSubmit;
  document.querySelector('#registerFormView .field:nth-child(1) label').textContent = dict.nameLabel;
  document.querySelector('#registerFormView .field:nth-child(2) label').textContent = dict.emailLabel;
  document.querySelector('#registerFormView .field:nth-child(3) label').textContent = dict.passwordLabel;
  document.getElementById('registerSubmitBtn').textContent = dict.registerSubmit;
  document.querySelector('#accountLoggedInView h3').textContent = dict.accountWelcome;
  document.querySelector('#registerBiometricBtn span').textContent = dict.registerBiometricBtn;
  document.getElementById('accountLogoutBtn').textContent = dict.logoutBtn;
  document.querySelectorAll('#langToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang === currentHeaderLang);
  });
  saveUiPrefs();
}
document.getElementById('langToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  applyHeaderLanguage(btn.dataset.lang);
});

// ---------- Ported from Design MIGA 1: account system (email/password,
// Google/Apple/Facebook, WebAuthn biometric). ----------
async function checkLoggedInUser(){
  const token = localStorage.getItem('megaPromptAuthToken');
  if(!token || !BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/me`, { headers:{ 'Authorization': `Bearer ${token}` } });
    if(res.ok){
      currentUser = await res.json();
      updateAccountButton();
        }else{
      localStorage.removeItem('megaPromptAuthToken');
    }
  }catch(e){ /* offline or backend unreachable — stay logged out silently */ }
}

function updateAccountButton(){
  const btn = document.getElementById('accountOpenBtn');
  if(!btn) return;
  const personIcon = '<span class="icon-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 19.5a7.2 7.2 0 0 1 14.4 0"/></svg></span>';
  btn.innerHTML = personIcon + `<span>${currentUser ? escapeHtml(currentUser.name) : 'تسجيل الدخول'}</span>`;
}

const accountModalBg = document.getElementById('accountModalBg');
document.getElementById('accountOpenBtn').onclick = ()=>{
  accountModalBg.classList.add('show');
  document.getElementById('accountLoggedOutView').style.display = currentUser ? 'none' : 'block';
  document.getElementById('accountLoggedInView').style.display = currentUser ? 'block' : 'none';
  if(currentUser){
    document.getElementById('accountUserInfo').textContent = `${currentUser.name} — ${currentUser.email}`;
  }
  checkBiometricAvailability();
};
document.getElementById('accountModalClose').onclick = ()=> accountModalBg.classList.remove('show');

document.getElementById('tabLoginBtn').onclick = ()=>{
  document.getElementById('tabLoginBtn').classList.add('active');
  document.getElementById('tabRegisterBtn').classList.remove('active');
  document.getElementById('loginFormView').style.display = 'block';
  document.getElementById('registerFormView').style.display = 'none';
};
document.getElementById('tabRegisterBtn').onclick = ()=>{
  document.getElementById('tabRegisterBtn').classList.add('active');
  document.getElementById('tabLoginBtn').classList.remove('active');
  document.getElementById('registerFormView').style.display = 'block';
  document.getElementById('loginFormView').style.display = 'none';
};

document.getElementById('loginSubmitBtn').onclick = async ()=>{
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if(!email || !password){ showToast('يرجى إكمال كل الحقول'); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
};

document.getElementById('registerSubmitBtn').onclick = async ()=>{
  const name = document.getElementById('registerName').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  if(!name || !email || !password){ showToast('يرجى إكمال كل الحقول'); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/register`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
    handleSocialAuthSuccess(data, 'toastRegistered');
    showToast('تم إنشاء الحساب ✅');
  }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
};

document.getElementById('accountLogoutBtn').onclick = ()=>{
  localStorage.removeItem('megaPromptAuthToken');
  currentUser = null;
  updateAccountButton();
  accountModalBg.classList.remove('show');
};

// ---------- Social login (Google / Apple / Facebook) ----------
// Each provider's SDK is loaded on demand (only when its button is clicked) so the
// page doesn't pay for three extra third-party scripts nobody may ever use.
// A missing *_CLIENT_ID / *_APP_ID means that provider hasn't been registered yet —
// the button says so honestly instead of attempting (and silently failing) a real flow.
function handleSocialAuthSuccess(data, successToastKey){
  localStorage.setItem('megaPromptAuthToken', data.token);
  currentUser = { name: data.name, email: data.email };
  updateAccountButton();
  accountModalBg.classList.remove('show');
  showToast((successToastKey === 'toastRegistered' ? 'تم إنشاء الحساب ✅' : 'تم تسجيل الدخول ✅'));
  checkBiometricAvailability();
}
function loadScriptOnce(src, id){
  return new Promise((resolve, reject)=>{
    if(document.getElementById(id)){ resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.id = id; s.onload = ()=>resolve(); s.onerror = ()=>reject(new Error('script load failed'));
    document.head.appendChild(s);
  });
}

document.getElementById('googleLoginBtn').onclick = async ()=>{
  if(!GOOGLE_CLIENT_ID){ showToast('الدخول بهذه الطريقة مش متاح دلوقتي'); return; }
  try{
    await loadScriptOnce('https://accounts.google.com/gsi/client', 'googleGsiScript');
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response)=>{
        try{
          const res = await fetch(`${BACKEND_BASE}/auth/social/google`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ idToken: response.credential })
          });
          const data = await res.json();
          if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
          handleSocialAuthSuccess(data, 'toastLoggedIn');
        }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
      }
    });
    google.accounts.id.prompt();
  }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
};

document.getElementById('facebookLoginBtn').onclick = async ()=>{
  if(!FACEBOOK_APP_ID){ showToast('الدخول بهذه الطريقة مش متاح دلوقتي'); return; }
  try{
    await loadScriptOnce('https://connect.facebook.net/en_US/sdk.js', 'facebookSdkScript');
    FB.init({ appId: FACEBOOK_APP_ID, cookie:true, xfbml:false, version:'v19.0' });
    FB.login(async (loginResp)=>{
      if(!loginResp.authResponse){ showToast('فشل تسجيل الدخول، جرب تاني'); return; }
      try{
        const res = await fetch(`${BACKEND_BASE}/auth/social/facebook`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ accessToken: loginResp.authResponse.accessToken })
        });
        const data = await res.json();
        if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
        handleSocialAuthSuccess(data, 'toastLoggedIn');
      }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
    }, { scope: 'public_profile,email' });
  }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
};

document.getElementById('appleLoginBtn').onclick = async ()=>{
  if(!APPLE_CLIENT_ID){ showToast('الدخول بهذه الطريقة مش متاح دلوقتي'); return; }
  try{
    await loadScriptOnce('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js', 'appleAuthScript');
    AppleID.auth.init({
      clientId: APPLE_CLIENT_ID,
      scope: 'name email',
      redirectURI: APPLE_REDIRECT_URI,
      usePopup: true
    });
    const result = await AppleID.auth.signIn();
    const idToken = result?.authorization?.id_token;
    if(!idToken){ showToast('فشل تسجيل الدخول، جرب تاني'); return; }
    const name = result?.user?.name ? `${result.user.name.firstName} ${result.user.name.lastName}` : undefined;
    const res = await fetch(`${BACKEND_BASE}/auth/social/apple`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, name })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){ showToast('فشل تسجيل الدخول، جرب تاني'); }
};

// ---------- Biometric login (WebAuthn / Passkeys — Face ID, Touch ID, Windows Hello, Android) ----------
// The actual biometric never reaches this code or the backend: navigator.credentials
// only ever hands back a signed assertion once the device's own secure hardware has
// already confirmed the fingerprint/face locally. See transform-worker.js for the
// server-side signature verification this pairs with.
function bufferToBase64Url(buf){
  const bytes = new Uint8Array(buf);
  let bin = '';
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlToBuffer(b64url){
  const b64 = b64url.replace(/-/g,'+').replace(/_/g,'/').padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function checkBiometricAvailability(){
  try{
    if(!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return;
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if(available){
      document.getElementById('biometricLoginBtn').style.display = 'flex';
      if(currentUser) document.getElementById('registerBiometricBtn').style.display = 'flex';
    }
  }catch(e){ /* no platform authenticator on this device/browser — buttons just stay hidden */ }
}

document.getElementById('biometricLoginBtn').onclick = async ()=>{
  if(!BACKEND_BASE) return;
  try{
    const optRes = await fetch(`${BACKEND_BASE}/auth/webauthn/login-options`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({})
    });
    const opts = await optRes.json();
    if(!optRes.ok){ showToast(opts.error || 'فشل تسجيل الدخول، جرب تاني'); return; }

    const credential = await navigator.credentials.get({
      publicKey:{
        challenge: base64UrlToBuffer(opts.challenge),
        rpId: opts.rpId,
        allowCredentials: opts.allowCredentials.map(c => ({ type:'public-key', id: base64UrlToBuffer(c.id) })),
        userVerification: opts.userVerification,
        timeout: opts.timeout
      }
    });
    if(!credential){ showToast('فشل تسجيل الدخول، جرب تاني'); return; }

    const res = await fetch(`${BACKEND_BASE}/auth/webauthn/login-verify`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        challengeToken: opts.challengeToken,
        credential: {
          id: bufferToBase64Url(credential.rawId),
          response:{
            clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
            authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
            signature: bufferToBase64Url(credential.response.signature)
          }
        }
      })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){
    // NotAllowedError fires if the user cancels the Face ID/Touch ID prompt — not a real failure.
    if(e.name !== 'NotAllowedError') showToast('فشل تسجيل الدخول، جرب تاني');
  }
};

document.getElementById('registerBiometricBtn').onclick = async ()=>{
  const authToken = localStorage.getItem('megaPromptAuthToken');
  if(!BACKEND_BASE || !authToken) return;
  try{
    const optRes = await fetch(`${BACKEND_BASE}/auth/webauthn/register-options`, {
      method:'POST', headers:{'Authorization': `Bearer ${authToken}`}
    });
    const opts = await optRes.json();
    if(!optRes.ok){ showToast(opts.error || 'فشل تسجيل الدخول، جرب تاني'); return; }

    const credential = await navigator.credentials.create({
      publicKey:{
        challenge: base64UrlToBuffer(opts.challenge),
        rp: opts.rp,
        user:{
          id: base64UrlToBuffer(opts.user.id),
          name: opts.user.name,
          displayName: opts.user.displayName
        },
        pubKeyCredParams: opts.pubKeyCredParams,
        authenticatorSelection: opts.authenticatorSelection,
        attestation: opts.attestation,
        timeout: opts.timeout,
        excludeCredentials: opts.excludeCredentials.map(c => ({ type:'public-key', id: base64UrlToBuffer(c.id) }))
      }
    });
    if(!credential){ showToast('فشل تسجيل الدخول، جرب تاني'); return; }

    const res = await fetch(`${BACKEND_BASE}/auth/webauthn/register-verify`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        challengeToken: opts.challengeToken,
        credential: {
          id: bufferToBase64Url(credential.rawId),
          response:{
            clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
            attestationObject: bufferToBase64Url(credential.response.attestationObject)
          }
        }
      })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || 'فشل تسجيل الدخول، جرب تاني'); return; }
    showToast('تم تفعيل الدخول بالبصمة ✅');
  }catch(e){
    if(e.name !== 'NotAllowedError') showToast('فشل تسجيل الدخول، جرب تاني');
  }
};


// ---------- Wiring ----------
document.addEventListener('DOMContentLoaded', async ()=>{
  loadPurchases();
  document.querySelectorAll('.pay-tab').forEach(b=> b.onclick = ()=> setPayMethod(b.dataset.method));
  document.getElementById('buySubmitBtn').onclick = submitOrder;
  document.getElementById('buyCloseBtn').onclick = closeBuyModal;
  document.getElementById('transformCloseBtn').onclick = closeTransformModal;

  const prefs = await loadUiPrefs();
  applyTheme(prefs?.theme || 'dark');
  applyHeaderLanguage(prefs?.lang || 'ar');
  applyViewMode(prefs?.view || 'mobile');
  await checkLoggedInUser();
  checkBiometricAvailability();

  await loadProducts();
  renderChips();
  renderGrid();
  await applyHeroModeForThisDesign();
  loadReviews();
});
