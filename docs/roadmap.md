# وضعیت roadmap

مرجع و ترتیب اجرا: بخش‌های ۶۰، ۶۱ و ۶۶ `REMI_Codex_Spec.md`.

| Phase                   | وضعیت                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0 — Bootstrap           | کد، migration، health، `/start` و owner gate پیاده شده؛ اتصال زنده به Telegram و استقرار نیازمند تنظیمات واقعی است |
| 1 — Domain + Recurrence | قواعد، اعتبارسنجی، شروط پایان، timezone و preview همراه تست پیاده شده                                              |
| 2 — Targets + Storage   | پیاده شده؛ discovery، `/targets`، permission check، مهاجرت گروه و adapter آرشیو پایدار با تست                      |
| 3 — REMInder Creation   | پیاده شده؛ Draft و wizard پایدار، دریافت آلبوم، preview و ساخت اتمیک Version 1 و cursorهای اولیه                   |
| 4 — Scheduler Core      | پیاده شده؛ producer، claim و locking، execution dedupe، Deliveryها، missed policies و تست concurrency              |
| 5 — Telegram Delivery   | پیاده شده؛ copy، ترتیب بسته و album، پیشرفت پایدار، retry، UNKNOWN و History                                       |
| 6 — Management          | پیاده شده؛ فهرست، edit/versioning، pause/resume، run now با تأیید، duplicate متوقف، پیش‌نمایش و delete             |
| 7 — Reliability         | تکمیل؛ تست قطع واقعی session DB، بازیابی SENDING/SENT، race/partial failure و log قابل پیگیری بدون دادهٔ محرمانه   |
| 8 — Daily Header        | تکمیل؛ `/daily`، تنظیمات پایدار، dedupe روزانه، timezone، پیوی/گروه/کانال و pin/unpin امن با retry مستقل           |
| 9 — Darkube polish      | به درخواست مالک به مسیر سبک محدود شد: Dockerfile موجود، darkube.json، PORT و راهنمای سریع؛ استقرار زنده انجام نشده |

## دامنهٔ تست این تحویل

نتیجهٔ تحویل قبلی (Phase 0–1) با Node 24.21.0: ۶۰ تست unit/adapter و ۲ تست integration موفق بود.

نتیجهٔ نهایی Phase 2 در ۲۰۲۶-۱۰-۰۳: **۱۱۲ تست unit/adapter و ۷ تست integration روی PostgreSQL واقعی پاس شدند**؛ تست skipشده وجود نداشت. typecheck، lint، format check و production build نیز موفق بودند؛ runtime تست Node 24.21.0 بود.

در Phase 2، تست‌های capture هر ۹ نوع محتوا، ترتیب آلبوم، replay/claim هم‌زمان، پاسخ ناقص کپی، timeout، خطای DB بعد از کپی، مجوز کانال و گروه، مالکیت و تغییر گروه به supergroup اضافه شدند. تست PostgreSQL نیز اتمیک بودن آرشیو، عدم تکرار کپی با repository جدید، مالکیت رکوردها و نگهداری referenceهای قبلی را پوشش می‌دهد. الزام UTF8 برای محتوای فارسی با تست واقعی مشخص و در migration اعمال شد. dependency جدیدی به پروژه اضافه نشده است.

Telegram واقعی، Docker image و Darkube آزمایش نشده‌اند؛ token و محیط عملیاتی در این workspace تنظیم نشده است. ابزار موقت PostgreSQL dependency پروژه نیست.

تست‌های recurrence شامل one-time، روزانه، timezone تهران، DST gap/overlap، چند weekday، parity دوهفته‌ای، عبور سال، روزهای ۱/۲۸/۲۹/۳۰/۳۱ ماه، nth weekday، سال کبیسه، interval و شروط پایان است. preview هم overlap، زمان‌های نزدیک، count مستقل و غیرفعال بودن Rule را تست می‌کند.

Bootstrap با fake Bot API، ورودی نامعتبر env، دسترسی مالک، callback غیرمجاز و وضعیت health تست شده است. تست PostgreSQL جداگانه، migration هم‌زمان، اجرای مجدد، checksum، BIGINT، timestamps و rollback را بررسی می‌کند.

در Phase 3 مسیر ساخت با متن/ویدئو/عکس، Rule هفتگی و ماهانه و دو مقصد روی PostgreSQL واقعی تست شده است. تست‌ها restart جلسه و آلبوم، callback قدیمی/جعلی، `/cancel`، تأیید هم‌زمان، rollback شکست cursor و بازیابی بعد از کپی و قبل از ذخیرهٔ Draft را پوشش می‌دهند. immutable بودن تعریف فعال نیز در DB بررسی می‌شود.

نتیجهٔ نهایی Phase 3 در ۲۰۲۶-۱۰-۰۳ با Node 24.21.0: **۱۴۹ تست unit/adapter و ۱۵ تست integration روی PostgreSQL واقعی پاس شدند**؛ هیچ تستی skip نشد. typecheck، lint، format check و production build موفق بودند. dependency جدیدی به پروژه اضافه نشد.

در Phase 4 تست‌های claim هم‌زمان، ادغام Ruleها، SKIP LOCKED، rollback کامل، جلوگیری از تولید برای نسخه/یادآور غیرفعال، restart، شمارش مستقل از ارسال و سقف پایدار CATCH_UP اضافه شدند. migration 004 و loop تولید اجرا فعال‌اند؛ dependency جدیدی اضافه نشده است.

نتیجهٔ نهایی Phase 4 در ۲۰۲۶-۱۰-۰۳ با Node 24.21.0: **۱۶۰ تست unit/adapter و ۲۵ تست integration روی PostgreSQL واقعی پاس شدند**؛ هیچ تستی skip نشد. typecheck، lint، format check و production build نیز موفق بودند. تست ارسال زنده و استقرار همچنان انجام نشده است.

در Phase 5 ارسال از Storage، پیشرفت پایدار هر بخش، claim هم‌زمان، retry از بخش ناموفق، سقف تلاش، retry_after، بازیابی پس از قطع کار، UNKNOWN، صف هر مقصد، ادغام مقصدهای مهاجرت‌کرده و `/history` فارسی اضافه شدند. migration 005 و worker ارسال به startup متصل‌اند؛ صف PENDING قبلی با اجرای برنامه پردازش می‌شود. dependency جدیدی اضافه نشده است.

نتیجهٔ نهایی Phase 5 در ۲۰۲۶-۱۰-۰۳ با Node 24.21.0: **۱۷۵ تست unit/adapter و ۳۹ تست integration روی PostgreSQL واقعی پاس شدند**؛ هیچ تستی skip نشد. typecheck، lint، format check و production build نیز موفق بودند. Telegram در تست‌ها fake است؛ ارسال زنده، قطع واقعی شبکه، Docker و Darkube آزمایش نشده‌اند.

در Phase 6، `/reminders` و عملیات مدیریت، پیش‌نویس ویرایش با Save اتمیک، ویرایش/تکثیر/توقف Rule، تنظیمات و مقصدها، افزودن/جایگزینی/حذف/مرتب‌سازی محتوا و پیش‌نمایش خصوصی اضافه شدند. متن/کپشن با ارسال دوبارهٔ پیام اصلاح‌شده به reference تازه تبدیل می‌شود؛ canonical قدیمی تغییر نمی‌کند. migration 006 اضافه شد؛ dependency جدیدی اضافه نشده است.

نتیجهٔ نهایی Phase 6 در ۲۰۲۶-۱۰-۰۳ با Node 24.21.0: **۱۸۱ تست unit/adapter و ۴۸ تست integration روی PostgreSQL واقعی پاس شدند**؛ هیچ تستی skip نشد. typecheck، lint، format check و production build نیز موفق بودند. ارسال زندهٔ Telegram و استقرار هنوز آزمایش نشده‌اند.

در Phase 7 تست قطع واقعی اتصال PostgreSQL در مرزهای SENDING و SENT اضافه شد؛ worker تازه به‌ترتیب UNKNOWN بدون ارسال دوباره یا ادامهٔ بخش باقی‌مانده را ثبت می‌کند. رویدادهای ارسال شناسه‌های داخلی قابل پیگیری دارند؛ شکست log sink ارسال را متوقف یا تکراری نمی‌کند. تست‌های قبلی race، شکست جزئی، 429، 5xx، permission loss و rollback نیز در مجموعهٔ نهایی دوباره اجرا شدند.

در Phase 8، migration افزایشی 007، تنظیمات/پیش‌نویس/رسید روزانه و `/daily` اضافه شدند. انتخاب مقصد، ساعت، timezone، ارسال با/بدون پین، ویرایش، توقف/ادامه و نتیجه‌های اخیر پیاده شدند. ارسال و pin/unpin مرحله‌های مستقل پایدار دارند؛ فقط پین قبلی خود قابلیت برداشته می‌شود. پس از downtime فقط امروز بررسی می‌شود؛ ارسال نامعلوم خودکار تکرار نمی‌شود. تنظیمات هر روز dedupe می‌شوند و تکرار Save یا restart پیام دیگری برای همان روز نمی‌سازد.

نتیجهٔ تحویل Phase 7–8 در ۲۰۲۶-۱۰-۰۴ با Node 24.21.0: **۱۸۵ تست unit/adapter و ۶۶ تست integration روی PostgreSQL واقعی پاس شدند**؛ هیچ تستی skip نشد. typecheck، lint، format check و production build موفق‌اند. dependency جدیدی اضافه نشد؛ ابزار تست PostgreSQL موقت و خارج از dependencyهای پروژه است. Docker در محیط موجود نیست؛ image، Darkube و ارسال زندهٔ Telegram آزمایش نشده‌اند.

اولویت اصلاح‌شدهٔ مالک برای Phase 9 راه‌اندازی سریع روی Darkube است. [راهنمای سریع](darkube-quickstart.md) و `darkube.json` برای build/migration/start/health آماده‌اند. برنامه `PORT` را می‌پذیرد و قفل polling تحویل بین نسخه‌های یک دیتابیس را هماهنگ می‌کند. قدم بعد: تنظیم چهار متغیر اصلی، Deploy و smoke test واقعی `/new`، `/history` و `/daily`. retry دستی UNKNOWN، GC و امکانات Future همچنان خارج از این تحویل‌اند.
