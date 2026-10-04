# آماده‌سازی انتشار REMI روی Darkube

این راهنما فقط برای انتشار آینده است؛ اجرای آن نیازمند اجازه صریح مالک است.

## تنظیم سرویس

- کلاستر: آلمان `c23`
- منبع build: `Dockerfile`
- replica: `1`
- port: `3000` یا مقدار `PORT`
- liveness: `/healthz`
- readiness و health deployment: `/readyz`
- start: فرمان پیش‌فرض image، یعنی `node dist/main.js`
- migration: برنامه پیش از Ready شدن، migration قفل‌شده و تراکنشی را اجرا می‌کند؛ فرمان بررسی دستی `npm run migrate:prod` است.

در نسخهٔ اولیه، PostgreSQL می‌تواند یک سرور یا کلاستر مشترک روی `c23` باشد و لازم نیست سرویس فیزیکی/منطقی جداگانه‌ای برای REMI ساخته شود. بااین‌حال REMI باید دیتابیس، user، رمز و مجوزهای محدود مستقل خودش را با encoding UTF8 داشته باشد. user برنامه فقط باید به دیتابیس REMI دسترسی داشته باشد و نباید بتواند به دیتابیس پروژه‌های دیگر connect یا داده‌های آن‌ها را بخواند/تغییر دهد. دیسک پایدار به کانتینر app متصل نکنید. همه Secretها فقط در console میزبان ثبت شوند و `.env` upload نشود.

متغیرهای لازم: `APP_ENV`, `APP_VERSION`, `DATABASE_URL`, `BOT_TOKEN`, `OWNER_TELEGRAM_USER_ID`, `STORAGE_CHAT_ID`. متغیرهای اختیاری در README فهرست شده‌اند.

## نخستین انتشار

1. Repository تازه GitHub را بسازید و بعد از اجازه مالک remote را اضافه و branch را push کنید.
2. CI را تا موفقیت کامل بررسی کنید.
3. روی کلاستر PostgreSQL مشترک یا مستقل، یک دیتابیس خالی، user و رمز مخصوص REMI بسازید؛ دسترسی user را به همان دیتابیس محدود و `DATABASE_URL` را به‌عنوان Secret وارد کنید.
4. Bot و کانال Storage تازه بسازید و Secretهای تازه را وارد کنید.
5. سرویس Darkube را به repository و کلاستر `c23` متصل کنید؛ replica را ۱ نگه دارید.
6. پس از deploy، `/version`, `/healthz`, `/readyz` و سپس `/start` را smoke test کنید.

## Rollback و بازیابی

برای rollback کد، image/tag سالم قبلی را deploy کنید. اگر نسخه جدید migration سازگار رو‌به‌جلو اضافه کرده باشد، schema را عقب نبرید؛ migration اصلاحی بسازید. پیش از تغییر schema پرخطر، از دیتابیس REMI بکاپ مستقل رمزگذاری‌شده بگیرید. Restore را ابتدا در یک دیتابیس خالی مخصوص REMI آزمایش کنید؛ این دیتابیس آزمایشی می‌تواند روی همان کلاستر مشترک باشد، ولی باید user و مجوزهای محدود مستقل داشته باشد. تنها پس از تأیید، مسیر بازیابی production را اجرا کنید.
