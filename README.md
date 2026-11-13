# موجز الصباح

تطبيق ويب قابل للتثبيت (PWA) يعرض أهم أخبار مصر والعالم والاقتصاد والتكنولوجيا من مصادر متعددة، ويتحدّث آلياً كل ساعة.

## كيف يعمل
- `.github/workflows/update.yml` يشغّل `scripts/update.mjs` كل ساعة على GitHub Actions.
- السكربت يقرأ خلاصات RSS المذكورة في `feeds.json`، يحذف المكرر والقديم، يوازن بين المصادر، ويكتب `data.json`.
- `index.html` يعرض `data.json`. GitHub Pages يستضيف التطبيق مجاناً.

## التشغيل لأول مرة
1. Settings → Pages → Source: Deploy from a branch → `main` / root.
2. Actions → «تحديث الأخبار» → Run workflow (للتجربة فوراً).

## التعديل
- إضافة أو حذف مصدر: عدّل `feeds.json` فقط.
- الخلاصات التي فشلت في آخر تشغيل تظهر في `data.json` تحت `failed`.
- اختياري: أضف Secret باسم `ANTHROPIC_API_KEY` لتفعيل «في دقيقة» و«ماذا يعني لك» (خدمة مدفوعة حسب الاستخدام).
