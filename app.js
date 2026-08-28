// ---------- Config ----------
const INSTAPAY_NUMBER = "01202530308";
const VODAFONE_CASH_NUMBER = "01017877978";
const SOFT_LAUNCH = false; // when true: all prompts unlock free, no payment required. Flip to false to resume paid InstaPay flow.
const LAUNCH_PROMO = true; // opening-offer mode: flat promo price, launch banner, bundles hidden
// Change this date to extend/shorten the launch offer countdown shown in the banner.
const LAUNCH_PROMO_END = new Date('2026-09-18T23:59:59+02:00');
// "Buy the prompt" service — same launch-promo pattern as photo prices.
const PROMPT_PRICE = 10;
const PROMPT_ORIGINAL_PRICE = 15;
// Card (Paymob) and Fawry are hidden from customers until their merchant credentials
// are set up (see transform-worker.js setup notes). Flip either to true once ready —
// no other change needed, the payment tab will reappear automatically.
const PAYMENT_METHODS_ENABLED = { card: false, fawry: false };
// Was hardcoded to Arabic, so every price ("25 جنيه") stayed Arabic even on the
// English page. Now tracks the active language and is refreshed in applyLanguage().
let CURRENCY = 'جنيه';
const HIDE_CHILDREN_FROM_CUSTOMERS = false; // children section is now live for all visitors

// Paste your deployed Cloudflare Worker URL here (see backend/transform-worker.js) to enable
// real AI photo transformation. Leave empty ("") to keep the client-side style-preview fallback.
const TRANSFORM_API_ENDPOINT = "https://miga-photobook-api.magdyfarouk380.workers.dev";

// BACKEND_BASE points at the same Cloudflare Worker as before (transform-worker.js) — it now
// also handles products, orders, and admin login. See setup notes at the top of that file.
const BACKEND_BASE = TRANSFORM_API_ENDPOINT;

// Fill these in once you've registered each app with the provider — until then the
// corresponding social login button just shows a "not configured yet" toast, it never
// pretends to sign someone in.
//   Google:   Google Cloud Console → APIs & Services → Credentials → OAuth Client ID (Web)
//   Facebook: developers.facebook.com → your app → Settings → Basic → App ID
//   Apple:    developer.apple.com → Certificates, IDs & Profiles → Identifiers → Services ID
const GOOGLE_CLIENT_ID = "";
const FACEBOOK_APP_ID = "";
const APPLE_CLIENT_ID = "";
const APPLE_REDIRECT_URI = window.location.origin + window.location.pathname;
let adminSessionToken = ''; // a short-lived session token issued by the server after login — the admin's actual password is never stored or resent after the initial /admin/verify call
const PLACEHOLDER_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='500'><rect width='100%' height='100%' fill='#17161d'/><text x='50%' y='50%' fill='#e3a429' font-size='16' font-family='sans-serif' text-anchor='middle'>Miga-Photobook</text></svg>`
);

let products = [];
let purchases = [];
let orders = [];
let currentBuyId = null;
let currentBuyType = 'transform'; // 'transform' | 'prompt' | 'package' — which of the three the open buy modal is for
let currentPackageSize = null; // 10 | 25 — only set when currentBuyType === 'package'

/** Fixed package pricing, mirrored server-side (the server never trusts a
 * client-sent package price — see createOrder). Kept here just so the
 * checkout UI has a title/price to show without waiting on a network call. */
const PACKAGE_CATALOG = {
  10: { price: 200, title: 'باقة الاحترافي — 10 صور', titleEn: 'Professional Package — 10 photos' },
  25: { price: 450, title: 'باقة الوكالة — 25 صورة', titleEn: 'Agency Package — 25 photos' },
};

/** Returns whatever is currently being purchased — a real product, or (for
 * package purchases) a synthetic pseudo-product built from the fixed
 * package pricing above — so every existing "p.title / p.price" call site
 * in the checkout flow works unchanged for both individual photos and
 * packages, instead of needing a parallel code path for each. */
function getBuyItem(){
  if(currentBuyType === 'package' && currentPackageSize && PACKAGE_CATALOG[currentPackageSize]){
    const pkg = PACKAGE_CATALOG[currentPackageSize];
    return { id: currentBuyId, title: pkg.title, titleEn: pkg.titleEn, price: pkg.price, category: null };
  }
  return products.find(x=>x.id===currentBuyId);
}

// ---------- i18n ----------
const translations = {
  ar: {
    categoriesLabel:'الأقسام',
    searchPlaceholder:'ابحث في الموقع...', searchHistoryLabel:'بحثك السابق', searchNoHistory:'لا يوجد بحث سابق',
    searchResultsLabel:'نتائج البحث', searchNoResults:'لا توجد نتائج', searchSectionsLabel:'أقسام الموقع',
    navAll:'الكل', navChildren:'أطفال', navMale:'رجالي', navFemale:'نسائي',
    navBusiness:'أعمال', navCinematic:'سينمائي', navLuxury:'فاخر', navArtistic:'فني', navMagazine:'مجلات',
    trackBtn:'تتبع طلبي', adminBtn:'لوحة الإدارة', adminQuickLabel:'لوحة التحكم',
    accountBtnGuest:'تسجيل الدخول', loginTab:'تسجيل الدخول', registerTab:'حساب جديد',
    continueGoogle:'المتابعة بحساب جوجل', continueApple:'المتابعة بحساب Apple', continueFacebook:'المتابعة بحساب فيسبوك',
    orDivider:'أو بالبريد الإلكتروني', toastSocialNotConfigured:'تسجيل الدخول بهذه الطريقة غير مُفعّل بعد',
    biometricLoginBtn:'الدخول ببصمة الوجه / الإصبع', registerBiometricBtn:'تفعيل الدخول ببصمة الوجه/الإصبع لهذا الجهاز',
    toastBiometricRegistered:'تم تفعيل الدخول ببصمة الوجه/الإصبع لهذا الجهاز',
    emailLabel:'البريد الإلكتروني', passwordLabel:'كلمة المرور', nameLabel:'الاسم',
    loginBtn:'دخول', registerBtn:'إنشاء الحساب', logoutBtn:'تسجيل الخروج',
    accountWelcome:'أهلاً بيك!',
    writeReviewBtn:'ضع تقييمك هنا', writeReviewTitle:'شاركنا رأيك', reviewPhotoLabel:'أرفق صورة نتيجتك (اختياري)',
    reviewPhotoConsentLabel:'انشر صورة نتيجتي مع التقييم', toastPickReviewPhoto:'اختار صورة النتيجة اللي عايز تنشرها',
    ratingLabel:'تقييمك', commentLabel:'تعليقك', submitReviewBtn:'إرسال التقييم',
    reviewModerationNote:'سيظهر تقييمك بعد مراجعته من فريقنا.',
    tabReviews:'التقييمات', noPendingReviews:'لا توجد تقييمات جديدة للمراجعة.',
    tabVisitors:'الزوار', visitorsTotalLabel:'إجمالي الزيارات', visitorsTodayLabel:'زيارات اليوم',
    tabShowcase:'الدائرة',
    tabPromoImages:'صور العرض',
    piIntro:'ارفع لحد 20 صورة نتيجة، وهتظهر بدل الفيديو كعرض متحرك بنفس شكل وإطار قسم "شوف Miga-Photobook وهو شغال".',
    piItemLabel1:'صورة 1',
    piItemLabel2:'صورة 2',
    piItemLabel3:'صورة 3',
    piItemLabel4:'صورة 4',
    piItemLabel5:'صورة 5',
    piItemLabel6:'صورة 6',
    piItemLabel7:'صورة 7',
    piItemLabel8:'صورة 8',
    piItemLabel9:'صورة 9',
    piItemLabel10:'صورة 10',
    piItemLabel11:'صورة 11',
    piItemLabel12:'صورة 12',
    piItemLabel13:'صورة 13',
    piItemLabel14:'صورة 14',
    piItemLabel15:'صورة 15',
    piItemLabel16:'صورة 16',
    piItemLabel17:'صورة 17',
    piItemLabel18:'صورة 18',
    piItemLabel19:'صورة 19',
    piItemLabel20:'صورة 20',
    piSaveBtn:'حفظ صور العرض',
    toastPromoImagesIncomplete:'لازم ترفع 3 صور على الأقل، أو تمسحهم كلهم',
    toastPromoImagesSaved:'تم حفظ صور العرض',
    toastPromoImageRemoved:'اضغط "حفظ صور العرض" لتثبيت الحذف',
    scIntro:'ارفع الصورة الأصلية اللي هتظهر في نص الدائرة في الصفحة الرئيسية، والنتايج الثمانية اللي هتلف حواليها.',
    scCenterLabel:'الصورة الأصلية (المنتصف)',
    scItemLabel1:'نتيجة 1', scItemLabel2:'نتيجة 2', scItemLabel3:'نتيجة 3', scItemLabel4:'نتيجة 4',
    scItemLabel5:'نتيجة 5', scItemLabel6:'نتيجة 6', scItemLabel7:'نتيجة 7', scItemLabel8:'نتيجة 8',
    scSaveBtn:'حفظ صور الدائرة',
    toastImageUploaded:'تم رفع الصورة',
    toastShowcaseIncomplete:'لازم ترفع كل الـ9 صور الأول',
    toastShowcaseSaved:'تم حفظ صور الدائرة',
    visitorsUniqueTotalLabel:'زوار فريدون', visitorsUniqueTodayLabel:'فريدون اليوم',
    visitorsColDate:'التاريخ والوقت', visitorsColPage:'الصفحة', visitorsColCountry:'الدولة',
    visitorsColName:'الاسم', visitorsColEmail:'الإيميل',
    visitorsEmptyNote:'لا توجد زيارات مسجلة بعد.',
    toastAuthFailed:'حصل خطأ، تأكد من البيانات وحاول تاني',
    toastLoggedIn:'تم تسجيل الدخول بنجاح', toastRegistered:'تم إنشاء الحساب بنجاح',
    toastLoginRequired:'سجّل دخولك الأول عشان تقدر تكتب تقييم',
    toastReviewSubmitted:'تم إرسال تقييمك، هيظهر بعد المراجعة. شكرًا ليك!',
    viewDesktopLabel:'كمبيوتر', viewMobileLabel:'موبايل',
    themeDayLabel:'الوضع النهاري', themeNightLabel:'الوضع الليلي',
    themeToggleTitle:'التبديل بين الوضع النهاري والوضع الليلي',
    heroEyebrow:'Miga-Photobook',
    promoMarqueeText:'حوّل أي صورة عادية إلى بورتريه استوديو احترافي بالذكاء الاصطناعي خلال دقائق — عرض الافتتاح: كل صورة بـ 25 جنيه بدلاً من 50 جنيه لفترة محدودة.',
    heroSlogan:'لقطتك... تتحول لتحفة فنية',
    promoVideoTitle:'شوف Miga-Photobook وهو شغال', promoVideoSub:'دقائق معدودة، وصورتك العادية بتتحول لتحفة فنية احترافية.',
    trustCheck1:'✅ نتيجة خلال دقائق', trustCheck2:'✅ دفع آمن', trustCheck3:'✅ دعم فني مباشر', trustCheck4:'✅ تحديثات مستمرة',
    whyUsTitle:'لماذا Miga-Photobook؟',
    rowPrevLabel:'الصور السابقة', rowNextLabel:'الصور التالية',
    whyEdgeTitle:'وأدوات الذكاء الاصطناعي المتاحة للكل؟',
    whyEdgeP1:'الأداة مش هي المشكلة — البرومبت هو المشكلة.',
    whyEdgeP3:'كل صورة في المعرض هنا نتيجة برومبت اتظبط قبل كده عشرات المرات، فبتوصلك من أول مرة من غير تخمين.',
    whyEdgeP4:'إحنا اختصرنا عليك كل التجربة والتعديل — تدفع وتستلم صورتك جاهزة على طول. حابب تجرب بنفسك في المرات الجاية؟ تقدر تشتري البرومبت وحده بـ10 جنيه (اختياري). <a href="#children" class="why-edge-link">تصفّح الصور واختار البرومبت ←</a>',
    whyUs1:'نتائج احترافية', whyUs2:'تحويل تلقائي بالكامل', whyUs3:'جاهزة خلال دقائق', whyUs4:'بدون أي خبرة تقنية', whyUs5:'خصوصيتك محفوظة بالكامل',
    howItWorksTitle:'كيف يعمل؟',
    how1Title:'اختار الستايل', how1Desc:'تصفح المكتبة واختر الأسلوب اللي يعجبك من أي قسم.',
    how2Title:'ادفع', how2Desc:'حوّل قيمة الطلب عن طريق InstaPay أو فودافون كاش، وسجّل رقم العملية.',
    how3Title:'ارفع صورتك', how3Desc:'بعد تأكيد التحويل (عادةً خلال دقائق)، ارفع صورتك بجودة واضحة.',
    how4Title:'استلم النتيجة', how4Desc:'هنطبّق الأسلوب اللي اخترته بالذكاء الاصطناعي، وتستلم صورتك الاحترافية خلال دقايق.',
    howItWorksCta:'ابدأ دلوقتي',
    mostRequestedTitle:'الأكثر طلبا',
    testimonialsTitle:'تقييمات وآراء عملائنا',
    testimonial1:'"أفضل تحويل صور جربته على الإطلاق"', testimonial2:'"حوّلت صوري إلى مستوى احترافي"',
    testimonialsNote:'* نماذج حقيقية من نتائج Miga-Photobook الفعلية.',
    trustBadge1:'جودة احترافية في كل صورة', trustBadge2:'تحديث مستمر للأساليب الفنية المتاحة',
    trustBadge3:'دعم فني سريع ومباشر', trustBadge4:'أمان وخصوصية في كل عملية',
    aboutUsTitle:'من نحن',
    aboutUsText:'Miga-Photobook مشروع مصري بدأ بفكرة بسيطة: خلي جلسة التصوير الاحترافية متاحة لأي حد وبسعر معقول. بنحوّل صورتك الشخصية لتحفة فنية بجودة استوديو باستخدام الذكاء الاصطناعي — ارفع صورتك واختار الأسلوب، وإحنا نتولى الباقي بعناية عشان تضمن نتيجة تستحق اسمك.',
    faqTitle:'أسئلة شائعة',
    faqQ1:'إزاي تتم عملية التحويل؟', faqA1:'بعد الدفع، بترفع صورتك، وإحنا نحوّلها تلقائيًا بالأسلوب اللي اخترته، وتستلم النتيجة جاهزة على الموقع مباشرة.',
    faqQ2:'قد إيه بتاخد وقت؟', faqA2:'في خطوتين: تأكيد التحويل البنكي بياخد عادةً دقائق (بنراجعه بنفسنا)، وبعد التأكيد، التحويل بالذكاء الاصطناعي نفسه بياخد دقائق وهتشوف النتيجة على نفس الصفحة.',
    faqQ6:'لو النتيجة معجبتنيش؟', faqA6:'تواصل معانا فورًا وهنعيد توليد صورتك ببرومبت مختلف من غير أي تكلفة إضافية، لحد ما توصل لنتيجة تعجبك.',
    faqQ3:'هل أحتاج خبرة؟', faqA3:'لأ خالص، بس بترفع صورتك وتختار الأسلوب، وإحنا بنعمل الباقي بالكامل.',
    faqQ4:'هل أستطيع استخدامه تجاريًا؟', faqA4:'الصورة الناتجة مرخّصة للاستخدام الشخصي. للاستخدام التجاري (إعادة بيع أو مشاريع عملاء)، تواصل معنا أولاً لترخيص مناسب.',
    faqQ5:'كيف أستلم النتيجة؟', faqA5:'فور تأكيد الدفع، بترفع صورتك على الموقع وتستلم النتيجة المُحوّلة مباشرة، وتقدر تحمّلها في أي وقت.',
    faqQ7:'هل أقدر أختار أكثر من ستايل؟', faqA7:'أكيد! تقدر تطلب أكتر من ستايل لنفس الصورة أو لصور مختلفة — كل ستايل بيتحسب طلب منفصل، أو استخدم إحدى الباقات (10 أو 25 صورة) عشان توفر لو محتاج أكتر من نتيجة.',
    heroTitle:'حوّل صورتك إلى بورتريه احترافي<br>بجودة استوديو باستخدام <span class="brand-mark">Miga-Photobook ميجا فوتوبوك</span><br>خلال دقائق.',
    heroP:'ارفع صورتك الشخصية — لك أو لطفلك — واختار الأسلوب اللي يعجبك، وإحنا نحوّلها لك تلقائيًا بجودة استوديو خلال دقائق بعد تأكيد الدفع.',
    heroCta1:'اعمل صورتك دلوقتي بـ25 جنيه', heroCta2:'الأسعار والعروض',
    bafTitle:'صورة واحدة منك... نحولها لأجمل صورة من اختيارك من عندنا',
    bafSub:'دي نفس الصورة، بعد ما Miga-Photobook حوّلها لأكتر من ستايل. اختار اللي يعجبك وجرّبه على صورتك.',
    bafCenterLabel:'صورتك الأصلية',
    bafCta:'اعمل صورتك دلوقتي بـ25 جنيه',
    secChildrenTitle:'قسم الأطفال', secMaleTitle:'القسم الرجالي', secFemaleTitle:'القسم النسائي',
    secBusinessTitle:'قسم الأعمال', secCinematicTitle:'القسم السينمائي', secLuxuryTitle:'القسم الفاخر',
    secArtisticTitle:'القسم الفني', secMagazineTitle:'قسم المجلات والملصقات',
    pricingTitle:'الأسعار والعروض',
    pricingSub:'اطلب تحويل صورك منفردة، أو وفّر أكثر مع الباقات. كل باقة تُطبّق كخصم عند طلب العدد المطابق من الصور ضمن أي قسم.', pricingGuaranteeNote:'❤️ مش عاجباك النتيجة؟ نعيد توليدها ببرومبت مختلف مجانًا.',
    plan1Title:'الباقة الفردية', plan1Price:'25 جنيه فقط', currencyLabel:'جنيه',
    plan1Li1:'تحويل صورة واحدة بالسعر المعروض', plan1Li2:'تنفيذ خلال دقائق بعد الدفع', plan1Li3:'مناسبة للتجربة', plan1Cta:'تصفح الآن',
    plan2Title:'باقة الاحترافي', plan2Unit:'/ 10 صور',
    plan2Li1:'وفّر 50 جنيه عن السعر الفردي', plan2Li2:'اختيار حر من أي قسم', plan2Li3:'دعم فني بالأولوية',
    planBuyBtn:'اطلب الباقة دلوقتي', planWhatsBtn:'اطلب الباقة عبر واتساب',
    plan3Title:'باقة الوكالة', plan3Unit:'/ 25 صورة',
    plan3Li1:'18 جنيه للصورة — وفّر 175 جنيه', plan3Li2:'تحديثات مجانية للأساليب المتاحة', plan3Li3:'مناسبة للاستوديوهات والوكالات',
    buyModalTitle:'الدفع عبر إنستاباي',
    ipLabel:'حوّل المبلغ عبر إنستاباي (من أي بنك أو محفظة تدعم التحويل عبر إنستاباي) إلى الرقم التالي',
    vodafoneLabel:'حوّل المبلغ عبر فودافون كاش إلى الرقم التالي',
    payMethodInstapay:'إنستاباي', payMethodVodafone:'فودافون كاش', payMethodCard:'بطاقة ائتمان', payMethodFawry:'فوري',
    payerNameLabel:'الاسم', payerPhoneLabel:'رقم الموبايل', payerEmailLabel:'البريد الإلكتروني (اختياري)',
    payNowBtn:'ادفع الآن', getFawryCodeBtn:'احصل على كود الدفع',
    fawryRefNote:'اذهب لأقرب منفذ فوري وادفع بالكود ده:',
    ipCopyBtn:'نسخ الرقم',
    buyerAppLabel:'اسم التطبيق/البنك الذي حوّلت منه (اختياري)', buyerAppPh:'مثال: إنستاباي، بنك مصر، CIB، فودافون كاش...',
    buyerPhoneLabel:'رقم الموبايل الذي حوّلت منه',
    buyerRefLabel:'رقم/مرجع عملية التحويل (إن وجد)', buyerRefPh:'مثال: آخر 4 أرقام أو رقم العملية',
    statusPendingText:'بنراجع تحويلك... الصفحة هتتحدّث لوحدها أول ما نأكده.',
    statusCodeNote:'كود طلبك (احتفظ بيه احتياطيًا):',
    statusSafeCloseNote:'تقدر تقفل الصفحة دلوقتي براحتك — هنراجع طلبك ونبعتلك تحديث بمجرد ما يتأكد.',
    statusApprovedText:'تم تأكيد الدفع ✅ تقدر ترفع صورتك دلوقتي.',
    buyModalNote:'هنراجع تحويلك بنفسنا فور ما يوصلنا — الصفحة هتفضل فاتحة قدامك وهتقولك أول ما يتأكد، من غير ما تدوّر على كود في مكان تاني.',
    buyConfirmBtn:'تم الدفع', cancelBtn:'إلغاء',
    detailValue1:'✓ نحوّل صورتك تلقائيًا فور تأكيد الدفع', detailValue2:'✓ جودة استوديو احترافية مضمونة',
    detailValue3:'✓ النتيجة جاهزة للتحميل مباشرة', detailValue4:'✓ دعم فني مباشر لو احتجت مساعدة',
    detailBuyBtn:'احصل عليها الآن',
    cropModalTitle:'اضبط إطار الصورة', cropModalSub:'حرّك الصورة واستخدم شريط التكبير عشان تظبط الإطار — كل صور المنتجات هتخرج بنفس المقاس بالظبط بعد كده.',
    cropConfirmBtn:'تأكيد القص',
    trackModalTitle:'تتبع طلبك', trackModalSub:'أدخل كود المتابعة الذي حصلت عليه بعد إرسال طلب الشراء.',
    myOrdersTitle:'طلباتك السابقة', loadingLabel:'جاري التحميل...',
    trackCodeLabel:'كود المتابعة', trackCheckBtn:'تحقّق من الحالة', closeBtn:'إغلاق',
    adminTitle:'دخول لوحة الإدارة', adminFabLabel:'لوحة الإدارة',
    alertsOnTitle:'تنبيهات الطلبات مفعّلة', alertsOffTitle:'فعّل تنبيهات الطلبات',
    toastAlertsOn:'تم تفعيل تنبيهات الطلبات ✅', toastAlertsBlocked:'المتصفح رفض التنبيهات — فعّلها من إعدادات الموقع.',
    toastAlertsUnsupported:'المتصفح ده مش بيدعم التنبيهات.',
    toastNewOrder:'وصل {n} طلب جديد 🔔',
    newOrderNotifTitle:'طلب جديد — Miga-Photobook',
    newOrderNotifBody:'{n} طلب جديد. إجمالي المعلّق: {total}.',
    shareResultBtn:'شارك النتيجة', shareResultText:'شوف صورتي من Miga-Photobook 🔥',
    toastShareCopied:'تم نسخ الرابط — الصقه في أي مكان ✅',
    nudgeTitle:'لسه مستني إيه؟',
    nudgeBody:'عرض الافتتاح لسه شغال — صورتك بـ 25 جنيه بدل 50. لو محتار في الاختيار، ابعتلنا واتساب ونساعدك تختار الأنسب لك.',
    nudgeBrowseBtn:'تصفّح الصور', nudgeAskBtn:'اسألنا واتساب',
    thanksTitle:'شكراً إنك جربتنا 🙏',
    thanksBody:'لو الصورة عجبتك، مشاركتها مع صحابك أو تقييم سريع بيساعدنا كتير.',
    thanksShareBtn:'شارك صورتك', thanksReviewBtn:'اكتب تقييمك',
    thankCustomerBtn:'شكر عبر واتساب', thankCustomerDoneBtn:'✓ تم إرسال رسالة الشكر',
    toastThankSaveFailed:'الرسالة اتفتحت، بس تسجيلها فشل — جرّب تحدّث الصفحة.',
    whatsappThanksTemplate:'أهلاً 👋\nشكراً إنك جربت Miga-Photobook وطلبت "{title}".\nلو الصورة عجبتك، مشاركتها مع صحابك هتبقى دعم كبير لينا 🙏\nولو حبيت صورة تانية، ابعتلنا في أي وقت.',
    payerRefLabel:'رقم عملية التحويل (من رسالة أو إشعار التحويل)',
    payerRefPh:'مثال: 4821960573',
    payWarning:'🔐 لضمان سرعة تنفيذ طلبك، تأكد من إدخال رقم عملية التحويل الصحيح.',
    payConfirmLabel:'أؤكد إني حوّلت المبلغ فعلًا، وإن رقم العملية المكتوب فوق صحيح.',
    toastEnterRef:'اكتب رقم عملية التحويل الصحيح من إشعار التحويل.',
    toastConfirmPaymentFirst:'علّم على خانة التأكيد إنك حوّلت المبلغ فعلًا.',
    pShareLinkLabel:'رابط المنتج (للإعلانات) — انسخه وضعه في منشور المنصة',
    pImageLinkLabel:'رابط الصورة الأصلية — لرفعها في الإعلان',
    copyLinkTitle:'نسخ رابط المنتج', copyImageLinkTitle:'نسخ رابط الصورة',
    setCoverTitle:'اجعلها واجهة القسم', cycleCoverTitle:'صورة أخرى من القسم',
    toastCoverSet:'تم تعيينها واجهة للقسم ⭐',
    toastCoverSaveFailed:'اتغيّرت على الشاشة، بس الحفظ فشل — جرّب تاني.',
    toastLinkCopied:'تم نسخ رابط المنتج ✅', toastImageLinkCopied:'تم نسخ رابط الصورة ✅',
    toastNoImageYet:'المنتج ده لسه مفيهوش صورة.',
    downloadArchiveBtn:'⬇️ تحميل أرشيف القسم', downloadAllArchiveBtn:'⬇️ تحميل أرشيف كل المنتجات',
    toastArchiveFailed:'تعذّر إنشاء الأرشيف، حاول تاني',
    dailyReportTitle:'📊 تقرير الأداء', dailyReportLoading:'جاري تجميع البيانات...',
    dailyReportTodaySuffix:'آخر 24 ساعة', dailyReportAllTimeSuffix:'كل الفترة — لا يوجد تاريخ مسجل للتقييمات',
    dailyReportOrdersTitle:'الطلبات', dailyReportTotal:'الإجمالي', dailyReportRevenue:'الإيرادات',
    dailyReportReviewsTitle:'التقييمات', reviewStatPendingLabel:'قيد المراجعة', reviewStatApprovedLabel:'تمت الموافقة',
    dailyReportVisitorsTitle:'الزوار', dailyReportDownloadBtn:'⬇️ تصدير Excel',
    periodDailyBtn:'اليوم', periodWeeklyBtn:'آخر 7 أيام', periodCustomBtn:'فترة مخصصة', periodApplyBtn:'تطبيق',
    periodCustomMissing:'اختار تاريخ البداية والنهاية الأول', reportChartTitle:'الأداء خلال الفترة',
    reportNarrativeTitle:'📋 ملخص وتوصيات', reportVsPrevious:'عن الفترة اللي قبلها', reportDownloadChartBtn:'⬇️ صورة الرسم البياني',
    visitorsAllTimeNote:'إجمالي كل الفترات', toastExcelLibFailed:'مكتبة تصدير Excel لسه بتتحمّل، جرب تاني بعد شوية',
    adminSub:'لوحة إدارة المنتجات والطلبات.',
    adminPassLabel:'كلمة المرور', adminLoginBtn:'دخول',
    tabProducts:'إضافة منتج', tabOrders:'الطلبات',
    pCatLabel:'القسم', optChildren:'أطفال', optMale:'رجالي', optFemale:'نسائي',
    optBusiness:'أعمال', optCinematic:'سينمائي', optLuxury:'فاخر', optArtistic:'فني', optMagazine:'مجلات وملصقات',
    pTitleLabel:'عنوان المنتج', pTitlePh:'مثال: بورتريه إضاءة سينمائية',
    pTitleEnLabel:'العنوان بالإنجليزي (اختياري — يظهر للعميل لما يبدّل للإنجليزي)', pTitleEnPh:'مثال: Cinematic Lighting Portrait',
    pPriceLabel:'السعر (جنيه)', pImageLabel:'صورة المنتج',
    pPromptLabel:'تعليمات التحويل بالذكاء الاصطناعي (للإدارة فقط — لا تظهر للعميل إطلاقًا)', pPromptPh:'اكتب تعليمات التحويل الدقيقة هنا...',
    pSaveBtn:'إضافة المنتج', adminLogoutBtn:'خروج',
    pUpdateBtn:'تحديث المنتج', confirmDeleteProduct:'هل أنت متأكد من حذف هذا المنتج؟ لا يمكن التراجع.',
    pCancelEditBtn:'إلغاء التعديل / منتج جديد', editingBannerText:'وضع التعديل: أي حفظ الآن هيغيّر المنتج ده — مش هيضيف منتج جديد.',
    replaceImageTitle:'استبدال الصورة', removeImageTitle:'حذف الصورة', moveCategoryTitle:'نقل لقسم آخر',
    moveUpTitle:'تحريك لأعلى (يظهر أولاً)', moveDownTitle:'تحريك لأسفل', popularityCountTitle:'عدد مرات الطلب على هذا المنتج',
    confirmRemoveImage:'هل تريد حذف صورة هذا المنتج واستبدالها بصورة افتراضية؟',
    toastImageReplaced:'تم استبدال الصورة بنجاح', toastImageRemoved:'تم حذف الصورة',
    toastCategoryMoved:'تم نقل المنتج للقسم الجديد',
    toastProductDeleted:'تم حذف المنتج',
    footerText:'© 2026 Miga-Photobook — كل التحويلات تتم بعد إتمام الدفع فقط.',
    footerTerms:'شروط الاستخدام', footerPrivacy:'سياسة الخصوصية', footerRefund:'سياسة الاسترجاع',
    lockOverlayText:'يتم تحويل صورتك بعد الشراء', ownedPill:'✓ تم الشراء',
    buyBtnPrefix:'🔷 احصل عليها الآن', emptyNoteCategory:'لا توجد منتجات في هذا القسم بعد — أضِف منتجات من لوحة الإدارة.',
    buyModalTextTemplate:'شراء "{title}" مقابل {price} جنيه.',
    buyPromptModalTextTemplate:'شراء البرومبت الاحترافي لـ "{title}" مقابل {price} جنيه.',
    buyPackageModalTextTemplate:'شراء "{title}" مقابل {price} جنيه — تقدر تستخدمها على أي منتجات تختارها بعد التأكيد.',
    buyPromptBtnPrefix:'احصل على البرومبت الاحترافي',
    copyPromptBtn:'نسخ البرومبت', promptPendingBtn:'البرومبت قيد المراجعة',
    orderTypeTransform:'تحويل صورة', orderTypePrompt:'شراء برومبت',
    statusPromptApprovedText:'تم تأكيد الدفع ✅ البرومبت جاهز — هتلاقيه في "تتبع طلبي".',
    toastPromptReady:'تم تأكيد الدفع — البرومبت جاهز الآن',
    statusPackageApprovedText:'تم تأكيد الدفع ✅ عندك {n} صورة متاحة — اختار أي منتج ودوس "استخدم من باقتك".',
    toastPackageReady:'تم تأكيد الدفع — باقتك جاهزة للاستخدام',
    toastPackageProductAlreadyUsed:'استخدمت رصيد باقتك على المنتج ده قبل كده — اختار منتج تاني',
    usePackageCreditBtnPrefix:'استخدم من باقتك',
    toastPromptCopied:'تم نسخ البرومبت',
    toastPromptNotReady:'البرومبت لسه قيد المراجعة',
    toastCopiedNumber:'تم نسخ الرقم', toastEnterPhone:'يرجى إدخال رقم الموبايل الذي حوّلت منه',
    toastInvalidPhone:'من فضلك أدخل رقم موبايل مصري صحيح (01 متبوع بـ 9 أرقام)',
    toastOrderSentTemplate:'تم إرسال طلبك — كود المتابعة: {code} (احتفظ به)',
    toastEnterCode:'أدخل كود المتابعة', toastOrderNotFound:'لم يتم العثور على طلب بهذا الكود',
    toastReadyToTransform:'تم تأكيد طلبك — جاهز تحوّل صورتك دلوقتي', toastOrderPending:'الطلب لا يزال قيد المراجعة، حاول لاحقًا',
    toastCopyFailed:'تعذّر النسخ التلقائي',
    toastOrderApproved:'تمت الموافقة على الطلب — يمكن للعميل تحويل صورته بالكود الآن',
    toastWrongPassword:'كلمة المرور غير صحيحة', toastAdminRateLimited:'محاولات كتير أوي في وقت قصير — استنى شوية (لحد 10 دقايق) وجرب تاني', toastAdminServerError:'السيرفر فيه مشكلة مؤقتة (مش كلمة السر) — جرب تاني بعد شوية، أو راجع حد الكتابة اليومي في Cloudflare KV', toastFillFields:'يرجى إكمال العنوان والسعر وتعليمات التحويل',
    changePassTitle:'تغيير كلمة مرور الأدمن', tabChangePassword:'تغيير كلمة المرور', changePassIntro:'غيّر كلمة مرور دخول لوحة الإدارة. لازم تعرف الكلمة الحالية عشان تقدر تغيّرها.', currentPassLabel:'كلمة المرور الحالية', newPassLabel:'كلمة المرور الجديدة', confirmNewPassLabel:'تأكيد كلمة المرور الجديدة', changePassBtn:'تغيير كلمة المرور',
    tabSiteDesign:'تصميم الموقع', siteDesignIntro:'اختار الشكل اللي هيشوفه العميل لما يفتح الموقع. لوحة الإدارة نفسها بتفضل زي ما هي دايمًا مهما كان اختيارك هنا.', siteDesignLabel:'التصميم الفعّال', siteDesignV1Option:'التصميم الأول (الحالي)', siteDesignV2Option:'التصميم الثاني (الجديد)', siteDesignSaveBtn:'حفظ الاختيار', toastSiteDesignSaved:'تم حفظ التصميم — هيظهر للعملاء من زيارتهم الجاية',
    toastPassChanged:'تم تغيير كلمة المرور بنجاح', toastPassMismatch:'كلمة المرور الجديدة وتأكيدها غير متطابقين', toastPassTooShort:'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل', toastCurrentPassWrong:'كلمة المرور الحالية غير صحيحة', toastFillPassFields:'يرجى إدخال كل الحقول',
    toastProductAdded:'تم إضافة المنتج بنجاح',
    uploadingImage:'جاري رفع الصورة...', toastImageUploadFailed:'تعذّر رفع الصورة، تأكد من اتصالك وحاول تاني',
    toastContactPro:'للاشتراك في باقة الاحترافي، يرجى التواصل معنا', toastContactAgency:'للاشتراك في باقة الوكالة، يرجى التواصل معنا',
    ordersEmptyNote:'لا توجد طلبات بعد.',
    orderLabelProduct:'المنتج', orderLabelPhone:'الموبايل', orderLabelPayApp:'وسيلة الدفع', orderLabelRef:'المرجع',
    orderLabelCode:'الكود', orderLabelStatus:'الحالة', orderStatusApproved:'تمت الموافقة', orderStatusPending:'قيد المراجعة',
    orderStatusRejected:'مرفوض', orderRejectBtn:'رفض الطلب', orderDeleteBtn:'حذف نهائي',
    confirmRejectOrder:'هل أنت متأكد إنك عايز ترفض الطلب ده؟ مش هينفع توافق عليه بعد كده.',
    confirmDeleteOrder:'هل أنت متأكد إنك عايز تحذف الطلب المرفوض ده نهائيًا؟', confirmDeleteReview:'هل أنت متأكد إنك عايز تحذف التقييم ده نهائيًا؟', reviewDeleteBtn:'حذف التقييم', toastReviewDeleted:'تم حذف التقييم',
    toastOrderRejected:'تم رفض الطلب', toastOrderDeleted:'تم حذف الطلب',
    statTotalLabel:'إجمالي الطلبات', statApprovedLabel:'تم تنفيذها', statPendingLabel:'قيد المراجعة',
    statRevenueLabel:'إجمالي المبلغ المحصّل', exportOrdersBtn:'⬇️ تصدير كل الطلبات Excel',
    reviewStatTotalLabel:'إجمالي التقييمات', reviewStatApprovedLabel:'منشورة', reviewStatPendingLabel:'قيد المراجعة',
    reviewColRating:'التقييم', reviewColComment:'التعليق',
    statColCode:'الكود', statColProduct:'المنتج', statColStatus:'الحالة', statColTime:'الوقت', statColBuyer:'الطالب',
    orderLabelBuyer:'اسم/إيميل الطالب', orderBuyerGuest:'زائر (بدون حساب)',
    orderLabelType:'نوع الطلب', statColType:'النوع',
    sendPromptWhatsAppBtn:'إرسال عبر واتساب',
    whatsappPromptMessageTemplate:'مرحبًا 👋 تحويلك تم تأكيده — ده البرومبت الاحترافي الخاص بـ "{title}":\n\n{prompt}\n\nشكرًا لثقتك في Miga-Photobook 🙏',
    orderApproveBtn:'موافقة وتفعيل التحويل',
    softLaunchBanner:'🎉 إطلاق تجريبي — كل التحويلات متاحة مجانًا الآن لفترة محدودة',
    launchPromoBannerText:'🎉 عرض افتتاح الموقع — كل صورة بـ 25 جنيه فقط!',
    countdownFormat:'العرض ينتهي خلال: {d} يوم {h} ساعة',
    countdownFormatHoursOnly:'العرض ينتهي خلال: {h} ساعة {m} دقيقة',
    countdownEnded:'انتهى العرض',
    freeLabel:'مجانًا', claimFreeBtn:'احصل عليه مجانًا',
    toastFreeUnlocked:'تم الفتح مجانًا — جاهز تحوّل صورتك! (فترة الإطلاق التجريبي)',
    transformBtn:'حوّل صورتك', viewResultBtn:'شاهد نتيجتك ✅', transformModalTitle:'حوّل صورتك',
    transformAlreadyDoneNote:'تم تحويل صورتك قبل كده باستخدام هذا الطلب — دي نتيجتك المحفوظة.',
    uploadPhotoLabel:'اختر صورتك', beforeLabel:'قبل', afterLabel:'بعد',
    consentLabel:'أؤكد إني صاحب هذه الصورة أو الوصي الشرعي عليها، وأوافق على استخدامها لتوليد النتيجة الفنية المطلوبة.',
    transformPrivacyNote:'صورتك بتُستخدم فقط لتنفيذ طلبك، ومتُشاركش مع أي جهة تانية.',
    transformPrivacyNoteReal:'صورتك تُرسَل بشكل آمن إلى خدمة معالجة الصور لإنشاء النتيجة، ولا تُخزَّن بشكل دائم على خوادمنا.',
    transformLikenessNote:'بنحافظ على ملامحك الأساسية قدر الإمكان، لكن جودة النتيجة بتعتمد على وضوح الصورة الأصلية.',
    generateBtn:'حوّل الصورة', downloadResultBtn:'تحميل النتيجة',
    toastInvalidImage:'من فضلك اختر ملف صورة صالح',
    toastSelectPhoto:'من فضلك اختر صورة أولاً',
    toastConsentRequired:'من فضلك وافق على إقرار الصورة قبل المتابعة',
    toastTransformDone:'تم تجهيز المعاينة — يمكنك تحميلها الآن',
    toastGenerating:'جاري توليد الصورة... ممكن يستغرق دقايق',
    toastGenerateFailed:'حصل خطأ أثناء التوليد، حاول تاني',
    toastOrderFailed:'تعذّر إرسال طلبك حاليًا — تأكد من اتصالك بالإنترنت وحاول تاني، أو تواصل معنا مباشرة.',
    toastDownloadFailed:'تعذّر تحميل الصورة تلقائيًا'
  },
  en: {
    categoriesLabel:'Categories',
    searchPlaceholder:'Search the site...', searchHistoryLabel:'Recent Searches', searchNoHistory:'No recent searches',
    searchResultsLabel:'Results', searchNoResults:'No results found', searchSectionsLabel:'Site Sections',
    navAll:'All', navChildren:'Children', navMale:'Men', navFemale:'Women',
    navBusiness:'Business', navCinematic:'Cinematic', navLuxury:'Luxury', navArtistic:'Artistic', navMagazine:'Magazine',
    trackBtn:'Track Order', adminBtn:'Admin Panel', adminQuickLabel:'Dashboard',
    accountBtnGuest:'Log In', loginTab:'Log In', registerTab:'New Account',
    continueGoogle:'Continue with Google', continueApple:'Continue with Apple', continueFacebook:'Continue with Facebook',
    orDivider:'Or with email', toastSocialNotConfigured:'This sign-in method is not set up yet',
    biometricLoginBtn:'Sign in with Face ID / fingerprint', registerBiometricBtn:'Enable Face ID/fingerprint sign-in on this device',
    toastBiometricRegistered:'Face ID/fingerprint sign-in enabled for this device',
    emailLabel:'Email', passwordLabel:'Password', nameLabel:'Name',
    loginBtn:'Log In', registerBtn:'Create Account', logoutBtn:'Log Out',
    accountWelcome:'Welcome!',
    writeReviewBtn:'Add Your Review Here', writeReviewTitle:'Share Your Feedback', reviewPhotoLabel:'Attach your result photo (optional)',
    reviewPhotoConsentLabel:'Publish my result photo with the review', toastPickReviewPhoto:'Pick which result photo you want to publish',
    ratingLabel:'Your Rating', commentLabel:'Your Comment', submitReviewBtn:'Submit Review',
    reviewModerationNote:'Your review will appear after our team reviews it.',
    tabReviews:'Reviews', noPendingReviews:'No new reviews to moderate.',
    tabVisitors:'Visitors', visitorsTotalLabel:'Total Visits', visitorsTodayLabel:'Today',
    tabShowcase:'Showcase',
    tabPromoImages:'Display Images',
    piIntro:'Upload up to 20 result images to replace the video with a rotating display using the same frame as the "See Miga-Photobook in action" section.',
    piItemLabel1:'Image 1',
    piItemLabel2:'Image 2',
    piItemLabel3:'Image 3',
    piItemLabel4:'Image 4',
    piItemLabel5:'Image 5',
    piItemLabel6:'Image 6',
    piItemLabel7:'Image 7',
    piItemLabel8:'Image 8',
    piItemLabel9:'Image 9',
    piItemLabel10:'Image 10',
    piItemLabel11:'Image 11',
    piItemLabel12:'Image 12',
    piItemLabel13:'Image 13',
    piItemLabel14:'Image 14',
    piItemLabel15:'Image 15',
    piItemLabel16:'Image 16',
    piItemLabel17:'Image 17',
    piItemLabel18:'Image 18',
    piItemLabel19:'Image 19',
    piItemLabel20:'Image 20',
    piSaveBtn:'Save Display Images',
    toastPromoImagesIncomplete:'Upload at least 3 images, or remove them all',
    toastPromoImagesSaved:'Display images saved',
    toastPromoImageRemoved:'Click "Save display images" to confirm the removal',
    scIntro:'Upload the original photo shown in the center of the homepage circle, and the 8 results that orbit around it.',
    scCenterLabel:'Original Photo (Center)',
    scItemLabel1:'Result 1', scItemLabel2:'Result 2', scItemLabel3:'Result 3', scItemLabel4:'Result 4',
    scItemLabel5:'Result 5', scItemLabel6:'Result 6', scItemLabel7:'Result 7', scItemLabel8:'Result 8',
    scSaveBtn:'Save Showcase Images',
    toastImageUploaded:'Image uploaded',
    toastShowcaseIncomplete:'Upload all 9 images first',
    toastShowcaseSaved:'Showcase images saved',
    visitorsUniqueTotalLabel:'Unique Visitors', visitorsUniqueTodayLabel:'Unique Today',
    visitorsColDate:'Date & Time', visitorsColPage:'Page', visitorsColCountry:'Country',
    visitorsColName:'Name', visitorsColEmail:'Email',
    visitorsEmptyNote:'No visits logged yet.',
    toastAuthFailed:'Something went wrong, please check your details and try again',
    toastLoggedIn:'Logged in successfully', toastRegistered:'Account created successfully',
    toastLoginRequired:'Please log in first to write a review',
    toastReviewSubmitted:'Your review has been submitted and will appear after moderation. Thank you!',
    viewDesktopLabel:'Computer', viewMobileLabel:'Mobile',
    themeDayLabel:'Day Mode', themeNightLabel:'Night Mode',
    themeToggleTitle:'Switch between day mode and night mode',
    heroEyebrow:'Miga-Photobook',
    promoMarqueeText:'Turn any ordinary photo into a professional studio portrait with AI, in minutes — launch offer: every photo for 25 EGP instead of 50 EGP, for a limited time.',
    heroSlogan:'Your shot... becomes a masterpiece',
    promoVideoTitle:'See Miga-Photobook in action', promoVideoSub:'A few minutes, and your ordinary photo becomes a professional work of art.',
    trustCheck1:'✅ Result within minutes', trustCheck2:'✅ Secure payment', trustCheck3:'✅ Direct support', trustCheck4:'✅ Ongoing updates',
    whyUsTitle:'Why Miga-Photobook?',
    rowPrevLabel:'Previous photos', rowNextLabel:'Next photos',
    whyEdgeTitle:'What about the AI tools everyone can use?',
    whyEdgeP1:'The tool is not the hard part — the prompt is.',
    whyEdgeP3:'Every image in this gallery is the result of a prompt refined dozens of times, so it delivers the first time — no guesswork.',
    whyEdgeP4:'We already did all the trial and error for you — pay once and get your finished photo right away. Want to experiment yourself next time? You can buy the prompt alone for 10 EGP (optional). <a href="#children" class="why-edge-link">Browse the gallery and pick a prompt &rarr;</a>',
    whyUs1:'Professional results', whyUs2:'Fully automatic transformation', whyUs3:'Ready in minutes', whyUs4:'No technical experience needed', whyUs5:'Your privacy is fully protected',
    howItWorksTitle:'How does it work?',
    how1Title:'Pick a style', how1Desc:'Browse the library and pick the look you like from any section.',
    how2Title:'Pay', how2Desc:'Transfer the amount via InstaPay or Vodafone Cash, and note the transaction reference.',
    how3Title:'Upload your photo', how3Desc:'Once your transfer is confirmed (usually within minutes), upload a clear photo.',
    how4Title:'Get your result', how4Desc:"We'll apply the style you picked using AI, and you'll receive your professional photo within minutes.",
    howItWorksCta:'Start Now',
    mostRequestedTitle:'Most Ordered',
    testimonialsTitle:'Customer Reviews & Testimonials',
    testimonial1:'"Best photo transformation I have tried"', testimonial2:'"Turned my photos pro-level"',
    testimonialsNote:'* Real samples from actual Miga-Photobook results.',
    trustBadge1:'Professional quality in every photo', trustBadge2:'Constantly growing prompt library',
    trustBadge3:'Fast, direct support', trustBadge4:'Security and privacy on every order',
    aboutUsTitle:'About Us',
    aboutUsText:"Miga-Photobook is an Egyptian project that started with a simple idea: make a professional photoshoot affordable and accessible to everyone. We turn your personal photo into a studio-quality piece of art using AI — upload your photo and pick a style, and we handle the rest carefully so the result is worthy of your name.",
    faqTitle:'Frequently Asked Questions',
    faqQ1:'How does the transformation work?', faqA1:'After payment, you upload your photo, and we transform it automatically in the style you picked — the result appears right on the site.',
    faqQ2:'How long does it take?', faqA2:'Two steps: confirming your bank transfer usually takes minutes (we review it ourselves), and once confirmed the AI transformation itself takes a few minutes, shown on the same page.',
    faqQ6:"What if I don't like the result?", faqA6:"Contact us right away and we'll regenerate your photo with a different prompt at no extra cost, until you're happy with the result.",
    faqQ3:'Do I need experience?', faqA3:'Not at all — just upload your photo and pick a style, we handle everything else.',
    faqQ4:'Can I use it commercially?', faqA4:'The resulting image is licensed for personal use. For commercial use (resale or client projects), please contact us first for proper licensing.',
    faqQ5:'How do I get my result?', faqA5:'Right after payment is confirmed, upload your photo on the site and get the transformed result directly — downloadable anytime.',
    faqQ7:'Can I choose more than one style?', faqA7:'Of course! You can order more than one style for the same photo or for different photos — each style counts as a separate order, or use one of the bundles (10 or 25 photos) to save if you need more than one result.',
    heroTitle:'Turn your photo into a professional,<br>studio-quality portrait with <span class="brand-mark">Miga-Photobook</span><br>in minutes.',
    heroP:'A library of professional, ready-to-use prompts for transforming personal photos — for children, men, and women — carefully written and tested. Buy, unlock instantly, and use right away.',
    heroCta1:'Make Your Photo Now — 25 EGP', heroCta2:'Pricing & Offers',
    bafTitle:'One Photo From You... Turned Into Your Favorite Style',
    bafSub:'This is the same photo, after Miga-Photobook transformed it into different styles. Pick one you like and try it on your own photo.',
    bafCenterLabel:'Your Original Photo',
    bafCta:'Make Your Photo Now — 25 EGP',
    secChildrenTitle:"Children's Section", secMaleTitle:"Men's Section", secFemaleTitle:"Women's Section",
    secBusinessTitle:'Business Section', secCinematicTitle:'Cinematic Section', secLuxuryTitle:'Luxury Section',
    secArtisticTitle:'Artistic Section', secMagazineTitle:'Magazine / Poster Section',
    pricingTitle:'Pricing & Offers',
    pricingSub:'Order photo transformations individually, or save more with bundles. Each bundle applies as a discount for the matching number of photos from any section.', pricingGuaranteeNote:'❤️ Not happy with the result? We will regenerate it with a different prompt for free.',
    plan1Title:'Single Transformation', plan1Price:'Only 25 EGP', currencyLabel:'EGP',
    plan1Li1:'One photo transformation at its listed price', plan1Li2:'Instant processing after payment', plan1Li3:'Good for trying it out', plan1Cta:'Browse Now',
    plan2Title:'Pro Bundle', plan2Unit:'/ 10 photos',
    plan2Li1:'Save 50 EGP off individual price', plan2Li2:'Free choice from any section', plan2Li3:'Priority support',
    planBuyBtn:'Order this package now', planWhatsBtn:'Order via WhatsApp',
    plan3Title:'Agency Bundle', plan3Unit:'/ 25 photos',
    plan3Li1:'18 EGP per photo — save 175 EGP', plan3Li2:'Free style library updates', plan3Li3:'Great for studios and agencies',
    buyModalTitle:'Pay via InstaPay',
    ipLabel:'Transfer the amount via InstaPay (from any bank or wallet that supports InstaPay transfers) to the following number',
    vodafoneLabel:'Transfer the amount via Vodafone Cash to the following number',
    payMethodInstapay:'InstaPay', payMethodVodafone:'Vodafone Cash', payMethodCard:'Credit Card', payMethodFawry:'Fawry',
    payerNameLabel:'Name', payerPhoneLabel:'Mobile Number', payerEmailLabel:'Email (optional)',
    payNowBtn:'Pay Now', getFawryCodeBtn:'Get Payment Code',
    fawryRefNote:'Go to any Fawry outlet and pay using this code:',
    ipCopyBtn:'Copy Number',
    buyerAppLabel:'App/bank you transferred from (optional)', buyerAppPh:'e.g. InstaPay, Banque Misr, CIB, Vodafone Cash...',
    buyerPhoneLabel:'Mobile number you transferred from',
    buyerRefLabel:'Transfer reference number (if any)', buyerRefPh:'e.g. last 4 digits or transaction number',
    statusPendingText:"We're reviewing your transfer... this page will update itself once it's confirmed.",
    statusCodeNote:'Your order code (keep it just in case):',
    statusSafeCloseNote:"You can close this page now — we'll review your order and update you as soon as it's confirmed.",
    statusApprovedText:'Payment confirmed ✅ You can upload your photo now.',
    buyModalNote:"We'll review your transfer ourselves as soon as it arrives — this page stays open and updates itself once confirmed, no separate code to look for.",
    buyConfirmBtn:"I've Paid", cancelBtn:'Cancel',
    detailValue1:'✓ Your photo is transformed automatically right after payment', detailValue2:'✓ Guaranteed professional studio quality',
    detailValue3:'✓ Result ready to download within minutes', detailValue4:'✓ Direct support if you need help',
    detailBuyBtn:'Get It Now',
    cropModalTitle:'Adjust the Photo Frame', cropModalSub:'Drag the photo and use the zoom slider to fit it in the frame — every product photo will come out at exactly the same size after this.',
    cropConfirmBtn:'Confirm Crop',
    trackModalTitle:'Track Your Order', trackModalSub:'Enter the tracking code you received after sending a purchase request.',
    myOrdersTitle:'Your Past Orders', loadingLabel:'Loading...',
    trackCodeLabel:'Tracking Code', trackCheckBtn:'Check Status', closeBtn:'Close',
    adminTitle:'Admin Login', adminFabLabel:'Admin panel',
    alertsOnTitle:'Order alerts are on', alertsOffTitle:'Turn on order alerts',
    toastAlertsOn:'Order alerts enabled ✅', toastAlertsBlocked:'The browser blocked notifications — enable them in site settings.',
    toastAlertsUnsupported:'This browser does not support notifications.',
    toastNewOrder:'{n} new order(s) just arrived 🔔',
    newOrderNotifTitle:'New order — Miga-Photobook',
    newOrderNotifBody:'{n} new order(s). Pending in total: {total}.',
    shareResultBtn:'Share result', shareResultText:'Check out my photo from Miga-Photobook 🔥',
    toastShareCopied:'Link copied — paste it anywhere ✅',
    nudgeTitle:'Still deciding?',
    nudgeBody:'The launch offer is still on — your photo for 25 EGP instead of 50. Not sure which style suits you? Message us on WhatsApp and we will help you pick.',
    nudgeBrowseBtn:'Browse photos', nudgeAskBtn:'Ask us on WhatsApp',
    thanksTitle:'Thank you for trying us 🙏',
    thanksBody:'If you like your photo, sharing it with friends or leaving a quick review helps us a lot.',
    thanksShareBtn:'Share your photo', thanksReviewBtn:'Write a review',
    thankCustomerBtn:'Thank via WhatsApp', thankCustomerDoneBtn:'✓ Thank-you message sent',
    toastThankSaveFailed:'The message opened, but saving the note failed — try refreshing.',
    whatsappThanksTemplate:'Hi 👋\nThank you for trying Miga-Photobook and ordering "{title}".\nIf you like your photo, sharing it with friends would mean a lot to us 🙏\nAnd if you would like another one, just message us any time.',
    payerRefLabel:'Transfer reference number (from your transfer receipt)',
    payerRefPh:'e.g. 4821960573',
    payWarning:'🔐 To make sure your order is processed quickly, double-check the transfer reference number.',
    payConfirmLabel:'I confirm I have actually transferred the amount, and the reference above is correct.',
    toastEnterRef:'Enter the correct transfer reference from your receipt.',
    toastConfirmPaymentFirst:'Please tick the box confirming you have transferred the amount.',
    pShareLinkLabel:'Product link (for ads) — copy it into your platform post',
    pImageLinkLabel:'Original image link — to upload with your ad',
    copyLinkTitle:'Copy product link', copyImageLinkTitle:'Copy image link',
    setCoverTitle:'Make this the category cover', cycleCoverTitle:'Show another photo',
    toastCoverSet:'Set as the category cover ⭐',
    toastCoverSaveFailed:'Changed on screen, but saving failed — please try again.',
    toastLinkCopied:'Product link copied ✅', toastImageLinkCopied:'Image link copied ✅',
    toastNoImageYet:'This product has no image yet.',
    downloadArchiveBtn:'⬇️ Download Category Archive', downloadAllArchiveBtn:'⬇️ Download Full Archive',
    toastArchiveFailed:'Could not create the archive, please try again',
    dailyReportTitle:'📊 Performance Report', dailyReportLoading:'Gathering data...',
    dailyReportTodaySuffix:'last 24 hours', dailyReportAllTimeSuffix:'all time — reviews have no recorded date',
    dailyReportOrdersTitle:'Orders', dailyReportTotal:'Total', dailyReportRevenue:'Revenue',
    dailyReportReviewsTitle:'Reviews', reviewStatPendingLabel:'Pending', reviewStatApprovedLabel:'Approved',
    dailyReportVisitorsTitle:'Visitors', dailyReportDownloadBtn:'⬇️ Export Excel',
    periodDailyBtn:'Today', periodWeeklyBtn:'Last 7 days', periodCustomBtn:'Custom range', periodApplyBtn:'Apply',
    periodCustomMissing:'Pick a start and end date first', reportChartTitle:'Performance over the period',
    reportNarrativeTitle:'📋 Summary & recommendations', reportVsPrevious:'vs. the previous period', reportDownloadChartBtn:'⬇️ Chart image',
    visitorsAllTimeNote:'all-time total', toastExcelLibFailed:'Excel export library is still loading, try again shortly',
    adminSub:'Product and order management panel.',
    adminPassLabel:'Password', adminLoginBtn:'Login',
    tabProducts:'Add Product', tabOrders:'Orders',
    pCatLabel:'Category', optChildren:'Children', optMale:'Men', optFemale:'Women',
    optBusiness:'Business', optCinematic:'Cinematic', optLuxury:'Luxury', optArtistic:'Artistic', optMagazine:'Magazine / Poster',
    pTitleLabel:'Product Title', pTitlePh:'e.g. Cinematic Lighting Portrait',
    pTitleEnLabel:'Product Title (English) — optional, shown to customers when they switch to English', pTitleEnPh:'e.g. Cinematic Lighting Portrait',
    pPriceLabel:'Price (EGP)', pImageLabel:'Product Image',
    pPromptLabel:'AI transformation instructions (admin only — never shown to the customer)', pPromptPh:'Write the exact transformation instructions here...',
    pSaveBtn:'Add Product', adminLogoutBtn:'Logout',
    pUpdateBtn:'Update Product', confirmDeleteProduct:'Are you sure you want to delete this product? This cannot be undone.',
    pCancelEditBtn:'Cancel edit / new product', editingBannerText:'Edit mode: saving now will change this product — not add a new one.',
    replaceImageTitle:'Replace image', removeImageTitle:'Remove image', moveCategoryTitle:'Move to another category',
    moveUpTitle:'Move up (shows first)', moveDownTitle:'Move down', popularityCountTitle:'Number of times this product has been ordered',
    confirmRemoveImage:'Remove this product\'s image and replace it with the default placeholder?',
    toastImageReplaced:'Image replaced successfully', toastImageRemoved:'Image removed',
    toastCategoryMoved:'Product moved to the new category',
    toastProductDeleted:'Product deleted',
    footerText:'© 2026 Miga-Photobook — All transformations happen only after payment is completed.',
    footerTerms:'Terms of Use', footerPrivacy:'Privacy Policy', footerRefund:'Refund Policy',
    lockOverlayText:'Your photo gets transformed after purchase', ownedPill:'✓ Purchased',
    buyBtnPrefix:'🔷 Get It Now', emptyNoteCategory:'No products in this section yet — add products from the admin panel.',
    buyModalTextTemplate:'Buy "{title}" for {price} EGP.',
    buyPromptModalTextTemplate:'Buy the professional prompt for "{title}" for {price} EGP.',
    buyPackageModalTextTemplate:'Buy "{title}" for {price} EGP — use it on any products you choose after confirmation.',
    buyPromptBtnPrefix:'Get the Pro Prompt',
    copyPromptBtn:'Copy Prompt', promptPendingBtn:'Prompt Under Review',
    orderTypeTransform:'Photo Transform', orderTypePrompt:'Prompt Purchase',
    statusPromptApprovedText:'Payment confirmed ✅ Your prompt is ready — find it under "Track Order".',
    toastPromptReady:'Payment confirmed — your prompt is ready',
    statusPackageApprovedText:'Payment confirmed ✅ You have {n} photos available — pick any product and tap "Use a package credit".',
    toastPackageReady:'Payment confirmed — your package is ready to use',
    toastPackageProductAlreadyUsed:'You already used a package credit on this product — pick a different one',
    usePackageCreditBtnPrefix:'Use a package credit',
    toastPromptCopied:'Prompt copied',
    toastPromptNotReady:'This prompt is still under review',
    toastCopiedNumber:'Number copied', toastEnterPhone:'Please enter the mobile number you transferred from',
    toastInvalidPhone:'Please enter a valid Egyptian mobile number (01 followed by 9 digits)',
    toastOrderSentTemplate:'Your request has been sent — tracking code: {code} (keep it)',
    toastEnterCode:'Enter the tracking code', toastOrderNotFound:'No order found with this code',
    toastReadyToTransform:'Order confirmed — ready to transform your photo', toastOrderPending:'Order still under review, try again later',
    toastCopyFailed:"Couldn't copy automatically",
    toastOrderApproved:'Order approved — the customer can now unlock the prompt with the code',
    toastWrongPassword:'Incorrect password', toastAdminRateLimited:'Too many attempts in a short time — wait a bit (up to 10 minutes) and try again', toastAdminServerError:'The server hit a temporary issue (not your password) — try again shortly, or check the daily Cloudflare KV write limit', toastFillFields:'Please complete the title, price, and prompt',
    changePassTitle:'Change admin password', tabChangePassword:'Change password', changePassIntro:'Change the password used to log in to the admin panel. You need to know the current one to change it.', currentPassLabel:'Current password', newPassLabel:'New password', confirmNewPassLabel:'Confirm new password', changePassBtn:'Change password',
    tabSiteDesign:'Site Design', siteDesignIntro:'Choose which look customers see when they open the site. The admin panel itself always stays the same regardless of your choice here.', siteDesignLabel:'Active design', siteDesignV1Option:'Design 1 (current)', siteDesignV2Option:'Design 2 (new)', siteDesignSaveBtn:'Save choice', toastSiteDesignSaved:'Design saved — customers will see it on their next visit',
    toastPassChanged:'Password changed successfully', toastPassMismatch:'New password and confirmation do not match', toastPassTooShort:'New password must be at least 8 characters', toastCurrentPassWrong:'Current password is incorrect', toastFillPassFields:'Please fill in all fields',
    toastProductAdded:'Product added successfully',
    uploadingImage:'Uploading image...', toastImageUploadFailed:'Could not upload the image, check your connection and try again',
    toastContactPro:'To subscribe to the Pro Bundle, please contact us', toastContactAgency:'To subscribe to the Agency Bundle, please contact us',
    ordersEmptyNote:'No orders yet.',
    orderLabelProduct:'Product', orderLabelPhone:'Mobile', orderLabelPayApp:'Payment Method', orderLabelRef:'Reference',
    orderLabelCode:'Code', orderLabelStatus:'Status', orderStatusApproved:'Approved', orderStatusPending:'Under Review',
    orderStatusRejected:'Rejected', orderRejectBtn:'Reject Order', orderDeleteBtn:'Delete Permanently',
    confirmRejectOrder:"Are you sure you want to reject this order? It can't be approved afterwards.",
    confirmDeleteOrder:'Are you sure you want to permanently delete this rejected order?', confirmDeleteReview:'Are you sure you want to permanently delete this review?', reviewDeleteBtn:'Delete review', toastReviewDeleted:'Review deleted',
    toastOrderRejected:'Order rejected', toastOrderDeleted:'Order deleted',
    statTotalLabel:'Total Orders', statApprovedLabel:'Completed', statPendingLabel:'Under Review',
    statRevenueLabel:'Total Revenue Collected', exportOrdersBtn:'⬇️ Export All Orders (Excel)',
    reviewStatTotalLabel:'Total Reviews', reviewStatApprovedLabel:'Published', reviewStatPendingLabel:'Under Review',
    reviewColRating:'Rating', reviewColComment:'Comment',
    statColCode:'Code', statColProduct:'Product', statColStatus:'Status', statColTime:'Time', statColBuyer:'Buyer',
    orderLabelBuyer:'Buyer name/email', orderBuyerGuest:'Guest (no account)',
    orderLabelType:'Order Type', statColType:'Type',
    sendPromptWhatsAppBtn:'Send via WhatsApp',
    whatsappPromptMessageTemplate:'Hi 👋 your payment is confirmed — here\\u2019s the professional prompt for "{title}":\\n\\n{prompt}\\n\\nThanks for choosing Miga-Photobook 🙏',
    orderApproveBtn:'Approve & Enable Transform',
    softLaunchBanner:'🎉 Soft Launch — all transformations are free right now for a limited time',
    launchPromoBannerText:'🎉 Launch Offer — every photo for just 25 EGP!',
    countdownFormat:'Offer ends in: {d}d {h}h',
    countdownFormatHoursOnly:'Offer ends in: {h}h {m}m',
    countdownEnded:'Offer ended',
    freeLabel:'Free', claimFreeBtn:'Get It Free',
    toastFreeUnlocked:'Unlocked for free — ready to transform your photo! (soft launch period)',
    transformBtn:'Transform Your Photo', viewResultBtn:'View Your Result ✅', transformModalTitle:'Transform Your Photo',
    transformAlreadyDoneNote:'Your photo was already transformed with this order — this is your saved result.',
    uploadPhotoLabel:'Choose your photo', beforeLabel:'Before', afterLabel:'After',
    consentLabel:"I confirm I own this photo or am its legal guardian, and consent to using it to generate the requested artistic result.",
    transformPrivacyNote:'Your photo is used only to fulfill your order and is never shared with anyone else.',
    transformPrivacyNoteReal:'Your photo is sent securely to an image-processing service to create the result, and is not permanently stored on our servers.',
    transformLikenessNote:"We keep your core facial features as close to the original as possible, but the result's quality depends on how clear the original photo is.",
    generateBtn:'Transform Photo', downloadResultBtn:'Download Result',
    toastInvalidImage:'Please choose a valid image file',
    toastSelectPhoto:'Please choose a photo first',
    toastConsentRequired:'Please agree to the photo consent statement to continue',
    toastTransformDone:'Preview ready — you can download it now',
    toastGenerating:'Generating your image... this can take a few minutes',
    toastGenerateFailed:'Something went wrong while generating, please try again',
    toastOrderFailed:"Couldn't send your order right now — check your connection and try again, or contact us directly.",
    toastDownloadFailed:'Could not download the image automatically'
  }
};
let currentLang = 'ar';

function t(key){
  return (translations[currentLang] && translations[currentLang][key]) || (translations.ar[key] || key);
}
// Product titles are admin-entered free text, not part of the translations
// dictionary — this uses the optional English title (titleEn) an admin can set
// per product, falling back to the Arabic title if none was entered yet.
function productTitle(p){
  if(!p) return '';
  return (currentLang === 'en' && p.titleEn) ? p.titleEn : p.title;
}

async function saveUiPrefs(){
  try{ localStorage.setItem('megaPromptUiPrefs', JSON.stringify({lang: currentLang, view: currentViewMode, theme: currentTheme})); }
  catch(e){ console.error('save prefs failed', e); }
}
async function loadUiPrefs(){
  try{
    const raw = localStorage.getItem('megaPromptUiPrefs');
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

function applyLanguage(lang){
  currentLang = (lang === 'en') ? 'en' : 'ar';
  document.documentElement.lang = currentLang;
  document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';
  CURRENCY = t('currencyLabel');

  document.querySelectorAll('[data-i18n]').forEach(el=>{
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el=>{
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el=>{
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });

  // If a specific category (not "All") is selected, the dropdown button shows
  // that category's name — the blanket data-i18n pass above just reset it to
  // the generic "Categories" label, so re-sync it to the active button's
  // freshly-translated text.
  const activeCatBtn = document.querySelector('#catNav button.active');
  if(activeCatBtn && activeCatBtn.dataset.cat !== 'all'){
    document.getElementById('catDropdownLabel').textContent = activeCatBtn.textContent;
  }

  document.querySelectorAll('#langToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
  refreshThemeToggleLabels();
  updateAccountButton();

  // The privacy note in the transform modal depends on whether a real
  // image-generation backend is configured (BACKEND_BASE) — override the
  // generic i18n text so customers always see an accurate description.
  // (The facial-likeness note below it is static and always shown as-is.)
  const privacyNoteEl = document.getElementById('transformPrivacyNoteEl');
  if(BACKEND_BASE){
    if(privacyNoteEl) privacyNoteEl.textContent = t('transformPrivacyNoteReal');
  }

  // re-render dynamic, language-dependent content
  renderHeroStrip();
  renderGrids();
  renderMostRequested();
  updateCountdown();
  if(adminLoggedIn && document.getElementById('adminTabOrders').style.display !== 'none'){
    renderOrdersList();
  }
  saveUiPrefs();
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

/** Day/night display theme — independent of language and of view mode, and
 * shared by every toggle button on the page (main header + admin panel), so
 * flipping it anywhere flips the whole document (a single data-theme
 * attribute on <html> drives every colour via CSS variables). Defaults to
 * 'dark' to match the site's original look for anyone who hasn't chosen yet. */
let currentTheme = 'dark';
function refreshThemeToggleLabels(){
  const isNight = currentTheme === 'dark';
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.classList.toggle('is-night', isNight);
    btn.setAttribute('aria-label', t(isNight ? 'themeNightLabel' : 'themeDayLabel'));
    btn.title = t('themeToggleTitle');
    btn.setAttribute('aria-pressed', String(isNight));
  });
}
function applyTheme(theme){
  currentTheme = (theme === 'light') ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  refreshThemeToggleLabels();
  saveUiPrefs();
}
function toggleTheme(){
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}
document.querySelectorAll('.theme-toggle').forEach(btn=>{
  btn.addEventListener('click', toggleTheme);
});

document.getElementById('langToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  applyLanguage(btn.dataset.lang);
});
document.getElementById('viewToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  applyViewMode(btn.dataset.view);
});

// ---------- Interactive click sound (subtle, synthesized — no audio file needed) ----------
let _audioCtx = null;
function playClickSound(){
  try{
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.08);
  }catch(e){ /* audio not available — fail silently */ }
}
document.addEventListener('click', (e)=>{
  if(e.target.closest('button, .buy-btn, .copy-btn, .contact-item')) playClickSound();
}, true);

document.getElementById('contactFabBtn').addEventListener('click', (e)=>{
  e.stopPropagation();
  document.getElementById('contactMenu').classList.toggle('show');
});
document.addEventListener('click', (e)=>{
  const widget = document.getElementById('contactWidget');
  if(widget && !widget.contains(e.target)){
    document.getElementById('contactMenu').classList.remove('show');
  }
});

// ---------- Lightbox (full-quality image view) ----------
function openLightbox(src){
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxBg').classList.add('show');
}
function closeLightbox(){
  document.getElementById('lightboxBg').classList.remove('show');
}

// ---------- Storage helpers ----------
// Products are shared across every visitor, so they're stored server-side via the
// Worker + Cloudflare KV (see transform-worker.js) — this replaces the old fake
// window.storage calls that only worked inside a Claude artifact preview and reset
// on every reload once deployed anywhere else.
//
// IMPORTANT: loadProducts() never writes anything back to the backend. An earlier
// version did — if /products ever came back empty (a network blip, a cold KV read,
// not necessarily a truly empty catalog), it would silently push 42 placeholder
// demo products into the SHARED backend from any ordinary visitor's page load,
// overwriting the real catalog. Only explicit admin actions (upsertProductRemote /
// deleteProductRemote, both password-protected) are allowed to write products now.
async function loadProducts(){
  if(!BACKEND_BASE){ products = seedProducts(); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/products`);
    const data = await res.json();
    let parsed = null;
    if(data && data.value){
      try{ parsed = JSON.parse(data.value); }catch(e){ parsed = null; }
    }
    products = Array.isArray(parsed) ? parsed : [];
  }catch(e){
    products = [];
  }
}
async function upsertProductRemote(product){
  if(!BACKEND_BASE) return false;
  try{
    const res = await fetch(`${BACKEND_BASE}/products/upsert`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, product })
    });
    return res.ok;
  }catch(e){ console.error('upsert product failed', e); return false; }
}
async function deleteProductRemote(id){
  if(!BACKEND_BASE) return false;
  try{
    const res = await fetch(`${BACKEND_BASE}/products/delete`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, id })
    });
    return res.ok;
  }catch(e){ console.error('delete product failed', e); return false; }
}

// Purchases are personal to this browser/device — a real per-customer account system
// would need a login, which this site doesn't have, so localStorage (scoped to this
// browser) is the correct, honest place for this — not a shared backend.
//
// orderCodes holds the approved order code for each product this browser has bought —
// that's the proof of purchase sent to /transform so the server can look up and run the
// real transformation itself. The prompt/instructions text never comes to the browser
// at any point, not even transiently: this site transforms the photo for the customer
// automatically; the instructions that drive that are an admin-only detail.
let orderCodes = {};
let transformedResults = {}; // productId -> cached generated image URL, so a refreshed
// page can show "شاهد النتيجة" instead of implying a fresh free attempt.
let productPopularity = {}; // productId -> approved-order count, from the public /products/popularity endpoint
// Prompt-purchase state — kept entirely separate from the photo-transform
// state above, since a customer can hold both kinds of order for the same
// product at once (they're two different products being sold).
let promptPurchases = [];
let promptOrderCodes = {};
let purchasedPromptTexts = {}; // productId -> prompt text, once its order is approved
// Package credits — a package order isn't tied to one productId server-side
// (see /transform's package branch in the Worker); it just carries a shared
// credit count the customer can spend on any product. This mirrors that
// locally so the storefront can show "N photos left in your package" and
// offer a "use a package credit" button on any product card.
let packageCredits = {}; // { [orderCode]: { size, remaining, usedProductIds: [] } }
async function loadPurchases(){
  try{
    const raw = localStorage.getItem('megaPromptPurchases');
    purchases = raw ? JSON.parse(raw) : [];
  }catch(e){ purchases = []; }
  try{
    const raw = localStorage.getItem('megaPromptOrderCodes');
    orderCodes = raw ? JSON.parse(raw) : {};
  }catch(e){ orderCodes = {}; }
  try{
    const raw = localStorage.getItem('megaPromptTransformedResults');
    transformedResults = raw ? JSON.parse(raw) : {};
  }catch(e){ transformedResults = {}; }
  try{
    const raw = localStorage.getItem('megaPromptPromptPurchases');
    promptPurchases = raw ? JSON.parse(raw) : [];
  }catch(e){ promptPurchases = []; }
  try{
    const raw = localStorage.getItem('megaPromptPromptOrderCodes');
    promptOrderCodes = raw ? JSON.parse(raw) : {};
  }catch(e){ promptOrderCodes = {}; }
  try{
    const raw = localStorage.getItem('megaPromptPurchasedPromptTexts');
    purchasedPromptTexts = raw ? JSON.parse(raw) : {};
  }catch(e){ purchasedPromptTexts = {}; }
  try{
    const raw = localStorage.getItem('megaPromptPackageCredits');
    packageCredits = raw ? JSON.parse(raw) : {};
  }catch(e){ packageCredits = {}; }
}
async function savePurchases(){
  try{ localStorage.setItem('megaPromptPurchases', JSON.stringify(purchases)); }
  catch(e){ console.error('save purchases failed', e); }
  try{ localStorage.setItem('megaPromptOrderCodes', JSON.stringify(orderCodes)); }
  catch(e){ console.error('save order codes failed', e); }
  try{ localStorage.setItem('megaPromptTransformedResults', JSON.stringify(transformedResults)); }
  catch(e){ console.error('save transformed results failed', e); }
  try{ localStorage.setItem('megaPromptPromptPurchases', JSON.stringify(promptPurchases)); }
  catch(e){ console.error('save prompt purchases failed', e); }
  try{ localStorage.setItem('megaPromptPromptOrderCodes', JSON.stringify(promptOrderCodes)); }
  catch(e){ console.error('save prompt order codes failed', e); }
  try{ localStorage.setItem('megaPromptPurchasedPromptTexts', JSON.stringify(purchasedPromptTexts)); }
  catch(e){ console.error('save purchased prompt texts failed', e); }
  try{ localStorage.setItem('megaPromptPackageCredits', JSON.stringify(packageCredits)); }
  catch(e){ console.error('save package credits failed', e); }
}

// Orders: admin-only listing goes through the Worker (password-checked server-side);
// creating an order and tracking a single order by code have their own public routes
// that don't expose the full order list. See the specific call sites below.
async function loadOrders(){
  if(!BACKEND_BASE || !adminSessionToken){ orders = []; return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/list?token=${encodeURIComponent(adminSessionToken)}`);
    const data = await res.json();
    orders = (data && data.value) ? JSON.parse(data.value) : [];
  }catch(e){ orders = []; }
}

/** Public, no-password — powers both the storefront's "الأكثر طلبًا" section
 * and the 🔥 count next to each product in the admin list. Safe to call for
 * any visitor, logged in or not. */
async function loadProductPopularity(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/products/popularity`);
    const data = await res.json();
    productPopularity = data.counts || {};
  }catch(e){ /* keep whatever counts we already had */ }
}

function seedProducts(){
  return [
    {id:'seed1', category:'children', title:'بورتريه كتاب قصص', price:25, image:PLACEHOLDER_IMG, prompt:'أضف عملك الفني هنا بعد رفع الصورة الفعلية.'},
    {id:'male_ar_badge', category:'male', title:'شعار بورتريه شخصي — إطار كروم بالاسم العربي', price:25, image:PLACEHOLDER_IMG, prompt:"Professional personal-branding portrait logo, circular badge composition: a polished brushed-chrome double ring frame with a subtle glowing blue neon rim-light tracing its inner edge, set against a pure black background. Centered inside the ring: a confident middle-aged man, upper chest and shoulders crop, short groomed grey hair, trimmed grey beard, dark-framed rectangular glasses, wearing a black buttoned shirt under a black blazer, softly lit with a single-source studio key light from upper-left creating gentle Rembrandt shadow on the right side of the face, subtle blue rim light separating him from the background, sharp catchlight in the eyes, high-end retouched skin with visible natural texture and pores preserved, shallow depth of field. Beneath the portrait, inside the lower arc of the ring, the person's name rendered in bold Arabic calligraphy as a polished engraved chrome 3D metal typography effect with the same blue neon glow outlining the letterforms, matching the ring's metallic finish. Square 1:1 canvas, ultra-detailed, commercial photography quality, 8k resolution, cinematic color grade in cool blacks and silvers."},
    {id:'male_en_badge', category:'male', title:'شعار بورتريه شخصي — إطار كروم بتوقيع إنجليزي', price:25, image:PLACEHOLDER_IMG, prompt:"Professional personal-branding portrait logo, circular badge composition: a polished brushed-chrome double ring frame with a subtle glowing blue neon rim-light tracing its inner edge, set against a pure black background. Centered inside the ring: a confident middle-aged man, upper chest and shoulders crop, short groomed grey hair, trimmed grey beard, dark-framed rectangular glasses, wearing a black buttoned shirt under a black blazer, softly lit with a single-source studio key light from upper-left creating gentle Rembrandt shadow on the right side of the face, subtle blue rim light separating him from the background, sharp catchlight in the eyes, high-end retouched skin with visible natural texture and pores preserved, shallow depth of field. Beneath the portrait, arcing along the lower inside of the ring, the person's name rendered in an elegant flowing English cursive script as a polished 3D brushed-metal signature-style logotype with soft specular highlights matching the ring's chrome finish, small blue light-flare accent centered beneath the signature. Square 1:1 canvas, ultra-detailed, commercial photography quality, 8k resolution, cinematic color grade in cool blacks and silvers."},
    {id:"male_amber_studio", category:'male', title:"بورتريه استوديو كهرماني", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه استوديو احترافي بإضاءة كهرمانية دافئة وخلفية متدرجة، تركيز حاد على تفاصيل الوجه بأسلوب راقٍ وهادئ."},
    {id:"male_aviator_gold_watch", category:'male', title:"إطلالة أفياتور وساعة ذهبية", price:25, image:PLACEHOLDER_IMG, prompt:"إطلالة عصرية بنظارة أفياتور شمسية وساعة ذهبية بارزة، إضاءة دافئة تبرز التفاصيل والملمس الفاخر."},
    {id:"male_bookshelf_maroon_tie", category:'male', title:"بورتريه مكتبة بربطة عنق كستنائية", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه رسمي أمام رفوف كتب خشبية، بربطة عنق كستنائية اللون وإضاءة دافئة توحي بالوقار والثقة."},
    {id:"male_bw_color_pop_red", category:'male', title:"أبيض وأسود مع لمسة حمراء", price:25, image:PLACEHOLDER_IMG, prompt:"صورة بالأبيض والأسود مع الحفاظ على عنصر واحد بلون أحمر بارز (Color Pop) لخلق تباين درامي لافت."},
    {id:"male_bw_dramatic_signature", category:'male', title:"بورتريه درامي أبيض وأسود بتوقيع", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه درامي بالأبيض والأسود بإضاءة قوية الظلال، مع إضافة توقيع أو عبارة مميزة أسفل الصورة كلمسة فنية شخصية."},
    {id:"male_cafe_golden", category:'male', title:"جلسة كافيه بإضاءة ذهبية", price:25, image:PLACEHOLDER_IMG, prompt:"صورة لايف ستايل داخل كافيه بإضاءة ذهبية دافئة وأجواء هادئة تعكس أسلوب حياة عصري وأنيق."},
    {id:"male_cafe_golden2", category:'male', title:"جلسة كافيه ذهبية - زاوية أخرى", price:25, image:PLACEHOLDER_IMG, prompt:"لقطة لايف ستايل ثانية داخل كافيه بإضاءة ذهبية وتكوين مختلف يبرز التفاصيل والأجواء الدافئة."},
    {id:"male_cafe_lifestyle", category:'male', title:"لقطة لايف ستايل في كافيه", price:25, image:PLACEHOLDER_IMG, prompt:"صورة طبيعية وعفوية داخل كافيه تعكس لحظة يومية أنيقة بإضاءة طبيعية ناعمة."},
    {id:"male_charcoal_lookup", category:'male', title:"رسم فحم بنظرة للأعلى", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة بأسلوب رسم الفحم (Charcoal) بتفاصيل يدوية دقيقة ونظرة معبرة للأعلى، إحساس فني كلاسيكي."},
    {id:"male_closeup_bookshelf_olive", category:'male', title:"لقطة قريبة أمام مكتبة بلون زيتي", price:25, image:PLACEHOLDER_IMG, prompt:"لقطة مقربة للوجه أمام خلفية مكتبة، بتدرج لوني زيتوني هادئ يعكس الجدية والعمق."},
    {id:"male_coffee_art_reflection", category:'male', title:"انعكاس فني في فنجان قهوة", price:25, image:PLACEHOLDER_IMG, prompt:"تكوين فني إبداعي يظهر انعكاس الصورة داخل فنجان قهوة، مزيج بين الواقعية واللمسة الفنية السريالية."},
    {id:"male_crossed_arms_library", category:'male', title:"وقفة واثقة أمام مكتبة", price:25, image:PLACEHOLDER_IMG, prompt:"صورة بوقفة واثقة والذراعين متقاطعتين أمام خلفية مكتبة، تعبّر عن الثقة والاحترافية."},
    {id:"male_cubist_geometric_painting", category:'male', title:"لوحة تكعيبية هندسية", price:25, image:PLACEHOLDER_IMG, prompt:"تحويل الصورة إلى لوحة فنية بأسلوب تكعيبي (Cubism) بأشكال هندسية متداخلة وألوان جريئة."},
    {id:"male_digital_painting_profile_dark", category:'male', title:"لوحة رقمية بروفايل داكن", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة رقمية بأسلوب فني معاصر بخلفية داكنة وإضاءة موضعية تبرز ملامح الوجه من زاوية جانبية."},
    {id:"male_digital_painting_splash", category:'male', title:"لوحة رقمية بتأثير الرذاذ اللوني", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة رقمية معاصرة مع تأثيرات رذاذ لوني (Splash) متطايرة حول الوجه تضيف حيوية وحركة بصرية."},
    {id:"male_double_exposure_skyline", category:'male', title:"تعريض مزدوج مع أفق المدينة", price:25, image:PLACEHOLDER_IMG, prompt:"تأثير التعريض المزدوج (Double Exposure) يدمج ملامح الوجه مع أفق مدينة حديثة، إحساس سينمائي عميق."},
    {id:"male_ember_sunglasses_black", category:'male', title:"نظارة شمسية بإضاءة جمرية - خلفية سوداء", price:25, image:PLACEHOLDER_IMG, prompt:"إطلالة عصرية بنظارة شمسية وإضاءة برتقالية جمرية دافئة على خلفية سوداء عميقة تبرز التباين."},
    {id:"male_ember_sunglasses_white", category:'male', title:"نظارة شمسية بإضاءة جمرية - خلفية بيضاء", price:25, image:PLACEHOLDER_IMG, prompt:"نفس أسلوب الإضاءة الجمرية الدافئة مع نظارة شمسية، لكن على خلفية بيضاء نظيفة لإحساس أخف وأكثر إشراقًا."},
    {id:"male_framed_easel_cosmic", category:'male', title:"لوحة مؤطرة على حامل فني بلمسة كونية", price:25, image:PLACEHOLDER_IMG, prompt:"عرض الصورة كلوحة فنية مؤطرة موضوعة على حامل رسام (Easel)، بخلفية كونية نجمية تضيف طابعًا خياليًا."},
    {id:"male_holiday_greeting_caption", category:'male', title:"بطاقة تهنئة بمناسبة مع عبارة", price:25, image:PLACEHOLDER_IMG, prompt:"تصميم بطاقة تهنئة احتفالية بعناصر المناسبة وإضاءة دافئة، مع مساحة لعبارة تهنئة مخصصة."},
    {id:"male_ink_sunglasses_grunge", category:'male', title:"نظارة شمسية بأسلوب حبر جرانج", price:25, image:PLACEHOLDER_IMG, prompt:"أسلوب بصري خشن (Grunge) مع تأثيرات حبر متناثرة ونظارة شمسية، إحساس عصري جريء وغير تقليدي."},
    {id:"male_library_study_portrait", category:'male', title:"بورتريه في مكتبة دراسة", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه هادئ داخل مكتبة أو غرفة دراسة كلاسيكية، إضاءة دافئة توحي بالعلم والتأمل."},
    {id:"male_luxury_study_teacup", category:'male', title:"أجواء دراسة فاخرة مع فنجان شاي", price:25, image:PLACEHOLDER_IMG, prompt:"مشهد لايف ستايل فاخر في غرفة دراسة مع فنجان شاي على الطاولة، أجواء هادئة وراقية."},
    {id:"male_neon_green_1", category:'male', title:"إضاءة نيون خضراء - تكوين أول", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه بإضاءة نيون خضراء نابضة على خلفية داكنة، أسلوب عصري حاد التباين."},
    {id:"male_neon_green_2", category:'male', title:"إضاءة نيون خضراء - تكوين ثانٍ", price:25, image:PLACEHOLDER_IMG, prompt:"تكوين مختلف بنفس أسلوب إضاءة النيون الأخضر النابض، بزاوية وتركيب مختلفين."},
    {id:"male_oil_painting_cosmic_tie", category:'male', title:"لوحة زيتية بربطة عنق كونية", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة بأسلوب الرسم الزيتي الكلاسيكي، مع تفاصيل ربطة عنق بنقشة كونية نجمية كلمسة فنية مميزة."},
    {id:"male_paint_splash_alley", category:'male', title:"رذاذ ألوان في زقاق حضري", price:25, image:PLACEHOLDER_IMG, prompt:"تأثير رذاذ الألوان المتفجرة حول الصورة على خلفية زقاق حضري، مزيج بين الطاقة والحركة الفنية."},
    {id:"male_pencil_color_sketch", category:'male', title:"سكتش رصاص ملون", price:25, image:PLACEHOLDER_IMG, prompt:"رسم سكتش بالرصاص الملون بخطوط يدوية ناعمة وألوان هادئة تضيف طابعًا فنيًا دافئًا."},
    {id:"male_pencil_sketch", category:'male', title:"سكتش رصاص أبيض وأسود", price:25, image:PLACEHOLDER_IMG, prompt:"رسم سكتش كلاسيكي بالرصاص الأبيض والأسود بخطوط دقيقة يدوية المظهر."},
    {id:"male_profile_caption_banner", category:'male', title:"بروفايل مع شريط عبارة", price:25, image:PLACEHOLDER_IMG, prompt:"تصميم صورة بروفايل احترافي مع شريط نصي أسفل الصورة لإضافة اسمك أو عبارتك المفضلة."},
    {id:"male_profile_pencil_smile", category:'male', title:"سكتش رصاص بابتسامة", price:25, image:PLACEHOLDER_IMG, prompt:"رسم سكتش بالرصاص يبرز ابتسامة طبيعية دافئة، أسلوب يدوي ناعم ومريح للعين."},
    {id:"male_sepia_bar_watercolor", category:'male', title:"ألوان مائية سيبيا في أجواء بار", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة ألوان مائية بدرجات السيبيا الدافئة في أجواء بار أو مقهى كلاسيكي، إحساس نوستالجي أنيق."},
    {id:"male_studio_softbox_cityview", category:'male', title:"استوديو بإضاءة سوفت بوكس وإطلالة مدينة", price:25, image:PLACEHOLDER_IMG, prompt:"بورتريه استوديو احترافي بإضاءة سوفت بوكس ناعمة، مع خلفية زجاجية تطل على أفق المدينة."},
    {id:"male_vintage_polaroid_sepia", category:'male', title:"بولارويد كلاسيكي بلون السيبيا", price:25, image:PLACEHOLDER_IMG, prompt:"تأثير صورة بولارويد قديمة بدرجات السيبيا الدافئة وحواف الإطار الكلاسيكية المميزة."},
    {id:"male_watercolor_curly_orange", category:'male', title:"ألوان مائية برتقالية بشعر مموج", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة ألوان مائية بدرجات برتقالية دافئة تبرز تفاصيل الشعر المموج بأسلوب فني انسيابي."},
    {id:"male_watercolor_illustration", category:'male', title:"رسم توضيحي بالألوان المائية", price:25, image:PLACEHOLDER_IMG, prompt:"تحويل الصورة إلى رسم توضيحي (Illustration) بالألوان المائية بخطوط ناعمة وتدرجات لونية شفافة."},
    {id:"male_watercolor_purple_smile", category:'male', title:"ألوان مائية بنفسجية وابتسامة", price:25, image:PLACEHOLDER_IMG, prompt:"لوحة ألوان مائية بدرجات بنفسجية دافئة تبرز ابتسامة طبيعية بأسلوب فني ناعم ومبهج."},
    {id:"male_yarn_tapestry_portrait", category:'male', title:"بورتريه بنسيج خيوط صوفية", price:25, image:PLACEHOLDER_IMG, prompt:"تحويل الصورة لتبدو وكأنها منسوجة من خيوط صوفية ملونة (Tapestry)، أسلوب فني دافئ وفريد."},
    {id:"female_newspaper_collage", category:'female', title:"بورتريه فني بأسلوب الكولاج الصحفي", price:25, image:PLACEHOLDER_IMG, prompt:"Ultra-realistic IMAX-level Netflix-style cinematic mixed-media editorial portrait, 9:16 vertical composition, use the uploaded image as the primary facial reference with maximum face consistency, create a beautiful young adult woman in a striking upward-looking close portrait, keeping the same bold artistic newspaper-collage aesthetic. Her head tilts slightly upward as she looks above the frame with an inspired, thoughtful and quietly ambitious expression, featuring softly raised brows, focused reflective eyes, relaxed cheeks, softly parted lips and a refined feminine jawline. Her luminous fair porcelain milky-white skin rendered with ultra-smooth clean texture, soft natural pink freshness and perfect even face-to-body skin tone consistency. She wears stylish translucent orange oversized eyeglasses and a simple black top. Her dark hair appears soft, slightly tousled and naturally voluminous, framing her face with elegant texture. Surround her with a vintage newspaper-print background layered with expressive blue and orange paint splashes, black ink scratches, sketch-like crosshatching and mixed-media illustration details, creating a modern artistic poster feel. Strong facial focus, rich texture, premium colour contrast, contemporary editorial mood, highly detailed 8K quality.", negativePrompt:"male face, distorted glasses, extra features, blurry details, watermark."},
  ];
}

// ---------- Render ----------
function updateCountdown(){
  const el = document.getElementById('promoCountdown');
  if(!el) return;
  const now = new Date();
  const diff = LAUNCH_PROMO_END - now;
  if(diff <= 0){
    el.textContent = t('countdownEnded');
    return;
  }
  const totalHours = Math.floor(diff / (1000*60*60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = Math.floor((diff / (1000*60)) % 60);
  if(days > 0){
    el.textContent = t('countdownFormat').replace('{d}', days).replace('{h}', hours);
  }else{
    el.textContent = t('countdownFormatHoursOnly').replace('{h}', hours).replace('{m}', minutes);
  }
}

function applyChildrenVisibility(){
  const visible = !HIDE_CHILDREN_FROM_CUSTOMERS || adminLoggedIn;
  const navBtn = document.querySelector('#catNav button[data-cat="children"]');
  const section = document.getElementById('children');
  const tile = document.querySelector('.cat-tile[data-cat="children"]');
  if(navBtn) navBtn.style.display = visible ? '' : 'none';
  if(section) section.style.display = visible ? '' : 'none';
  if(tile) tile.style.display = visible ? '' : 'none';
  const heroCta1 = document.getElementById('heroCta1Link');
  if(heroCta1) heroCta1.setAttribute('href', visible ? '#children' : '#male');

  // Any OTHER category with zero products right now is hidden from regular
  // visitors too — its section, its tile in the "الأقسام" grid, and its
  // entry in the categories dropdown — but stays fully visible to a
  // logged-in admin so they can still add photos to it. It reappears for
  // everyone automatically the moment it has at least one product, no
  // manual "unhide" step needed. (renderCatTiles() also bakes this same
  // check in directly, so a tile stays correctly hidden/shown even when it
  // gets rebuilt from scratch without this function running again first.)
  const allCats = ['children','male','female','business','cinematic','luxury','artistic','magazine'];
  allCats.forEach(cat=>{
    if(cat === 'children') return; // handled by HIDE_CHILDREN_FROM_CUSTOMERS above
    const hasProducts = products.some(p => p.category === cat);
    const catVisible = hasProducts || adminLoggedIn;
    const btn = document.querySelector('#catNav button[data-cat="'+cat+'"]');
    const sec = document.getElementById(cat);
    const catTile = document.querySelector('.cat-tile[data-cat="'+cat+'"]');
    if(btn) btn.style.display = catVisible ? '' : 'none';
    if(sec) sec.style.display = catVisible ? '' : 'none';
    if(catTile) catTile.style.display = catVisible ? '' : 'none';
  });
}

function renderHeroStrip(){
  const track = document.getElementById('heroStrip');
  const list = (products.length ? products : seedProducts())
    .filter(p => p.image !== PLACEHOLDER_IMG)
    .sort((a,b) => (b.order ?? 9999) - (a.order ?? 9999));
  const doubled = [...list, ...list];
  track.innerHTML = doubled.map((p,i) => `
    <div class="frame">
      <img src="${p.image}" alt="" loading="lazy" decoding="async">
      <span class="fno">NO. ${String((i % list.length)+1).padStart(3,'0')}</span>
    </div>`).join('');
}

/** "الأكثر طلبا" — top products by confirmed order count, from the public
 * /products/popularity endpoint (counts approved orders only). Hidden
 * entirely until at least one product has a confirmed order, so a brand-new
 * store doesn't show an awkward empty "most ordered" section. Cards are the
 * exact same orderable product-card component used in every category grid
 * (see renderProductCard) — same zoom-on-click photo, same title/price/buy
 * button — so a visitor can act on it immediately, not just admire it. */
function renderMostRequested(){
  const section = document.getElementById('mostRequested');
  const grid = document.getElementById('mostRequestedGrid');
  if(!section || !grid) return;
  const ranked = products
    .filter(p => p.image && p.image !== PLACEHOLDER_IMG && (productPopularity[p.id] || 0) > 0)
    .sort((a,b) => (productPopularity[b.id]||0) - (productPopularity[a.id]||0))
    .slice(0, 12);
  if(!ranked.length){
    section.style.display = 'none';
    const d = document.getElementById('gridDots-mostRequested');
    if(d) d.innerHTML = '';
    return;
  }
  section.style.display = '';
  grid.innerHTML = ranked.map(renderProductCard).join('');
  buildRowArrows('mostRequested', document.getElementById('gridDots-mostRequested'), grid);
}

// ---------- Living background watermark (site photos + wordmark, very low opacity) ----------
function renderWatermarkBackground(){
  const photosEl = document.getElementById('wmPhotos');
  const logoEl = document.getElementById('wmLogoLayer');
  if(!photosEl || !logoEl) return;

  // Photos: reuse the same product images already on the page — no extra downloads
  // beyond what the storefront loads anyway. Cycle through them to fill the grid.
  const withImages = products.filter(p => p.image && p.image !== PLACEHOLDER_IMG);
  const source = withImages.length ? withImages : products;
  if(source.length){
    const slots = 24; // enough to cover the grid at desktop width; extra ones just sit off-screen
    let html = '';
    for(let i=0; i<slots; i++){
      const p = source[i % source.length];
      html += `<img src="${p.image}" alt="" loading="lazy">`;
    }
    photosEl.innerHTML = html;
  }

  // Wordmark: repeating diagonal rows of the brand name, offset per row so it tiles cleanly.
  if(!logoEl.dataset.built){
    let rows = '';
    for(let r=0; r<8; r++){
      const words = Array.from({length:6}, ()=> 'Miga-Photobook').join(' &nbsp;•&nbsp; ');
      rows += `<div class="wm-logo-row" style="margin-inline-start:${(r%2)*-90}px;">${words}</div>`;
    }
    logoEl.innerHTML = rows;
    logoEl.dataset.built = '1';
  }
}

function renderGrids(){
  CAT_IDS.forEach(cat=>{
    const el = document.getElementById('grid-'+cat);
    if(!el) return;
    // Products the admin has written up (title, prompt, price) but hasn't
    // attached a real photo to yet still carry PLACEHOLDER_IMG — a mostly
    // empty dark rectangle with small centered text. Left unfiltered here,
    // every one of those showed up as a large, blank-looking card in the
    // live customer grid alongside the real photos. The category tiles
    // already exclude these from their own cover photo (see categoryCover);
    // this brings the actual product grid in line with that same rule, so a
    // draft with no photo yet stays a backstage admin concern instead of a
    // customer-facing empty tile.
    const allItems = products.filter(p=>p.category===cat && p.image && p.image !== PLACEHOLDER_IMG)
      .sort((a,b) => (b.order ?? 9999) - (a.order ?? 9999));
    const dotsEl = document.getElementById('gridDots-'+cat);

    if(!allItems.length){
      el.innerHTML = `<div class="empty-note">${t('emptyNoteCategory')}</div>`;
      if(dotsEl) dotsEl.innerHTML = '';
      return;
    }

    // Every product is rendered into one scrollable row; the arrows move the
    // row by exactly one visible width rather than swapping a page of cards.
    el.innerHTML = allItems.map(renderProductCard).join('');
    buildRowArrows(cat, dotsEl, el);
  });
  renderCatTiles();
}

/** Draws the two arrows under a product row and keeps their enabled state in
 * sync with how far the row has been scrolled. Used by every category row and
 * by the "most requested" row, so all of them behave identically. */
function buildRowArrows(key, dotsEl, rowEl){
  if(!dotsEl || !rowEl) return;
  if(rowEl.scrollWidth <= rowEl.clientWidth + 4){
    dotsEl.innerHTML = '';
    return;
  }
  dotsEl.innerHTML =
    `<button type="button" class="gp-arrow" data-row-prev onclick="scrollRow('${key}', -1)" aria-label="${t('rowPrevLabel')}">&#8249;</button>` +
    `<button type="button" class="gp-arrow" data-row-next onclick="scrollRow('${key}', 1)" aria-label="${t('rowNextLabel')}">&#8250;</button>`;
  if(!rowEl.dataset.arrowsBound){
    rowEl.addEventListener('scroll', ()=> updateRowArrows(key), {passive:true});
    rowEl.dataset.arrowsBound = '1';
  }
  updateRowArrows(key);
}

function rowElements(key){
  const rowEl = key === 'mostRequested'
    ? document.getElementById('mostRequestedGrid')
    : document.getElementById('grid-'+key);
  const dotsEl = key === 'mostRequested'
    ? document.getElementById('gridDots-mostRequested')
    : document.getElementById('gridDots-'+key);
  return {rowEl, dotsEl};
}

/** How far a card's leading edge sits from the row's leading edge. Written in
 * terms of on-screen rectangles so it is correct in both writing directions
 * and does not depend on how a browser signs scrollLeft in RTL. */
function rowEdgeOffset(rect, rowRect, rtl){
  return rtl ? (rowRect.right - rect.right) : (rect.left - rowRect.left);
}

function rowCards(rowEl){
  return Array.from(rowEl.querySelectorAll(':scope > .card'));
}

/** Index of the card currently sitting at the start of the visible area. */
function currentRowIndex(rowEl, cards, rtl){
  const rowRect = rowEl.getBoundingClientRect();
  let index = 0, best = Infinity;
  cards.forEach((c,i)=>{
    const d = Math.abs(rowEdgeOffset(c.getBoundingClientRect(), rowRect, rtl));
    if(d < best){ best = d; index = i; }
  });
  return index;
}

/** How many whole cards fit in one view: five on a wide screen, one on a phone. */
function rowPerView(rowEl, cards){
  const styles = getComputedStyle(rowEl);
  const gap = parseFloat(styles.columnGap || styles.gap) || 0;
  const pitch = cards[0].getBoundingClientRect().width + gap;
  if(!pitch) return 1;
  return Math.max(1, Math.round((rowEl.clientWidth + gap) / pitch));
}

/** Moves the row on by exactly one view's worth of cards. The target card is
 * scrolled to by element rather than by adding a pixel offset each time, so
 * the row can never drift half a card out of alignment however many times the
 * arrows are pressed. */
function scrollRow(key, direction){
  const {rowEl} = rowElements(key);
  if(!rowEl) return;
  const cards = rowCards(rowEl);
  if(!cards.length) return;
  const rtl = getComputedStyle(rowEl).direction === 'rtl';
  const perView = rowPerView(rowEl, cards);
  const current = currentRowIndex(rowEl, cards, rtl);
  const maxIndex = Math.max(0, cards.length - perView);
  const target = Math.max(0, Math.min(maxIndex, current + direction * perView));
  // 'center' (not 'start') so the arrow buttons land on exactly the same
  // snap point the CSS scroll-snap now uses — 'start' means the RTL
  // inline-start (right) edge, which combined with flex-basis:100% + gap's
  // sub-pixel rounding was what left a stray gap bleeding through on the
  // left on mobile. Centering removes that edge dependency entirely.
  cards[target].scrollIntoView({behavior:'smooth', inline:'center', block:'nearest'});
}

function updateRowArrows(key){
  const {rowEl, dotsEl} = rowElements(key);
  if(!rowEl || !dotsEl) return;
  const prev = dotsEl.querySelector('[data-row-prev]');
  const next = dotsEl.querySelector('[data-row-next]');
  if(!prev || !next) return;
  const cards = rowCards(rowEl);
  if(!cards.length) return;
  const rtl = getComputedStyle(rowEl).direction === 'rtl';
  const rowRect = rowEl.getBoundingClientRect();
  const firstOffset = rowEdgeOffset(cards[0].getBoundingClientRect(), rowRect, rtl);
  const lastRect = cards[cards.length - 1].getBoundingClientRect();
  const lastTrailing = rtl ? (lastRect.left - rowRect.left) : (rowRect.right - lastRect.right);
  prev.disabled = firstOffset >= -4;
  next.disabled = lastTrailing >= -4;
}

/** Single shared product-card template, used everywhere a product photo is
 * shown as a full, orderable card: every category grid AND the "الأكثر طلبا"
 * section — so "الأكثر طلبا" behaves exactly like a category (click the
 * photo to zoom, same title/price/buttons to order right away), and so the
 * 🔥 order-count badge (once a product has at least one confirmed order)
 * shows consistently on every card site-wide, not just in one section. */
function renderProductCard(p){
  const owned = purchases.includes(p.id);
  const alreadyTransformed = !!transformedResults[p.id];
  const requestCount = productPopularity[p.id] || 0;
  const activePkg = !owned ? activePackageWithCredits() : null;
  const pkgAvailableHere = activePkg && !activePkg.usedProductIds.includes(p.id);
  return `
  <div class="card">
    <div class="card-media">
      <img src="${p.image}" alt="${escapeHtml(productTitle(p))}" loading="lazy" decoding="async" onclick="openLightbox(this.src)" style="cursor:zoom-in;">
      <span class="card-badge">${escapeHtml(productTitle(p))}</span>
      ${requestCount > 0 ? `<span class="request-count-overlay" title="${t('popularityCountTitle')}">🔥 ${requestCount}</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title" onclick="openProductDetail('${p.id}')" style="cursor:pointer;">${escapeHtml(productTitle(p))}</div>
      ${owned ? `<span class="owned-pill">${t('ownedPill')}</span>` : ''}
      <div class="card-actions">
        ${owned
          ? (alreadyTransformed
              ? `<button class="buy-btn" onclick="openTransformModal('${p.id}')">${t('viewResultBtn')}</button>`
              : `<button class="buy-btn" onclick="openTransformModal('${p.id}')">${t('transformBtn')}</button>`)
          : SOFT_LAUNCH
            ? `<button class="buy-btn" onclick="claimFree('${p.id}')">${t('claimFreeBtn')}</button>`
            : `<button class="buy-btn" onclick="openBuyModal('${p.id}', 'transform')">${t('buyBtnPrefix')} — ${p.price} ${CURRENCY}</button>`}
        ${pkgAvailableHere
          ? `<button class="buy-btn package-credit-btn" onclick="usePackageCredit('${p.id}')">${t('usePackageCreditBtnPrefix')} (${activePkg.remaining})</button>`
          : ''}
        ${promptPurchases.includes(p.id)
          ? (purchasedPromptTexts[p.id]
              ? `<button class="buy-btn prompt-btn" onclick="copyPurchasedPrompt('${p.id}')">${t('copyPromptBtn')}</button>`
              : `<button class="buy-btn prompt-btn" onclick="openTrackForPrompt('${p.id}')">${t('promptPendingBtn')}</button>`)
          : `<button class="buy-btn prompt-btn" onclick="openBuyModal('${p.id}', 'prompt')">
               ${t('buyPromptBtnPrefix')} — <span class="price-old">${PROMPT_ORIGINAL_PRICE} ${CURRENCY}</span> <span class="price-new">${PROMPT_PRICE} ${CURRENCY}</span>
             </button>`}
      </div>
    </div>
  </div>`;
}

const CAT_IDS = ['children','male','female','business','cinematic','luxury','artistic','magazine'];
/** One small line-icon per category, shared everywhere a category shows its
 * identity (overview tile, opened section header, search results) so the
 * icon+name pairing reads as a single deliberate mark instead of the old
 * name-plus-separate-colour-tag duplication. No width/height baked in — each
 * context sizes it with CSS (font-size + 1em svg) so the same markup works
 * small in a chip and larger in a section header. Colour comes from
 * currentColor, inherited from whichever tag-<cat>/icon-<cat> class wraps it. */
const CAT_ICON = {
  children: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l2.2 4.9 5.3.5-4 3.6 1.3 5.3L12 15.1l-4.8 2.7 1.3-5.3-4-3.6 5.3-.5L12 3.5z"/></svg>',
  male: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5h6l.9 2.6-1.9 1.7 1.6 9-3.6 3.7-3.6-3.7 1.6-9-1.9-1.7L9 3.5z"/></svg>',
  female: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l2.8 3.6-1.3 1.2 2 11a1 1 0 0 1-1 1.2H9.5a1 1 0 0 1-1-1.2l2-11-1.3-1.2L12 3.2z"/></svg>',
  business: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="7.5" width="17.6" height="11.5" rx="2"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/><path d="M3.2 12.8h17.6"/></svg>',
  cinematic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.2l1-4.2h15l1 4.2"/><rect x="3" y="9.2" width="18" height="10.3" rx="1.5"/><path d="M7 5l2.2 4.2M12 5l2.2 4.2M17 5l2.2 4.2"/></svg>',
  luxury: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.3 3.5h11.4l3 5-8.7 12-8.7-12 3-5z"/><path d="M2.6 8.5h18.8M9 3.5l-1.8 5 4.8 12 4.8-12-1.8-5"/></svg>',
  artistic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2a8.8 8.8 0 1 0 0 17.6c1.3 0 1.9-.9 1.9-1.8 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2a4 4 0 0 0 4-4c0-3.9-4-7-8.9-7z"/><circle cx="7.6" cy="10.8" r="1"/><circle cx="9.6" cy="7.2" r="1"/><circle cx="14.2" cy="6.6" r="1"/><circle cx="17" cy="9.8" r="1"/></svg>',
  magazine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6c3.3-1.4 6.5-1.4 9.5.3 3-1.7 6.2-1.7 9.5-.3v12.4c-3.3-1.4-6.5-1.4-9.5.3-3-1.7-6.2-1.7-9.5-.3V6z"/><path d="M12 6.3v12.4"/></svg>',
};
const ICON_COLOR_CLASS = { children:'icon-children', male:'icon-male', female:'icon-female', business:'icon-business', cinematic:'icon-cinematic', luxury:'icon-luxury', artistic:'icon-artistic', magazine:'icon-magazine' };

/** One tile per category: its "icon" is a 2x2 collage built from that
 * category's own real product photos (falls back to the placeholder art
 * only if it has none yet), plus its name and item count. Tiles stay in
 * sync with the catalog because this runs at the end of every renderGrids(). */
/** Picks the one photo that fronts a category.
 *
 * Preference order:
 *   1. a photo the admin has explicitly flagged as the cover
 *   2. the most-ordered photo in that category — customers voting with their
 *      money is a better judge of "most appealing" than any fixed rule
 *   3. the first photo that actually has an image
 */
/** The category's strongest photos, best first — ranked by how many people
 * actually ordered them, which is a truer measure of appeal than any fixed
 * rule. Placeholders never qualify. */
function categoryTopPhotos(items, limit){
  return items
    .filter(p => p.image && p.image !== PLACEHOLDER_IMG)
    .sort((a,b) => (productPopularity[b.id] || 0) - (productPopularity[a.id] || 0))
    .slice(0, limit || 3);
}

/** How many photos a tile may rotate between. Kept small on purpose: showing
 * the 5th-best photo to some visitors means deliberately showing a weaker
 * image, so the pool stops at the genuine top few. */
const COVER_POOL_SIZE = 3;

/** Chosen once per page load, never on a timer. A tile that changed while it
 * was being looked at would read as a glitch, and a visitor who remembers
 * "the black-and-white one" should still find it where they left it. Picking
 * fresh on each visit keeps the storefront from looking static without ever
 * moving under anyone's eyes. */
const sessionCoverPick = {};

function categoryCover(items){
  const withPhoto = items.filter(p => p.image && p.image !== PLACEHOLDER_IMG);
  if(!withPhoto.length) return null;

  // An explicit admin choice always wins — it is a decision, not a default.
  const chosen = withPhoto.find(p => p.isCover);
  if(chosen) return chosen;

  const cat = withPhoto[0].category;
  const pool = categoryTopPhotos(withPhoto, COVER_POOL_SIZE);
  if(pool.length === 1) return pool[0];

  if(!(cat in sessionCoverPick)){
    sessionCoverPick[cat] = Math.floor(Math.random() * pool.length);
  }
  return pool[Math.min(sessionCoverPick[cat], pool.length - 1)] || pool[0];
}

function renderCatTiles(){
  const wrap = document.getElementById('categoryTilesGrid');
  if(!wrap) return;
  wrap.innerHTML = CAT_IDS.map(cat=>{
    const items = products.filter(p=>p.category===cat).sort((a,b) => (b.order ?? 9999) - (a.order ?? 9999));
    const cover = categoryCover(items);
    const isOpen = document.getElementById(cat)?.classList.contains('open');
    // One photo, swapped only when the small ⟳ control is pressed. The tile's
    // own job is to open the category, so nothing else about it moves.
    const pool = categoryTopPhotos(items, COVER_POOL_SIZE);
    const coverHtml = cover
      ? `<img src="${cover.image}" alt="" loading="lazy" decoding="async">`
        + (pool.length > 1
            ? `<span class="ct-cycle" role="button" tabindex="0" data-cycle="${cat}" title="${t('cycleCoverTitle')}" aria-label="${t('cycleCoverTitle')}">&#8635;</span>`
            : '')
      : `<span class="ct-empty">${t('emptyNoteCategory')}</span>`;
    // A category with zero products right now is hidden from regular
    // visitors (same rule applyChildrenVisibility() applies to the section
    // and nav-dropdown entry) but stays visible to a logged-in admin so they
    // can still open it and add photos — baked in here directly so a freshly
    // rebuilt tile is correct immediately, without depending on that other
    // function having run first.
    const catVisible = cat === 'children'
      ? (!HIDE_CHILDREN_FROM_CUSTOMERS || adminLoggedIn)
      : (items.length > 0 || adminLoggedIn);
    return `
    <button type="button" class="cat-tile${isOpen ? ' open' : ''}" data-cat="${cat}" aria-expanded="${isOpen ? 'true' : 'false'}" style="${catVisible ? '' : 'display:none;'}">
      <div class="cat-tile-cover">
        ${coverHtml}
        ${items.length ? `<span class="ct-count">${items.length}</span>` : ''}
        <div class="cat-tile-label">
          <span class="cat-chip tag-${cat}">
            <span class="cicon" aria-hidden="true">${CAT_ICON[cat]}</span>
            <span class="cc-name">${escapeHtml(catLabel(cat))}</span>
          </span>
        </div>
      </div>
      <span class="sh-chevron" aria-hidden="true">&#9660;</span>
    </button>`;
  }).join('');
}

/** Steps a tile to the next of its top photos. Bound to its own small control
 * rather than the tile itself: the tile is a button whose job is to open the
 * category, and a tap that sometimes opened and sometimes swapped the picture
 * would make it unpredictable. */
function cycleCategoryCover(cat){
  const items = products.filter(p => p.category === cat);
  const pool = categoryTopPhotos(items, COVER_POOL_SIZE);
  if(pool.length < 2) return;
  sessionCoverPick[cat] = ((sessionCoverPick[cat] ?? 0) + 1) % pool.length;

  const tile = document.querySelector(`.cat-tile[data-cat="${cat}"] .cat-tile-cover img`);
  if(!tile) return;
  // Fade through the swap so it reads as a change, not a flicker.
  tile.classList.add('swapping');
  setTimeout(()=>{
    tile.src = pool[sessionCoverPick[cat]].image;
    tile.classList.remove('swapping');
  }, 180);
}

document.getElementById('categoryTilesGrid')?.addEventListener('click', (e)=>{
  const cycle = e.target.closest('[data-cycle]');
  if(cycle){
    // Swallow the click so the tile underneath does not also open.
    e.preventDefault();
    e.stopPropagation();
    cycleCategoryCover(cycle.getAttribute('data-cycle'));
    return;
  }
  const tile = e.target.closest('.cat-tile');
  if(!tile) return;
  const sec = document.getElementById(tile.dataset.cat);
  if(!sec) return;
  const willOpen = !sec.classList.contains('open');
  sec.classList.toggle('open', willOpen);
  tile.classList.toggle('open', willOpen);
  tile.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if(willOpen) sec.scrollIntoView({behavior:'smooth', block:'start'});
});

/** Shared helper for every other place in the app that needs to jump a
 * visitor straight to one category section (after a purchase, from search,
 * from the nav dropdown, …). Since the category sections are now collapsed
 * by default, scrolling to one isn't enough on its own — it must also be
 * opened, and its tile kept in sync, or the visitor lands on an empty header. */
function openCatSection(id){
  const sec = document.getElementById(id);
  if(!sec) return null;
  sec.classList.add('open');
  const tile = document.querySelector(`.cat-tile[data-cat="${id}"]`);
  if(tile){ tile.classList.add('open'); tile.setAttribute('aria-expanded', 'true'); }
  return sec;
}

function catLabel(c){
  const map = { children:'optChildren', male:'optMale', female:'optFemale', business:'optBusiness', cinematic:'optCinematic', luxury:'optLuxury', artistic:'optArtistic', magazine:'optMagazine' };
  return t(map[c] || 'optChildren');
}
function escapeHtml(s){ const d=document.createElement('div'); d.innerText = s ?? ''; return d.innerHTML; }

// ---------- Buy flow (InstaPay — manual review, no automatic payment verification) ----------
async function claimFree(id){
  if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/claim-free`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ productId: id })
    });
    const data = await res.json().catch(()=>null);
    if(!res.ok || !data){ showToast(t('toastOrderFailed')); return; }
    if(!purchases.includes(id)) purchases.push(id);
    if(data.code) orderCodes[id] = data.code;
    await savePurchases();
    renderGrids();
    showToast(t('toastFreeUnlocked'));
  }catch(e){
    showToast(t('toastOrderFailed'));
  }
}

function openProductDetail(id){
  const p = products.find(x=>x.id===id);
  if(!p) return;
  const owned = purchases.includes(p.id);
  document.getElementById('detailImg').src = p.image;
  document.getElementById('detailImg').alt = productTitle(p);
  document.getElementById('detailTitle').textContent = productTitle(p);
  document.getElementById('detailPrice').innerHTML = SOFT_LAUNCH ? t('freeLabel') : (LAUNCH_PROMO
    ? `<span class="price-old">${p.originalPrice || (p.price*2)} ${CURRENCY}</span> <span class="price-new">${p.price} ${CURRENCY}</span>`
    : (p.price + ' ' + CURRENCY));
  const buyBtn = document.getElementById('detailBuyBtn');
  buyBtn.style.display = owned ? 'none' : '';
  buyBtn.onclick = ()=>{
    document.getElementById('detailModalBg').classList.remove('show');
    if(SOFT_LAUNCH){ claimFree(id); } else { openBuyModal(id, 'transform'); }
  };
  document.getElementById('detailModalBg').classList.add('show');
}
document.getElementById('detailModalClose').onclick = ()=> document.getElementById('detailModalBg').classList.remove('show');
document.getElementById('detailCancelBtn').onclick = ()=> document.getElementById('detailModalBg').classList.remove('show');

/** Public, shareable address for one product. Used for ads: the link drops a
 * visitor straight onto this photo instead of the top of the storefront.
 * Built from the live page address so it stays correct if the site ever moves. */
function productShareLink(id){
  const base = window.location.origin + window.location.pathname;
  return `${base}#product=${encodeURIComponent(id)}`;
}

function copyToClipboard(text, toastKey){
  if(!text) return;
  const done = ()=> showToast(t(toastKey));
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=> fallbackCopy(text, done));
  }else{
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done){
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly','');
  ta.style.cssText = 'position:fixed; top:-1000px; opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); done(); }catch(e){}
  document.body.removeChild(ta);
}

function copyProductLink(id){ copyToClipboard(productShareLink(id), 'toastLinkCopied'); }

/** Makes this photo the face of its category. Exactly one cover per category,
 * so choosing a new one clears the previous choice rather than leaving two
 * flagged and letting the order of the list decide. */
async function setCategoryCover(id){
  const chosen = products.find(p => p.id === id);
  if(!chosen) return;
  if(!chosen.image || chosen.image === PLACEHOLDER_IMG){ showToast(t('toastNoImageYet')); return; }

  const previous = products.filter(p => p.category === chosen.category && p.isCover && p.id !== id);
  previous.forEach(p => { delete p.isCover; });
  chosen.isCover = true;

  renderCatTiles();
  renderAdminProductsList();

  const saved = await Promise.all([chosen, ...previous].map(upsertProductRemote));
  showToast(t(saved.every(Boolean) ? 'toastCoverSet' : 'toastCoverSaveFailed'));
}

function copyProductImageUrl(id){
  const p = products.find(x=>x.id===id);
  if(!p || !p.image || p.image === PLACEHOLDER_IMG){ showToast(t('toastNoImageYet')); return; }
  copyToClipboard(p.image, 'toastImageLinkCopied');
}

/** Opens the product named in the address bar, e.g. #product=p_123. Retried
 * once shortly after load because the catalogue arrives over the network and
 * may not be in memory yet on the first pass. */
function openProductFromHash(){
  const m = /[#&]product=([^&]+)/.exec(window.location.hash || '');
  if(!m) return;
  const id = decodeURIComponent(m[1]);
  const open = ()=>{
    if(!products.find(x=>x.id===id)) return false;
    openProductDetail(id);
    return true;
  };
  if(open()) return;
  let tries = 0;
  const timer = setInterval(()=>{
    if(open() || ++tries > 20) clearInterval(timer);
  }, 300);
}
window.addEventListener('hashchange', openProductFromHash);

/** Shows one gentle reminder to a visitor who has looked around for a while
 * without ordering. Deliberately conservative: never for someone who has
 * already bought, never for the admin, never twice in the same visit, and
 * never before they have actually engaged with the page. */
function armStayNudge(){
  const nudge = document.getElementById('stayNudge');
  if(!nudge) return;
  let dismissed = false;
  try{ dismissed = sessionStorage.getItem('migaNudgeSeen') === '1'; }catch(e){}
  if(dismissed || adminLoggedIn || purchases.length) return;

  let scrolledEnough = false;
  const onScroll = ()=>{
    if(window.scrollY > window.innerHeight * 0.9) scrolledEnough = true;
  };
  window.addEventListener('scroll', onScroll, {passive:true});

  const hide = ()=>{
    nudge.classList.remove('show');
    try{ sessionStorage.setItem('migaNudgeSeen','1'); }catch(e){}
  };
  document.getElementById('stayNudgeClose').onclick = hide;
  document.getElementById('nudgeBrowseBtn').onclick = hide;

  setTimeout(()=>{
    // Re-check at the last moment: they may have bought, logged in as admin,
    // or already have a modal open in the meantime.
    if(!scrolledEnough || adminLoggedIn || purchases.length) return;
    if(document.querySelector('.modal-bg.show')) return;
    nudge.classList.add('show');
    try{ sessionStorage.setItem('migaNudgeSeen','1'); }catch(e){}
    setTimeout(()=> nudge.classList.remove('show'), 20000);
  }, 45000);
}

/** Central funnel-tracking helper. Sends the same event to both GA4 (gtag)
 * and Meta Pixel (fbq) when they're available, and silently does nothing
 * otherwise — analytics must never be able to break the actual purchase flow,
 * so every call is wrapped and failures are swallowed. `gaName`/`gaParams`
 * go to GA4 as a custom event; `fbName`/`fbParams` go to Pixel as a
 * standard event (PageView, InitiateCheckout, Purchase, etc. — see
 * https://developers.facebook.com/docs/meta-pixel/reference for the list). */
function trackFunnelEvent(gaName, gaParams, fbName, fbParams){
  try{ if(typeof gtag === 'function') gtag('event', gaName, gaParams || {}); }catch(e){}
  try{ if(typeof fbq === 'function') fbq('track', fbName, fbParams || {}); }catch(e){}
}

function openBuyModal(id, type){
  currentBuyId = id;
  currentBuyType = type === 'prompt' ? 'prompt' : type === 'package' ? 'package' : 'transform';
  if(currentBuyType !== 'package') currentPackageSize = null;
  const p = getBuyItem();
  const displayPrice = currentBuyType === 'prompt' ? PROMPT_PRICE : p.price;
  trackFunnelEvent(
    'begin_checkout', { currency:'EGP', value: displayPrice, items:[{ item_id:id, item_name: p?.title || '', price: displayPrice }] },
    'InitiateCheckout', { currency:'EGP', value: displayPrice, content_ids:[id], content_name: p?.title || '' }
  );
  document.getElementById('ipNumber').innerText = INSTAPAY_NUMBER;
  document.getElementById('buyModalText').innerText = currentBuyType === 'prompt'
    ? t('buyPromptModalTextTemplate').replace('{title}', productTitle(p)).replace('{price}', displayPrice)
    : currentBuyType === 'package'
      ? t('buyPackageModalTextTemplate').replace('{title}', productTitle(p)).replace('{price}', displayPrice)
      : t('buyModalTextTemplate').replace('{title}', productTitle(p)).replace('{price}', displayPrice);
  document.getElementById('buyerPhone').value='';
  document.getElementById('payerRef').value='';
  document.getElementById('payConfirmChk').checked = false;
  syncBuyConfirmBtn();
  document.getElementById('payerName').value='';
  document.getElementById('payerPhone').value='';
  document.getElementById('payerEmail').value='';
  document.getElementById('fawryRefResult').style.display='none';
  document.querySelector('#paymentMethodTabs button[data-method="card"]').style.display =
    PAYMENT_METHODS_ENABLED.card ? '' : 'none';
  document.querySelector('#paymentMethodTabs button[data-method="fawry"]').style.display =
    PAYMENT_METHODS_ENABLED.fawry ? '' : 'none';
  setPaymentMethod('instapay');
  stopOrderStatusPolling();
  document.getElementById('payFormFields').style.display = '';
  document.getElementById('payStatusPanel').style.display = 'none';
  document.getElementById('buyModalBg').classList.add('show');
}

/** Package purchases now go through the exact same in-site checkout as a
 * single photo — InstaPay/Vodafone/card/Fawry, no WhatsApp detour. This is
 * the single entry point the pricing cards call. */
function openPackageBuyModal(size){
  if(!PACKAGE_CATALOG[size]) return;
  currentPackageSize = size;
  openBuyModal('package-' + size, 'package');
}

/** The order button stays inert until the customer has actively ticked the
 * confirmation. A deliberate second action is what stops "I've paid" being
 * tapped on reflex before the transfer has actually been made. */
function syncBuyConfirmBtn(){
  const chk = document.getElementById('payConfirmChk');
  const btn = document.getElementById('buyConfirmBtn');
  if(!chk || !btn) return;
  btn.disabled = !chk.checked;
}
document.getElementById('payConfirmChk').addEventListener('change', syncBuyConfirmBtn);

function setPaymentMethod(method){
  document.querySelectorAll('#paymentMethodTabs button').forEach(b=>{
    b.classList.toggle('active', b.dataset.method === method);
  });
  const isManualTransfer = method === 'instapay' || method === 'vodafone';
  document.getElementById('payViewInstapay').style.display = isManualTransfer ? 'block' : 'none';
  document.getElementById('payViewCardFawry').style.display = !isManualTransfer ? 'block' : 'none';

  if(method === 'instapay'){
    document.getElementById('ipNumber').textContent = INSTAPAY_NUMBER;
    document.getElementById('ipLabelEl').textContent = t('ipLabel');
  }else if(method === 'vodafone'){
    document.getElementById('ipNumber').textContent = VODAFONE_CASH_NUMBER;
    document.getElementById('ipLabelEl').textContent = t('vodafoneLabel');
  }

  if(!isManualTransfer){
    document.getElementById('payCardFawryBtn').dataset.method = method;
    document.getElementById('payCardFawryBtn').textContent =
      method === 'card' ? t('payNowBtn') : t('getFawryCodeBtn');
  }
}
document.getElementById('paymentMethodTabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  setPaymentMethod(btn.dataset.method);
});

document.getElementById('buyModalClose').onclick = ()=> document.getElementById('buyModalBg').classList.remove('show');
document.getElementById('buyCancelBtn').onclick = ()=> document.getElementById('buyModalBg').classList.remove('show');
document.getElementById('payCardFawryCancelBtn').onclick = ()=> document.getElementById('buyModalBg').classList.remove('show');

document.getElementById('payCardFawryBtn').onclick = async ()=>{
  const method = document.getElementById('payCardFawryBtn').dataset.method;
  const name = document.getElementById('payerName').value.trim();
  const phone = document.getElementById('payerPhone').value.trim();
  const email = document.getElementById('payerEmail').value.trim();
  if(!name || !phone){ showToast(t('toastFillFields')); return; }
  const p = getBuyItem();
  const amount = currentBuyType === 'prompt' ? PROMPT_PRICE : p.price;
  if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }

  try{
    // Create the underlying order first (same order system as InstaPay), then hand off to the gateway.
    const orderRes = await fetch(`${BACKEND_BASE}/orders/create`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ productId: currentBuyId, productTitle: p.title, price: amount, phone, appUsed: method==='card' ? 'Paymob' : 'Fawry', ref:'', buyerName: currentUser?.name || '', buyerEmail: currentUser?.email || '', orderType: currentBuyType, packageSize: currentBuyType==='package' ? currentPackageSize : undefined })
    });
    const orderData = await orderRes.json();
    if(!orderRes.ok || !orderData.code){ showToast(t('toastOrderFailed')); return; }

    if(method === 'card'){
      const res = await fetch(`${BACKEND_BASE}/payment/paymob/create`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ orderCode: orderData.code, amount, name, phone, email })
      });
      const data = await res.json();
      if(!res.ok || !data.checkoutUrl){ showToast(t('toastOrderFailed')); return; }
      window.location.href = data.checkoutUrl;
    }else{
      const res = await fetch(`${BACKEND_BASE}/payment/fawry/create`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ orderCode: orderData.code, amount, name, phone, email })
      });
      const data = await res.json();
      if(!res.ok || !data.referenceNumber){ showToast(t('toastOrderFailed')); return; }
      document.getElementById('fawryRefNumber').textContent = data.referenceNumber;
      document.getElementById('fawryRefResult').style.display = 'block';
      saveOrderReference(currentBuyId, currentBuyType, orderData.code);
      showToast(t('toastOrderSentTemplate').replace('{code}', orderData.code));
    }
  }catch(e){
    showToast(t('toastOrderFailed'));
  }
};
document.getElementById('ipCopyBtn').onclick = ()=>{
  const shownNumber = document.getElementById('ipNumber').textContent;
  navigator.clipboard?.writeText(shownNumber).then(()=> showToast(t('toastCopiedNumber'))).catch(()=>{});
};

document.getElementById('buyConfirmBtn').onclick = async ()=>{
  if(!currentBuyId) return;
  const phone = document.getElementById('buyerPhone').value.trim();
  const activeTab = document.querySelector('#paymentMethodTabs button.active');
  const manualMethod = activeTab && activeTab.dataset.method === 'vodafone' ? 'Vodafone Cash' : 'InstaPay';
  if(!phone){
    showToast(t('toastEnterPhone'));
    return;
  }
  // Same Egyptian-mobile-number check the server enforces — this is just
  // immediate feedback so a placeholder like "......" or "2222222" is caught
  // before a network round trip; the server-side check is what actually
  // prevents the order (this one alone could always be bypassed).
  if(!/^01[0125][0-9]{8}$/.test(phone)){
    showToast(t('toastInvalidPhone'));
    return;
  }
  if(!document.getElementById('payConfirmChk').checked){
    showToast(t('toastConfirmPaymentFirst'));
    return;
  }
  // The transfer reference is the one thing a visitor who has not actually
  // paid cannot produce, so it is required rather than optional.
  const ref = document.getElementById('payerRef').value.trim();
  if(ref.length < 4 || !/[0-9]/.test(ref)){
    showToast(t('toastEnterRef'));
    return;
  }
  const p = getBuyItem();
  const amount = currentBuyType === 'prompt' ? PROMPT_PRICE : p.price;
  if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/create`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ productId: currentBuyId, productTitle: p.title, price: amount, phone, appUsed: manualMethod, ref, buyerName: currentUser?.name || '', buyerEmail: currentUser?.email || '', orderType: currentBuyType, packageSize: currentBuyType==='package' ? currentPackageSize : undefined })
    });
    const data = await res.json();
    if(!res.ok || !data.code){
      showToast(res.status === 400 ? t('toastInvalidPhone') : t('toastOrderFailed'));
      return;
    }
    trackFunnelEvent(
      'add_payment_info', { currency:'EGP', value: amount, payment_type: manualMethod },
      'AddPaymentInfo', { currency:'EGP', value: amount, content_ids:[currentBuyId] }
    );
    saveOrderReference(currentBuyId, currentBuyType, data.code);
    showOrderStatusPanel(currentBuyId, data.code, currentBuyType);
  }catch(e){
    showToast(t('toastOrderFailed'));
  }
};

/** Records a newly-created order's code against the right local bucket —
 * separate from the photo-transform bucket, since a customer can hold both
 * a 'transform' order and a 'prompt' order for the same product at once. */
function saveOrderReference(productId, type, code){
  if(type === 'prompt'){
    promptOrderCodes[productId] = code;
    if(!promptPurchases.includes(productId)) promptPurchases.push(productId);
  }else{
    orderCodes[productId] = code;
  }
  savePurchases();
}

/** The package with credits left that was most recently approved — offered
 * on every eligible product card's "use a package credit" button. A
 * customer juggling two active packages at once is rare enough that always
 * offering the most recent one is a reasonable default. */
function activePackageWithCredits(){
  const codes = Object.keys(packageCredits);
  for(let i = codes.length - 1; i >= 0; i--){
    const code = codes[i];
    if(packageCredits[code].remaining > 0) return { code, ...packageCredits[code] };
  }
  return null;
}

/** Redeems one credit from the active package for a specific product,
 * skipping payment entirely, and opens the exact same upload-and-generate
 * flow a normal purchase uses — the Worker's /transform route already
 * accepts any productId against a package order's code (see transformImage),
 * so nothing else about that flow needs to change. */
function usePackageCredit(productId){
  const pkg = activePackageWithCredits();
  if(!pkg) return;
  if(pkg.usedProductIds.includes(productId)){
    showToast(t('toastPackageProductAlreadyUsed'));
    return;
  }
  orderCodes[productId] = pkg.code;
  if(!purchases.includes(productId)) purchases.push(productId);
  savePurchases();
  renderGrids();
  openTransformModal(productId);
}

// ---------- Live order status (replaces the old "close modal + remember a
// code" flow) — the modal stays open and polls the backend on its own, so the
// customer never has to go find the tracking modal and re-type the code
// themselves; that manual entry is kept only as a fallback for a later visit.
let orderStatusPollTimer = null;

function stopOrderStatusPolling(){
  if(orderStatusPollTimer){ clearInterval(orderStatusPollTimer); orderStatusPollTimer = null; }
}

function showOrderStatusPanel(productId, code, orderType){
  orderType = orderType === 'prompt' ? 'prompt' : orderType === 'package' ? 'package' : 'transform';
  document.getElementById('payFormFields').style.display = 'none';
  document.getElementById('payStatusPanel').style.display = 'block';
  document.getElementById('payStatusCode').textContent = code;
  document.getElementById('payStatusText').textContent = t('statusPendingText');
  document.querySelector('#payStatusPanel .order-status-spinner').style.display = '';

  stopOrderStatusPolling();
  const check = async ()=>{
    if(!BACKEND_BASE) return;
    try{
      const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
      if(!res.ok) return;
      const order = await res.json();
      if(order.status === 'approved'){
        stopOrderStatusPolling();
        if(orderType === 'prompt'){
          if(!promptPurchases.includes(productId)) promptPurchases.push(productId);
          promptOrderCodes[productId] = order.code || code;
          if(order.promptText) purchasedPromptTexts[productId] = order.promptText;
        }else if(orderType === 'package'){
          packageCredits[order.code || code] = {
            size: order.packageSize,
            remaining: order.creditsRemaining,
            usedProductIds: (order.usedItems || []).map(u => u.productId),
          };
        }else{
          if(!purchases.includes(productId)) purchases.push(productId);
          orderCodes[productId] = order.code || code;
        }
        await savePurchases();
        renderGrids();
        document.querySelector('#payStatusPanel .order-status-spinner').style.display = 'none';
        document.getElementById('payStatusText').textContent =
          orderType === 'prompt' ? t('statusPromptApprovedText')
          : orderType === 'package' ? t('statusPackageApprovedText').replace('{n}', order.creditsRemaining)
          : t('statusApprovedText');
        showToast(
          orderType === 'prompt' ? t('toastPromptReady')
          : orderType === 'package' ? t('toastPackageReady')
          : t('toastReadyToTransform')
        );
      }
    }catch(e){ /* network hiccup — the next poll retries automatically */ }
  };
  check();
  orderStatusPollTimer = setInterval(check, 6000);
}

document.getElementById('payStatusCloseBtn').onclick = ()=>{
  stopOrderStatusPolling();
  document.getElementById('buyModalBg').classList.remove('show');
  const p = getBuyItem();
  if(p && p.category) openCatSection(p.category)?.scrollIntoView({behavior:'smooth'});
};

// ---------- Photo transform (client-side style preview) ----------
// NOTE FOR THE BUSINESS OWNER: this applies a category-based color/style preset
// entirely in the browser — it does not call any external AI image-generation
// service, so it can't reproduce the exact look of each individual prompt.
// To do real generative image transformation per-prompt, replace the body of
// generateTransform() below with a fetch() to an image-generation API of your
// choice (e.g. a provider offering image-to-image or "edit image" endpoints),
// sending the uploaded photo + the product's prompt text, and draw the
// returned image onto transformOutCanvas instead of applying a canvas filter.
const TRANSFORM_PRESETS = {
  children: {filter:'contrast(1.15) saturate(1.55) brightness(1.22) sepia(0.28) hue-rotate(-6deg)', vignette:'rgba(255,201,77,0.32)', grain:0.05},
  male:     {filter:'contrast(1.65) saturate(0.3) brightness(0.82) grayscale(0.6)', vignette:'rgba(5,3,15,0.55)', grain:0.10},
  female:   {filter:'contrast(1.2) saturate(1.55) brightness(1.2) sepia(0.18) hue-rotate(-8deg)', vignette:'rgba(255,92,150,0.3)', grain:0.05}
};

function applyFilmGrain(ctx, w, h, intensity){
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for(let i=0; i<d.length; i+=4){
    const noise = (Math.random() - 0.5) * 255 * intensity;
    d[i]   = Math.min(255, Math.max(0, d[i]   + noise));
    d[i+1] = Math.min(255, Math.max(0, d[i+1] + noise));
    d[i+2] = Math.min(255, Math.max(0, d[i+2] + noise));
  }
  ctx.putImageData(imgData, 0, 0);
}

// ---------- Image crop tool (forces every admin-uploaded product photo to
// the same output size, no matter how the source photo was framed) ----------
const CROP_OUTPUT_W = 1000, CROP_OUTPUT_H = 1250; // matches the product card's 4:5 aspect ratio
const cropModalBg = document.getElementById('cropModalBg');
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
const cropZoomSlider = document.getElementById('cropZoomSlider');
let cropState = null; // { img, scale, offsetX, offsetY, resolve }

function drawCrop(){
  if(!cropState) return;
  const { img, scale, offsetX, offsetY } = cropState;
  const w = cropCanvas.width, h = cropCanvas.height;
  cropCtx.clearRect(0,0,w,h);
  cropCtx.save();
  cropCtx.translate(w/2 + offsetX, h/2 + offsetY);
  cropCtx.scale(scale, scale);
  cropCtx.drawImage(img, -img.width/2, -img.height/2);
  cropCtx.restore();
}

function clampCropOffset(){
  const { img, scale } = cropState;
  const w = cropCanvas.width, h = cropCanvas.height;
  const drawnW = img.width * scale, drawnH = img.height * scale;
  const maxX = Math.max(0, (drawnW - w) / 2);
  const maxY = Math.max(0, (drawnH - h) / 2);
  cropState.offsetX = Math.min(maxX, Math.max(-maxX, cropState.offsetX));
  cropState.offsetY = Math.min(maxY, Math.max(-maxY, cropState.offsetY));
}

/** Opens the crop modal for `file`; resolves with a JPEG Blob at a fixed
 * CROP_OUTPUT_W×CROP_OUTPUT_H once confirmed, or null if cancelled. A
 * source photo's own framing (close-up vs full body vs a wide scene) can't
 * be guessed reliably by any algorithm, so the admin repositions/zooms once
 * — but the OUTPUT size is then always identical no matter what they upload. */
function openCropModal(file){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const w = cropCanvas.width, h = cropCanvas.height;
        const baseScale = Math.max(w / img.width, h / img.height);
        cropState = { img, scale: baseScale, offsetX: 0, offsetY: 0, resolve };
        cropZoomSlider.value = '1';
        drawCrop();
        cropModalBg.classList.add('show');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

cropZoomSlider.addEventListener('input', ()=>{
  if(!cropState) return;
  const w = cropCanvas.width, h = cropCanvas.height;
  const baseScale = Math.max(w / cropState.img.width, h / cropState.img.height);
  cropState.scale = baseScale * Number(cropZoomSlider.value);
  clampCropOffset();
  drawCrop();
});

let cropDragging = false, cropDragStart = null;
function cropPointerDown(x, y){
  cropDragging = true;
  cropDragStart = { x, y, offsetX: cropState.offsetX, offsetY: cropState.offsetY };
}
function cropPointerMove(x, y){
  if(!cropDragging || !cropState) return;
  cropState.offsetX = cropDragStart.offsetX + (x - cropDragStart.x);
  cropState.offsetY = cropDragStart.offsetY + (y - cropDragStart.y);
  clampCropOffset();
  drawCrop();
}
function cropPointerUp(){ cropDragging = false; }

cropCanvas.addEventListener('mousedown', (e)=>{
  const rect = cropCanvas.getBoundingClientRect();
  cropPointerDown(e.clientX - rect.left, e.clientY - rect.top);
});
window.addEventListener('mousemove', (e)=>{
  const rect = cropCanvas.getBoundingClientRect();
  cropPointerMove(e.clientX - rect.left, e.clientY - rect.top);
});
window.addEventListener('mouseup', cropPointerUp);
cropCanvas.addEventListener('touchstart', (e)=>{
  const rect = cropCanvas.getBoundingClientRect();
  const t = e.touches[0];
  cropPointerDown(t.clientX - rect.left, t.clientY - rect.top);
}, { passive:true });
cropCanvas.addEventListener('touchmove', (e)=>{
  const rect = cropCanvas.getBoundingClientRect();
  const t = e.touches[0];
  cropPointerMove(t.clientX - rect.left, t.clientY - rect.top);
}, { passive:true });
cropCanvas.addEventListener('touchend', cropPointerUp);

function closeCropModal(result){
  cropModalBg.classList.remove('show');
  if(cropState){
    const resolve = cropState.resolve;
    cropState = null;
    resolve(result);
  }
}

document.getElementById('cropConfirmBtn').onclick = ()=>{
  if(!cropState) return;
  const out = document.createElement('canvas');
  out.width = CROP_OUTPUT_W; out.height = CROP_OUTPUT_H;
  const octx = out.getContext('2d');
  const scaleUp = CROP_OUTPUT_W / cropCanvas.width; // display canvas size -> real output size
  octx.save();
  octx.translate(out.width/2 + cropState.offsetX * scaleUp, out.height/2 + cropState.offsetY * scaleUp);
  octx.scale(cropState.scale * scaleUp, cropState.scale * scaleUp);
  octx.drawImage(cropState.img, -cropState.img.width/2, -cropState.img.height/2);
  octx.restore();
  out.toBlob((blob)=> closeCropModal(blob), 'image/jpeg', 0.92);
};
document.getElementById('cropCancelBtn').onclick = ()=> closeCropModal(null);
document.getElementById('cropModalClose').onclick = ()=> closeCropModal(null);

let currentTransformId = null;
let transformImg = null;
const transformModalBg = document.getElementById('transformModalBg');

/** Copies an already-approved prompt purchase straight to the clipboard —
 * the fastest path once the customer already has it, no modal needed. */
function copyPurchasedPrompt(id){
  const text = purchasedPromptTexts[id];
  if(!text){ showToast(t('toastPromptNotReady')); return; }
  navigator.clipboard?.writeText(text).then(()=> showToast(t('toastPromptCopied'))).catch(()=>{
    showToast(t('toastPromptCopied')); // clipboard permission denied — the track modal below still shows it
  });
}

/** A prompt order that's still pending: send the customer to "تتبع طلبي"
 * (My Orders) where its live status already refreshes automatically. */
function openTrackForPrompt(id){
  document.getElementById('trackModalBg').classList.add('show');
  renderMyOrdersHistory();
}

function openTransformModal(id){
  currentTransformId = id;
  const p = products.find(x=>x.id===id);
  if(!p) return;
  document.getElementById('transformModalText').innerText = productTitle(p);
  document.getElementById('transformFileInput').value = '';
  document.getElementById('transformConsent').checked = false;
  document.getElementById('transformDownloadBtn').style.display = 'none';
  document.getElementById('transformShareBtn').style.display = 'none';
  document.getElementById('thanksPanel').classList.remove('show');
  document.getElementById('transformGenerateBtn').dataset.used = '';
  transformImg = null;

  const cachedUrl = transformedResults[id];
  if(cachedUrl){
    // Already generated with this order — show the saved result straight away
    // instead of the upload form, so refreshing the page (or coming back later)
    // never looks like "another free attempt" is on offer.
    document.getElementById('transformUploadField').style.display = 'none';
    document.getElementById('transformAlreadyDoneNote').style.display = 'block';
    document.getElementById('transformFreshFlowControls').style.display = 'none';
    document.getElementById('transformBeforeCol').style.display = 'none';
    document.getElementById('transformPreviewGrid').style.gridTemplateColumns = '1fr';
    document.getElementById('transformPreviewWrap').style.display = 'block';
    const outCanvas = document.getElementById('transformOutCanvas');
    const ctx = outCanvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=>{
      outCanvas.width = img.naturalWidth; outCanvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      document.getElementById('transformDownloadBtn').style.display = 'inline-block';
      document.getElementById('transformShareBtn').style.display = 'inline-block';
      document.getElementById('thanksPanel').classList.add('show');
    };
    img.src = cachedUrl;
  }else{
    document.getElementById('transformUploadField').style.display = '';
    document.getElementById('transformAlreadyDoneNote').style.display = 'none';
    document.getElementById('transformFreshFlowControls').style.display = '';
    document.getElementById('transformBeforeCol').style.display = '';
    document.getElementById('transformPreviewGrid').style.gridTemplateColumns = '1fr 1fr';
    document.getElementById('transformPreviewWrap').style.display = 'none';
  }
  transformModalBg.classList.add('show');
}
document.getElementById('transformModalClose').onclick = ()=> transformModalBg.classList.remove('show');
document.getElementById('transformCancelBtn').onclick = ()=> transformModalBg.classList.remove('show');

document.getElementById('transformFileInput').addEventListener('change', (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  if(!file.type.startsWith('image/')){
    showToast(t('toastInvalidImage'));
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev)=>{
    const img = new Image();
    img.onload = ()=>{
      transformImg = img;
      const srcCanvas = document.getElementById('transformSrcCanvas');
      const outCanvas = document.getElementById('transformOutCanvas');
      const maxW = 360;
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      [srcCanvas, outCanvas].forEach(c=>{ c.width = w; c.height = h; });
      srcCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
      outCanvas.getContext('2d').clearRect(0,0,w,h);
      document.getElementById('transformPreviewWrap').style.display = 'block';
      document.getElementById('transformDownloadBtn').style.display = 'none';
      document.getElementById('transformShareBtn').style.display = 'none';
      document.getElementById('thanksPanel').classList.remove('show');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('transformGenerateBtn').onclick = async ()=>{
  if(!transformImg){ showToast(t('toastSelectPhoto')); return; }
  if(!document.getElementById('transformConsent').checked){ showToast(t('toastConsentRequired')); return; }
  const p = products.find(x=>x.id===currentTransformId);
  const orderCode = orderCodes[currentTransformId];
  if(!orderCode){ showToast(t('toastGenerateFailed')); return; }
  const genBtn = document.getElementById('transformGenerateBtn');
  const outCanvas = document.getElementById('transformOutCanvas');
  const ctx = outCanvas.getContext('2d');
  const w = outCanvas.width, h = outCanvas.height;

  if(TRANSFORM_API_ENDPOINT){
    // Client-side guard only — the real limit is enforced server-side (an order
    // can only ever produce one successful generation). This just avoids an
    // extra round trip and gives the customer immediate feedback.
    if(genBtn.dataset.used === '1'){
      showToast(t('toastAlreadyGenerated') || 'This order has already been used to generate an image.');
      return;
    }
    genBtn.disabled = true;
    showToast(t('toastGenerating'));
    try{
      const dataUri = document.getElementById('transformSrcCanvas').toDataURL('image/jpeg', 0.9);
      // The server looks up the real transformation instructions itself using productId +
      // orderCode as proof of purchase — this browser never holds or sends that text.
      const res = await fetch(`${BACKEND_BASE}/transform`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ image: dataUri, productId: currentTransformId, orderCode })
      });
      const data = await res.json().catch(()=>null);
      if(!res.ok || !data || !data.imageUrl){
        // 409 means the order was already consumed (possibly from another tab/device) —
        // keep the button locked instead of letting the customer keep retrying.
        if(res.status !== 409) genBtn.disabled = false;
        showToast(t('toastGenerateFailed'));
        return;
      }
      genBtn.dataset.used = '1';
      // If this generation was paid for out of a package's shared credits
      // (not an individually-purchased order), the server's response is the
      // authoritative source for how many are left — sync local bookkeeping
      // to it rather than just assuming "minus one" succeeded.
      if(packageCredits[orderCode]){
        if(typeof data.creditsRemaining === 'number') packageCredits[orderCode].remaining = data.creditsRemaining;
        if(!packageCredits[orderCode].usedProductIds.includes(currentTransformId)){
          packageCredits[orderCode].usedProductIds.push(currentTransformId);
        }
        savePurchases();
      }
      const resultImg = new Image();
      resultImg.crossOrigin = 'anonymous';
      resultImg.onload = ()=>{
        ctx.clearRect(0,0,w,h);
        ctx.drawImage(resultImg, 0, 0, w, h);
        document.getElementById('transformDownloadBtn').style.display = 'inline-block';
        document.getElementById('transformShareBtn').style.display = 'inline-block';
        document.getElementById('thanksPanel').classList.add('show');
        showToast(t('toastTransformDone'));
      };
      resultImg.onerror = ()=> showToast(t('toastGenerateFailed'));
      resultImg.src = data.imageUrl;
      transformedResults[currentTransformId] = data.imageUrl;
      // This is the true "purchase completed" moment — the customer paid AND
      // actually received their transformed photo, not just placed an order
      // that might still be pending/rejected. Tracking it here (not at order
      // creation) is what makes the funnel numbers mean something.
      trackFunnelEvent(
        'purchase', { currency:'EGP', value: (products.find(x=>x.id===currentTransformId)||{}).price || 0, transaction_id: orderCode },
        'Purchase', { currency:'EGP', value: (products.find(x=>x.id===currentTransformId)||{}).price || 0, content_ids:[currentTransformId] }
      );
      savePurchases();
      renderGrids();
    }catch(e){
      genBtn.disabled = false;
      showToast(t('toastGenerateFailed'));
    }
    return;
  }

  // Fallback: client-side style preview only (no API endpoint configured above)
  const preset = TRANSFORM_PRESETS[p.category] || TRANSFORM_PRESETS.female;
  ctx.clearRect(0,0,w,h);
  ctx.filter = preset.filter;
  ctx.drawImage(transformImg, 0, 0, w, h);
  ctx.filter = 'none';
  const vg = ctx.createRadialGradient(w/2,h/2,h*0.22, w/2,h/2,h*0.72);
  vg.addColorStop(0,'rgba(0,0,0,0)');
  vg.addColorStop(1,preset.vignette);
  ctx.fillStyle = vg;
  ctx.fillRect(0,0,w,h);
  applyFilmGrain(ctx, w, h, preset.grain);
  document.getElementById('transformDownloadBtn').style.display = 'inline-block';
  document.getElementById('transformShareBtn').style.display = 'inline-block';
  document.getElementById('thanksPanel').classList.add('show');
  showToast(t('toastTransformDone'));
};

/** Lets a happy customer pass the result on. Uses the phone's native share
 * sheet with the actual image where the browser allows it, and falls back to
 * sharing (or copying) the storefront link everywhere else. */
document.getElementById('transformShareBtn').onclick = async ()=>{
  const outCanvas = document.getElementById('transformOutCanvas');
  const shareText = t('shareResultText');
  const shareUrl = window.location.origin + window.location.pathname;
  try{
    const blob = outCanvas ? await new Promise(r=> outCanvas.toBlob(r, 'image/jpeg', 0.92)) : null;
    if(blob && navigator.canShare){
      const file = new File([blob], 'miga-photobook.jpg', {type:'image/jpeg'});
      if(navigator.canShare({files:[file]})){
        await navigator.share({files:[file], text: `${shareText} ${shareUrl}`});
        return;
      }
    }
    if(navigator.share){
      await navigator.share({title:'Miga-Photobook', text: shareText, url: shareUrl});
      return;
    }
  }catch(e){
    if(e && e.name === 'AbortError') return;   // customer closed the share sheet
  }
  copyToClipboard(`${shareText} ${shareUrl}`, 'toastShareCopied');
};

document.getElementById('transformDownloadBtn').onclick = ()=>{
  const outCanvas = document.getElementById('transformOutCanvas');
  try{
    const link = document.createElement('a');
    link.download = 'mega-prompt-result.png';
    link.href = outCanvas.toDataURL('image/png');
    link.click();
  }catch(e){
    showToast(t('toastDownloadFailed'));
  }
};

// ---------- Order tracking ----------
const trackModalBg = document.getElementById('trackModalBg');
document.getElementById('trackOpenBtn').onclick = ()=>{
  trackModalBg.classList.add('show');
  renderMyOrdersHistory();
};

/** Every code the visitor has ever generated on this browser is already kept
 * in orderCodes (localStorage) — this just re-checks each one's live status
 * so "تتبع طلبي" shows a full history instead of a one-code-at-a-time lookup. */
async function renderMyOrdersHistory(){
  const wrap = document.getElementById('myOrdersHistory');
  const listEl = document.getElementById('myOrdersHistoryList');
  const transformEntries = Object.entries(orderCodes || {}).map(([productId, code]) => ({productId, code, type:'transform'}));
  const promptEntries = Object.entries(promptOrderCodes || {}).map(([productId, code]) => ({productId, code, type:'prompt'}));
  const entries = [...transformEntries, ...promptEntries];
  if(!entries.length || !BACKEND_BASE){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  listEl.innerHTML = `<div class="empty-note">${t('loadingLabel') || '...'}</div>`;
  const rows = await Promise.all(entries.map(async ({productId, code, type})=>{
    const p = products.find(x=>x.id===productId);
    try{
      const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
      if(!res.ok) return null;
      const order = await res.json();
      if(type === 'prompt' && order.status === 'approved' && order.promptText){
        purchasedPromptTexts[productId] = order.promptText; // keep local cache in sync
      }
      return { p, code, type, status: order.status, createdAt: order.createdAt, promptText: order.promptText };
    }catch(e){ return null; }
  }));
  savePurchases();
  const valid = rows.filter(Boolean).sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
  if(!valid.length){
    listEl.innerHTML = `<div class="empty-note">${t('ordersEmptyNote')}</div>`;
    return;
  }
  listEl.innerHTML = valid.map(r => `
    <div class="my-order-row" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div class="mo-info">
          <b>${r.p ? escapeHtml(productTitle(r.p)) : r.code} <span style="color:var(--brass); font-weight:600; font-size:11px;">— ${r.type==='prompt' ? t('orderTypePrompt') : t('orderTypeTransform')}</span></b>
          <span class="mo-date">${r.createdAt ? new Date(r.createdAt).toLocaleString(currentLang==='ar' ? 'ar-EG' : 'en-GB', {dateStyle:'medium', timeStyle:'short'}) : ''} — ${r.code}</span>
        </div>
        <span class="order-status ${orderStatusClass(r.status)}">${orderStatusLabel(r.status)}</span>
      </div>
      ${r.type==='prompt' && r.status==='approved' && r.promptText ? `
        <div class="purchased-prompt-box">
          <p>${escapeHtml(r.promptText)}</p>
          <button class="btn-ghost" onclick="copyPurchasedPrompt('${r.p ? r.p.id : ''}')">${t('copyPromptBtn')}</button>
        </div>` : ''}
    </div>`).join('');
}
document.getElementById('trackModalClose').onclick = ()=> trackModalBg.classList.remove('show');
document.getElementById('trackCancelBtn').onclick = ()=> trackModalBg.classList.remove('show');
document.getElementById('trackCheckBtn').onclick = async ()=>{
  const code = document.getElementById('trackCode').value.trim().toUpperCase();
  if(!code){ showToast(t('toastEnterCode')); return; }
  if(!BACKEND_BASE){ showToast(t('toastOrderNotFound')); return; }
  let order;
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/track?code=${encodeURIComponent(code)}`);
    if(!res.ok){ showToast(t('toastOrderNotFound')); return; }
    order = await res.json();
  }catch(e){
    showToast(t('toastOrderNotFound'));
    return;
  }
  if(order.status === 'approved'){
    if(!purchases.includes(order.productId)){
      purchases.push(order.productId);
    }
    orderCodes[order.productId] = order.code || code;
    await savePurchases();
    renderGrids();
    trackModalBg.classList.remove('show');
    showToast(t('toastReadyToTransform'));
    openCatSection(order.productId ? getCategoryOf(order.productId) : 'children')?.scrollIntoView({behavior:'smooth'});
  }else{
    showToast(t('toastOrderPending'));
  }
};
function getCategoryOf(productId){
  const p = products.find(x=>x.id===productId);
  return p ? p.category : 'children';
}


// ---------- Promo video: don't fetch any of the ~14MB file until the visitor
// actually scrolls near it, instead of downloading it on every page load. ----------
(function(){
  const vid = document.getElementById('promoVideoEl');
  if(!vid) return;
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        vid.src = vid.dataset.src;
        vid.play().catch(()=>{}); // ignore autoplay-blocked errors; the poster + controls still work
        io.disconnect();
      }
    });
  }, {rootMargin: '200px'});
  io.observe(vid);
})();

// ---------- Quick-nav row ----------
// "لماذا Miga-Photobook؟" / "كيف يعمل؟" / "من نحن" / "أسئلة شائعة" now share
// one fixed content area right below the tab row (#sectionTabPanel):
// clicking a tab is an instant show/hide swap — no scrolling, no animated
// accordion expand — so the content always appears in the exact same spot
// as the buttons. "تقييمات وآراء عملائنا" isn't part of this panel (it's
// always visible further down the page, per explicit request), so its tab
// is still a plain scroll-to-it shortcut.
const TAB_PANEL_IDS = ['whyUs', 'howItWorks', 'aboutUs', 'faq'];
function setActiveSectionTab(targetId, {scroll} = {scroll: true}){
  const row = document.getElementById('sectionTabsRow');
  document.querySelectorAll('.section-tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.target === targetId);
  });
  TAB_PANEL_IDS.forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', id === targetId);
  });
  row.classList.toggle('has-active', !!targetId);
  if(targetId && scroll){
    document.getElementById(targetId)?.scrollIntoView({behavior:'smooth', block:'start'});
  }
}
document.getElementById('sectionTabsRow').addEventListener('click', (e)=>{
  const btn = e.target.closest('.section-tab-btn');
  if(!btn) return;
  if(!TAB_PANEL_IDS.includes(btn.dataset.target)){
    // "تقييمات" — always visible elsewhere on the page, just scroll to it.
    document.getElementById(btn.dataset.target)?.scrollIntoView({behavior:'smooth', block:'start'});
    return;
  }
  const alreadyActive = btn.classList.contains('active');
  // Swapping tabs never needs to scroll — the panel is already right here.
  setActiveSectionTab(alreadyActive ? null : btn.dataset.target, {scroll: false});
});
// The panel starts on "لماذا Miga-Photobook؟" so visitors see something
// the instant they reach this row, instead of an empty gap before their
// first click.
setActiveSectionTab('whyUs', {scroll: false});

// ---------- Back to top + vertical scroll ruler ----------
const backToTopBtn = document.getElementById('backToTopBtn');
const scrollRulerThumb = document.getElementById('scrollRulerThumb');
const scrollRulerTrack = document.getElementById('scrollRulerTrack');

function updateScrollChrome(){
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = scrollHeight > 0 ? Math.min(1, scrollTop / scrollHeight) : 0;

  backToTopBtn.style.display = scrollTop > 400 ? 'flex' : 'none';

  const trackHeight = scrollRulerTrack.clientHeight;
  const thumbHeight = scrollRulerThumb.clientHeight;
  scrollRulerThumb.style.top = (ratio * (trackHeight - thumbHeight)) + 'px';
}
window.addEventListener('scroll', updateScrollChrome, { passive: true });
window.addEventListener('resize', updateScrollChrome);
updateScrollChrome();

backToTopBtn.addEventListener('click', ()=>{
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('scrollRulerUp').addEventListener('click', ()=>{
  window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
});
document.getElementById('scrollRulerDown').addEventListener('click', ()=>{
  window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
});

/** Dragging the ruler track (or just clicking a spot on it) jumps the page
 * to that relative scroll position — same idea as dragging a scrollbar. */
function scrollToRulerPosition(clientY){
  const rect = scrollRulerTrack.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo({ top: ratio * scrollHeight, behavior: 'auto' });
}
let rulerDragging = false;
scrollRulerTrack.addEventListener('mousedown', (e)=>{
  rulerDragging = true;
  scrollToRulerPosition(e.clientY);
});
window.addEventListener('mousemove', (e)=>{
  if(rulerDragging) scrollToRulerPosition(e.clientY);
});
window.addEventListener('mouseup', ()=>{ rulerDragging = false; });
scrollRulerTrack.addEventListener('touchstart', (e)=>{
  scrollToRulerPosition(e.touches[0].clientY);
}, { passive: true });
scrollRulerTrack.addEventListener('touchmove', (e)=>{
  scrollToRulerPosition(e.touches[0].clientY);
}, { passive: true });

// ---------- Search (site content + per-visitor search history) ----------
const searchBox = document.getElementById('searchBox');
const searchInput = document.getElementById('searchInput');
const searchDropdown = document.getElementById('searchDropdown');
const SEARCH_HISTORY_KEY = 'megaPromptSearchHistory';

function getSearchHistory(){
  try{ return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); }
  catch(e){ return []; }
}
function saveSearchHistory(list){
  try{ localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 10))); }catch(e){}
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
  renderSearchDropdown(searchInput.value);
}

function scrollToProductCard(p){
  addSearchHistory(searchInput.value || productTitle(p));
  searchBox.classList.remove('open');
  searchInput.value = '';
  const sectionEl = openCatSection(p.category);
  if(sectionEl) sectionEl.scrollIntoView({behavior:'smooth', block:'start'});
  // Open the quick-view modal shortly after scrolling so the visitor lands
  // right on the product they searched for, not just its general section
  // (products are paginated, so it may not be on the currently-shown page).
  setTimeout(()=> openProductDetail(p.id), 450);
}

/** Static, always-searchable parts of the site (category sections, FAQ,
 * testimonials, etc.) — combined with live product-title matches below so
 * the search box covers the whole site, not just products. Rebuilt fresh on
 * every call so labels follow the current language. */
function getStaticSearchIndex(){
  const cats = ['children','male','female','business','cinematic','luxury','artistic','magazine'];
  const items = cats.map(c => ({ id:c, label: catLabel(c), keywords:[catLabel(c)], icon:`<span class="cicon ${ICON_COLOR_CLASS[c]}" style="display:inline-flex;font-size:15px;vertical-align:-2px;">${CAT_ICON[c]}</span>` }));
  items.push(
    { id:'howItWorks', label:t('howItWorksTitle'), keywords:[t('how1Title'), t('how1Desc'), t('how2Title'), t('how2Desc'), t('how3Title'), t('how3Desc')], icon:'❔' },
    { id:'testimonials', label:t('testimonialsTitle'), keywords:['تقييم', 'تقييمات', 'review', 'reviews', 'rating'], icon:'⭐' },
    { id:'aboutUs', label:t('aboutUsTitle'), keywords:[t('aboutUsText')], icon:'👥' },
    { id:'faq', label:t('faqTitle'), keywords:['اسئلة', 'أسئلة', 'faq', 'questions', t('faqQ1'), t('faqA1'), t('faqQ2'), t('faqA2'), t('faqQ3'), t('faqA3'), t('faqQ4'), t('faqA4')], icon:'❓' },
    { id:'whyUs', label:t('whyUsTitle'), keywords:[t('whyUs1'), t('whyUs2'), t('whyUs3'), t('whyUs4'), t('whyUs5'), t('trustBadge1'), t('trustBadge2'), t('trustBadge3'), t('trustBadge4')], icon:'✅' },
    { id:'mostRequested', label:t('mostRequestedTitle'), keywords:[], icon:'🔥' },
    { id:'pricing', label:t('pricingTitle'), keywords:[t('pricingSub'), t('plan1Title'), t('plan1Price'), t('plan2Title'), t('plan2Unit')], icon:'💳' },
  );
  // Every section's whole body text (title + every keyword phrase) is
  // flattened into one lowercase haystack, so a query whose words are
  // scattered across a question and its answer — or a title and a bullet
  // several lines below it — still matches, instead of requiring both
  // words to land inside the same short phrase.
  items.forEach(it => { it.searchText = [it.label, ...it.keywords].filter(Boolean).join(' ').toLowerCase(); });
  return items;
}

function scrollToSiteSection(id){
  searchBox.classList.remove('open');
  const term = searchInput.value;
  searchInput.value = '';
  addSearchHistory(term);
  const el = document.getElementById(id);
  if(!el) return;
  if(TAB_PANEL_IDS.includes(id)){
    setActiveSectionTab(id, {scroll: false}); // switches the shared tab panel to this one
  } else if(!['testimonials','whyEdge'].includes(id)){
    el.classList.add('open'); // opens it if it's one of the collapsible category sections
  }
  // testimonials/whyEdge are always-visible — nothing to open, scrollIntoView below is enough.
  document.querySelector(`.cat-tile[data-cat="${id}"]`)?.classList.add('open');
  document.querySelector(`.cat-tile[data-cat="${id}"]`)?.setAttribute('aria-expanded', 'true');
  el.scrollIntoView({behavior:'smooth', block:'start'});
}

// The "السر" card's closing link (".why-edge-link", injected via
// data-i18n-html so it has no ID of its own to bind to directly) used to be
// a plain `href="#children"` anchor. Since the "أطفال" category section is
// collapsed by default, that just scrolled the page to an empty, still-
// closed section — nothing visibly happened, so it read as broken. Event
// delegation here intercepts the click and routes it through the same
// open-and-scroll logic every other in-page link already uses.
document.addEventListener('click', (e)=>{
  const link = e.target.closest('.why-edge-link');
  if(!link) return;
  e.preventDefault();
  scrollToSiteSection('children');
});

/** Splits a query into its individual words and requires every one of them
 * to appear somewhere in the given text (in any order, anywhere in it) —
 * so "دعم مباشر" still finds a phrase like "دعم فني سريع ومباشر" even
 * though the two query words aren't adjacent there. */
function textHasAllWords(text, words){
  if(!text || !words.length) return false;
  const hay = text.toLowerCase();
  return words.every(w => hay.includes(w));
}

function renderSearchDropdown(query){
  query = (query || '').trim().toLowerCase();
  if(!query){
    const history = getSearchHistory();
    if(!history.length){
      searchDropdown.innerHTML = `<div class="sd-empty">${t('searchNoHistory')}</div>`;
      return;
    }
    searchDropdown.innerHTML =
      `<div class="sd-section-label">${t('searchHistoryLabel')}</div>` +
      history.map(term => `
        <div class="sd-history-item" data-term="${escapeHtml(term)}">
          <span>🕘 ${escapeHtml(term)}</span>
          <span class="sd-remove" data-remove="${escapeHtml(term)}">✕</span>
        </div>`).join('');
    return;
  }
  const words = query.split(/\s+/).filter(Boolean);
  const sectionMatches = getStaticSearchIndex()
    .filter(s => textHasAllWords(s.searchText, words))
    .slice(0, 6);
  const productMatches = products
    .filter(p => textHasAllWords(productTitle(p), words) || textHasAllWords(p.title, words))
    .slice(0, 8);

  if(!sectionMatches.length && !productMatches.length){
    searchDropdown.innerHTML = `<div class="sd-empty">${t('searchNoResults')}</div>`;
    return;
  }

  let html = '';
  if(sectionMatches.length){
    html += `<div class="sd-section-label">${t('searchSectionsLabel')}</div>` +
      sectionMatches.map(s => `
        <div class="sd-history-item" data-section="${s.id}">
          <span>${s.icon} ${escapeHtml(s.label)}</span>
        </div>`).join('');
  }
  if(productMatches.length){
    html += `<div class="sd-section-label">${t('searchResultsLabel')}</div>` +
      productMatches.map(p => `
        <div class="sd-result" data-product="${p.id}">
          <img src="${p.image}" alt="">
          <div>
            <div class="sd-title">${escapeHtml(productTitle(p))}</div>
            <div class="sd-cat">${catLabel(p.category)}</div>
          </div>
        </div>`).join('');
  }
  searchDropdown.innerHTML = html;
}

searchInput.addEventListener('focus', ()=>{
  searchBox.classList.add('open');
  renderSearchDropdown(searchInput.value);
});
searchInput.addEventListener('input', ()=> renderSearchDropdown(searchInput.value));
searchInput.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){
    const query = searchInput.value.trim();
    if(query) addSearchHistory(query);
    renderSearchDropdown(query);
  }
});
document.addEventListener('click', (e)=>{
  if(!searchBox.contains(e.target)) searchBox.classList.remove('open');
});
searchDropdown.addEventListener('click', (e)=>{
  const removeBtn = e.target.closest('[data-remove]');
  if(removeBtn){
    e.stopPropagation();
    removeSearchHistoryItem(removeBtn.dataset.remove);
    return;
  }
  const sectionItem = e.target.closest('[data-section]');
  if(sectionItem){
    scrollToSiteSection(sectionItem.dataset.section);
    return;
  }
  const historyItem = e.target.closest('.sd-history-item[data-term]');
  if(historyItem){
    searchInput.value = historyItem.dataset.term;
    renderSearchDropdown(historyItem.dataset.term);
    return;
  }
  const resultItem = e.target.closest('.sd-result');
  if(resultItem){
    const p = products.find(x => x.id === resultItem.dataset.product);
    if(p) scrollToProductCard(p);
  }
});

// ---------- Category dropdown (single button + menu, replaces the old pill row) ----------
const catDropdown = document.getElementById('catDropdown');
const catDropdownBtn = document.getElementById('catDropdownBtn');
const catDropdownLabel = document.getElementById('catDropdownLabel');

function closeCatDropdown(){
  catDropdown.classList.remove('open');
  catDropdownBtn.setAttribute('aria-expanded', 'false');
}
catDropdownBtn.addEventListener('click', (e)=>{
  e.stopPropagation();
  const willOpen = !catDropdown.classList.contains('open');
  catDropdown.classList.toggle('open', willOpen);
  catDropdownBtn.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (e)=>{
  if(!catDropdown.contains(e.target)) closeCatDropdown();
});
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape') closeCatDropdown();
});

document.getElementById('catNav').addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  [...document.querySelectorAll('#catNav button')].forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  // Selecting "All" restores the generic "Categories" label; picking a specific
  // category shows that category's own name on the button, so it's clear at a
  // glance which section you're currently browsing.
  catDropdownLabel.textContent = btn.dataset.cat === 'all' ? t('categoriesLabel') : btn.textContent;
  closeCatDropdown();
  const cat = btn.dataset.cat;
  if(cat==='all'){ document.getElementById('categoryTiles')?.scrollIntoView({behavior:'smooth'}); }
  else{ openCatSection(cat)?.scrollIntoView({behavior:'smooth'}); }
});

// ---------- Admin quick-access bell (top of page, before categories) ----------
// Only ever shown once adminLoggedIn is true (see admin login/logout handlers
// below) — customers who never authenticate never see this at all, same as
// the old hidden "لوحة الإدارة" button.
const adminQuickAccess = document.getElementById('adminQuickAccess');
const adminBellBtn = document.getElementById('adminBellBtn');
let adminBellPollTimer = null;

function closeAdminQuickMenu(){
  adminQuickAccess.classList.remove('open');
  adminBellBtn.setAttribute('aria-expanded', 'false');
}
adminBellBtn.addEventListener('click', (e)=>{
  e.stopPropagation();
  const willOpen = !adminQuickAccess.classList.contains('open');
  adminQuickAccess.classList.toggle('open', willOpen);
  adminBellBtn.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (e)=>{
  if(!adminQuickAccess.contains(e.target)) closeAdminQuickMenu();
});

document.getElementById('adminQuickMenu').addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-admin-tab]');
  if(!btn) return;
  closeAdminQuickMenu();
  const tab = btn.dataset.adminTab;
  adminModalBg.classList.add('show');
  document.getElementById('adminLoginView').style.display = 'none';
  document.getElementById('adminFormView').style.display = 'block';
  setAdminTab(tab);
  if(tab === 'orders'){ loadOrders().then(renderOrdersList); }
  if(tab === 'showcase'){ loadShowcaseIntoAdmin(); }
  if(tab === 'promoimages'){ loadPromoImagesIntoAdmin(); }
});
document.getElementById('adminQuickLogout').addEventListener('click', ()=>{
  closeAdminQuickMenu();
  document.getElementById('adminLogoutBtn').click();
});

/** Refreshes just the pending-orders count for the bell badge, independent of
 * whether the orders tab (or the admin modal at all) is currently open. */
let lastSeenPendingCount = null;   // null = first poll, nothing to compare against yet
let adminAlertSound = null;

/** Asks once for permission to raise a system notification. Only ever called
 * from a real click (browsers reject the request otherwise). */
function enableAdminAlerts(){
  if(!('Notification' in window)) { showToast(t('toastAlertsUnsupported')); return; }
  Notification.requestPermission().then(perm=>{
    showToast(t(perm === 'granted' ? 'toastAlertsOn' : 'toastAlertsBlocked'));
    updateAdminAlertBtn();
  }).catch(()=>{});
}

function updateAdminAlertBtn(){
  const btn = document.getElementById('adminAlertsBtn');
  if(!btn) return;
  const granted = ('Notification' in window) && Notification.permission === 'granted';
  btn.textContent = granted ? '🔔' : '🔕';
  btn.title = t(granted ? 'alertsOnTitle' : 'alertsOffTitle');
}

/** Short chime built with the Web Audio API — no audio file to ship, and it
 * only ever plays in response to a new order, never on page load. */
function playAdminChime(){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    adminAlertSound = adminAlertSound || new Ctx();
    if(adminAlertSound.state === 'suspended') adminAlertSound.resume();
    [880, 1320].forEach((freq, i)=>{
      const osc = adminAlertSound.createOscillator();
      const gain = adminAlertSound.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, adminAlertSound.currentTime + i*0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, adminAlertSound.currentTime + i*0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, adminAlertSound.currentTime + i*0.18 + 0.35);
      osc.connect(gain).connect(adminAlertSound.destination);
      osc.start(adminAlertSound.currentTime + i*0.18);
      osc.stop(adminAlertSound.currentTime + i*0.18 + 0.36);
    });
  }catch(e){ /* sound is a nicety, never block on it */ }
}

/** Fires when the pending-order count goes UP, so an order that arrives while
 * the storefront is sitting in a background tab still gets noticed. */
function announceNewOrders(pending){
  if(lastSeenPendingCount === null){ lastSeenPendingCount = pending; return; }
  const added = pending - lastSeenPendingCount;
  lastSeenPendingCount = pending;
  if(added <= 0) return;
  playAdminChime();
  showToast(t('toastNewOrder').replace('{n}', added));
  document.title = `(${pending}) ` + document.title.replace(/^\(\d+\)\s*/, '');
  if(('Notification' in window) && Notification.permission === 'granted'){
    try{
      const n = new Notification(t('newOrderNotifTitle'), {
        body: t('newOrderNotifBody').replace('{n}', added).replace('{total}', pending),
        tag: 'miga-new-order'
      });
      n.onclick = ()=>{ window.focus(); expandAdminPanel(); n.close(); };
    }catch(e){}
  }
}

async function refreshAdminBellBadge(){
  if(!adminLoggedIn || !BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/list?token=${encodeURIComponent(adminSessionToken)}`);
    if(!res.ok) return;
    const data = await res.json();
    const list = (data && data.value) ? JSON.parse(data.value) : [];
    const pending = list.filter(o=>o.status==='pending').length;
    announceNewOrders(pending);
    const badge = document.getElementById('adminBellBadge');
    const menuLabel = document.getElementById('adminQuickPendingLabel');
    badge.style.display = pending ? '' : 'none';
    badge.textContent = pending > 99 ? '99+' : String(pending);
    menuLabel.textContent = pending ? `(${pending})` : '';
    // If the orders tab happens to be open, keep its stats/table live too —
    // same 30s cadence, no extra timer needed.
    if(document.getElementById('adminTabOrders').style.display !== 'none'){
      orders = list;
      renderOrdersList();
    }
    if(document.getElementById('adminTabReviews').style.display !== 'none'){
      loadPendingReviews();
    }
  }catch(e){ /* next poll retries */ }
}

/** Folds the admin panel away without discarding anything typed into it: the
 * modal is hidden and the floating launcher takes its place, so re-opening
 * lands back on exactly the same tab with the same half-filled form. */
function collapseAdminPanel(){
  document.getElementById('adminModalBg').classList.remove('show');
  document.getElementById('adminFab').classList.add('show');
}

function expandAdminPanel(){
  document.getElementById('adminModalBg').classList.add('show');
  document.getElementById('adminFab').classList.remove('show');
}

function syncAdminFabBadge(){
  const badge = document.getElementById('adminFabBadge');
  if(!badge) return;
  const text = (document.getElementById('pendingCount')?.innerText || '').replace(/[()]/g,'').trim();
  badge.textContent = text;
  badge.classList.toggle('show', !!text);
}

document.getElementById('adminCollapseBtn').onclick = ()=>{
  collapseAdminPanel();
  syncAdminFabBadge();
};
document.getElementById('adminFab').onclick = expandAdminPanel;
document.getElementById('adminAlertsBtn').onclick = enableAdminAlerts;
updateAdminAlertBtn();
document.getElementById('pShareLinkCopy').onclick = ()=>
  copyToClipboard(document.getElementById('pShareLink').value, 'toastLinkCopied');
document.getElementById('pImageLinkCopy').onclick = ()=>
  copyToClipboard(document.getElementById('pImageLink').value, 'toastImageLinkCopied');

function showAdminQuickAccess(){
  adminQuickAccess.style.display = '';
  refreshAdminBellBadge();
  if(adminBellPollTimer) clearInterval(adminBellPollTimer);
  adminBellPollTimer = setInterval(refreshAdminBellBadge, 10000);
}
function hideAdminQuickAccess(){
  lastSeenPendingCount = null;
  document.title = document.title.replace(/^\(\d+\)\s*/, '');
  adminQuickAccess.style.display = 'none';
  closeAdminQuickMenu();
  if(adminBellPollTimer){ clearInterval(adminBellPollTimer); adminBellPollTimer = null; }
}

// ---------- Customer accounts (real, D1-backed via the Worker) ----------
let currentUser = null; // { name, email }

async function checkLoggedInUser(){
  const token = localStorage.getItem('megaPromptAuthToken');
  if(!token || !BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/auth/me`, { headers:{ 'Authorization': `Bearer ${token}` } });
    if(res.ok){
      currentUser = await res.json();
      updateAccountButton();
      logVisitAsLoggedInUser();
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
  logVisitAsLoggedInUser();
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

// ---------- Reviews ----------
const reviewModalBg = document.getElementById('reviewModalBg');
// The thank-you panel reuses the buttons that already exist, so there is one
// share implementation and one review flow rather than parallel copies.
document.getElementById('thanksShareBtn').onclick = ()=>
  document.getElementById('transformShareBtn').click();
document.getElementById('thanksReviewBtn').onclick = ()=>
  document.getElementById('writeReviewBtn').click();

let selectedReviewPhotoUrl = null;
let reviewResultUrls = [];
function populateReviewPhotoPicker(){
  const field = document.getElementById('reviewPhotoField');
  const picker = document.getElementById('reviewPhotoPicker');
  const consent = document.getElementById('reviewPhotoConsent');
  selectedReviewPhotoUrl = null;
  consent.checked = false;
  picker.style.display = 'none';
  picker.innerHTML = '';
  reviewResultUrls = Object.values(transformedResults || {}).filter(Boolean);
  if(!reviewResultUrls.length){ field.style.display = 'none'; return; }
  field.style.display = 'block';
  reviewResultUrls.forEach((url, i)=>{
    const thumb = document.createElement('div');
    thumb.className = 'review-photo-thumb';
    thumb.innerHTML = `<img src="${url}" alt="نتيجتك ${i+1}" loading="lazy">`;
    thumb.onclick = ()=>{
      picker.querySelectorAll('.review-photo-thumb').forEach(t=>t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedReviewPhotoUrl = url;
    };
    picker.appendChild(thumb);
  });
}
document.getElementById('reviewPhotoConsent').addEventListener('change', function(){
  const picker = document.getElementById('reviewPhotoPicker');
  if(this.checked){
    if(reviewResultUrls.length > 1){
      // More than one result on file — show the thumbnails so the customer
      // picks which one, none pre-selected until they actually tap one.
      picker.style.display = 'flex';
      selectedReviewPhotoUrl = null;
    }else{
      // Only one result exists — checking the box is the whole decision,
      // no picker needed.
      picker.style.display = 'none';
      selectedReviewPhotoUrl = reviewResultUrls[0] || null;
    }
  }else{
    picker.style.display = 'none';
    selectedReviewPhotoUrl = null;
    picker.querySelectorAll('.review-photo-thumb').forEach(t=>t.classList.remove('selected'));
  }
});

document.getElementById('writeReviewBtn').onclick = ()=>{
  if(!currentUser){
    showToast(t('toastLoginRequired'));
    document.getElementById('accountOpenBtn').click();
    return;
  }
  populateReviewPhotoPicker();
  reviewModalBg.classList.add('show');
};
document.getElementById('reviewModalClose').onclick = ()=> reviewModalBg.classList.remove('show');
document.getElementById('reviewCancelBtn').onclick = ()=> reviewModalBg.classList.remove('show');

document.getElementById('reviewSubmitBtn').onclick = async ()=>{
  const rating = document.getElementById('reviewRating').value;
  const comment = document.getElementById('reviewComment').value.trim();
  const token = localStorage.getItem('megaPromptAuthToken');
  if(!comment){ showToast(t('toastFillFields')); return; }
  if(document.getElementById('reviewPhotoConsent').checked && reviewResultUrls.length > 1 && !selectedReviewPhotoUrl){
    showToast(t('toastPickReviewPhoto'));
    return;
  }
  try{
    const res = await fetch(`${BACKEND_BASE}/reviews/submit`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token, rating, comment, resultImageUrl: selectedReviewPhotoUrl || undefined })
    });
    const data = await res.json();
    if(!res.ok){ showToast(data.error || t('toastGenerateFailed')); return; }
    reviewModalBg.classList.remove('show');
    document.getElementById('reviewComment').value = '';
    selectedReviewPhotoUrl = null;
    showToast(t('toastReviewSubmitted'));
  }catch(e){ showToast(t('toastGenerateFailed')); }
};

async function renderTestimonials(){
  const grid = document.getElementById('testimonialsGrid');
  const note = document.getElementById('testimonialsNoteEl');
  if(!grid || !BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/reviews/list`);
    const data = await res.json();
    if(data.reviews && data.reviews.length){
      // Same display style as Design MIGA 3: text-only cards in a horizontal
      // scrollable row, with filled/empty stars reflecting the exact rating.
      grid.innerHTML = data.reviews.map(r => {
        const rating = r.rating || 5;
        const starsStr = '★'.repeat(rating) + '☆'.repeat(5 - rating);
        return `
        <div class="testimonial-card">
          <div class="stars">${starsStr}</div>
          <p>"${escapeHtml(r.comment)}"</p>
          <div class="testimonial-author">— ${escapeHtml(r.user_name)}</div>
        </div>`;
      }).join('');
      if(note) note.style.display = 'none';
    }
  }catch(e){ /* keep the example placeholders on failure */ }
}

async function loadPendingReviews(){
  const el = document.getElementById('pendingReviewsList');
  if(!el || !BACKEND_BASE) return;
  try{
    const [pendingRes, approvedRes] = await Promise.all([
      fetch(`${BACKEND_BASE}/reviews/pending?token=${encodeURIComponent(adminSessionToken)}`),
      fetch(`${BACKEND_BASE}/reviews/list`)
    ]);
    const pendingData = await pendingRes.json();
    const approvedData = await approvedRes.json().catch(()=>({reviews:[]}));
    const reviews = pendingData.reviews || [];
    const approvedReviews = approvedData.reviews || [];

    document.getElementById('pendingReviewCount').textContent = reviews.length ? `(${reviews.length})` : '';
    document.getElementById('reviewStatTotal').textContent = reviews.length + approvedReviews.length;
    document.getElementById('reviewStatApproved').textContent = approvedReviews.length;
    document.getElementById('reviewStatPending').textContent = reviews.length;
    renderReviewStatsTable(reviews, approvedReviews);

    if(!reviews.length){
      el.innerHTML = `<div class="empty-note">${t('noPendingReviews')}</div>`;
      return;
    }
    el.innerHTML = reviews.map(r => `
      <div class="admin-product-row">
        ${r.resultImageUrl ? `<img src="${r.resultImageUrl}" alt="نتيجة مرفقة" style="width:44px; height:56px; object-fit:cover; border-radius:6px; flex-shrink:0;">` : ''}
        <div class="admin-product-info">
          <b>${'⭐'.repeat(r.rating)} — ${escapeHtml(r.user_name)}</b>
          <span>${escapeHtml(r.comment)}</span>
        </div>
        <div class="admin-product-actions">
          <button onclick="approveReview(${r.id})" title="موافقة">✅</button>
          <button onclick="deleteReviewPrompt(${r.id})" title="${t('reviewDeleteBtn')}">🗑️</button>
        </div>
      </div>`).join('');
  }catch(e){ el.innerHTML = `<div class="empty-note">${t('noPendingReviews')}</div>`; }
}

/** Same compact-table-on-expand pattern as the orders stats bar — shows the
 * most recent pending reviews (need action) followed by the most recent
 * approved ones, so admin gets a live snapshot without scrolling the full
 * pending-reviews list below. */
function renderReviewStatsTable(pending, approved){
  const tableEl = document.getElementById('reviewStatsTable');
  if(!tableEl) return;
  const rows = [
    ...pending.slice(0, 10).map(r=>({...r, status:'pending'})),
    ...approved.slice(0, 10).map(r=>({...r, status:'approved'})),
  ];
  if(!rows.length){
    tableEl.innerHTML = `<div class="empty-note">${t('noPendingReviews')}</div>`;
    return;
  }
  tableEl.innerHTML = `<table>
    <thead><tr>
      <th>${t('statColBuyer')}</th><th>${t('reviewColRating')}</th><th>${t('reviewColComment')}</th><th>${t('statColStatus')}</th><th></th>
    </tr></thead>
    <tbody>
      ${rows.map(r=>`
        <tr>
          <td>${escapeHtml(r.user_name || '—')}</td>
          <td>${'⭐'.repeat(r.rating || 0)}</td>
          <td>${escapeHtml((r.comment || '').slice(0, 60))}</td>
          <td><span class="order-status ${r.status==='approved' ? 'status-approved' : 'status-pending'}">${r.status==='approved' ? t('orderStatusApproved') : t('orderStatusPending')}</span></td>
          <td><button class="btn-ghost reject-btn" style="padding:4px 8px; font-size:12px;" onclick="deleteReviewPrompt(${r.id})" title="${t('reviewDeleteBtn')}">🗑️</button></td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

document.getElementById('reviewStatsBar').addEventListener('click', function(){
  const isOpen = this.classList.toggle('open');
  this.setAttribute('aria-expanded', String(isOpen));
  document.getElementById('reviewStatsTable').style.display = isOpen ? 'block' : 'none';
});

async function approveReview(id){
  try{
    await fetch(`${BACKEND_BASE}/reviews/approve`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, id })
    });
    await loadPendingReviews();
    renderTestimonials();
    showToast(t('toastOrderApproved'));
  }catch(e){ showToast(t('toastOrderFailed')); }
}

/** Permanently removes a review — works whether it's still pending or
 * already published, since the backend checks both lists by id. Used both
 * from the pending-reviews list and from the reviews stats table below. */
async function deleteReviewPrompt(id){
  if(!confirm(t('confirmDeleteReview'))) return;
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/reviews/delete`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, id })
    });
    if(!res.ok){ showToast(t('toastOrderFailed')); return; }
    await loadPendingReviews();
    renderTestimonials();
    showToast(t('toastReviewDeleted'));
  }catch(e){ showToast(t('toastOrderFailed')); }
}

// ---------- Admin ----------
const adminOpenBtn = document.getElementById('adminOpenBtn');
const adminModalBg = document.getElementById('adminModalBg');
let adminLoggedIn = false;

adminOpenBtn.onclick = async ()=>{
  adminModalBg.classList.add('show');
  document.getElementById('adminLoginView').style.display = adminLoggedIn ? 'none' : 'block';
  document.getElementById('adminFormView').style.display = adminLoggedIn ? 'block' : 'none';
  if(adminLoggedIn){
    await loadOrders();
    renderOrdersList();
  }
};

function setAdminTab(tab){
  document.getElementById('tabBtnProducts').classList.toggle('active', tab==='products');
  document.getElementById('tabBtnOrders').classList.toggle('active', tab==='orders');
  document.getElementById('tabBtnReviews').classList.toggle('active', tab==='reviews');
  document.getElementById('tabBtnVisitors').classList.toggle('active', tab==='visitors');
  document.getElementById('tabBtnShowcase').classList.toggle('active', tab==='showcase');
  document.getElementById('tabBtnPromoImages').classList.toggle('active', tab==='promoimages');
  document.getElementById('tabBtnChangePassword').classList.toggle('active', tab==='changepassword');
  document.getElementById('tabBtnSiteDesign').classList.toggle('active', tab==='sitedesign');
  document.getElementById('adminTabProducts').style.display = tab==='products' ? 'block' : 'none';
  document.getElementById('adminTabOrders').style.display = tab==='orders' ? 'block' : 'none';
  document.getElementById('adminTabReviews').style.display = tab==='reviews' ? 'block' : 'none';
  document.getElementById('adminTabVisitors').style.display = tab==='visitors' ? 'block' : 'none';
  document.getElementById('adminTabShowcase').style.display = tab==='showcase' ? 'block' : 'none';
  document.getElementById('adminTabPromoImages').style.display = tab==='promoimages' ? 'block' : 'none';
  document.getElementById('adminTabChangePassword').style.display = tab==='changepassword' ? 'block' : 'none';
  document.getElementById('adminTabSiteDesign').style.display = tab==='sitedesign' ? 'block' : 'none';
}
document.getElementById('tabBtnProducts').onclick = ()=> setAdminTab('products');
document.getElementById('tabBtnOrders').onclick = async ()=>{
  setAdminTab('orders');
  await loadOrders();
  renderOrdersList();
};
document.getElementById('tabBtnReviews').onclick = async ()=>{
  setAdminTab('reviews');
  await loadPendingReviews();
};
document.getElementById('tabBtnVisitors').onclick = async ()=>{
  setAdminTab('visitors');
  await loadVisitorStats();
};
document.getElementById('tabBtnShowcase').onclick = async ()=>{
  setAdminTab('showcase');
  await loadShowcaseIntoAdmin();
};
document.getElementById('tabBtnPromoImages').onclick = async ()=>{
  setAdminTab('promoimages');
  await loadPromoImagesIntoAdmin();
};
document.getElementById('tabBtnChangePassword').onclick = ()=> setAdminTab('changepassword');
document.getElementById('tabBtnSiteDesign').onclick = async ()=>{
  setAdminTab('sitedesign');
  await loadSiteDesignIntoAdmin();
};

/** Loads the list of available designs AND which one is currently live,
 * building the dropdown from server data — a future Design MIGA 3/4 just
 * needs one entry added to the Worker's registry to show up here, with no
 * frontend change needed at all. */
async function loadSiteDesignIntoAdmin(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/site-config`);
    const data = await res.json();
    const select = document.getElementById('siteDesignSelect');
    const lang = document.documentElement.lang === 'en' ? 'nameEn' : 'nameAr';
    const list = Array.isArray(data.availableDesigns) ? data.availableDesigns : [];
    select.innerHTML = list.map(d => `<option value="${d.id}">${escapeHtml(d[lang] || d.id)}</option>`).join('');
    select.value = data.activeDesign === 'v2' ? 'v2' : (list.some(d=>d.id===data.activeDesign) ? data.activeDesign : 'v1');
  }catch(e){ /* leave the dropdown empty on a network hiccup */ }
}
document.getElementById('saveSiteDesignBtn').onclick = async ()=>{
  const design = document.getElementById('siteDesignSelect').value;
  if(!BACKEND_BASE || !adminSessionToken) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/admin/set-design?token=${encodeURIComponent(adminSessionToken)}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ design })
    });
    const data = await res.json().catch(()=>({}));
    if(res.ok && data.ok) showToast(t('toastSiteDesignSaved'));
    else showToast(t('toastAdminServerError'));
  }catch(e){
    showToast(t('toastAdminServerError'));
  }
};

// ---------- Before/After circle showcase (homepage hero section) ----------
// The 9 slots (center + 8 satellites) are stored server-side as plain image
// URLs under one config object, so Magdy can swap them from the admin panel
// without ever touching code. If the backend has nothing saved yet, the
// hardcoded default images already in the HTML markup are left untouched.
const SHOWCASE_SLOTS = ['center','1','2','3','4','5','6','7','8'];
let showcaseState = {}; // slot -> uploaded URL (only populated once loaded/changed)

async function loadShowcaseIntoAdmin(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/showcase`);
    const data = await res.json().catch(()=>null);
    if(!data) return;
    SHOWCASE_SLOTS.forEach(slot=>{
      const url = slot==='center' ? data.center : (data.items || [])[parseInt(slot,10)-1];
      if(url){
        showcaseState[slot] = url;
        const img = document.getElementById(`scPreview-${slot}`);
        if(img){ img.src = url; img.style.display = 'inline-block'; }
      }
    });
  }catch(e){ /* silent — admin can still upload fresh images regardless */ }
}

SHOWCASE_SLOTS.forEach(slot=>{
  const input = document.getElementById(`scInput-${slot}`);
  if(!input) return;
  input.addEventListener('change', async (e)=>{
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
    try{
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`${BACKEND_BASE}/admin/upload-image?token=${encodeURIComponent(adminSessionToken)}`, {
        method:'POST', body: form
      });
      const data = await res.json().catch(()=>null);
      if(!res.ok || !data || !data.url){
        showToast(data && data.error ? data.error : t('toastImageUploadFailed'));
        return;
      }
      showcaseState[slot] = data.url;
      const img = document.getElementById(`scPreview-${slot}`);
      if(img){ img.src = data.url; img.style.display = 'inline-block'; }
      showToast(t('toastImageUploaded') || 'تم رفع الصورة');
    }catch(err){
      showToast(t('toastImageUploadFailed'));
    }
  });
});

document.getElementById('scSaveBtn').onclick = async ()=>{
  if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
  const missing = SHOWCASE_SLOTS.filter(s=>!showcaseState[s]);
  if(missing.length){ showToast(t('toastShowcaseIncomplete') || 'لازم ترفع كل الـ9 صور الأول'); return; }
  const btn = document.getElementById('scSaveBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('uploadingImage');
  try{
    const payload = {
      center: showcaseState['center'],
      items: [1,2,3,4,5,6,7,8].map(n=>showcaseState[String(n)])
    };
    const res = await fetch(`${BACKEND_BASE}/admin/showcase?token=${encodeURIComponent(adminSessionToken)}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    const data = await res.json().catch(()=>null);
    btn.disabled = false;
    btn.textContent = original;
    if(!res.ok){
      showToast(data && data.error ? data.error : t('toastOrderFailed'));
      return;
    }
    showToast(t('toastShowcaseSaved') || 'تم حفظ صور الدائرة');
  }catch(e){
    btn.disabled = false;
    btn.textContent = original;
    showToast(t('toastOrderFailed'));
  }
};

/** Loads the saved showcase images (if any) into the homepage circle. If the
 * backend has nothing configured yet, the default images already baked into
 * the HTML (before-after/before-after/*.jpg) stay exactly as they are — this
 * only overrides them once real choices exist. Each swap keeps the original
 * default as a fallback: if a custom-uploaded URL turns out to be broken
 * (deleted, expired, failed upload), the slot reverts to its default photo
 * instead of showing a broken-image icon in the circle. */
async function loadShowcaseOnHomepage(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/showcase`);
    const data = await res.json().catch(()=>null);
    if(!data || !data.center || !Array.isArray(data.items) || data.items.length < 8) return;
    const centerImg = document.querySelector('.baf-center img');
    if(centerImg && data.center){
      const fallback = centerImg.src;
      centerImg.onerror = ()=>{ centerImg.onerror = null; centerImg.src = fallback; };
      centerImg.src = data.center;
    }
    const itemImgs = document.querySelectorAll('.baf-item img');
    itemImgs.forEach((img,i)=>{
      if(!data.items[i]) return;
      const fallback = img.src;
      img.onerror = ()=>{ img.onerror = null; img.src = fallback; };
      img.src = data.items[i];
    });
  }catch(e){ /* keep default images on any failure */ }
}
loadShowcaseOnHomepage();

// ---------- Promo images (rotating 3-panel display, replaces the video if configured) ----------
const PROMO_IMAGE_SLOTS = Array.from({length:20}, (_,i)=>String(i+1));
let promoImagesState = {}; // slot -> uploaded URL

async function loadPromoImagesIntoAdmin(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/promo-images`);
    const data = await res.json().catch(()=>null);
    if(!data || !Array.isArray(data.items)) return;
    PROMO_IMAGE_SLOTS.forEach((slot,i)=>{
      const url = data.items[i];
      if(url){
        promoImagesState[slot] = url;
        const img = document.getElementById(`piPreview-${slot}`);
        if(img){ img.src = url; img.style.display = 'inline-block'; }
        const removeBtn = document.getElementById(`piRemove-${slot}`);
        if(removeBtn){ removeBtn.style.display = 'flex'; removeBtn.style.alignItems = 'center'; removeBtn.style.justifyContent = 'center'; }
      }
    });
  }catch(e){ /* silent — admin can still upload fresh images regardless */ }
}

PROMO_IMAGE_SLOTS.forEach(slot=>{
  const input = document.getElementById(`piInput-${slot}`);
  if(!input) return;
  input.addEventListener('change', async (e)=>{
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
    try{
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`${BACKEND_BASE}/admin/upload-image?token=${encodeURIComponent(adminSessionToken)}`, {
        method:'POST', body: form
      });
      const data = await res.json().catch(()=>null);
      if(!res.ok || !data || !data.url){
        showToast(data && data.error ? data.error : t('toastImageUploadFailed'));
        return;
      }
      promoImagesState[slot] = data.url;
      const img = document.getElementById(`piPreview-${slot}`);
      if(img){ img.src = data.url; img.style.display = 'inline-block'; }
      const removeBtn = document.getElementById(`piRemove-${slot}`);
      if(removeBtn){ removeBtn.style.display = 'flex'; removeBtn.style.alignItems = 'center'; removeBtn.style.justifyContent = 'center'; }
      showToast(t('toastImageUploaded') || 'تم رفع الصورة');
    }catch(err){
      showToast(t('toastImageUploadFailed'));
    }
  });
});

PROMO_IMAGE_SLOTS.forEach(slot=>{
  const removeBtn = document.getElementById(`piRemove-${slot}`);
  if(!removeBtn) return;
  removeBtn.addEventListener('click', ()=>{
    delete promoImagesState[slot];
    const img = document.getElementById(`piPreview-${slot}`);
    if(img){ img.src = ''; img.style.display = 'none'; }
    const input = document.getElementById(`piInput-${slot}`);
    if(input) input.value = '';
    removeBtn.style.display = 'none';
    showToast(t('toastPromoImageRemoved') || 'اضغط "حفظ صور العرض" لتثبيت الحذف');
  });
});

document.getElementById('piSaveBtn').onclick = async ()=>{
  if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
  const items = PROMO_IMAGE_SLOTS.map(s=>promoImagesState[s]).filter(Boolean);
  // Either a full, meaningful gallery (3+) or a fully cleared one (0) — a
  // half-filled 1-2 state can't drive the 3-panel display anyway, so it's
  // blocked the same way it always was; a full clear is now explicitly allowed.
  if(items.length > 0 && items.length < 3){ showToast(t('toastPromoImagesIncomplete') || 'لازم ترفع 3 صور على الأقل، أو تمسحهم كلهم'); return; }
  const btn = document.getElementById('piSaveBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('uploadingImage');
  try{
    const res = await fetch(`${BACKEND_BASE}/admin/promo-images?token=${encodeURIComponent(adminSessionToken)}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items })
    });
    const data = await res.json().catch(()=>null);
    btn.disabled = false;
    btn.textContent = original;
    if(!res.ok){
      showToast(data && data.error ? data.error : t('toastOrderFailed'));
      return;
    }
    showToast(t('toastPromoImagesSaved') || 'تم حفظ صور العرض');
  }catch(e){
    btn.disabled = false;
    btn.textContent = original;
    showToast(t('toastOrderFailed'));
  }
};

/** On the homepage, if the admin has saved 3+ promo images, replace the <video>
 * with a rotating 3-panel image display using the exact same frame/border CSS
 * (.promo-video-frame / .promo-video) so it looks identical to the video
 * version. If nothing is configured yet, the original video stays untouched. */
async function loadPromoImagesOnHomepage(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/promo-images`);
    const data = await res.json().catch(()=>null);
    if(!data || !Array.isArray(data.items) || data.items.length < 3) return;
    let items = data.items.filter(Boolean);
    const frame = document.querySelector('.promo-video-frame');
    const video = document.querySelector('.promo-video');
    if(!frame || !video) return;
    if(frame.dataset.carouselInit === '1') return; // guard against double-init
    frame.dataset.carouselInit = '1';
    // Keep the video playing (muted, hidden) in the background rather than
    // pausing it — this way its narration audio is ready the instant the
    // person taps the sound button, with no restart/reload delay.
    video.style.cssText = 'position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; overflow:hidden;';
    video.play().catch(()=>{});
    frame.style.overflow = 'hidden';

    // Shuffle once per page load (Fisher–Yates) so repeat visits — and repeat
    // watches in the same visit — show a different sequence each time.
    for(let i=items.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [items[i],items[j]] = [items[j],items[i]];
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; gap:0; border-radius:12px; overflow:hidden; cursor:pointer; user-select:none;';
    const n = 3;
    const imgs = [];
    for(let i=0;i<n;i++){
      const holder = document.createElement('div');
      holder.style.cssText = 'flex:1 1 0; height:100%; overflow:hidden; position:relative;';
      const im = document.createElement('img');
      im.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block; transition:opacity 0.5s ease; background:#111;';
      im.src = items[i % items.length];
      holder.appendChild(im);
      wrap.appendChild(holder);
      imgs.push(im);
    }
    // Progress dots — one per image, lightly indicating position and inviting
    // curiosity ("what's next?") which is what keeps people watching.
    const dots = document.createElement('div');
    dots.style.cssText = 'position:absolute; bottom:10px; left:0; right:0; display:flex; justify-content:center; gap:5px; z-index:2;';
    const dotEls = items.slice(0, Math.min(items.length, 10)).map(()=>{
      const d = document.createElement('span');
      d.style.cssText = 'width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,0.35); transition:background 0.3s, transform 0.3s;';
      dots.appendChild(d);
      return d;
    });
    wrap.appendChild(dots);

    // Sound button — the images have no audio of their own, so this unmutes
    // the original video's narration playing quietly behind the scenes.
    const soundBtn = document.createElement('button');
    soundBtn.type = 'button';
    soundBtn.setAttribute('aria-label', 'تشغيل الصوت');
    soundBtn.style.cssText = 'position:absolute; top:10px; left:10px; z-index:3; width:36px; height:36px; border-radius:50%; border:1.5px solid var(--brass); background:rgba(20,16,8,0.55); color:var(--brass); font-size:16px; display:flex; align-items:center; justify-content:center; cursor:pointer; backdrop-filter:blur(2px);';
    soundBtn.textContent = '🔇';
    soundBtn.addEventListener('click', (e)=>{
      e.stopPropagation(); // don't trigger the left/right image navigation
      video.muted = !video.muted;
      if(!video.muted) video.play().catch(()=>{});
      soundBtn.textContent = video.muted ? '🔇' : '🔊';
    });
    wrap.appendChild(soundBtn);

    // Wavy, moving zigzag seams between the 3 panels instead of a hard
    // straight edge — a thin jagged strip laid over each boundary, its
    // background scrolling continuously to feel alive, like water.
    const waveSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='48' viewBox='0 0 24 48'%3E%3Cpath d='M0 0 L24 6 L0 12 L24 18 L0 24 L24 30 L0 36 L24 42 L0 48' fill='none' stroke='%23e3a429' stroke-width='2.5' opacity='0.55'/%3E%3C/svg%3E";
    [1,2].forEach(pos=>{
      const d = document.createElement('div');
      d.style.cssText = `position:absolute; top:0; bottom:0; left:${(100/3)*pos}%; width:26px; margin-left:-13px; z-index:2; background-image:url("${waveSvg}"); background-repeat:repeat-y; background-size:24px 48px; animation:promoWaveScroll 2.6s linear infinite; pointer-events:none; mix-blend-mode:overlay;`;
      wrap.appendChild(d);
    });
    frame.appendChild(wrap);

    let offset = 0;
    let paused = false;
    let resumeTimer = null;

    function preload(src){
      return new Promise((resolve)=>{
        const p = new Image();
        p.onload = ()=>resolve(true);
        p.onerror = ()=>resolve(false);
        p.src = src;
      });
    }
    // Warm the whole library in the background right away so every future
    // transition is instant — this is what makes it feel buttery, not just
    // the next couple of frames.
    items.forEach(src=> preload(src));

    function updateDots(){
      const active = offset % dotEls.length;
      dotEls.forEach((d,i)=>{
        d.style.background = i===active ? 'var(--brass)' : 'rgba(255,255,255,0.35)';
        d.style.transform = i===active ? 'scale(1.3)' : 'scale(1)';
      });
    }
    updateDots();

    async function render(){
      const nextSrcs = imgs.map((im,i)=> items[((offset + i*Math.floor(items.length/n)) % items.length + items.length) % items.length]);
      await Promise.all(nextSrcs.map(preload));
      if(paused) { /* still show — preload doesn't hurt */ }
      imgs.forEach((im,i)=>{
        im.style.opacity = '0';
        setTimeout(()=>{
          im.src = nextSrcs[i];
          im.style.opacity = '1';
        }, 350);
      });
      updateDots();
    }

    function goTo(step){
      offset = ((offset + step) % items.length + items.length) % items.length;
      const renderPromise = render();
      // Manual navigation counts as engagement — give the auto-rotation a
      // breather so it doesn't fight the person's own browsing.
      if(resumeTimer) clearTimeout(resumeTimer);
      paused = true;
      resumeTimer = setTimeout(()=>{ paused = false; }, 5000);
      return renderPromise;
    }

    setInterval(()=>{ if(!paused) goTo(1); }, 3400);

    // Tap the right half to go forward, left half to go back — simple,
    // intuitive, and gives visitors a reason to keep interacting instead of
    // just watching passively.
    wrap.addEventListener('click', (e)=>{
      const rect = wrap.getBoundingClientRect();
      const tappedRight = (e.clientX - rect.left) > rect.width / 2;
      return goTo(tappedRight ? 1 : -1);
    });
  }catch(e){ /* keep the default video on any failure */ }
}
// Disabled on purpose (Magdy's request): the homepage should always show the
// promo video, never the 3-image carousel fallback, even though images are
// still saved in the admin panel's "صور العرض" tab. Nothing was deleted —
// just uncomment the line below to bring the image carousel back on.
// loadPromoImagesOnHomepage();

async function loadVisitorStats(){
  const listEl = document.getElementById('visitorsLogList');
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/visits/stats?token=${encodeURIComponent(adminSessionToken)}`);
    const data = await res.json();
    document.getElementById('visitorsTotalStat').textContent = data.total ?? 0;
    document.getElementById('visitorsTodayStat').textContent = data.today ?? 0;
    document.getElementById('visitorsUniqueTotalStat').textContent = data.uniqueTotal ?? 0;
    document.getElementById('visitorsUniqueTodayStat').textContent = data.uniqueToday ?? 0;
    const recent = data.recent || [];
    if(!recent.length){
      listEl.innerHTML = `<div class="empty-note">${t('visitorsEmptyNote')}</div>`;
      return;
    }
    listEl.innerHTML = `
      <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
        <thead>
          <tr style="text-align:right; color:var(--paper-dim);">
            <th style="padding:6px 4px; border-bottom:1px solid var(--line);">${t('visitorsColDate')}</th>
            <th style="padding:6px 4px; border-bottom:1px solid var(--line);">${t('visitorsColPage')}</th>
            <th style="padding:6px 4px; border-bottom:1px solid var(--line);">${t('visitorsColCountry')}</th>
            <th style="padding:6px 4px; border-bottom:1px solid var(--line);">${t('visitorsColName')}</th>
            <th style="padding:6px 4px; border-bottom:1px solid var(--line);">${t('visitorsColEmail')}</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map(v => `
            <tr>
              <td style="padding:6px 4px; border-bottom:1px solid var(--line);">${escapeHtml(new Date(v.visited_at).toLocaleString())}</td>
              <td style="padding:6px 4px; border-bottom:1px solid var(--line);">${escapeHtml(v.path || '/')}</td>
              <td style="padding:6px 4px; border-bottom:1px solid var(--line);">${escapeHtml(v.country || '—')}</td>
              <td style="padding:6px 4px; border-bottom:1px solid var(--line);">${escapeHtml(v.user_name || '—')}</td>
              <td style="padding:6px 4px; border-bottom:1px solid var(--line);">${escapeHtml(v.user_email || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }catch(e){
    listEl.innerHTML = `<div class="empty-note">${t('visitorsEmptyNote')}</div>`;
  }
}

document.getElementById('visitorStatsBar').addEventListener('click', function(){
  const isOpen = this.classList.toggle('open');
  this.setAttribute('aria-expanded', String(isOpen));
  document.getElementById('visitorsLogList').style.display = isOpen ? 'block' : 'none';
});

/** Long-lived anonymous ID (survives across sessions/tabs) — used only to count unique visitors, no PII. */
function getOrCreateVisitorId(){
  try{
    let id = localStorage.getItem('mp_visitor_id');
    if(!id){
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('mp_visitor_id', id);
    }
    return id;
  }catch(e){ return null; } // localStorage blocked (private mode, etc.) — visit still logs, just not as a unique
}

/** Best-effort, fire-and-forget visit ping — once per browser tab session, never blocks or breaks the page. */
function logVisitOnce(){
  if(!BACKEND_BASE) return;
  try{
    if(sessionStorage.getItem('mp_visit_logged')) return;
    sessionStorage.setItem('mp_visit_logged', '1');
  }catch(e){ /* sessionStorage unavailable — just log without dedup */ }
  fetch(`${BACKEND_BASE}/visits/log`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: window.location.pathname + window.location.hash, visitorId: getOrCreateVisitorId(), userName: currentUser?.name || null, userEmail: currentUser?.email || null })
  }).catch(()=>{});
}

/** Fired right after a successful login (any method) — bypasses the once-per-tab
 * dedup above on purpose, since "this visitor just logged in as X" is a distinct,
 * worthwhile event for the admin visitors log even if an anonymous visit was
 * already logged earlier in the same tab session. */
function logVisitAsLoggedInUser(){
  if(!BACKEND_BASE || !currentUser) return;
  fetch(`${BACKEND_BASE}/visits/log`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: window.location.pathname + window.location.hash, visitorId: getOrCreateVisitorId(), userName: currentUser.name || null, userEmail: currentUser.email || null })
  }).catch(()=>{});
}

/** Shared by every place that renders an order's status badge/label. */
function orderStatusClass(status){
  if(status==='approved') return 'status-approved';
  if(status==='rejected') return 'status-rejected';
  return 'status-pending';
}
function orderStatusLabel(status){
  if(status==='approved') return t('orderStatusApproved');
  if(status==='rejected') return t('orderStatusRejected');
  return t('orderStatusPending');
}

function renderOrdersList(){
  const el = document.getElementById('ordersList');
  const pending = orders.filter(o=>o.status==='pending').length;
  const approved = orders.filter(o=>o.status==='approved').length;
  const revenue = orders.filter(o=>o.status==='approved').reduce((sum,o)=> sum + (Number(o.price)||0), 0);
  document.getElementById('pendingCount').innerText = pending ? `(${pending})` : '';
  syncAdminFabBadge();
  document.getElementById('statTotal').textContent = orders.length;
  document.getElementById('statApproved').textContent = approved;
  document.getElementById('statPending').textContent = pending;
  document.getElementById('statRevenue').textContent = revenue + ' ' + CURRENCY;
  renderOrderStatsTable();
  if(!orders.length){
    el.innerHTML = `<div class="empty-note">${t('ordersEmptyNote')}</div>`;
    return;
  }
  const sorted = [...orders].sort((a,b)=> b.createdAt - a.createdAt);
  el.innerHTML = sorted.map(o=>`
    <div class="order-row">
      <div class="oline"><span>${t('orderLabelType')}</span><b class="order-type-badge ${o.orderType==='prompt' ? 'type-prompt' : 'type-transform'}">${o.orderType==='prompt' ? t('orderTypePrompt') : t('orderTypeTransform')}</b></div>
      <div class="oline"><span>${t('orderLabelProduct')}</span><b>${escapeHtml(o.productTitle)} — ${o.price} ${CURRENCY}</b></div>
      <div class="oline"><span>${t('orderLabelPhone')}</span><b>${escapeHtml(o.phone)}</b></div>
      <div class="oline"><span>${t('orderLabelBuyer')}</span><b>${o.buyerName || o.buyerEmail ? escapeHtml(o.buyerName || '') + (o.buyerEmail ? ' — ' + escapeHtml(o.buyerEmail) : '') : t('orderBuyerGuest')}</b></div>
      <div class="oline"><span>${t('orderLabelPayApp')}</span><b>${escapeHtml(o.appUsed || '—')}</b></div>
      <div class="oline"><span>${t('orderLabelRef')}</span><b>${escapeHtml(o.ref || '—')}</b></div>
      <div class="oline"><span>${t('orderLabelCode')}</span><b>${o.code}</b></div>
      <div class="oline"><span>${t('orderLabelStatus')}</span>
        <span class="order-status ${orderStatusClass(o.status)}">${orderStatusLabel(o.status)}</span>
      </div>
      <div class="order-actions">
        ${o.status==='pending' ? `
          <button class="buy-btn" onclick="approveOrder('${o.code}')">${t('orderApproveBtn')}</button>
          <button class="btn-ghost reject-btn" onclick="rejectOrderPrompt('${o.code}')">${t('orderRejectBtn')}</button>` : ''}
        ${o.status==='rejected' ? `<button class="btn-ghost reject-btn" onclick="deleteOrderPrompt('${o.code}')">${t('orderDeleteBtn')}</button>` : ''}
        ${o.orderType==='prompt' && o.status==='approved' && o.promptText ? `<button class="btn-ghost" onclick="sendPromptViaWhatsApp('${o.code}')">${t('sendPromptWhatsAppBtn')}</button>` : ''}
        ${o.status==='approved' ? (isOrderThanked(o)
          ? `<button class="btn-ghost thanked-btn" disabled>${t('thankCustomerDoneBtn')}</button>`
          : `<button class="btn-ghost" onclick="thankCustomerViaWhatsApp('${o.code}')">${t('thankCustomerBtn')}</button>`) : ''}
      </div>
    </div>`).join('');
}
/** Full order-ledger export (admin panel, Orders tab) — reuses the same
 * SheetJS instance already loaded for the performance report, so this adds
 * no extra dependency. Exports every order currently loaded client-side
 * (same `orders` array the list above already renders from). */
function exportOrdersExcel(){
  if(typeof XLSX === 'undefined'){ showToast(t('toastExcelLibFailed')); return; }
  if(!orders.length){ showToast(t('ordersEmptyNote')); return; }
  const header = [
    t('orderLabelCode'), t('orderLabelType'), t('orderLabelProduct'),
    t('dailyReportRevenue'), t('orderLabelStatus'), t('orderLabelPhone'),
    t('orderLabelBuyer'), t('orderLabelPayApp'), t('orderLabelRef'), t('dailyReportTitle') + ' — ' + t('statColTime')
  ];
  const sorted = [...orders].sort((a,b)=> b.createdAt - a.createdAt);
  const rows = sorted.map(o => [
    o.code,
    o.orderType==='prompt' ? t('orderTypePrompt') : t('orderTypeTransform'),
    o.productTitle,
    (Number(o.price)||0) + ' ' + CURRENCY,
    orderStatusLabel(o.status),
    o.phone || '',
    o.buyerName || o.buyerEmail || '',
    o.appUsed || '',
    o.ref || '',
    o.createdAt ? new Date(o.createdAt).toLocaleString() : ''
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{wch:10},{wch:12},{wch:26},{wch:12},{wch:12},{wch:14},{wch:22},{wch:12},{wch:14},{wch:18}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  const stamp = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `Miga-Photobook-Orders-${stamp}.xlsx`);
}
const exportOrdersBtnEl = document.getElementById('exportOrdersBtn');
if(exportOrdersBtnEl) exportOrdersBtnEl.onclick = exportOrdersExcel;

/** Compact recent-orders table shown when the stats bar is expanded — same
 * `orders` array already loaded for the full list below, just condensed to
 * the last 15 rows so the admin gets a live at-a-glance view without
 * scrolling past the full detailed list. */
function renderOrderStatsTable(){
  const tableEl = document.getElementById('orderStatsTable');
  if(!tableEl) return;
  const sorted = [...orders].sort((a,b)=> b.createdAt - a.createdAt).slice(0, 15);
  if(!sorted.length){
    tableEl.innerHTML = `<div class="empty-note">${t('ordersEmptyNote')}</div>`;
    return;
  }
  tableEl.innerHTML = `<table>
    <thead><tr>
      <th>${t('statColCode')}</th><th>${t('statColType')}</th><th>${t('statColProduct')}</th><th>${t('statColStatus')}</th><th>${t('statColBuyer')}</th><th>${t('statColTime')}</th>
    </tr></thead>
    <tbody>
      ${sorted.map(o=>`
        <tr>
          <td>${o.code}</td>
          <td>${o.orderType==='prompt' ? t('orderTypePrompt') : t('orderTypeTransform')}</td>
          <td>${escapeHtml(o.productTitle)}</td>
          <td><span class="order-status ${orderStatusClass(o.status)}">${orderStatusLabel(o.status)}</span></td>
          <td>${escapeHtml(o.buyerName || o.buyerEmail || '—')}</td>
          <td>${new Date(o.createdAt).toLocaleString(currentLang==='ar' ? 'ar-EG' : 'en-GB', {dateStyle:'short', timeStyle:'short'})}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

document.getElementById('orderStatsBar').addEventListener('click', function(){
  const isOpen = this.classList.toggle('open');
  this.setAttribute('aria-expanded', String(isOpen));
  document.getElementById('orderStatsTable').style.display = isOpen ? 'block' : 'none';
});

/** Confirms, then rejects a pending order — for invalid/fake transfer claims
 * (e.g. a made-up phone number, or the money never actually arriving). A
 * rejected order can never be approved afterwards, and never unlocks a
 * transform or a prompt. */
async function rejectOrderPrompt(code){
  if(!confirm(t('confirmRejectOrder'))) return;
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/reject`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, code })
    });
    if(!res.ok){ showToast(t('toastOrderFailed')); return; }
    await loadOrders();
    renderOrdersList();
    refreshAdminBellBadge();
    showToast(t('toastOrderRejected'));
  }catch(e){ showToast(t('toastOrderFailed')); }
}

/** Permanently removes an already-rejected order from the list, once the
 * admin is done with it — pure cleanup, never available on a pending or
 * approved order. */
async function deleteOrderPrompt(code){
  if(!confirm(t('confirmDeleteOrder'))) return;
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/delete`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, code })
    });
    if(!res.ok){ showToast(t('toastOrderFailed')); return; }
    await loadOrders();
    renderOrdersList();
    refreshAdminBellBadge();
    showToast(t('toastOrderDeleted'));
  }catch(e){ showToast(t('toastOrderFailed')); }
}

async function approveOrder(code){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/orders/approve`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, code })
    });
    if(!res.ok){ showToast(t('toastWrongPassword')); return; }
    await loadOrders();
    renderOrdersList();
    refreshAdminBellBadge();
    await loadProductPopularity();
    renderMostRequested();
    showToast(t('toastOrderApproved'));
  }catch(e){
    showToast(t('toastOrderFailed'));
  }
}

/** Opens WhatsApp (web or app) with the prompt text pre-filled, addressed to
 * the phone number the customer paid from — a one-click manual send for the
 * admin, since there's no WhatsApp Business API integration set up. Only
 * ever shown for prompt orders that are already approved, so the text being
 * sent is always exactly what the customer paid for and already has access
 * to via "تتبع طلبي" on their end too. */
/** Egyptian local numbers start with 0 (e.g. 010...) — WhatsApp links need
 * the international form (20...) with the leading zero dropped. */
function toWhatsAppNumber(phone){
  const digitsOnly = String(phone || '').replace(/\D/g, '');
  return digitsOnly.startsWith('0') ? '20' + digitsOnly.slice(1) : digitsOnly;
}

/** Opens WhatsApp on the customer's number with a thank-you already written,
 * so following up after delivery costs one tap instead of retyping the same
 * message for every order. Sending stays a deliberate human action. */
/** Whether this order has already had a thank-you sent. Read straight off the
 * order record, so the state is the same on every device the admin uses
 * instead of resetting each time a different browser opens the panel. */
function isOrderThanked(order){
  return !!(order && order.thankedAt);
}

function thankCustomerViaWhatsApp(code){
  const order = orders.find(o => o.code === code);
  if(!order) return;
  const message = t('whatsappThanksTemplate').replace('{title}', order.productTitle);
  window.open(`https://wa.me/${toWhatsAppNumber(order.phone)}?text=${encodeURIComponent(message)}`, '_blank');

  // Update the button immediately so it cannot be pressed twice while the
  // request is in flight, then persist. Marked as soon as WhatsApp opens: the
  // message has been composed and handed over, and the page has no way to
  // learn whether "send" was actually tapped.
  order.thankedAt = Date.now();
  renderOrdersList();

  if(!BACKEND_BASE) return;
  fetch(`${BACKEND_BASE}/orders/mark-thanked`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ code, token: adminSessionToken })
  }).catch(()=>{
    // Saving the note failed; the message itself was still handed to WhatsApp.
    // Say so plainly rather than leaving a tick that will vanish on reload.
    showToast(t('toastThankSaveFailed'));
  });
}

function sendPromptViaWhatsApp(code){
  const order = orders.find(o => o.code === code);
  if(!order || !order.promptText){ showToast(t('toastPromptNotReady')); return; }
  const digitsOnly = String(order.phone || '').replace(/\D/g, '');
  // Egyptian local numbers start with 0 (e.g. 010...) — WhatsApp links need
  // the international form (20...) with the leading 0 dropped.
  const intlPhone = digitsOnly.startsWith('0') ? '20' + digitsOnly.slice(1) : digitsOnly;
  const message = t('whatsappPromptMessageTemplate')
    .replace('{title}', order.productTitle)
    .replace('{prompt}', order.promptText);
  window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`, '_blank');
}
document.getElementById('adminModalClose').onclick = ()=>{
  adminModalBg.classList.remove('show');
  document.getElementById('adminFab').classList.remove('show');
  editingProductId = null;
  resetEditUI();
};

async function loadAdminProducts(){
  if(!BACKEND_BASE) return;
  try{
    const res = await fetch(`${BACKEND_BASE}/admin/products?token=${encodeURIComponent(adminSessionToken)}`);
    const data = await res.json();
    let parsed = null;
    if(data && data.value){
      try{ parsed = JSON.parse(data.value); }catch(e){ parsed = null; }
    }
    if(Array.isArray(parsed)) products = parsed;
  }catch(e){ console.error('load admin products failed', e); }
}

document.getElementById('adminLoginBtn').onclick = async ()=>{
  const val = document.getElementById('adminPass').value;
  const result = await adminLoginWithPassword(val);
  if(!result.ok){
    if(result.reason === 'rateLimited') showToast(t('toastAdminRateLimited'));
    else if(result.reason === 'serverError') showToast(t('toastAdminServerError'));
    else showToast(t('toastWrongPassword'));
  }
};

/** Fresh login only — the one moment the real admin password is ever sent.
 * The server verifies it and hands back a session token; that token (never
 * the password itself) is what gets stored and reused from here on, so a
 * compromised browser/device leaks a revocable token, not the master password.
 * Returns a small status object instead of a bare boolean so the caller can
 * tell "wrong password" apart from "too many attempts, try later" — showing
 * the same generic toast for both was exactly what made an earlier real
 * rate-limit lockout look identical to a typo, and cost a lot of time to
 * track down. */
async function adminLoginWithPassword(val){
  if(!BACKEND_BASE || !val) return { ok:false, reason:'network' };
  try{
    const res = await fetch(`${BACKEND_BASE}/admin/verify`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: val })
    });
    if(res.status === 429) return { ok:false, reason:'rateLimited' };
    // Any other non-2xx (500, 502, etc.) means the server itself failed
    // before it ever got to compare the password — most likely cause on
    // this backend is the daily KV write-operation cap. Surfacing this
    // distinctly instead of folding it into "wrong password" is exactly
    // what would have saved a lot of back-and-forth diagnosing this before.
    if(!res.ok) return { ok:false, reason:'serverError' };
    const data = await res.json();
    if(data.ok && data.token){
      await activateAdminSession(data.token, true);
      return { ok:true };
    }
    return { ok:false, reason:'wrongPassword' };
  }catch(e){
    return { ok:false, reason:'network' };
  }
}
/** Restores a previously-issued session token on page load (e.g. after a
 * refresh) by re-checking it with the server. Never touches the raw password.
 * If the token was revoked, rotated, or expired server-side, this correctly
 * logs the browser out instead of leaving a stale session. */
async function adminRestoreSession(token){
  if(!BACKEND_BASE || !token) return false;
  try{
    const res = await fetch(`${BACKEND_BASE}/admin/verify`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if(res.ok && data.ok){
      return await activateAdminSession(token, false);
    }
    try{ localStorage.removeItem('megaPromptAdminToken'); }catch(e){}
    return false;
  }catch(e){
    return false;
  }
}
/** Shared activation step for both a fresh login and a restored session. */
async function activateAdminSession(token, persist){
  adminSessionToken = token;
  adminLoggedIn = true;
  document.getElementById('adminLoginView').style.display = 'none';
  document.getElementById('adminFormView').style.display = 'block';
  // Pre-fills the add-product form's defaults (title, price, and the
  // watermark prompt) right away — without this, a fresh login shows an
  // empty prompt box until the first save, since that's the only other
  // place these defaults get applied.
  if(!editingProductId) resetProductFormToDefaults();
  await loadAdminProducts(); // full prompt text — only this authenticated session sees it
  applyChildrenVisibility();
  renderAdminProductsList();
  showAdminQuickAccess();
  if(persist){
    // Kept in localStorage so the admin stays logged in across page refreshes,
    // the same way a customer account does — but this is a revocable session
    // token, not the master password. Use "خروج" to revoke it from this device.
    try{ localStorage.setItem('megaPromptAdminToken', token); }catch(e){}
  }
  return true;
}
document.getElementById('adminLogoutBtn').onclick = async ()=>{
  const tokenToRevoke = adminSessionToken;
  adminLoggedIn = false;
  adminSessionToken = '';
  adminModalBg.classList.remove('show');
  editingProductId = null;
  resetEditUI();
  document.getElementById('adminFab').classList.remove('show');
  try{ localStorage.removeItem('megaPromptAdminToken'); }catch(e){}
  // Best-effort server-side revoke — the browser logs out locally either way,
  // but this also invalidates the token so it can't be reused if it ever leaked.
  if(BACKEND_BASE && tokenToRevoke){
    try{
      await fetch(`${BACKEND_BASE}/admin/logout`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token: tokenToRevoke })
      });
    }catch(e){}
  }
  await loadProducts(); // drop back to the prompt-free public list
  renderGrids();
  renderHeroStrip();
  applyChildrenVisibility();
  hideAdminQuickAccess();
};

/** Changes the admin password. Requires the current session token (proves
 * this browser is already logged in) plus the current password (proves the
 * person typing isn't just riding a leaked/stolen session token). The new
 * password is sent once over HTTPS and never stored client-side — same
 * trust model as the original login. */
document.getElementById('changeAdminPassBtn').onclick = async ()=>{
  const currentPassInput = document.getElementById('currentAdminPass');
  const newPassInput = document.getElementById('newAdminPass');
  const confirmPassInput = document.getElementById('confirmNewAdminPass');
  const currentPass = currentPassInput.value;
  const newPass = newPassInput.value;
  const confirmPass = confirmPassInput.value;

  if(!currentPass || !newPass || !confirmPass){ showToast(t('toastFillPassFields')); return; }
  if(newPass !== confirmPass){ showToast(t('toastPassMismatch')); return; }
  if(newPass.length < 8){ showToast(t('toastPassTooShort')); return; }
  if(!BACKEND_BASE || !adminSessionToken){ showToast(t('toastAdminServerError')); return; }

  try{
    const res = await fetch(`${BACKEND_BASE}/admin/change-password`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: adminSessionToken, currentPassword: currentPass, newPassword: newPass })
    });
    if(res.status === 429){ showToast(t('toastAdminRateLimited')); return; }
    if(res.status === 401){
      const data = await res.json().catch(()=>({}));
      // A 401 here means either the current password was wrong, or the
      // session itself expired — tell them apart so a stale-session case
      // doesn't get misread as "you typed your own current password wrong".
      if(data.error === 'Session expired, please log in again'){
        showToast(t('toastAdminServerError'));
      } else {
        showToast(t('toastCurrentPassWrong'));
      }
      return;
    }
    if(!res.ok){ showToast(t('toastAdminServerError')); return; }
    const data = await res.json();
    if(data.ok){
      showToast(t('toastPassChanged'));
      currentPassInput.value = '';
      newPassInput.value = '';
      confirmPassInput.value = '';
    } else {
      showToast(t('toastAdminServerError'));
    }
  }catch(e){
    showToast(t('toastAdminServerError'));
  }
};

const NEW_PRODUCT_DEFAULT_TITLE = 'Miga-photobook';
const NEW_PRODUCT_DEFAULT_PRICE = 25;
// Every new product's AI-transform prompt starts with this watermark
// instruction pre-filled — it's still a normal editable textarea, so the
// admin can add to it or delete it per product, but it no longer has to be
// re-typed from scratch every single time.
const NEW_PRODUCT_DEFAULT_PROMPT = 'Add  a custom luxury signature watermark logo at bottom-right: royal king crown with "Miga-photobook " in shield crest, metallic gold, elegant, minimal, premium, glowing edges, embossed texture, naturally blending.';

/** Puts the add-product form back to a clean state for the *next* product:
 * the suggested name and price are filled in ready to be typed over, rather
 * than leaving the admin with three empty boxes every single time. */
/** The link boxes only mean anything for a product that already exists, so
 * they are shown while editing one and hidden while a new one is being typed. */
function setProductLinkFields(p){
  const linkField = document.getElementById('pShareLinkField');
  const imgField = document.getElementById('pImageLinkField');
  if(!linkField || !imgField) return;
  if(!p){
    linkField.style.display = 'none';
    imgField.style.display = 'none';
    document.getElementById('pShareLink').value = '';
    document.getElementById('pImageLink').value = '';
    return;
  }
  linkField.style.display = '';
  document.getElementById('pShareLink').value = productShareLink(p.id);
  const hasImage = p.image && p.image !== PLACEHOLDER_IMG;
  imgField.style.display = hasImage ? '' : 'none';
  document.getElementById('pImageLink').value = hasImage ? p.image : '';
}

function resetProductFormToDefaults(){
  setProductLinkFields(null);
  document.getElementById('pTitle').value = NEW_PRODUCT_DEFAULT_TITLE;
  document.getElementById('pTitleEn').value = NEW_PRODUCT_DEFAULT_TITLE;
  document.getElementById('pPrice').value = NEW_PRODUCT_DEFAULT_PRICE;
  document.getElementById('pPrompt').value = NEW_PRODUCT_DEFAULT_PROMPT;
  document.getElementById('pImage').value = '';
  pendingCroppedBlob = null;
}

let editingProductId = null;
// The raw file input still exists (for the OS file picker), but its file is
// never uploaded directly — selecting one immediately opens the crop tool,
// and only the resulting fixed-size Blob is ever sent to the server.
let pendingCroppedBlob = null;
document.getElementById('pImage').addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file){ pendingCroppedBlob = null; return; }
  const blob = await openCropModal(file);
  if(!blob){
    e.target.value = ''; // cancelled — never silently fall back to the uncropped original
    pendingCroppedBlob = null;
    return;
  }
  pendingCroppedBlob = blob;
});

document.getElementById('pSaveBtn').onclick = async ()=>{
  const cat = document.getElementById('pCat').value;
  const title = document.getElementById('pTitle').value.trim();
  const titleEn = document.getElementById('pTitleEn').value.trim();
  const price = parseFloat(document.getElementById('pPrice').value || '0');
  const promptText = document.getElementById('pPrompt').value.trim();
  const fileInput = document.getElementById('pImage');

  if(!title || !promptText || !price){
    showToast(t('toastFillFields'));
    return;
  }

  const finish = async (imageUrl)=>{
    let productToSave;
    if(editingProductId){
      const existing = products.find(p=>p.id===editingProductId);
      if(!existing){
        // The product we thought we were editing is gone (deleted elsewhere) —
        // refuse to silently create a mismatched record; make the admin retry cleanly.
        editingProductId = null;
        resetEditUI();
        showToast(t('toastImageUploadFailed'));
        return;
      }
      existing.category = cat; existing.title = title; existing.titleEn = titleEn || undefined; existing.price = price; existing.prompt = promptText;
      if(imageUrl) existing.image = imageUrl;
      productToSave = existing;
      editingProductId = null;
      resetEditUI();
    }else{
      productToSave = {
        id: 'p_' + Date.now(),
        category: cat, title, titleEn: titleEn || undefined, price, image: imageUrl || PLACEHOLDER_IMG, prompt: promptText, order: Date.now()
      };
      products.push(productToSave);
    }
    // Only the one product being added/edited is sent — never the whole list —
    // so this can't silently clobber anything another admin session added.
    const ok = await upsertProductRemote(productToSave);
    if(!ok){ showToast(t('toastImageUploadFailed')); return; }
    renderGrids();
    renderHeroStrip();
    renderAdminProductsList();
    applyChildrenVisibility();
    resetProductFormToDefaults();
    showToast(t('toastProductAdded'));
  };

  // Images are uploaded to the Worker's R2-backed image host and referenced by
  // URL — never embedded as base64 in the product record. This keeps the
  // products payload (and this page) small and lets browsers cache photos
  // normally instead of re-downloading them as text on every /products fetch.
  // The Blob sent here always came out of the crop tool above, so every
  // uploaded product photo is the same fixed pixel size regardless of what
  // the original file looked like.
  if(pendingCroppedBlob){
    if(!BACKEND_BASE){ showToast(t('toastOrderFailed')); return; }
    const saveBtn = document.getElementById('pSaveBtn');
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = t('uploadingImage');
    saveBtn.disabled = true;
    try{
      const form = new FormData();
      form.append('image', pendingCroppedBlob, 'product.jpg');
      const res = await fetch(`${BACKEND_BASE}/admin/upload-image?token=${encodeURIComponent(adminSessionToken)}`, {
        method:'POST', body: form
      });
      const data = await res.json().catch(()=>null);
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
      if(!res.ok || !data || !data.url){
        // Show the server's actual reason (e.g. "Image too large", "Wrong password")
        // instead of a generic message that hides what really went wrong.
        showToast(data && data.error ? data.error : t('toastImageUploadFailed'));
        return;
      }
      await finish(data.url);
    }catch(e){
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
      showToast(t('toastImageUploadFailed'));
    }
  }else{
    finish(null);
  }
};

function resetEditUI(){
  document.getElementById('pSaveBtn').textContent = t('pSaveBtn');
  document.getElementById('pCancelEditBtn').style.display = 'none';
  document.getElementById('editingBanner').style.display = 'none';
}
document.getElementById('pCancelEditBtn').onclick = ()=>{
  editingProductId = null;
  resetEditUI();
  resetProductFormToDefaults();
};
document.getElementById('pCat').addEventListener('change', renderAdminProductsList);

function editProduct(id){
  const p = products.find(x=>x.id===id);
  if(!p) return;
  editingProductId = id;
  document.getElementById('pCat').value = p.category;
  document.getElementById('pTitle').value = p.title;
  document.getElementById('pTitleEn').value = p.titleEn || '';
  document.getElementById('pPrice').value = p.price;
  document.getElementById('pPrompt').value = p.prompt;
  document.getElementById('pImage').value = '';
  setProductLinkFields(p);
  pendingCroppedBlob = null;
  document.getElementById('pSaveBtn').textContent = t('pUpdateBtn');
  document.getElementById('pCancelEditBtn').style.display = '';
  document.getElementById('editingBanner').style.display = '';
  document.getElementById('pTitle').scrollIntoView({behavior:'smooth', block:'center'});
}

async function deleteProduct(id){
  if(!confirm(t('confirmDeleteProduct'))) return;
  const ok = await deleteProductRemote(id);
  if(!ok){ showToast(t('toastImageUploadFailed')); return; }
  products = products.filter(p=>p.id!==id);
  if(editingProductId===id){ editingProductId = null; resetEditUI(); }
  renderGrids();
  renderHeroStrip();
  renderAdminProductsList();
  applyChildrenVisibility();
  showToast(t('toastProductDeleted'));
}

// ---------- Product archive downloads (admin only) ----------
// Reuses the exact image URLs already shown in the storefront <img> tags —
// no new upload or storage involved. Requires the image host (R2) to answer
// with permissive CORS headers for fetch() to read the bytes; <img> tags
// don't need this, so if downloads fail with a console CORS error, that's
// the one thing to enable on the R2 bucket / Worker route, not a bug here.
async function fetchImageAsBlob(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error('fetch failed: ' + url);
  return await res.blob();
}
function sanitizeFilename(name){
  return String(name || 'product').replace(/[\\/:*?"<>|]/g, '_').trim() || 'product';
}
function extFromBlob(blob){
  const type = blob.type || '';
  if(type.includes('png')) return 'png';
  if(type.includes('webp')) return 'webp';
  if(type.includes('gif')) return 'gif';
  return 'jpg';
}
function uniqueZipName(usedNames, base, ext){
  let name = `${base}.${ext}`, n = 1;
  while(usedNames.has(name)) name = `${base} (${++n}).${ext}`;
  usedNames.add(name);
  return name;
}
function triggerBlobDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 4000);
}
async function downloadCategoryArchive(cat){
  if(typeof JSZip === 'undefined'){ showToast(t('toastArchiveFailed')); return; }
  const btn = document.getElementById('archiveBtn-' + cat);
  const items = products.filter(p => p.category === cat && p.image && p.image !== PLACEHOLDER_IMG);
  if(!items.length){ showToast(t('toastNoImageYet')); return; }
  const originalLabel = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; }
  try{
    const zip = new JSZip();
    const usedNames = new Set();
    for(let i = 0; i < items.length; i++){
      if(btn) btn.textContent = `⏳ ${i}/${items.length}`;
      try{
        const blob = await fetchImageAsBlob(items[i].image);
        const name = uniqueZipName(usedNames, sanitizeFilename(items[i].title), extFromBlob(blob));
        zip.file(name, blob);
      }catch(e){ console.error('archive: failed to fetch', items[i].title, e); }
    }
    const content = await zip.generateAsync({type:'blob'});
    triggerBlobDownload(content, `${sanitizeFilename(catLabel(cat))} - Miga-Photobook.zip`);
  }catch(e){
    showToast(t('toastArchiveFailed'));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = originalLabel || t('downloadArchiveBtn'); }
  }
}
async function downloadAllArchive(){
  if(typeof JSZip === 'undefined'){ showToast(t('toastArchiveFailed')); return; }
  const btn = document.getElementById('archiveAllBtn');
  const cats = ['children','male','female','business','cinematic','luxury','artistic','magazine'];
  const relevant = products.filter(p => p.image && p.image !== PLACEHOLDER_IMG);
  if(!relevant.length){ showToast(t('toastNoImageYet')); return; }
  const originalLabel = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; }
  try{
    const zip = new JSZip();
    let done = 0;
    for(const cat of cats){
      const items = products.filter(p => p.category === cat && p.image && p.image !== PLACEHOLDER_IMG);
      if(!items.length) continue;
      const folder = zip.folder(sanitizeFilename(catLabel(cat)));
      const usedNames = new Set();
      for(const p of items){
        if(btn) btn.textContent = `⏳ ${done}/${relevant.length}`;
        try{
          const blob = await fetchImageAsBlob(p.image);
          const name = uniqueZipName(usedNames, sanitizeFilename(p.title), extFromBlob(blob));
          folder.file(name, blob);
        }catch(e){ console.error('archive: failed to fetch', p.title, e); }
        done++;
      }
    }
    const content = await zip.generateAsync({type:'blob'});
    const stamp = new Date().toISOString().slice(0,10);
    triggerBlobDownload(content, `Miga-Photobook-Archive-${stamp}.zip`);
  }catch(e){
    showToast(t('toastArchiveFailed'));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = originalLabel || t('downloadAllArchiveBtn'); }
  }
}

// ---------- Performance report (admin only) — period-flexible: daily / weekly / custom ----------
function reportStatTile(num, label){
  return `<div class="order-stat"><span class="order-stat-num">${num}</span><span class="order-stat-label">${escapeHtml(label)}</span></div>`;
}
function findTimestamp(obj, fallbackFields){
  for(const f of fallbackFields){
    if(obj && obj[f] != null){
      const v = obj[f];
      const n = typeof v === 'number' ? v : Date.parse(v);
      if(!isNaN(n)) return n;
    }
  }
  return null;
}
let reportPeriod = 'daily'; // 'daily' | 'weekly' | 'custom'
let reportCustomFrom = null; // 'YYYY-MM-DD' from the date input
let reportCustomTo = null;   // 'YYYY-MM-DD' from the date input
let lastReportSnapshot = null; // stashed here so the export buttons don't need to re-fetch

function fmtShortDate(ms){
  const d = new Date(ms);
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0');
}
/** Resolves the currently selected period into a concrete {start,end} range
 * plus which bucket size the chart/table should use. */
function getReportRange(period){
  const now = Date.now();
  const dayMs = 24*60*60*1000;
  if(period === 'weekly'){
    return { start: now - 7*dayMs, end: now, bucket:'day', label: t('periodWeeklyBtn') };
  }
  if(period === 'custom'){
    const from = reportCustomFrom ? new Date(reportCustomFrom+'T00:00:00').getTime() : (now - dayMs);
    const to = reportCustomTo ? new Date(reportCustomTo+'T23:59:59').getTime() : now;
    const spanDays = Math.max(1, Math.round((to - from) / dayMs));
    return { start: from, end: to, bucket: spanDays > 60 ? 'week' : 'day', label: t('periodCustomBtn') };
  }
  // daily (default)
  return { start: now - dayMs, end: now, bucket:'hour', label: t('periodDailyBtn') };
}
function buildReportBuckets(range){
  const buckets = [];
  if(range.bucket === 'hour'){
    const hourMs = 60*60*1000;
    const n = Math.max(1, Math.ceil((range.end - range.start) / hourMs));
    for(let i=0;i<n;i++){
      const bStart = range.start + i*hourMs;
      buckets.push({ start:bStart, end:bStart+hourMs, label: new Date(bStart).getHours()+':00' });
    }
  } else if(range.bucket === 'week'){
    const weekMs = 7*24*60*60*1000;
    const n = Math.max(1, Math.ceil((range.end - range.start) / weekMs));
    for(let i=0;i<n;i++){
      const bStart = range.start + i*weekMs;
      const bEnd = Math.min(bStart+weekMs, range.end);
      buckets.push({ start:bStart, end:bEnd, label: fmtShortDate(bStart)+'–'+fmtShortDate(bEnd) });
    }
  } else { // day
    const dayMs = 24*60*60*1000;
    const n = Math.max(1, Math.ceil((range.end - range.start) / dayMs));
    for(let i=0;i<n;i++){
      const bStart = range.start + i*dayMs;
      buckets.push({ start:bStart, end:Math.min(bStart+dayMs, range.end), label: fmtShortDate(bStart) });
    }
  }
  return buckets;
}
function orderTotals(arr){
  const approved = arr.filter(o => o.status === 'approved');
  return {
    total: arr.length,
    approved: approved.length,
    pending: arr.filter(o => o.status === 'pending').length,
    rejected: arr.filter(o => o.status === 'rejected').length,
    revenue: approved.reduce((sum,o) => sum + (Number(o.price) || 0), 0),
  };
}
function aggregateOrdersByBucket(ordersArr, buckets){
  return buckets.map(b => {
    const inBucket = ordersArr.filter(o => (o.createdAt||0) >= b.start && (o.createdAt||0) < b.end);
    const t = orderTotals(inBucket);
    return { label: b.label, total:t.total, approved:t.approved, pending:t.pending, rejected:t.rejected, revenue:t.revenue };
  });
}
/** Draws a simple themed bar chart (revenue per bucket) with no external
 * dependency — canvas is already used elsewhere in this file (crop tool),
 * so this stays consistent and 100% works on mobile Safari too. */
function drawReportChart(canvas, buckets){
  const cssW = canvas.clientWidth || 300, cssH = 170;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW*dpr; canvas.height = cssH*dpr;
  canvas.style.height = cssH+'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);
  const styles = getComputedStyle(document.documentElement);
  const brass = (styles.getPropertyValue('--brass')||'#ffc94d').trim();
  const dim = (styles.getPropertyValue('--paper-dim')||'#999').trim();
  const line = (styles.getPropertyValue('--line')||'rgba(255,255,255,.15)').trim();
  const padL=36, padB=20, padT=10, padR=6;
  const chartW = Math.max(10, cssW - padL - padR);
  const chartH = Math.max(10, cssH - padT - padB);
  const max = Math.max(1, ...buckets.map(b => b.revenue));
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, cssH-padB+0.5); ctx.lineTo(cssW-padR, cssH-padB+0.5); ctx.stroke();
  ctx.fillStyle = dim; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(String(Math.round(max)), padL-6, padT+8);
  const n = buckets.length || 1;
  const barGap = 4;
  const barW = Math.max(2, (chartW / n) - barGap);
  const labelEvery = n <= 12 ? 1 : Math.ceil(n/12);
  buckets.forEach((b,i) => {
    const h = max>0 ? (b.revenue/max)*chartH : 0;
    const x = padL + i*(chartW/n) + barGap/2;
    const y = cssH - padB - h;
    ctx.fillStyle = brass;
    ctx.fillRect(x, y, barW, h);
    if(i % labelEvery === 0){
      ctx.fillStyle = dim; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(b.label, x + barW/2, cssH-6);
    }
  });
}
/** Builds a short Arabic narrative — positives/negatives + a couple of
 * concrete, heuristic next-step suggestions. Kept simple and honest: no
 * invented numbers, just plain comparisons against the previous equal-length
 * period (which is already available client-side, no extra network call). */
function buildReportNarrative(cur, prev, reviewsByStatus){
  const lines = [];
  const pct = (a,b) => b>0 ? Math.round(((a-b)/b)*100) : (a>0 ? 100 : 0);
  const revChange = pct(cur.revenue, prev.revenue);
  if(cur.total === 0){
    lines.push(currentLang==='en' ? '❕ No orders in this period — worth checking your ad spend or posting times.' : '❕ مفيش طلبات في الفترة دي — يستاهل تراجع الإعلانات أو مواعيد النشر.');
  } else if(revChange > 5){
    lines.push((currentLang==='en' ? `📈 Revenue is up ${revChange}% vs. the previous period — good momentum.` : `📈 الإيرادات زادت ${revChange}% عن الفترة اللي قبلها — أداء كويس.`));
  } else if(revChange < -5){
    lines.push((currentLang==='en' ? `📉 Revenue is down ${Math.abs(revChange)}% vs. the previous period.` : `📉 الإيرادات قلّت ${Math.abs(revChange)}% عن الفترة اللي قبلها.`));
  } else {
    lines.push(currentLang==='en' ? '➖ Revenue is roughly flat vs. the previous period.' : '➖ الإيرادات مستقرة تقريبًا عن الفترة اللي قبلها.');
  }
  const rejectRate = cur.total>0 ? Math.round((cur.rejected/cur.total)*100) : 0;
  if(cur.total >= 5 && rejectRate >= 20){
    lines.push(currentLang==='en' ? `⚠️ ${rejectRate}% of orders were rejected — worth checking the most common rejection reason and whether the payment steps are clear.` : `⚠️ ${rejectRate}% من الطلبات مرفوضة — يستاهل تتأكد من سبب الرفض الشائع ووضوح خطوات الدفع.`);
  }
  if(reviewsByStatus.pending >= 5){
    lines.push(currentLang==='en' ? `🔔 ${reviewsByStatus.pending} reviews are waiting for moderation — approving them adds real social proof to the site.` : `🔔 عندك ${reviewsByStatus.pending} تقييم قيد المراجعة — موافقتك عليهم بتظهرهم كتقييمات حقيقية على الموقع.`);
  }
  if(cur.total > 0 && (cur.pending/cur.total) > 0.3){
    lines.push(currentLang==='en' ? '💡 A large share of orders are still pending review — reviewing transfers faster reduces drop-off.' : '💡 نسبة كبيرة من الطلبات لسه قيد المراجعة — مراجعة التحويلات بسرعة أكبر بتقلل فقدان العملاء.');
  }
  return lines;
}
async function renderPerformanceReport(){
  const body = document.getElementById('dailyReportBody');
  const subtitle = document.getElementById('dailyReportSubtitle');
  body.innerHTML = `<div class="empty-note">${t('dailyReportLoading')}</div>`;

  const range = getReportRange(reportPeriod);
  const prevSpan = range.end - range.start;
  const prevRange = { start: range.start - prevSpan, end: range.start };
  subtitle.textContent = `${range.label} · ${fmtShortDate(range.start)} → ${fmtShortDate(range.end)}`;

  await loadOrders();
  const curOrders = orders.filter(o => (o.createdAt||0) >= range.start && (o.createdAt||0) < range.end);
  const prevOrders = orders.filter(o => (o.createdAt||0) >= prevRange.start && (o.createdAt||0) < prevRange.end);
  const curTotals = orderTotals(curOrders);
  const prevTotals = orderTotals(prevOrders);
  const buckets = aggregateOrdersByBucket(curOrders, buildReportBuckets(range));

  // Reviews — same defensive timestamp-detection as before, just applied to
  // the selected range instead of a fixed 24h window.
  let reviewsByStatus = { pending: 0, approved: 0 };
  let reviewsScopeNote = '';
  try{
    const [pendingRes, approvedRes] = await Promise.all([
      fetch(`${BACKEND_BASE}/reviews/pending?token=${encodeURIComponent(adminSessionToken)}`),
      fetch(`${BACKEND_BASE}/reviews/list`)
    ]);
    const pendingData = await pendingRes.json().catch(()=>({reviews:[]}));
    const approvedData = await approvedRes.json().catch(()=>({reviews:[]}));
    const allPending = pendingData.reviews || [];
    const allApproved = approvedData.reviews || [];
    const tsFields = ['createdAt','created_at','submittedAt','submitted_at','timestamp'];
    const anyTimestamped = [...allPending, ...allApproved].some(r => findTimestamp(r, tsFields) != null);
    if(anyTimestamped){
      reviewsByStatus.pending = allPending.filter(r => { const ts = findTimestamp(r, tsFields); return ts!=null && ts>=range.start && ts<range.end; }).length;
      reviewsByStatus.approved = allApproved.filter(r => { const ts = findTimestamp(r, tsFields); return ts!=null && ts>=range.start && ts<range.end; }).length;
    }else{
      reviewsByStatus.pending = allPending.length;
      reviewsByStatus.approved = allApproved.length;
      reviewsScopeNote = t('dailyReportAllTimeSuffix');
    }
  }catch(e){ /* leave counts at 0 if the reviews endpoints fail */ }

  // Visitors — the Worker only exposes a same-day "today" count right now.
  // For non-daily periods we honestly label this as an all-time total rather
  // than fabricate a range figure the backend doesn't actually compute yet.
  let visitorsLabel = '—';
  try{
    const res = await fetch(`${BACKEND_BASE}/visits/stats?token=${encodeURIComponent(adminSessionToken)}`);
    const data = await res.json();
    visitorsLabel = reportPeriod === 'daily'
      ? `${data.today ?? 0}`
      : `${data.total ?? 0} (${t('visitorsAllTimeNote')})`;
  }catch(e){}

  const narrative = buildReportNarrative(curTotals, prevTotals, reviewsByStatus);
  const revPct = prevTotals.revenue>0 ? Math.round(((curTotals.revenue-prevTotals.revenue)/prevTotals.revenue)*100) : (curTotals.revenue>0?100:0);
  const cmpCls = revPct >= 0 ? 'report-up' : 'report-down';
  const cmpSign = revPct > 0 ? '+' : '';

  body.innerHTML = `
    <div class="report-compare-note"><span class="${cmpCls}">${cmpSign}${revPct}%</span> ${t('reportVsPrevious')}</div>
    <div>
      <h4 class="report-h4">${t('dailyReportOrdersTitle')}</h4>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        ${reportStatTile(curTotals.total, t('dailyReportTotal'))}
        ${reportStatTile(curTotals.pending, t('orderStatusPending'))}
        ${reportStatTile(curTotals.approved, t('orderStatusApproved'))}
        ${reportStatTile(curTotals.rejected, t('orderStatusRejected'))}
        ${reportStatTile(curTotals.revenue + ' ' + CURRENCY, t('dailyReportRevenue'))}
      </div>
    </div>
    <div>
      <h4 class="report-h4">${t('reportChartTitle')}</h4>
      <div class="report-chart-wrap"><canvas id="reportChartCanvas"></canvas></div>
    </div>
    <div>
      <h4 class="report-h4">${t('dailyReportReviewsTitle')} ${reviewsScopeNote ? `<span class="report-scope-note">(${reviewsScopeNote})</span>` : ''}</h4>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        ${reportStatTile(reviewsByStatus.pending, t('reviewStatPendingLabel'))}
        ${reportStatTile(reviewsByStatus.approved, t('reviewStatApprovedLabel'))}
      </div>
    </div>
    <div>
      <h4 class="report-h4">${t('dailyReportVisitorsTitle')}</h4>
      <div style="display:flex; gap:18px; flex-wrap:wrap;">
        ${reportStatTile(visitorsLabel, t('visitorsTodayLabel'))}
      </div>
    </div>
    <div class="report-narrative">
      <h4 class="report-h4">${t('reportNarrativeTitle')}</h4>
      ${narrative.map(l => `<p>${escapeHtml(l)}</p>`).join('')}
    </div>`;

  requestAnimationFrame(() => {
    const canvas = document.getElementById('reportChartCanvas');
    if(canvas) drawReportChart(canvas, buckets);
  });

  lastReportSnapshot = { range, buckets, totals: curTotals, prevTotals, reviews: reviewsByStatus, visitorsLabel, narrative };
}
async function openDailyReport(){
  const modal = document.getElementById('dailyReportModalBg');
  modal.classList.add('show');
  await renderPerformanceReport();
}
/** Exports the current report snapshot as a real, organized .xlsx workbook
 * (Summary sheet + a per-bucket breakdown sheet) via SheetJS. Degrades
 * gracefully with a toast — never a silent failure or a broken button —
 * if the CDN script hasn't finished loading yet. */
function exportReportExcel(){
  if(typeof XLSX === 'undefined'){ showToast(t('toastExcelLibFailed')); return; }
  if(!lastReportSnapshot) return;
  const { range, buckets, totals, reviews, visitorsLabel, narrative } = lastReportSnapshot;

  const summaryRows = [
    ['Miga-Photobook — ' + t('dailyReportTitle')],
    [t('reportChartTitle'), range.label],
    ['From / من', new Date(range.start).toLocaleString()],
    ['To / إلى', new Date(range.end).toLocaleString()],
    [],
    [t('dailyReportTotal'), totals.total],
    [t('orderStatusApproved'), totals.approved],
    [t('orderStatusPending'), totals.pending],
    [t('orderStatusRejected'), totals.rejected],
    [t('dailyReportRevenue'), totals.revenue + ' ' + CURRENCY],
    [],
    [t('reviewStatPendingLabel'), reviews.pending],
    [t('reviewStatApprovedLabel'), reviews.approved],
    [],
    [t('dailyReportVisitorsTitle'), visitorsLabel],
    [],
    [t('reportNarrativeTitle')],
    ...narrative.map(l => [l]),
  ];
  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{wch:30},{wch:38}];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  const detailHeader = [t('reportChartTitle'), t('dailyReportTotal'), t('orderStatusApproved'), t('orderStatusPending'), t('orderStatusRejected'), t('dailyReportRevenue')];
  const detailRows = buckets.map(b => [b.label, b.total, b.approved, b.pending, b.rejected, b.revenue]);
  const wsDetail = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
  wsDetail['!cols'] = [{wch:14},{wch:10},{wch:12},{wch:12},{wch:10},{wch:12}];
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Breakdown');

  const stamp = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `Miga-Photobook-Report-${range.label}-${stamp}.xlsx`);
}
function downloadReportChartImage(){
  const canvas = document.getElementById('reportChartCanvas');
  if(!canvas || !lastReportSnapshot) return;
  canvas.toBlob(blob => {
    if(!blob) return;
    const stamp = new Date().toISOString().slice(0,10);
    triggerBlobDownload(blob, `Miga-Photobook-Chart-${lastReportSnapshot.range.label}-${stamp}.png`);
  }, 'image/png');
}
document.querySelectorAll('.report-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.report-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    reportPeriod = btn.dataset.period;
    const customRow = document.getElementById('reportCustomRange');
    if(customRow) customRow.style.display = reportPeriod === 'custom' ? 'flex' : 'none';
    if(reportPeriod !== 'custom') renderPerformanceReport();
  });
});
const reportApplyRangeBtn = document.getElementById('reportApplyRangeBtn');
if(reportApplyRangeBtn) reportApplyRangeBtn.addEventListener('click', () => {
  reportCustomFrom = document.getElementById('reportFromDate').value;
  reportCustomTo = document.getElementById('reportToDate').value;
  if(!reportCustomFrom || !reportCustomTo){ showToast(t('periodCustomMissing')); return; }
  renderPerformanceReport();
});
document.getElementById('dailyReportDownloadBtn').onclick = exportReportExcel;
const reportDownloadChartBtn = document.getElementById('reportDownloadChartBtn');
if(reportDownloadChartBtn) reportDownloadChartBtn.onclick = downloadReportChartImage;
document.getElementById('dailyReportModalClose').onclick = ()=> document.getElementById('dailyReportModalBg').classList.remove('show');
document.getElementById('dailyReportCloseBtn').onclick = ()=> document.getElementById('dailyReportModalBg').classList.remove('show');

function renderAdminProductsList(){
  const el = document.getElementById('adminProductsList');
  if(!el) return;
  const allCats = ['children','male','female','business','cinematic','luxury','artistic','magazine'];
  const selectedCat = document.getElementById('pCat')?.value;
  const cats = allCats.includes(selectedCat) ? [selectedCat] : allCats;
  let html = '';
  cats.forEach(cat=>{
    const items = products.filter(p=>p.category===cat).sort((a,b)=>(b.order??9999)-(a.order??9999));
    if(!items.length) return;
    html += `<div class="admin-cat-group"><h4>${catLabel(cat)}</h4>`;
    items.forEach((p, idx)=>{
      html += `
      <div class="admin-product-row">
        <img src="${p.image}" alt="">
        <div class="admin-product-info">
          <b>${escapeHtml(p.title)}</b>
          <span>${p.price} ${CURRENCY}</span>
          <select class="admin-move-cat" onchange="moveProductCategory('${p.id}', this.value)" title="${t('moveCategoryTitle')}">
            ${allCats.map(c => `<option value="${c}" ${c===p.category?'selected':''}>${catLabel(c)}</option>`).join('')}
          </select>
        </div>
        <span class="popularity-badge" title="${t('popularityCountTitle')}">🔥 ${productPopularity[p.id] || 0}</span>
        <div class="admin-product-actions">
          <button onclick="moveProductOrder('${p.id}', -1)" ${idx===0?'disabled':''} title="${t('moveUpTitle')}">▲</button>
          <button onclick="moveProductOrder('${p.id}', 1)" ${idx===items.length-1?'disabled':''} title="${t('moveDownTitle')}">▼</button>
          <button onclick="setCategoryCover('${p.id}')" title="${t('setCoverTitle')}">${p.isCover ? '⭐' : '☆'}</button>
          <button onclick="copyProductLink('${p.id}')" title="${t('copyLinkTitle')}">🔗</button>
          <button onclick="copyProductImageUrl('${p.id}')" title="${t('copyImageLinkTitle')}">📷</button>
          <button onclick="editProduct('${p.id}')" title="تعديل">✏️</button>
          <button onclick="triggerReplaceImage('${p.id}')" title="${t('replaceImageTitle')}">🖼️</button>
          <button onclick="removeProductImage('${p.id}')" title="${t('removeImageTitle')}">🚫</button>
          <button onclick="deleteProduct('${p.id}')" title="حذف">🗑️</button>
        </div>
      </div>`;
    });
    html += `</div>
    <div style="display:flex; justify-content:flex-end; margin:6px 0 18px;">
      <button type="button" class="btn-ghost" id="archiveBtn-${cat}" onclick="downloadCategoryArchive('${cat}')" data-i18n="downloadArchiveBtn">⬇️ تحميل أرشيف القسم</button>
    </div>`;
  });
  el.innerHTML = html || `<div class="empty-note">${t('emptyNoteCategory')}</div>`;
}

async function moveProductOrder(id, direction){
  const p = products.find(x=>x.id===id);
  if(!p) return;
  const siblings = products.filter(x=>x.category===p.category).sort((a,b)=>(b.order??9999)-(a.order??9999));
  const idx = siblings.findIndex(x=>x.id===id);
  const swapIdx = idx + direction;
  if(swapIdx < 0 || swapIdx >= siblings.length) return;
  const other = siblings[swapIdx];
  if(p.order == null) p.order = idx;
  if(other.order == null) other.order = swapIdx;
  const tmp = p.order; p.order = other.order; other.order = tmp;
  const ok1 = await upsertProductRemote(p);
  const ok2 = await upsertProductRemote(other);
  if(!ok1 || !ok2){ showToast(t('toastImageUploadFailed')); return; }
  renderGrids(); renderHeroStrip(); renderAdminProductsList();
}

// ---------- Admin: quick image replace / remove / move category (no full edit form needed) ----------
let quickImageTargetId = null;
document.getElementById('adminQuickImageInput').addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  const id = quickImageTargetId;
  e.target.value = '';
  if(!file || !id || !BACKEND_BASE) return;
  const p = products.find(x=>x.id===id);
  if(!p) return;
  const blob = await openCropModal(file);
  if(!blob) return; // cancelled
  showToast(t('uploadingImage'));
  try{
    const form = new FormData();
    form.append('image', blob, 'product.jpg');
    const res = await fetch(`${BACKEND_BASE}/admin/upload-image?token=${encodeURIComponent(adminSessionToken)}`, {
      method:'POST', body: form
    });
    const data = await res.json().catch(()=>null);
    if(!res.ok || !data || !data.url){
      showToast(data && data.error ? data.error : t('toastImageUploadFailed'));
      return;
    }
    p.image = data.url;
    const ok = await upsertProductRemote(p);
    if(!ok){ showToast(t('toastImageUploadFailed')); return; }
    renderGrids(); renderHeroStrip(); renderAdminProductsList();
    showToast(t('toastImageReplaced'));
  }catch(e){
    showToast(t('toastImageUploadFailed'));
  }
});
function triggerReplaceImage(id){
  quickImageTargetId = id;
  document.getElementById('adminQuickImageInput').click();
}
async function removeProductImage(id){
  const p = products.find(x=>x.id===id);
  if(!p) return;
  if(!confirm(t('confirmRemoveImage'))) return;
  p.image = PLACEHOLDER_IMG;
  const ok = await upsertProductRemote(p);
  if(!ok){ showToast(t('toastImageUploadFailed')); return; }
  renderGrids(); renderHeroStrip(); renderAdminProductsList();
  showToast(t('toastImageRemoved'));
}
async function moveProductCategory(id, newCat){
  const p = products.find(x=>x.id===id);
  if(!p || p.category===newCat) return;
  const prevCat = p.category;
  p.category = newCat;
  const ok = await upsertProductRemote(p);
  if(!ok){ p.category = prevCat; renderAdminProductsList(); showToast(t('toastImageUploadFailed')); return; }
  renderGrids(); renderHeroStrip(); renderAdminProductsList();
  showToast(t('toastCategoryMoved'));
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 3800);
}

// ---------- Init ----------
(async function init(){
  logVisitOnce();
  const prefs = await loadUiPrefs();
  await loadProducts();
  renderWatermarkBackground();
  await loadPurchases();
  await loadOrders();
  await loadProductPopularity();

  // Persistent admin session: if this browser logged in before, silently
  // re-verify and restore it — same behavior as a saved customer login,
  // instead of asking for the password again on every refresh.
  try{
    const savedAdminToken = localStorage.getItem('megaPromptAdminToken');
    if(savedAdminToken) await adminRestoreSession(savedAdminToken);
  }catch(e){}

  applyTheme(prefs?.theme || 'dark');
  applyLanguage(prefs?.lang || 'ar');
  applyViewMode(prefs?.view || 'desktop');
  await checkLoggedInUser();
  await renderTestimonials();
  checkBiometricAvailability();

  if(LAUNCH_PROMO){
    document.getElementById('pricing').style.display = 'none';
    document.getElementById('heroCta2Link').style.display = 'none';
  }else{
    document.getElementById('softLaunchBanner').style.display = 'none';
  }
  applyChildrenVisibility();
  setInterval(updateCountdown, 60000);

  // Secret admin entry point: visit index.html#mega-admin-9k2x to open the admin login.
  // The button itself stays hidden from customers (see adminOpenBtn above).
  if(window.location.hash === '#mega-admin-9k2x'){
    adminModalBg.classList.add('show');
  }
  openProductFromHash();
  armStayNudge();
})();
