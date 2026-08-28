// ============================================================================
// Design MIGA 3 — app.js
// Combines what worked in both earlier designs: the interactive before/after
// slider and one-click category filters from Design MIGA 2, plus bilingual
// support and deeper content from Design MIGA 1 — with a few additions of
// its own (a live rating badge, an inline "how it works" strip, a persistent
// package-credit badge, and a multi-example product gallery). No admin panel
// here on purpose — the admin always manages the site from Design MIGA 1's
// URL. Every request below hits the exact same Cloudflare Worker as the
// other designs, so switching the active design never duplicates data.
// ============================================================================

const BACKEND_BASE = "https://miga-photobook-api.magdyfarouk380.workers.dev";
const INSTAPAY_NUMBER = "01202530308";
const VODAFONE_CASH_NUMBER = "01017877978";
const PROMPT_PRICE = 10;
const PROMPT_ORIGINAL_PRICE = 15;
const PACKAGE_CATALOG = {
  10: { price: 200, titleAr: 'باقة الاحترافي — 10 صور', titleEn: 'Professional Package — 10 photos' },
  25: { price: 450, titleAr: 'باقة الوكالة — 25 صورة', titleEn: 'Agency Package — 25 photos' },
};
const CATEGORIES = [
  { id: 'all', ar: 'الكل', en: 'All' },
  { id: 'children', ar: 'أطفال', en: 'Kids' },
  { id: 'male', ar: 'رجالي', en: 'Men' },
  { id: 'female', ar: 'نسائي', en: 'Women' },
  { id: 'business', ar: 'أعمال', en: 'Business' },
  { id: 'cinematic', ar: 'سينمائي', en: 'Cinematic' },
  { id: 'luxury', ar: 'فاخر', en: 'Luxury' },
  { id: 'artistic', ar: 'فني', en: 'Artistic' },
  { id: 'magazine', ar: 'مجلات', en: 'Magazine' },
];

// ---------- Bilingual support ----------
// A lean, purpose-built dictionary (not Design MIGA 1's full one) covering
// just what Design MIGA 3's own markup needs, applied via data-i18n /
// data-i18n-ph attributes exactly like Design MIGA 1's convention.
const I18N = {
  ar: {
    dir: 'rtl', currency: 'جنيه',
    navPricing:'الأسعار', navCta:'اطلب دلوقتي', langBtn:'English',
    heroEyebrow:'نتيجة حقيقية — مش تصميم',
    heroTitle1:'صورتك العادية', heroTitleHi:' تحفة استوديو', heroTitle2:'تتحول لـ', heroTitle3:'قدام عينك دلوقتي',
    heroP:'مش هنقولك "صدقنا" — اسحب الدائرة وشوف الفرق بنفسك. نتيجة احترافية خلال دقائق.',
    heroCtaPrimary:'جرّب بصورتك دلوقتي', heroCtaGhost:'شوف الأسعار',
    trust1:'نتيجة خلال دقائق', trust2:'دفع آمن InstaPay/فودافون كاش',
    step1Num:'1', step1:'اختار الستايل', step2Num:'2', step2:'ادفع وارفع صورتك', step3Num:'3', step3:'استلم نتيجتك',
    sliderHint:'اسحب يمين وشمال، ودوس ‹ › تتنقل بين أمثلة مختلفة',
    productsTitle:'اختار الستايل اللي يعجبك', productsSub:'فلتر واحد بس — من غير ما تفتح وتقفل أقسام.',
    pricingTitle:'الأسعار والباقات', pricingSub:'مسار دفع واحد للكل — مفيش تحويل لواتساب.',
    planSingleTitle:'صورة واحدة', planSingleFeat1:'أي ستايل من التصنيفات', planSingleFeat2:'نتيجة خلال دقائق', planSingleBtn:'اختار صورتك',
    planProTitle:'باقة الاحترافي', planProFeat1:'وفّر 50 جنيه', planProFeat2:'اختيار حر من أي قسم', planBuyBtn:'اطلب الباقة',
    planAgencyTitle:'باقة الوكالة', planAgencyFeat1:'18 جنيه للصورة', planAgencyFeat2:'مناسبة للاستوديوهات',
    whyTitle:'ليه Miga-Photobook؟', why1Title:'احترافية بدون استوديو', why1Body:'نتيجة بجودة استوديو تصوير حقيقي، من غير ما تحجز أو تسافر أو تستأجر معدات.',
    howTitle:'إزاي بيشتغل؟', howLi1:'اختار الستايل اللي عايزه', howLi2:'ادفع وارفع صورتك', howLi3:'استلم نتيجتك خلال دقائق',
    faqTitle:'أسئلة شائعة',
    faqQ1:'قد إيه بتاخد الصورة؟', faqA1:'غالبًا خلال دقائق من رفع صورتك بعد تأكيد الدفع.',
    faqQ2:'لو النتيجة معجبتنيش؟', faqA2:'كلّمنا وهنشوف الحل المناسب.',
    faqQ3:'صوري بتتخزن فين؟', faqA3:'بتتخزن بأمان ومش بتتشارك مع حد.',
    aboutTitle:'من نحن', aboutBody:'Miga-Photobook خدمة تحويل صور بالذكاء الاصطناعي لصور استوديو احترافية، من غير الحاجة لحجز استوديو حقيقي.',
    reviewsTitle:'آراء عملائنا',
    footerText:'© 2026 —', footerV1:'تصفح Design MIGA 1', footerV2:'تصفح Design MIGA 2',
    buyConfirm:'تأكيد الدفع', buyAmountLabel:'المبلغ المطلوب:',
    payInstapayLabel:'حوّل على رقم إنستاباي:', payVodafoneLabel:'حوّل على رقم فودافون كاش:',
    phoneLabel:'رقم موبايلك', phonePh:'01xxxxxxxxx', refLabel:'رقم عملية التحويل (من الإيصال)', refPh:'مثال: 123456789',
    transformSub:'ارفع صورتك الشخصية وهنحوّلها بنفس الستايل ده.', transformBtn:'حوّل الصورة',
    creditBadgePrefix:'رصيد الباقة:', usePackageCreditBtn:'استخدم من باقتك',
    ownedLabel:'تم الشراء ✓', viewResultBtn:'شوف النتيجة', startTransformBtn:'ابدأ التحويل',
    moreExamplesTitle:'أمثلة تانية بنفس الستايل', noMoreExamples:'مفيش أمثلة تانية بنفس الستايل لسه',
    noProductsInCategory:'مفيش منتجات في القسم ده لسه',
    toastPhoneInvalid:'اكتب رقم موبايل مصري صحيح', toastRefInvalid:'اكتب رقم عملية التحويل من الإيصال',
    toastGenericError:'حصل خطأ، جرب تاني', toastNetworkError:'حصل خطأ في الاتصال، جرب تاني',
    toastAlreadyUsedCredit:'استخدمت رصيد باقتك على المنتج ده قبل كده — اختار منتج تاني',
    toastNeedPurchase:'محتاج تشتري المنتج ده الأول', toastPickPhoto:'اختار صورتك الأول',
    toastGenSuccess:'تمام! صورتك جاهزة 🎉', toastOrderApprovedPkg:(n)=>`تم تأكيد الدفع ✅ عندك ${n} صورة متاحة — اختار أي منتج ودوس "استخدم من باقتك"`,
    toastOrderApprovedPrompt:'تم تأكيد الدفع ✅ البرومبت جاهز', toastOrderApprovedTransform:'تم تأكيد الدفع ✅ تقدر تبدأ التحويل دلوقتي',
    toastOrderConfirmed:'تم تأكيد الدفع بنجاح', statusPending:'طلبك قيد المراجعة — بنتأكد من التحويل...',
    noReviewsYet:'',
  },
  en: {
    dir: 'ltr', currency: 'EGP',
    navPricing:'Pricing', navCta:'Order now', langBtn:'العربية',
    heroEyebrow:'A real result — not a mockup',
    heroTitle1:'Your ordinary photo', heroTitleHi:' a studio masterpiece', heroTitle2:'becomes', heroTitle3:'right before your eyes',
    heroP:'We won\'t just tell you — drag the slider and see the difference yourself. A professional result in minutes.',
    heroCtaPrimary:'Try it with your photo', heroCtaGhost:'See pricing',
    trust1:'Result in minutes', trust2:'Secure payment via InstaPay/Vodafone Cash',
    step1Num:'1', step1:'Pick a style', step2Num:'2', step2:'Pay & upload your photo', step3Num:'3', step3:'Get your result',
    sliderHint:'Drag left and right, or use ‹ › to browse different examples',
    productsTitle:'Pick the style you like', productsSub:'One filter — no opening and closing sections.',
    pricingTitle:'Pricing & Packages', pricingSub:'One checkout for everything — no WhatsApp detour.',
    planSingleTitle:'Single Photo', planSingleFeat1:'Any style from any category', planSingleFeat2:'Result in minutes', planSingleBtn:'Pick your photo',
    planProTitle:'Professional Package', planProFeat1:'Save 50 EGP', planProFeat2:'Free choice from any category', planBuyBtn:'Order this package',
    planAgencyTitle:'Agency Package', planAgencyFeat1:'18 EGP per photo', planAgencyFeat2:'Great for studios',
    whyTitle:'Why Miga-Photobook?', why1Title:'Professional, no studio needed', why1Body:'Real studio-quality results without booking, traveling, or renting equipment.',
    howTitle:'How does it work?', howLi1:'Pick the style you want', howLi2:'Pay and upload your photo', howLi3:'Get your result in minutes',
    faqTitle:'Frequently Asked Questions',
    faqQ1:'How long does it take?', faqA1:'Usually a few minutes after your photo is uploaded and payment is confirmed.',
    faqQ2:'What if I don\'t like the result?', faqA2:'Reach out and we\'ll find the right fix.',
    faqQ3:'Where are my photos stored?', faqA3:'Stored securely and never shared with anyone.',
    aboutTitle:'About Us', aboutBody:'Miga-Photobook is an AI photo transformation service delivering professional studio photos, no real studio required.',
    reviewsTitle:'Customer Reviews',
    footerText:'© 2026 —', footerV1:'Browse Design MIGA 1', footerV2:'Browse Design MIGA 2',
    buyConfirm:'Confirm Payment', buyAmountLabel:'Amount due:',
    payInstapayLabel:'Transfer to InstaPay number:', payVodafoneLabel:'Transfer to Vodafone Cash number:',
    phoneLabel:'Your mobile number', phonePh:'01xxxxxxxxx', refLabel:'Transfer reference number (from receipt)', refPh:'e.g. 123456789',
    transformSub:'Upload your personal photo and we\'ll transform it into this style.', transformBtn:'Transform photo',
    creditBadgePrefix:'Package credits:', usePackageCreditBtn:'Use a package credit',
    ownedLabel:'Purchased ✓', viewResultBtn:'View result', startTransformBtn:'Start transform',
    moreExamplesTitle:'More examples of this style', noMoreExamples:'No other examples of this style yet',
    noProductsInCategory:'No products in this category yet',
    toastPhoneInvalid:'Enter a valid Egyptian mobile number', toastRefInvalid:'Enter the transfer reference number from your receipt',
    toastGenericError:'Something went wrong, try again', toastNetworkError:'Connection error, try again',
    toastAlreadyUsedCredit:'You already used a package credit on this product — pick a different one',
    toastNeedPurchase:'You need to buy this product first', toastPickPhoto:'Pick your photo first',
    toastGenSuccess:'Done! Your photo is ready 🎉', toastOrderApprovedPkg:(n)=>`Payment confirmed ✅ You have ${n} photos available — pick any product and tap "Use a package credit"`,
    toastOrderApprovedPrompt:'Payment confirmed ✅ Your prompt is ready', toastOrderApprovedTransform:'Payment confirmed ✅ You can start transforming now',
    toastOrderConfirmed:'Payment confirmed successfully', statusPending:'Your order is under review — confirming your transfer...',
    noReviewsYet:'',
  },
};
let currentLang = 'ar';
function t(key){
  const v = I18N[currentLang][key];
  return v === undefined ? key : v;
}
function applyLang(lang){
  currentLang = (lang === 'en') ? 'en' : 'ar';
  document.documentElement.lang = currentLang;
  document.documentElement.dir = I18N[currentLang].dir;
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if(typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el=>{
    const key = el.getAttribute('data-i18n-ph');
    const val = t(key);
    if(typeof val === 'string') el.placeholder = val;
  });
  try{ localStorage.setItem('megaPromptLangV3', currentLang); }catch(e){}
  renderChips();
  renderGrid();
}
function catLabel(c){ return currentLang === 'en' ? c.en : c.ar; }

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
    return { id: currentBuyId, title: currentLang==='en' ? pkg.titleEn : pkg.titleAr, price: pkg.price, category: null };
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

function updateCreditBadge(){
  const pkg = activePackageWithCredits();
  const badge = document.getElementById('creditBadge');
  if(pkg){
    badge.textContent = `${t('creditBadgePrefix')} ${pkg.remaining}`;
    badge.classList.add('show');
  }else{
    badge.classList.remove('show');
  }
}

function renderChips(){
  const row = document.getElementById('chipRow');
  row.innerHTML = CATEGORIES.map(c =>
    `<button type="button" class="chip ${c.id===activeCategory?'active':''}" data-cat="${c.id}">${escapeHtml(catLabel(c))}</button>`
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
    grid.innerHTML = `<div class="empty-note">${escapeHtml(t('noProductsInCategory'))}</div>`;
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
      <img src="${p.image}" alt="${escapeHtml(productTitle(p))}" loading="lazy" onclick="openProductDetail('${p.id}')" style="cursor:pointer;">
      <span class="card-badge">${escapeHtml(productTitle(p))}</span>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(productTitle(p))}</div>
      ${owned ? `<span class="owned-pill">${escapeHtml(t('ownedLabel'))}</span>` : ''}
      ${owned
        ? `<button class="buy-btn" onclick="openTransformModal('${p.id}')">${transformedResults[p.id] ? escapeHtml(t('viewResultBtn')) : escapeHtml(t('startTransformBtn'))}</button>`
        : `<button class="buy-btn" onclick="openBuyModal('${p.id}', 'transform')">${escapeHtml(t('planSingleBtn'))} — ${p.price} ${t('currency')}</button>`}
      ${pkgAvailableHere ? `<button class="buy-btn package-credit-btn" onclick="usePackageCredit('${p.id}')">${escapeHtml(t('usePackageCreditBtn'))} (${activePkg.remaining})</button>` : ''}
    </div>
  </div>`;
}

function usePackageCredit(productId){
  const pkg = activePackageWithCredits();
  if(!pkg) return;
  if(pkg.usedProductIds.includes(productId)){
    showToast(t('toastAlreadyUsedCredit'));
    return;
  }
  orderCodes[productId] = pkg.code;
  if(!purchases.includes(productId)) purchases.push(productId);
  savePurchases();
  renderGrid();
  updateCreditBadge();
  openTransformModal(productId);
}

let transformedResults = {};

// ---------- Product detail (multiple real examples of the same style) ----------
// Reuses genuinely existing data — other products already published in the
// same category — rather than inventing example images that don't exist.
function openProductDetail(productId){
  const p = products.find(x=>x.id===productId);
  if(!p) return;
  document.getElementById('detailTitle').textContent = productTitle(p);
  document.getElementById('detailMainImg').src = p.image;
  const others = products.filter(x=>x.id!==productId && x.category===p.category).slice(0,6);
  const gallery = document.getElementById('detailGallery');
  document.getElementById('detailGalleryTitle').textContent = t('moreExamplesTitle');
  gallery.innerHTML = others.length
    ? others.map(o=>`<img src="${o.image}" alt="${escapeHtml(productTitle(o))}" onclick="openLightbox('${o.image}')">`).join('')
    : `<div class="empty-note">${escapeHtml(t('noMoreExamples'))}</div>`;
  document.getElementById('detailBuyBtn').onclick = ()=>{
    document.getElementById('detailModalBg').classList.remove('show');
    if(purchases.includes(productId)) openTransformModal(productId);
    else openBuyModal(productId, 'transform');
  };
  updateDetailBuyBtnLabel(p);
  document.getElementById('detailModalBg').classList.add('show');
}
function updateDetailBuyBtnLabel(p){
  const owned = purchases.includes(p.id);
  document.getElementById('detailBuyBtn').textContent = owned
    ? t('startTransformBtn')
    : `${t('planSingleBtn')} — ${p.price} ${t('currency')}`;
}

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

  let angle = 0;
  (function autoDemo(){
    if(sliderDemo && !sliderDragging && sliderPairs.length){
      angle += 0.014;
      const pct = 50 + Math.sin(angle) * 24;
      wrap.style.setProperty('--pos', pct + '%');
      line.style.setProperty('--posR', (100-pct) + '%');
      handle.style.setProperty('--posR', (100-pct) + '%');
    }
    requestAnimationFrame(autoDemo);
  })();
}

// ---------- Reviews (+ the hero's live rating badge, computed from the
// exact same real data — never a separate, possibly-stale number). ----------
async function loadReviews(){
  try{
    const res = await fetch(`${BACKEND_BASE}/reviews/list`);
    const data = await res.json();
    const list = Array.isArray(data.reviews) ? data.reviews : (Array.isArray(data) ? data : []);
    const row = document.getElementById('reviewRow');
    const badge = document.getElementById('ratingBadge');
    if(!list.length){
      document.getElementById('reviewsSection').style.display = 'none';
      badge.style.display = 'none';
      return;
    }
    row.innerHTML = list.slice(0,12).map(r => `
      <div class="review-card">
        <div class="review-stars">${'★'.repeat(r.rating||5)}${'☆'.repeat(5-(r.rating||5))}</div>
        <div class="review-text">${escapeHtml(r.text || r.comment || '')}</div>
        <div class="review-name">${escapeHtml(r.name || 'Miga-Photobook')}</div>
      </div>`).join('');

    const avg = list.reduce((sum,r)=> sum + (r.rating||5), 0) / list.length;
    const avgRounded = Math.round(avg * 10) / 10;
    const fullStars = Math.round(avg);
    badge.innerHTML = `<span class="stars">${'★'.repeat(fullStars)}${'☆'.repeat(5-fullStars)}</span> ${avgRounded} (${list.length})`;
    badge.style.display = '';
  }catch(e){
    document.getElementById('reviewsSection').style.display = 'none';
    document.getElementById('ratingBadge').style.display = 'none';
  }
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
  document.getElementById('buyPrice').textContent = `${price} ${t('currency')}`;
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
  if(!/^01[0125][0-9]{8}$/.test(phone)){ showToast(t('toastPhoneInvalid')); return; }
  if(ref.length < 4){ showToast(t('toastRefInvalid')); return; }

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
    if(!res.ok || !data.code){ showToast(data.error || t('toastGenericError')); return; }
    trackFunnelEvent('add_payment_info', { currency:'EGP', value:p.price }, 'AddPaymentInfo', { currency:'EGP', value:p.price });
    if(currentBuyType === 'prompt') promptOrderCodes[currentBuyId] = data.code;
    else if(currentBuyType !== 'package') orderCodes[currentBuyId] = data.code;
    savePurchases();
    showOrderStatusPanel(data.code);
  }catch(e){ showToast(t('toastNetworkError')); }
}

function stopOrderStatusPolling(){ if(orderStatusPollTimer){ clearInterval(orderStatusPollTimer); orderStatusPollTimer = null; } }

function showOrderStatusPanel(code){
  document.getElementById('payFormFields').style.display = 'none';
  document.getElementById('payStatusPanel').style.display = 'block';
  document.getElementById('payStatusCode').textContent = code;
  document.getElementById('payStatusText').textContent = t('statusPending');
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
          document.getElementById('payStatusText').textContent = t('toastOrderApprovedPkg')(order.creditsRemaining);
        }else if(order.orderType === 'prompt'){
          if(!promptPurchases.includes(order.productId)) promptPurchases.push(order.productId);
          if(order.promptText) purchasedPromptTexts[order.productId] = order.promptText;
          document.getElementById('payStatusText').textContent = t('toastOrderApprovedPrompt');
        }else{
          if(!purchases.includes(order.productId)) purchases.push(order.productId);
          document.getElementById('payStatusText').textContent = t('toastOrderApprovedTransform');
        }
        savePurchases();
        renderGrid();
        updateCreditBadge();
        showToast(t('toastOrderConfirmed'));
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
    if(!dataUri){ showToast(t('toastPickPhoto')); return; }
    const orderCode = orderCodes[currentTransformId];
    if(!orderCode){ showToast(t('toastNeedPurchase')); return; }
    const btn = document.getElementById('transformGenerateBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true; btn.textContent = currentLang==='en' ? 'Transforming...' : 'بيتحوّل...';
    try{
      const res = await fetch(`${BACKEND_BASE}/transform`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ image: dataUri, productId: currentTransformId, orderCode })
      });
      const data = await res.json();
      if(!res.ok || !data.imageUrl){ showToast(data.error || t('toastGenericError')); return; }
      transformedResults[currentTransformId] = data.imageUrl;
      document.getElementById('transformPreview').src = data.imageUrl;
      if(packageCredits[orderCode]){
        if(typeof data.creditsRemaining === 'number') packageCredits[orderCode].remaining = data.creditsRemaining;
        if(!packageCredits[orderCode].usedProductIds.includes(currentTransformId)) packageCredits[orderCode].usedProductIds.push(currentTransformId);
        savePurchases();
        updateCreditBadge();
      }
      const p = products.find(x=>x.id===currentTransformId);
      trackFunnelEvent('purchase', { currency:'EGP', value: p?.price || 0, transaction_id: orderCode }, 'Purchase', { currency:'EGP', value: p?.price || 0 });
      showToast(t('toastGenSuccess'));
      renderGrid();
    }catch(e){
      showToast(t('toastNetworkError'));
    }finally{
      btn.disabled = false; btn.textContent = t('transformBtn') || originalLabel;
    }
  };
});

// ---------- Wiring ----------
document.addEventListener('DOMContentLoaded', async ()=>{
  loadPurchases();
  try{ currentLang = localStorage.getItem('megaPromptLangV3') === 'en' ? 'en' : 'ar'; }catch(e){ currentLang = 'ar'; }

  document.querySelectorAll('.pay-tab').forEach(b=> b.onclick = ()=> setPayMethod(b.dataset.method));
  document.getElementById('buySubmitBtn').onclick = submitOrder;
  document.getElementById('buyCloseBtn').onclick = closeBuyModal;
  document.getElementById('transformCloseBtn').onclick = closeTransformModal;
  document.getElementById('langToggleBtn').onclick = ()=> applyLang(currentLang === 'ar' ? 'en' : 'ar');

  await loadProducts();
  applyLang(currentLang); // sets dir/lang, translates static markup, and does the first chips+grid render
  updateCreditBadge();
  initSlider();
  loadSliderPairs();
  loadReviews();
});
