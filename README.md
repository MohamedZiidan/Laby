# Laby MVP

"Apply to Learn. Explain to Master" — موقع بنظام المعامل (Labs): فيديو قصير ← تحدي عملي ← تصحيح بالـ AI ← شرح صوتي ← فتح اللاب التالي.

## التشغيل

```bash
npm install
cp .env.example .env      # ثم ضع ANTHROPIC_API_KEY (اختياري للتجربة)
npm start                 # http://localhost:3000
```

يحتاج Node 22.5 أو أحدث (قاعدة البيانات SQLite مدمجة، بدون تثبيت إضافي).

حساب مدرب تجريبي يتم إنشاؤه تلقائياً: `demo@laby.app` / `demo1234` (فيه كورس تسويق من لابين).

## أوضاع الـ AI

| الوضع | متى | ما يحدث |
|---|---|---|
| `claude` | وضعت `ANTHROPIC_API_KEY` | السيرفر يكلّم Claude مباشرة |
| `n8n` | وضعت `N8N_WEBHOOK_URL` | السيرفر يرسل الطلب لـ n8n وهو يكلّم Claude |
| `demo` | لا مفتاح | تصحيح بسيط بقاعدة الطول، لتجربة الرحلة كاملة بدون تكلفة |

### n8n
1. في n8n: Workflows ← Import from file ← `n8n/laby-workflow.json`
2. عرّف متغير البيئة `ANTHROPIC_API_KEY` في n8n (أو غيّر ترويسة `x-api-key` لتستخدم Credential).
3. فعّل الـ Workflow وانسخ رابط الـ Production webhook إلى `N8N_WEBHOOK_URL`.

الـ Workflow يستقبل `type: gatekeeper` أو `type: voice` ويرجع نفس JSON الذي يتوقعه السيرفر.

## الشرح الصوتي (Whisper)
ضع `OPENAI_API_KEY` لتحويل الصوت لنص وتقييمه. بدونه يُحفظ التسجيل ويُقبل بدون تحليل.
للتجربة السريعة اجعل `MIN_VOICE_SECONDS=5`. تسجيل الميكروفون يعمل على `localhost` أو HTTPS فقط.

## رفع الفيديو
من صفحة **استوديو المدرب** (حساب مدرب): أنشئ كورساً ثم أضف لاب بالترتيب: الاسم ← الفيديو ← التحدي.
يمكن رفع ملف (يُحفظ في `uploads/videos`) أو لصق رابط YouTube/Vimeo.

## الهيكل
```
server.js   الـ API والمنطق (قفل المعامل، المحاولات، XP، Streaks)
ai.js       Claude + Whisper + n8n + البرومبتات
db.js       SQLite + البيانات التجريبية
public/     واجهة الطالب والمدرب (عربي RTL)
n8n/        ملف الأتمتة
```

## ما هو غير مبني بعد (من الخطة)
- Laby Coins ومراجعة الأقران، سوق التوظيف و Laby Score، وباقات الشركات B2B.
- الدفع والاشتراكات.

## قبل الإطلاق الفعلي
- منع التسجيل الحر كـ "مدرب" (حالياً مفتوح للتجربة) وإضافة تأكيد البريد.
- نقل الفيديوهات لتخزين سحابي مع CDN (مثل Cloudflare R2 أو Bunny Stream أو Mux) بدل القرص المحلي.
- الانتقال من SQLite إلى PostgreSQL كما في الخطة، وتشغيل الموقع خلف HTTPS.
