#!/usr/bin/env python3
"""
مزامنة رقم "?v=" تلقائيًا لـ app.js و styles.css — ميجا فوتوبوك
================================================================
بدل ما تفتكر تزوّد رقم ?v= بإيدك كل مرة (وده اللي اتنسي فعليًا يوم ١٦
سبتمبر ٢٠٢٦ وكسر الموقع)، السكريبت ده بيحسب الرقم من محتوى الملف نفسه
(sha256، أول ٨ حروف) وبيكتبه في كل ملفات الـHTML اللي بتحمّل الملف ده —
تلقائيًا، من غير ما تفتكر حاجة.

ليه ده أضمن من رقم بتكتبه بإيدك:
- لو الملف اتغيّر فعلًا → الرقم لازم يتغيّر (لأنه محسوب من المحتوى نفسه).
- لو الملف ما اتغيّرش → الرقم مايتغيّرش (مفيش cache-bust من غير داعي).
- مستحيل "تنسى" تزوّده — هو مش حاجة بتتكتب بإيد، هو نتيجة حساب.

الاستخدام
---------
  python3 sync_asset_versions.py /path/to/folder

بيدوّر تلقائيًا على app.js و styles.css في الفولدر، وبيحدّث كل مرجع ليهم
(?v=xxxxxxxx) في: index.html, en/index.html, admin-9k2x.html,
categories/male/index.html, categories/female/index.html,
categories/business/index.html — أي ملف من دول موجود فعلًا في الفولدر.

شغّله **قبل** pre_upload_check.py في كل مرة، عشان لما توصل لفحص
pre_upload_check.py يبقى فاضي من مشاكل النسخة خالص، ومركّز بس على فحص
"هل index.html فعلاً الصفحة الرئيسية الصح؟".
"""
import sys, os, re, hashlib

ASSETS = ["app.js", "styles.css"]

# كل ملف HTML وأي أصل بيحمّله (بعضهم بيحمّل الاتنين، بعضهم styles.css بس)
CONSUMERS = {
    "index.html": ASSETS,
    "en/index.html": ASSETS,
    "admin-9k2x.html": ASSETS,
    "categories/male/index.html": ["styles.css"],
    "categories/female/index.html": ["styles.css"],
    "categories/business/index.html": ["styles.css"],
}


def short_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


def main():
    if len(sys.argv) != 2:
        print("الاستخدام: python3 sync_asset_versions.py /path/to/folder")
        sys.exit(2)

    folder = sys.argv[1]
    if not os.path.isdir(folder):
        print(f"❌ الفولدر مش موجود: {folder}")
        sys.exit(2)

    versions = {}
    for asset in ASSETS:
        path = os.path.join(folder, asset)
        if os.path.exists(path):
            versions[asset] = short_hash(path)

    if not versions:
        print("مفيش app.js ولا styles.css في الفولدر ده — مفيش حاجة أعمل بيها حاجة.")
        sys.exit(0)

    print("النسخ المحسوبة من المحتوى الفعلي:")
    for asset, v in versions.items():
        print(f"  {asset} -> v={v}")
    print()

    changed_files = []
    for rel_path, assets_used in CONSUMERS.items():
        full_path = os.path.join(folder, rel_path)
        if not os.path.exists(full_path):
            continue
        with open(full_path, "r", encoding="utf-8") as f:
            text = f.read()
        original = text
        for asset in assets_used:
            if asset not in versions:
                continue
            pattern = re.compile(re.escape(asset) + r"\?v=[A-Za-z0-9_.-]+")
            text, n = pattern.subn(f"{asset}?v={versions[asset]}", text)
            if n == 0:
                # الملف موجود بس مفيهوش مرجع للأصل ده أصلًا — طبيعي لو
                # مثلاً categories/* ماعندهاش app.js.
                continue
        if text != original:
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(text)
            changed_files.append(rel_path)

    if changed_files:
        print("اتحدّثوا:")
        for f in changed_files:
            print(f"  ✅ {f}")
    else:
        print("كل الملفات كانت مطابقة بالفعل — مفيش تحديث لازم.")


if __name__ == "__main__":
    main()
