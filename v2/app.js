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
const PACKAGE_CATALOG = {
  10: { price: 200, title: 'باقة الاحترافي — 10 صور' },
  25: { price: 450, title: 'باقة الوكالة — 25 صورة' },
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

function renderGrid(){
  const grid = document.getElementById('productGrid');
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
    </div>
  </div>`;
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
let sliderPairs = [];
let sliderCurrent = 0;
let sliderDemo = true;
let sliderDragging = false;

async function loadSliderPairs(){
  try{
    const res = await fetch(`${BACKEND_BASE}/showcase`);
    const data = await res.json();
    if(data && data.center && Array.isArray(data.items) && data.items.length){
      sliderPairs = data.items.filter(Boolean).map(after => ({ before: data.center, after }));
    }
  }catch(e){ /* fall through to the static fallback below */ }
  if(!sliderPairs.length){
    // Fallback so the hero never ships broken if the admin hasn't configured
    // the showcase yet — reuses the first couple of real product photos.
    const withImages = products.filter(p=>p.image).slice(0,3);
    sliderPairs = withImages.map(p => ({ before: withImages[0]?.image, after: p.image }));
  }
  if(!sliderPairs.length) return;
  renderSliderDots();
  renderSliderPair(0);
}

function renderSliderDots(){
  const el = document.getElementById('sliderDots');
  el.innerHTML = sliderPairs.map((_,i)=>`<button type="button" class="slider-dot" aria-label="مثال ${i+1}"></button>`).join('');
  [...el.children].forEach((d,i)=> d.onclick = ()=> renderSliderPair(i));
}
function renderSliderPair(index){
  if(!sliderPairs.length) return;
  sliderCurrent = ((index % sliderPairs.length) + sliderPairs.length) % sliderPairs.length;
  const pair = sliderPairs[sliderCurrent];
  document.getElementById('imgBefore').src = pair.before;
  document.getElementById('imgAfter').src = pair.after;
  const wrap = document.getElementById('afterWrap');
  const line = document.getElementById('sliderLine');
  const handle = document.getElementById('sliderHandle');
  wrap.style.setProperty('--pos','50%'); line.style.setProperty('--posR','50%'); handle.style.setProperty('--posR','50%');
  sliderDemo = true;
  [...document.getElementById('sliderDots').children].forEach((d,i)=> d.classList.toggle('active', i===sliderCurrent));
}
function initSlider(){
  const card = document.getElementById('bafSlider');
  const handle = document.getElementById('sliderHandle');
  const wrap = document.getElementById('afterWrap');
  const line = document.getElementById('sliderLine');

  function setPos(clientX){
    const rect = card.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    const pct = (x / rect.width) * 100;
    wrap.style.setProperty('--pos', pct + '%');
    line.style.setProperty('--posR', (100-pct) + '%');
    handle.style.setProperty('--posR', (100-pct) + '%');
  }
  function start(e){ sliderDragging = true; sliderDemo = false; move(e); }
  function move(e){ if(!sliderDragging) return; setPos(e.touches ? e.touches[0].clientX : e.clientX); }
  function end(){ sliderDragging = false; }

  handle.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  handle.addEventListener('touchstart', start, {passive:true});
  window.addEventListener('touchmove', move, {passive:true});
  window.addEventListener('touchend', end);
  document.getElementById('navPrev').onclick = ()=> renderSliderPair(sliderCurrent-1);
  document.getElementById('navNext').onclick = ()=> renderSliderPair(sliderCurrent+1);

  let t = 0;
  (function autoDemo(){
    if(sliderDemo && !sliderDragging && sliderPairs.length){
      t += 0.014;
      const pct = 50 + Math.sin(t) * 24;
      wrap.style.setProperty('--pos', pct + '%');
      line.style.setProperty('--posR', (100-pct) + '%');
      handle.style.setProperty('--posR', (100-pct) + '%');
    }
    requestAnimationFrame(autoDemo);
  })();
}

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
  const price = p.price;
  trackFunnelEvent(
    'begin_checkout', { currency:'EGP', value: price, items:[{ item_id:id, item_name: p.title, price }] },
    'InitiateCheckout', { currency:'EGP', value: price, content_ids:[id] }
  );
  document.getElementById('buyTitle').textContent = p.title;
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
  const phone = document.getElementById('buyerPhone').value.trim();
  const ref = document.getElementById('payerRef').value.trim();
  if(!/^01[0125][0-9]{8}$/.test(phone)){ showToast('اكتب رقم موبايل مصري صحيح'); return; }
  if(ref.length < 4){ showToast('اكتب رقم عملية التحويل من الإيصال'); return; }

  try{
    const res = await fetch(`${BACKEND_BASE}/orders/create`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        productId: currentBuyId, productTitle: p.title, price: p.price, phone,
        appUsed: currentPayMethod === 'instapay' ? 'InstaPay' : 'Vodafone Cash', ref,
        orderType: currentBuyType, packageSize: currentBuyType==='package' ? currentPackageSize : undefined,
      })
    });
    const data = await res.json();
    if(!res.ok || !data.code){ showToast(data.error || 'حصل خطأ، جرب تاني'); return; }
    trackFunnelEvent('add_payment_info', { currency:'EGP', value:p.price }, 'AddPaymentInfo', { currency:'EGP', value:p.price });
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

// ---------- Wiring ----------
document.addEventListener('DOMContentLoaded', async ()=>{
  loadPurchases();
  document.querySelectorAll('.pay-tab').forEach(b=> b.onclick = ()=> setPayMethod(b.dataset.method));
  document.getElementById('buySubmitBtn').onclick = submitOrder;
  document.getElementById('buyCloseBtn').onclick = closeBuyModal;
  document.getElementById('transformCloseBtn').onclick = closeTransformModal;

  await loadProducts();
  renderChips();
  renderGrid();
  initSlider();
  loadSliderPairs();
  loadReviews();
});
