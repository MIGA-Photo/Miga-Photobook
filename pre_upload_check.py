#!/usr/bin/env python3
"""
فحص سريع قبل أي رفع يدوي على GitHub Pages — ميجا فوتوبوك
==========================================================
بيصطاد بالظبط الغلطتين اللي كسروا الموقع فعليًا في ١٦ سبتمبر ٢٠٢٦:

  1) نسيان تحديث رقم "?v=" (cache-buster) في index.html/en/index.html/
     admin-9k2x.html بعد ما app.js أو styles.css اتغيّروا — ده بيخلي
     المتصفح وCloudflare يفضلوا يقدّموا النسخة القديمة، فالزائر يحس إن
     "كل حاجة باظت" رغم إن الكود الجديد فعلاً مرفوع.

  2) رفع ملف غلط في مكان index.html (زي ما حصل لما صفحة "مكتبة" اتحطت
     مكان الصفحة الرئيسية بالغلط) — بيتأكد إن الملف لسه فيه العناصر
     الأساسية للصفحة الرئيسية الحقيقية.

الاستخدام
---------
  python3 pre_upload_check.py /path/to/folder-full-of-files-about-to-upload

- المرة الأولى بيسجّل "بصمة" app.js/styles.css الحاليين في ملف
  .upload_check_state.json جنب السكريبت، وبيطلع تحذير لطيف بس.
- من المرة اللي بعدها: لو app.js أو styles.css اتغيّروا عن آخر مرة
  ومفيش تحديث لرقم ?v= في كل ملفات HTML الموجودة في نفس الفولدر،
  بيوقف برسالة FAIL واضحة بالعربي.
- ملوش أي اتصال بالإنترنت ولا يحتاج تنصيب حاجة — بايثون عادي بس.

شغّله دايمًا قبل ما ترفع أي ملفات على GitHub، من نفس الفولدر اللي فيه
الملفات الجاهزة للرفع.
"""
import sys, os, re, json, hashlib

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".upload_check_state.json")

HTML_FILES = ["index.html", "en/index.html", "admin-9k2x.html"]
ASSET_FILES = ["app.js", "styles.css"]

# علامات لازم تكون موجودة في الصفحة الرئيسية الحقيقية (لو اختفت = فيه
# احتمال كبير إن الملف ده مش index.html الصح)
REQUIRED_HOME_MARKERS = [
    "hero-with-slider",
    "catNav",
    "footerAbout",
]
MIN_HOME_SIZE_BYTES = 100_000  # الصفحة الحقيقية أكبر من ١٠٠ كيلوبايت بكتير


def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def find_version_tags(html_text, asset_name):
    # يلقط ?v=xxxx بعد اسم الملف (app.js أو styles.css)
    pattern = re.compile(re.escape(asset_name) + r"\?v=([A-Za-z0-9_.-]+)")
    return pattern.findall(html_text)


def main():
    if len(sys.argv) != 2:
        print("الاستخدام: python3 pre_upload_check.py /path/to/folder")
        sys.exit(2)

    folder = sys.argv[1]
    if not os.path.isdir(folder):
        print(f"❌ الفولدر مش موجود: {folder}")
        sys.exit(2)

    failures = []
    warnings = []
    state = load_state()

    # موجودين فعلاً في الفولدر ده؟
    present_html = [f for f in HTML_FILES if os.path.exists(os.path.join(folder, f))]
    present_assets = [f for f in ASSET_FILES if os.path.exists(os.path.join(folder, f))]

    # ---------- الفحص ١: تغيّر app.js/styles.css بدون تحديث ?v= ----------
    # اجمع أرقام ?v= الحالية في كل ملفات الـHTML الموجودة، لكل أصل (asset) على حدة
    per_asset_versions = {}
    per_file_versions = {}
    for html in present_html:
        with open(os.path.join(folder, html), "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
        per_file_versions[html] = {}
        for asset in present_assets:
            found = set(find_version_tags(text, asset))
            per_file_versions[html][asset] = found
            per_asset_versions.setdefault(asset, set()).update(found)

    changed_assets = []
    for asset in present_assets:
        path = os.path.join(folder, asset)
        new_hash = sha256_of(path)
        prev = state.get(asset, {})
        old_hash = prev.get("hash")
        old_versions = set(prev.get("versions", []))
        new_versions = per_asset_versions.get(asset, set())

        if old_hash and old_hash != new_hash:
            changed_assets.append(asset)
            if new_versions and old_versions and new_versions == old_versions:
                failures.append(
                    f"🔴 FAIL — {asset} اتغيّر (المحتوى مختلف عن آخر مرة) لكن رقم ?v= لسه "
                    f"{sorted(new_versions)} زي قبل كده بالظبط.\n"
                    "   لازم تزوّد رقم ?v= (مثلاً v=20260917a) في كل ملفات الـHTML اللي بتحمّله:\n"
                    "   " + ", ".join(present_html) + "\n"
                    "   وإلا المتصفح/Cloudflare هيفضلوا يقدّموا النسخة القديمة زي ما حصل فعلاً يوم ١٦ سبتمبر."
                )
            elif not new_versions and present_html:
                warnings.append(f"⚠️  {asset} اتغيّر بس مالقتش أي ?v= بيشاور عليه في ملفات الـHTML — تأكد إنه بيتحمّل صح.")

        # سجّل الحالة الحالية دايمًا عشان يبقى فيه أساس للمقارنة في المرة الجاية
        state[asset] = {"hash": new_hash, "versions": sorted(new_versions)}

    if not present_html and changed_assets:
        warnings.append(
            "⚠️  " + " و ".join(changed_assets) + " اتغيّروا لكن مفيش ملفات HTML في نفس الرفعة عشان أتأكد من رقم ?v= — "
            "تأكد إنك هترفع ملفات الـHTML المحدَّثة معاهم في نفس الدفعة."
        )

    # تطابق رقم ?v= بين كل ملفات الـHTML المرفوعة مع بعضهم (لكل أصل موجود)
    if len(present_html) > 1:
        for asset in present_assets:
            versions_by_file = {h: per_file_versions[h].get(asset, set()) for h in present_html}
            distinct = {frozenset(v) for v in versions_by_file.values()}
            if len(distinct) > 1:
                mismatch_lines = [f"     {h}: {sorted(v) if v else 'مفيش'}" for h, v in versions_by_file.items()]
                failures.append(
                    f"🔴 FAIL — رقم ?v= بتاع {asset} مش متطابق بين ملفات الـHTML المرفوعة:\n" +
                    "\n".join(mismatch_lines) +
                    "\n   الملفات دي لازم يكون عندهم نفس الرقم بالظبط."
                )

    # ---------- الفحص ٢: index.html مش استُبدل بملف غلط ----------
    for html in ["index.html", "en/index.html"]:
        path = os.path.join(folder, html)
        if not os.path.exists(path):
            continue
        size = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
        missing_markers = [m for m in REQUIRED_HOME_MARKERS if m not in text]
        if size < MIN_HOME_SIZE_BYTES or missing_markers:
            failures.append(
                f"🔴 FAIL — {html} بيبان إنه مش الصفحة الرئيسية الحقيقية!\n"
                f"   الحجم: {size:,} بايت (المتوقع أكبر من {MIN_HOME_SIZE_BYTES:,})\n"
                f"   عناصر ناقصة: {missing_markers if missing_markers else 'ولا حاجة، الحجم بس صغير'}\n"
                "   ده بالظبط اللي حصل يوم ١٦ سبتمبر لما صفحة 'مكتبة' اتحطت غلط مكان الرئيسية.\n"
                "   افتح الملف وتأكد إنه فعلاً الصفحة الرئيسية قبل ما ترفعه."
            )

    save_state(state)

    print("=" * 60)
    if failures:
        for f in failures:
            print(f)
            print()
        print(f"النتيجة: ❌ {len(failures)} مشكلة لازم تتصلح قبل الرفع.")
        sys.exit(1)
    else:
        if warnings:
            for w in warnings:
                print(w)
            print()
        print("النتيجة: ✅ الفحصين عدّوا. تقدر ترفع.")
        sys.exit(0)


if __name__ == "__main__":
    main()
