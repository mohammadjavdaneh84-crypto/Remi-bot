# REMI

REMI یک موتور شخصی زمان‌بندی و ارسال یادآور با رابط فارسی Telegram است. slug فنی محصول `remi` است. برنامه تک‌مالک، بدون قابلیت AI و بدون وابستگی production به SQLite است.

## قابلیت‌های فعلی

- ساخت و ویرایش یادآور از wizard فارسی با متن، رسانه و آلبوم
- شش الگوی زمان‌بندی، timezone/DST، preview و سیاست رخدادهای ازدست‌رفته
- کشف گروه و کانال، بررسی دسترسی و پشتیبانی مهاجرت supergroup
- صف پایدار PostgreSQL، retry کنترل‌شده و توقف خودکار ارسال با نتیجه نامعلوم
- تاریخچه، توقف/ادامه، اجرای دستی، تکثیر، حذف نرم و Daily Header اختیاری
- جلوگیری از replay و پردازش تکراری، claimهای قفل‌شده و lease واحد Telegram polling
- لاگ JSON پالایش‌شده، shutdown با `SIGTERM` و health endpointها

مسیر اصلی کاربر: ساخت bot و Storage خصوصی → `/start` → ثبت مقصدها → `/new` و تعریف محتوا/زمان‌بندی/مقصد → مشاهده با `/reminders` و `/history` → تنظیم تاریخ روز با `/daily`.

داده‌های پایدار شامل profile مالک، مقصدها، reference محتوای Telegram Storage، draft/session، reminder/version/rule/cursor، execution/delivery/retry و تنظیمات Daily Header است. تمام این metadata در PostgreSQL است. رسانه در کانال خصوصی Telegram نگهداری می‌شود و فایل دائمی روی filesystem کانتینر تولید نمی‌شود؛ در نتیجه Object Storage جداگانه برای رفتار فعلی لازم نیست.

## اجرای محلی از صفر

پیش‌نیازها: Node.js `24.21.0`، Docker/Compose و Bot/Storage جدید. `.env.example` را به `.env` کپی و فیلدهای اجباری را تکمیل کنید؛ هیچ credential قدیمی را استفاده نکنید.

```sh
docker compose up --build
```

Compose برای توسعهٔ محلی یک PostgreSQL خالی می‌سازد. در محیط میزبانی، REMI می‌تواند از یک سرور/کلاستر PostgreSQL مشترک استفاده کند، به شرط آنکه دیتابیس، کاربر، رمز و مجوزهای محدود مستقل خودش را داشته باشد و کاربر REMI به دیتابیس پروژه‌های دیگر دسترسی نداشته باشد. برنامه پیش از Ready شدن migrationهای versioned را با advisory lock، transaction و checksum اجرا می‌کند. فایل migration اجراشده را تغییر ندهید؛ تغییر schema باید فایل شماره‌دار تازه باشد.

برای اجرای Node روی میزبان و فقط PostgreSQL در Docker:

```sh
docker compose up -d postgres
npm ci
npm run migrate
npm run dev
```

## تست و بررسی

```sh
npm ci
npm run check
TEST_DATABASE_URL=postgresql://remi:local-development-only@localhost:5432/remi npm run test:db
docker build -t remi:local .
```

تست‌ها Telegram را fake می‌کنند و پیام یا درخواست خارجی واقعی ندارند. integration test برای هر اجرا schema تصادفی می‌سازد، migrationها را از صفر اجرا و همان schema را حذف می‌کند.

## تنظیمات

| متغیر                              | وضعیت                | کاربرد                                                     |
| ---------------------------------- | -------------------- | ---------------------------------------------------------- |
| `APP_ENV`                          | اجباری               | `development`، `test` یا `production`                      |
| `APP_VERSION`                      | اجباری در production | tag یا commit نمایشی در `/version`                         |
| `DATABASE_URL`                     | اجباری               | اتصال دیتابیس و کاربر مستقل REMI؛ سرور می‌تواند مشترک باشد |
| `BOT_TOKEN`                        | اجباری               | توکن BotFather جدید                                        |
| `OWNER_TELEGRAM_USER_ID`           | اجباری               | شناسه عددی مالک                                            |
| `STORAGE_CHAT_ID`                  | اجباری               | کانال/supergroup خصوصی آرشیو رسانه                         |
| `LOG_LEVEL`                        | اختیاری              | سطح log؛ پیش‌فرض `info`                                    |
| `PORT`                             | اختیاری              | HTTP؛ پیش‌فرض `3000`                                       |
| `DEFAULT_TIMEZONE`                 | اختیاری              | پیش‌فرض profile تازه                                       |
| `SCHEDULER_POLL_MS`                | اختیاری              | فاصله scheduler                                            |
| `DELIVERY_CONCURRENCY`             | اختیاری              | تعداد workerهای ارسال                                      |
| `MAX_DELIVERY_ATTEMPTS`            | اختیاری              | سقف retry                                                  |
| `MAX_CATCH_UP_EXECUTIONS_PER_RULE` | اختیاری              | سقف catch-up                                               |

`APP_ENCRYPTION_KEY` وجود ندارد چون REMI قابلیت AI یا داده رمزگذاری‌شونده در سطح برنامه ندارد. در صورت افزودن AI، طراحی باید ابتدا BYOK و migration امن کلید رمزگذاری‌شده را اضافه کند.

## سلامت و عملیات

- `GET /healthz`: زنده‌بودن process
- `GET /readyz`: Ready بودن برنامه، migration و PostgreSQL؛ در خرابی `503`
- `GET /version`: فقط `APP_VERSION`

لاگ‌ها JSON و روی stdout/stderr هستند. raw update، متن کاربر، token، URL دیتابیس و خطای خام provider ثبت نمی‌شوند. یک replica تنظیم کنید؛ PostgreSQL advisory lock مانع دو polling consumer هم‌زمان است.

## بکاپ و Restore

ابزارهای `pg_dump`، `pg_restore` و `age` لازم‌اند. `DATABASE_URL` باید فقط به دیتابیس REMI وصل شود؛ بکاپ کل سرور یا دیتابیس پروژه‌های دیگر لازم نیست. بکاپ رمزگذاری‌شده:

```sh
DATABASE_URL=... BACKUP_RECIPIENT=age1... ./scripts/backup.sh
```

Restore فقط در یک دیتابیس خالی مخصوص REMI انجام شود. این دیتابیس می‌تواند روی همان کلاستر مشترک باشد، اما باید owner/user و مجوزهای مستقل داشته باشد:

```sh
RESTORE_DATABASE_URL=... AGE_IDENTITY_FILE=... ./scripts/restore.sh backups/remi-....dump.age
```

پس از Restore، اسکریپت وجود migrationها را بررسی می‌کند؛ سپس `/readyz` و smoke test خواندنی اجرا شود. برنامه نگهداری پیشنهادی: روزانه ۱۴ نسخه، هفتگی ۸ نسخه، ماهانه ۱۲ نسخه. فایل‌های رمزگذاری‌شده بعداً به bucket/prefix اختصاصی REMI منتقل و Restore به‌صورت دوره‌ای در دیتابیس موقت تمرین شود. بکاپ میزبان تنها نسخه قابل اعتماد نیست.

## GitHub و Darkube

Workflow روی push و pull request نصب تمیز، typecheck، lint، format check، unit test، integration test با PostgreSQL واقعی، migration از صفر، build، بررسی فایل‌های ممنوع و Docker build را اجرا می‌کند.

راهنمای انتشار آینده در [docs/darkube.md](docs/darkube.md) است. روند استاندارد: branch جدا → بررسی محلی → Push فقط با اجازه مالک → CI موفق → تأیید مالک → merge به `main` → انتشار Darkube در کلاستر آلمان `c23`.

Rollback کد با deploy مجدد image/tag سالم قبلی انجام می‌شود. migrationها forward-only هستند؛ rollback schema با migration اصلاحی جدید انجام می‌شود، نه ویرایش یا حذف migration قبلی.

## محدودیت‌ها

- نتیجه ارسال نامعلوم خودکار retry نمی‌شود و بررسی دستی لازم دارد.
- تقویم recurrence و Daily Header فعلاً Gregorian است.
- Storage رسانه به Telegram وابسته است و ابزار GC/reconciliation کامل ندارد.
- smoke test زنده Telegram، اتصال Darkube و Restore production باید بعداً با credentialهای جدید انجام شوند.
