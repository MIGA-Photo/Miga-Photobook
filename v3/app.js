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
  3:  { price: 59,  titleAr: 'باقة Starter — 3 صور',  titleEn: 'Starter Package — 3 photos' },
  15: { price: 259, titleAr: 'باقة Pro — 15 صورة',    titleEn: 'Pro Package — 15 photos' },
  30: { price: 419, titleAr: 'باقة Premium — 30 صورة', titleEn: 'Premium Package — 30 photos' },
  // "Monthly" subscription-style packages — same underlying credits
  // mechanism as the packages above (no auto-recurring billing exists),
  // just marketed with a monthly framing to encourage repeat purchases.
  10: { price: 149, titleAr: 'اشتراك شهري — 10 صور/شهريًا', titleEn: 'Monthly Subscription — 10 photos/month' },
  20: { price: 299, titleAr: 'اشتراك شهري — 20 صورة/شهريًا', titleEn: 'Monthly Subscription — 20 photos/month' },
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
    heroCtaPrimary:'جرّب بصورتك <b class="brand-mega">ميجا</b> دلوقتي', heroCtaGhost:'شوف الأسعار',
    trust1:'نتيجة خلال دقائق', trust2:'دفع آمن InstaPay/فودافون كاش',
    step1Num:'1', step1:'اختار الستايل', step2Num:'2', step2:'ادفع وارفع صورتك', step3Num:'3', step3:'استلم نتيجتك',
    sliderHint:'اسحب يمين وشمال، ودوس ‹ › تتنقل بين أمثلة مختلفة',
    productsTitle:'اختار الستايل اللي يعجبك', productsSub:'فلتر واحد بس — من غير ما تفتح وتقفل أقسام.',
    pricingTitle:'الأسعار والباقات', pricingSub:'اختار الباقة اللي تناسبك — كل باقة بتوفّرلك سعر أقل للصورة.',
    planStarterTitle:'باقة Starter', planStarterFeat1:'تقريبًا 20 جنيه للصورة', planStarterFeat2:'اختيار حر من أي قسم',
    planProTitle:'باقة Pro', planProFeat1:'أقل من 18 جنيه للصورة', planProFeat2:'اختيار حر من أي قسم', planBuyBtn:'اطلب الباقة',
    planPremiumTitle:'باقة Premium', planPremiumFeat1:'أقل من 14 جنيه للصورة', planPremiumFeat2:'مناسبة للاستوديوهات',
    subTitle:'اشترك شهريًا ووفّر أكتر', subSub:'أسلوب جديد كل شهر، ورصيد صور يتجدد — التجديد بنفس خطوات الدفع اليدوي (مش خصم تلقائي).',
    subUnitMonthly:'/ شهريًا', subPlanFeatCommon:'أساليب جديدة تُضاف شهريًا', subPlanBuyBtn:'اشترك دلوقتي',
    subPlan1Title:'اشتراك شهري — 10 صور', subPlan1Feat1:'10 صور كل شهر',
    subPlan2Title:'اشتراك شهري — 20 صورة', subPlan2Feat1:'20 صورة كل شهر', subPlan2Feat2:'أفضل قيمة للاستخدام المستمر',
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
    businessHeading:'احصل على صورة LinkedIn تزيد احترافيتك خلال 5 دقائق',
    // ---------- Ported from Design MIGA 1: header controls, account modal, track order ----------
    viewDesktopLabel:'كمبيوتر', viewMobileLabel:'موبايل', trackBtn:'تتبع طلبي', loginBtn:'تسجيل الدخول',
    searchPlaceholder:'ابحث في الموقع...',
    trackModalTitle:'تتبع طلبك', myOrdersTitle:'طلباتك السابقة', trackModalSub:'أدخل كود المتابعة الذي حصلت عليه بعد إرسال طلب الشراء.',
    trackCodeLabel:'كود المتابعة', trackCodePh:'مثال: A1B2C3', trackCheckBtn:'تحقّق من الحالة', closeBtn:'إغلاق',
    biometricLoginBtn:'الدخول ببصمة الوجه / الإصبع', continueGoogle:'المتابعة بحساب جوجل',
    continueApple:'المتابعة بحساب Apple', continueFacebook:'المتابعة بحساب فيسبوك',
    orDivider:'أو بالبريد الإلكتروني', loginTab:'تسجيل الدخول', registerTab:'حساب جديد',
    emailLabel:'البريد الإلكتروني', passwordLabel:'كلمة المرور', loginSubmit:'دخول',
    nameLabel:'الاسم', registerSubmit:'إنشاء الحساب', accountWelcome:'أهلاً بيك!',
    registerBiometricBtn:'تفعيل الدخول ببصمة الوجه/الإصبع لهذا الجهاز', logoutBtn:'تسجيل الخروج',
    accountBtnGuest:'تسجيل الدخول', toastAuthFailed:'فشل تسجيل الدخول، جرب تاني',
    toastBiometricRegistered:'تم تفعيل الدخول بالبصمة ✅', toastFillFields:'يرجى إكمال كل الحقول',
    toastRegistered:'تم إنشاء الحساب ✅', toastLoggedIn:'تم تسجيل الدخول ✅',
    toastSocialNotConfigured:'الدخول بهذه الطريقة مش متاح دلوقتي',
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
    heroCtaPrimary:'Try your <b class="brand-mega">Mega</b> photo now', heroCtaGhost:'See pricing',
    trust1:'Result in minutes', trust2:'Secure payment via InstaPay/Vodafone Cash',
    step1Num:'1', step1:'Pick a style', step2Num:'2', step2:'Pay & upload your photo', step3Num:'3', step3:'Get your result',
    sliderHint:'Drag left and right, or use ‹ › to browse different examples',
    productsTitle:'Pick the style you like', productsSub:'One filter — no opening and closing sections.',
    pricingTitle:'Pricing & Packages', pricingSub:'Pick the package that fits — the more photos, the lower the price per photo.',
    planStarterTitle:'Starter Package', planStarterFeat1:'About 20 EGP per photo', planStarterFeat2:'Free choice from any category',
    planProTitle:'Pro Package', planProFeat1:'Under 18 EGP per photo', planProFeat2:'Free choice from any category', planBuyBtn:'Order this package',
    planPremiumTitle:'Premium Package', planPremiumFeat1:'Under 14 EGP per photo', planPremiumFeat2:'Great for studios',
    subTitle:'Subscribe monthly and save more', subSub:'A new style every month, and a credit balance that renews — renewal uses the same manual payment steps (not auto-billed).',
    subUnitMonthly:'/ month', subPlanFeatCommon:'New styles added monthly', subPlanBuyBtn:'Subscribe now',
    subPlan1Title:'Monthly Subscription — 10 photos', subPlan1Feat1:'10 photos every month',
    subPlan2Title:'Monthly Subscription — 20 photos', subPlan2Feat1:'20 photos every month', subPlan2Feat2:'Best value for ongoing use',
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
    businessHeading:'Get a LinkedIn photo that boosts your professionalism in 5 minutes',
    // ---------- Ported from Design MIGA 1: header controls, account modal, track order ----------
    viewDesktopLabel:'Desktop', viewMobileLabel:'Mobile', trackBtn:'Track my order', loginBtn:'Log in',
    searchPlaceholder:'Search the site...',
    trackModalTitle:'Track your order', myOrdersTitle:'Your past orders', trackModalSub:'Enter the tracking code you got after submitting your order.',
    trackCodeLabel:'Tracking code', trackCodePh:'e.g. A1B2C3', trackCheckBtn:'Check status', closeBtn:'Close',
    biometricLoginBtn:'Sign in with Face/Touch ID', continueGoogle:'Continue with Google',
    continueApple:'Continue with Apple', continueFacebook:'Continue with Facebook',
    orDivider:'or by email', loginTab:'Log in', registerTab:'New account',
    emailLabel:'Email', passwordLabel:'Password', loginSubmit:'Log in',
    nameLabel:'Name', registerSubmit:'Create account', accountWelcome:'Welcome!',
    registerBiometricBtn:'Enable Face/Touch ID sign-in on this device', logoutBtn:'Log out',
    accountBtnGuest:'Log in', toastAuthFailed:'Login failed, try again',
    toastBiometricRegistered:'Biometric sign-in enabled ✅', toastFillFields:'Please fill in all fields',
    toastRegistered:'Account created ✅', toastLoggedIn:'Logged in ✅',
    toastSocialNotConfigured:'This sign-in method isn\'t available yet',
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
// ---------- Ported from Design MIGA 1: account system config ----------
const GOOGLE_CLIENT_ID = "";
const FACEBOOK_APP_ID = "";
const APPLE_CLIENT_ID = "";
const APPLE_REDIRECT_URI = window.location.origin + window.location.pathname;
let currentUser = null; // { name, email }

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
  // Supports embedded markup (e.g. a bold "ميجا"/"Mega") — data-i18n above
  // only ever sets plain textContent, which would strip any HTML tags.
  document.querySelectorAll('[data-i18n-html]').forEach(el=>{
    const key = el.getAttribute('data-i18n-html');
    const val = t(key);
    if(typeof val === 'string') el.innerHTML = val;
  });
  document.querySelectorAll('#langToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
  if(!currentUser){
    const acctBtn = document.getElementById('accountOpenBtn');
    if(acctBtn) acctBtn.textContent = t('accountBtnGuest');
  }
  try{ localStorage.setItem('megaPromptLangV3', currentLang); }catch(e){}
  renderChips();
  renderGrid();
}
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('langToggle').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(btn) applyLang(btn.dataset.lang);
  });
});

// ---------- Ported from Design MIGA 1: view mode (mobile/desktop) + theme
// (day/night). ----------
let currentViewMode = 'desktop';
function applyViewMode(mode){
  currentViewMode = (mode === 'mobile') ? 'mobile' : 'desktop';
  document.body.classList.remove('view-mode-desktop', 'view-mode-mobile');
  document.body.classList.add(currentViewMode === 'mobile' ? 'view-mode-mobile' : 'view-mode-desktop');
  document.querySelectorAll('#viewToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.view === currentViewMode);
  });
  try{ localStorage.setItem('megaPromptViewV3', currentViewMode); }catch(e){}
}
let currentTheme = 'dark';
function applyTheme(theme){
  currentTheme = (theme === 'light') ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.classList.toggle('is-night', currentTheme === 'dark');
    btn.setAttribute('aria-pressed', String(currentTheme === 'dark'));
  });
  try{ localStorage.setItem('megaPromptThemeV3', currentTheme); }catch(e){}
}
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.addEventListener('click', ()=> applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
  });
  document.getElementById('viewToggle').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(btn) applyViewMode(btn.dataset.view);
  });
});

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

const CATEGORY_HEADING_KEYS = { business: 'businessHeading' };
function renderGrid(){
  const grid = document.getElementById('productGrid');
  const heading = document.getElementById('categoryHeading');
  const headingKey = CATEGORY_HEADING_KEYS[activeCategory];
  if(headingKey){
    heading.textContent = t(headingKey);
    heading.style.display = '';
  }else{
    heading.style.display = 'none';
  }
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

// ---------- Hero showcase mode (circle vs slider), chosen per-design from
// the admin panel's "تصميم الموقع" tab. Design MIGA 3 defaults to its
// original slider if nothing has been chosen yet. ----------
async function applyHeroModeForThisDesign(){
  let mode = 'slider';
  try{
    const res = await fetch(`${BACKEND_BASE}/site-config`);
    const data = await res.json();
    if(data && data.heroModes && data.heroModes.v3) mode = data.heroModes.v3;
  }catch(e){ /* network hiccup — keep this design's original default */ }

  // The permanent slider (right below the nav) is unconditional — always a
  // slider, always on, regardless of the toggle further down.
  const pairs = await loadSliderData();
  const fixedInst = initSliderInstance('bafSliderFixed');
  if(fixedInst && pairs.length) fixedInst.setPairs(pairs);

  const circleEl = document.getElementById('heroVariantCircle');
  const sliderEl = document.getElementById('heroVariantSlider');
  if(!circleEl || !sliderEl) return;
  if(mode === 'circle'){
    circleEl.hidden = false;
    sliderEl.hidden = true;
  }else{
    circleEl.hidden = true;
    sliderEl.hidden = false;
    const inst = initSliderInstance('bafSliderV3');
    if(inst && pairs.length) inst.setPairs(pairs);
  }
}

// ---------- Reviews (+ the hero's live rating badge, computed from the
// exact same real data — never a separate, possibly-stale number). ----------
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
  btn.innerHTML = personIcon + `<span>${currentUser ? escapeHtml(currentUser.name) : t('accountBtnGuest')}</span>`;
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
  if(!email || !password){ showToast(t('toastFillFields')); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){ showToast(t('toastAuthFailed')); }
};

document.getElementById('registerSubmitBtn').onclick = async ()=>{
  const name = document.getElementById('registerName').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  if(!name || !email || !password){ showToast(t('toastFillFields')); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/register`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
    handleSocialAuthSuccess(data, 'toastRegistered');
    showToast(t('toastRegistered'));
  }catch(e){ showToast(t('toastAuthFailed')); }
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
  showToast(t(successToastKey));
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
  if(!GOOGLE_CLIENT_ID){ showToast(t('toastSocialNotConfigured')); return; }
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
          if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
          handleSocialAuthSuccess(data, 'toastLoggedIn');
        }catch(e){ showToast(t('toastAuthFailed')); }
      }
    });
    google.accounts.id.prompt();
  }catch(e){ showToast(t('toastAuthFailed')); }
};

document.getElementById('facebookLoginBtn').onclick = async ()=>{
  if(!FACEBOOK_APP_ID){ showToast(t('toastSocialNotConfigured')); return; }
  try{
    await loadScriptOnce('https://connect.facebook.net/en_US/sdk.js', 'facebookSdkScript');
    FB.init({ appId: FACEBOOK_APP_ID, cookie:true, xfbml:false, version:'v19.0' });
    FB.login(async (loginResp)=>{
      if(!loginResp.authResponse){ showToast(t('toastAuthFailed')); return; }
      try{
        const res = await fetch(`${BACKEND_BASE}/auth/social/facebook`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ accessToken: loginResp.authResponse.accessToken })
        });
        const data = await res.json();
        if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
        handleSocialAuthSuccess(data, 'toastLoggedIn');
      }catch(e){ showToast(t('toastAuthFailed')); }
    }, { scope: 'public_profile,email' });
  }catch(e){ showToast(t('toastAuthFailed')); }
};

document.getElementById('appleLoginBtn').onclick = async ()=>{
  if(!APPLE_CLIENT_ID){ showToast(t('toastSocialNotConfigured')); return; }
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
    if(!idToken){ showToast(t('toastAuthFailed')); return; }
    const name = result?.user?.name ? `${result.user.name.firstName} ${result.user.name.lastName}` : undefined;
    const res = await fetch(`${BACKEND_BASE}/auth/social/apple`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ idToken, name })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){ showToast(t('toastAuthFailed')); }
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
    if(!optRes.ok){ showToast(opts.error || t('toastAuthFailed')); return; }

    const credential = await navigator.credentials.get({
      publicKey:{
        challenge: base64UrlToBuffer(opts.challenge),
        rpId: opts.rpId,
        allowCredentials: opts.allowCredentials.map(c => ({ type:'public-key', id: base64UrlToBuffer(c.id) })),
        userVerification: opts.userVerification,
        timeout: opts.timeout
      }
    });
    if(!credential){ showToast(t('toastAuthFailed')); return; }

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
    if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
    handleSocialAuthSuccess(data, 'toastLoggedIn');
  }catch(e){
    // NotAllowedError fires if the user cancels the Face ID/Touch ID prompt — not a real failure.
    if(e.name !== 'NotAllowedError') showToast(t('toastAuthFailed'));
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
    if(!optRes.ok){ showToast(opts.error || t('toastAuthFailed')); return; }

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
    if(!credential){ showToast(t('toastAuthFailed')); return; }

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
    if(!res.ok){ showToast(data.error || t('toastAuthFailed')); return; }
    showToast(t('toastBiometricRegistered'));
  }catch(e){
    if(e.name !== 'NotAllowedError') showToast(t('toastAuthFailed'));
  }
};

// ---------- Ported from Design MIGA 1 (simplified): product search with
// per-visitor history. ----------
function getSearchHistory(){
  try{ return JSON.parse(localStorage.getItem('megaPromptSearchHistoryV3') || '[]'); }catch(e){ return []; }
}
function saveSearchHistory(list){
  try{ localStorage.setItem('megaPromptSearchHistoryV3', JSON.stringify(list.slice(0,8))); }catch(e){}
}
function addSearchHistory(term){
  term = term.trim();
  if(!term) return;
  let list = getSearchHistory().filter(x => x.toLowerCase() !== term.toLowerCase());
  list.unshift(term);
  saveSearchHistory(list);
}
function removeSearchHistoryItem(term){
  saveSearchHistory(getSearchHistory().filter(x => x !== term));
  renderSearchDropdown(document.getElementById('searchInput').value);
}
function renderSearchDropdown(query){
  const el = document.getElementById('searchDropdown');
  query = query.trim();
  if(!query){
    const history = getSearchHistory();
    el.innerHTML = !history.length ? '' : `
      <div class="sd-section-label">${currentLang==='en' ? 'Recent searches' : 'بحثك السابق'}</div>
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
      ? `<div class="sd-empty">${currentLang==='en' ? 'No results' : 'لا توجد نتائج'}</div>`
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

// ---------- Ported from Design MIGA 1 (adapted): order tracking modal. ----------
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
      <span>${escapeHtml(title)}${en.type==='prompt' ? (currentLang==='en' ? ' (prompt)' : ' (برومبت)') : ''}</span>
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
  if(!code){ showToast(currentLang==='en' ? 'Enter a tracking code' : 'اكتب كود المتابعة'); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
    if(!res.ok){ showToast(currentLang==='en' ? 'Order not found' : 'مفيش طلب بالكود ده'); return; }
    const order = await res.json();
    const statusText = order.status === 'approved'
      ? (currentLang==='en' ? 'Approved ✅' : 'تم التأكيد ✅')
      : order.status === 'rejected'
        ? (currentLang==='en' ? 'Rejected' : 'مرفوض')
        : (currentLang==='en' ? 'Under review' : 'قيد المراجعة');
    showToast(`${currentLang==='en' ? 'Status' : 'الحالة'}: ${statusText}`);
  }catch(e){ showToast(currentLang==='en' ? 'Connection error' : 'حصل خطأ في الاتصال'); }
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

  let savedTheme = 'dark', savedView = 'mobile';
  try{ savedTheme = localStorage.getItem('megaPromptThemeV3') === 'light' ? 'light' : 'dark'; }catch(e){}
  // Only overrides the 'mobile' default above if a preference was actually
  // saved before (a first-time visitor has no key yet, so this correctly
  // leaves savedView at 'mobile' instead of falling through to 'desktop').
  try{
    const rawView = localStorage.getItem('megaPromptViewV3');
    if(rawView) savedView = rawView === 'mobile' ? 'mobile' : 'desktop';
  }catch(e){}
  applyTheme(savedTheme);
  applyViewMode(savedView);
  await checkLoggedInUser();
  checkBiometricAvailability();

  await loadProducts();
  applyLang(currentLang); // sets dir/lang, translates static markup, and does the first chips+grid render
  updateCreditBadge();
  await applyHeroModeForThisDesign();
  loadReviews();
});
