# REMI — Product & Engineering Specification for Codex

> **Status:** Approved product baseline + implementation specification  
> **Project name:** REMI  
> **Primary interface language:** Persian  
> **Target platform:** Telegram Bot  
> **Purpose of this document:** This is the source of truth for starting implementation. Codex should read the whole document before changing architecture or writing substantial code.

---

## 0. دستور مستقیم به Codex

این پروژه را به‌عنوان یک «ربات یادآوری ساده» پیاده نکن. REMI در اصل یک **Telegram Scheduling Engine با رابط مکالمه‌ای ساده** است.

سه اصل باید همزمان حفظ شوند:

1. **UX ساده و روزمره**؛ کاربر نباید cron، chat_id، syntax پیچیده یا تنظیمات Advanced فراوان ببیند.
2. **هسته‌ی اجرایی جدی و قابل اتکا**؛ Versioning، History، Retry، Idempotency، Crash Recovery و Timezone از ابتدا در معماری درست باشند.
3. **پیاده‌سازی سبک و قابل نگهداری**؛ برای V1 سرویس اضافی غیرضروری مثل Redis اضافه نشود. PostgreSQL برای persistence و هماهنگی Scheduler کافی است.

در طول توسعه:

- ابتدا Domain و Scheduler را درست بساز؛ سپس UI تلگرام را روی آن سوار کن.
- منطق recurrence را داخل handlerهای Telegram پخش نکن.
- منطق Telegram را داخل Domain Model قفل نکن.
- هیچ فایل مدیایی را روی filesystem سرور یا داخل PostgreSQL ذخیره نکن.
- هیچ secret، token یا chat ID حساس را در repository commit نکن.
- هر feature مهم باید تست داشته باشد.
- اگر برای یک edge case راه‌حل ساده و امن وجود دارد، آن را به ساخت UI پیچیده ترجیح بده.
- قابلیت‌هایی که در این سند Future/Deferred هستند را خودسرانه وارد V1 نکن.
- هرجا این سند عمداً یک جزئیات UX را باز گذاشته، primitiveهای ساده و قابل‌ترکیب را انتخاب کن، نه صفحه یا منوی Advanced شلوغ.

---

# 1. مسئله‌ای که REMI حل می‌کند

نیاز اولیه از یک workflow دستی در Telegram آمده است:

- چند ویدئو/پیام باید هر روز یا طبق الگوی مشخص در یک گروه یا کانال ارسال شوند.
- بعضی پیام‌ها باید هفتگی، هر دو هفته یک‌بار، ماهانه یا با الگوهای متفاوت تکرار شوند.
- در روش دستی، پیام‌ها با Scheduled Messages خود Telegram تنظیم می‌شدند و حتی لازم بود یادآوری شود که برای روز بعد دوباره schedule شوند.
- هدف REMI حذف این چرخه‌ی دستی و تبدیل آن به یک سیستم قابل مدیریت است.

کاربر باید بتواند:

- یک «یادآور» بسازد.
- برای آن چند پیام/مدیا به‌ترتیب مشخص تعریف کند.
- یک یا چند قانون زمانی مستقل روی همان محتوا بگذارد.
- یک یا چند گروه/کانال را مقصد قرار دهد.
- پایان هر قانون را مشخص کند.
- یادآورها را ببیند، ویرایش کند، Pause/Resume کند، Duplicate کند، دستی اجرا کند یا حذف کند.
- بدون نیاز به AI و بدون فرمت‌نویسی پیچیده همه‌ی این کارها را انجام دهد.

---

# 2. واژگان رسمی پروژه

## 2.1 واژگان رابط فارسی

در UI فارسی:

- واحد اصلی محصول: **یادآور**
- Rule زمانی: **زمان‌بندی** یا در جاهایی که لازم است «قانون زمان‌بندی»
- Destination: **مقصد**
- Content Package: **محتوا** / **بسته‌ی محتوا**
- Pause: **توقف موقت**
- Resume: **فعال‌سازی مجدد**
- Duplicate: **کپی / Duplicate**؛ متن نهایی UI بعداً قابل تنظیم است.

کاربر نباید با واژه‌های داخلی مثل `REMInderVersion`, `Execution`, `Cursor`, `Dedupe Key` مواجه شود.

## 2.2 واژگان داخلی پیشنهادی

در کد از این مفاهیم استفاده شود:

- `REMInder`
- `REMInderVersion`
- `ContentItem`
- `ScheduleRule`
- `ScheduleCursor`
- `Target`
- `Execution`
- `ExecutionRule`
- `Delivery`
- `DeliveryItem`
- `Draft`
- `WizardSession`
- `DailyHeaderConfig`

---

# 3. مرز اصلی محصول

## 3.1 پیوی REMI

Private Chat کاربر با REMI **Control Plane** است.

در آن:

- یادآور ساخته می‌شود.
- محتوای یادآور به ربات تحویل داده می‌شود.
- مقصدها انتخاب و مدیریت می‌شوند.
- زمان‌بندی‌ها ساخته و ویرایش می‌شوند.
- Preview و History دیده می‌شود.
- Duplicate / Pause / Resume / Run now / Delete انجام می‌شود.

**یادآورهای عادی به پیوی کاربر ارسال نمی‌شوند.**

## 3.2 مقصدهای یادآور عادی

Targetهای V1:

- Group
- Supergroup
- Channel

Saved Messages کاربر Target نیست.

Private Chat کاربر Target یادآور عادی نیست.

## 3.3 استثنا: Daily Header

قابلیت «تاریخ امروز / Daily Header» feature مستقلی است و می‌تواند در:

- Private Chat خود کاربر با REMI
- Group/Supergroup
- Channel

فعال شود.

این استثنا نباید باعث شود Private Chat وارد مدل Target یادآورهای عادی شود.

---

# 4. تعریف یک REMInder

هر REMInder یک **هویت پایدار** دارد، اما تنظیماتش immutable و versioned هستند.

مدل ذهنی:

```text
REMInder
  ├── stable identity
  ├── operational state (ACTIVE / PAUSED / DELETED)
  └── current REMInderVersion
        ├── name
        ├── timezone
        ├── Content Package
        │     ├── ContentItem 1
        │     ├── ContentItem 2
        │     └── ...
        ├── Schedule Rules
        │     ├── Rule 1
        │     ├── Rule 2
        │     └── ...
        ├── Targets
        │     ├── Target A
        │     └── Target B
        └── behavior settings
```

یک REMInder:

- دقیقاً یک Content Package دارد.
- Content Package می‌تواند چند ContentItem داشته باشد.
- یک یا چند ScheduleRule دارد.
- یک یا چند Target دارد.

تمام Ruleهای یک REMInder **همان Content Package مشترک** را ارسال می‌کنند.

اگر زمان A باید Content A و زمان B باید Content B ارسال کند، این‌ها دو REMInder مستقل هستند؛ Rule نباید صاحب محتوای مستقل شود.

---

# 5. Content Package

## 5.1 Multi-content

Content Package می‌تواند شامل چند پیام Telegram باشد:

- Text
- Photo
- Video
- Animation/GIF
- Document
- Audio
- Voice
- Video note
- Sticker
- Media album، در محدوده‌ی قابل پشتیبانی Telegram

ترتیب ContentItemها مهم است و باید هنگام ارسال حفظ شود.

مثال:

```text
1. متن مقدمه
2. ویدئوی اول
3. ویدئوی دوم
4. عکس
5. متن پایانی
```

## 5.2 اصل ذخیره‌سازی

REMI نباید فایل‌های رسانه‌ای را روی سرور خودش نگه دارد.

مدل پیشنهادی **Hybrid Telegram Storage**:

1. کاربر محتوا را در Private Chat به REMI می‌فرستد.
2. REMI آن را به یک Storage Chat خصوصی متعلق به پروژه copy می‌کند.
3. canonical Telegram messages در Storage Chat نگهداری می‌شوند.
4. PostgreSQL فقط metadata و referenceها را نگه می‌دارد.
5. در زمان Delivery، REMI محتوا را از Storage Chat به Target copy می‌کند.

برای mediaها `file_id` نیز به‌عنوان metadata/fallback نگهداری شود، اما canonical source ترجیحاً Storage Chat باشد.

### چرا Storage Chat؟

- حذف پیام اولیه توسط کاربر REMInder را خراب نمی‌کند.
- REMI فایل سنگین را locally ذخیره نمی‌کند.
- Telegram عملاً object storage پروژه است.
- `copyMessage` / `copyMessages` بدون برچسب Forward قابل استفاده‌اند.
- `copyMessages` grouping آلبوم را حفظ می‌کند.

## 5.3 Storage Chat

یک Private Channel یا Private Supergroup به‌صورت دستی برای REMI ساخته می‌شود.

Bot باید permission کافی برای:

- ارسال/copy محتوا به storage
- خواندن referenceهای لازم برای copy مجدد

داشته باشد.

`STORAGE_CHAT_ID` از environment دریافت شود.

Storage Chat بخشی از UI کاربر نهایی نیست.

## 5.4 Immutable archive

پیام canonical داخل Storage بعد از فعال شدن یک REMInderVersion **immutable فرض شود**.

اگر کاربر caption یا متن را ویرایش کرد:

- پیام قدیمی در storage دست نخورَد.
- یک canonical message جدید در storage ساخته شود.
- REMInderVersion جدید به reference جدید اشاره کند.

این موضوع History را قابل اعتماد نگه می‌دارد.

## 5.5 ویرایش محتوا — UX ساده

عملیات لازم:

- افزودن آیتم
- حذف آیتم
- جایگزینی آیتم
- ویرایش متن/caption
- مرتب‌سازی آیتم‌ها

لازم نیست UI پیچیده‌ای مثل `insert at exact index` ساخته شود.

رویکرد پیشنهادی:

```text
📦 محتوا — 4 آیتم

1. 📝 متن
2. 🎬 ویدئو
3. 🎬 ویدئو
4. 🖼 عکس

[➕ افزودن]
[↕️ مرتب‌سازی]
[✏️ انتخاب آیتم]
```

برای آیتم انتخاب‌شده:

```text
[🔄 جایگزینی]
[📝 ویرایش متن/Caption]
[🗑 حذف]
```

افزودن می‌تواند به انتهای package انجام شود؛ اگر جای دیگری لازم بود کاربر با مرتب‌سازی آن را جابه‌جا می‌کند.

## 5.6 Album

اگر کاربر یک Telegram media group بفرستد:

- `media_group_id` تشخیص داده شود.
- آیتم‌های آن به‌عنوان یک گروه contiguous در Content Package نگهداری شوند.
- در Delivery، grouping حفظ شود.

در V1 نیازی به editor پیچیده برای شکستن/ترکیب album نیست.

## 5.7 محتوای غیرقابل کپی

اگر Telegram اجازه‌ی copy نوعی پیام را ندهد، آن آیتم با خطای دوستانه رد شود و Draft خراب نشود.

انواع خاصی مثل service messages، invoice، paid media و موارد unsupported جزو هدف اولیه نیستند.

---

# 6. Schedule Rule — مفهوم اصلی

Rule مشخص می‌کند:

> «این Content Package در چه زمان‌هایی باید trigger شود؟»

یک REMInder می‌تواند چند Rule داشته باشد.

Ruleها با منطق **OR** ترکیب می‌شوند.

مثال:

```text
Rule A: هر دوشنبه ساعت 20:00
Rule B: روز سوم هر ماه ساعت 18:00
Rule C: یک بار در تاریخ مشخص
```

هرکدام می‌تواند REMInder را trigger کند.

---

# 7. انواع Rule در V1

V1 باید این primitiveها را پشتیبانی کند:

1. **One-time**
2. **Every N days**
3. **Weekly / Every N weeks**
4. **Monthly**
5. **Yearly**
6. **Custom interval**

Cron expression جزو UI استاندارد نیست.

## 7.1 One-time

ورودی:

- تاریخ
- ساعت

پایان خودکار بعد از همان occurrence.

تاریخ گذشته معتبر نیست.

## 7.2 Every N days

ورودی:

- `N >= 1`
- local time
- anchor/start date
- end condition

رفتار calendar-based باشد؛ مثلاً ساعت 18 محلی را در روزهای چرخه حفظ کند.

## 7.3 Weekly / Every N weeks

ورودی:

- یک یا چند weekday
- فاصله‌ی هفته‌ای: 1، 2، یا N
- local time
- anchor week/date
- end condition

مثال:

```text
Friday
every 2 weeks
18:00
cycle anchored at 2026-10-09
unlimited
```

Anchor برای «یک هفته در میان» حیاتی است.

## 7.4 Monthly

دو حالت اصلی:

### day of month

مثال:

- روز 3 هر ماه
- روز 15 هر 2 ماه

اگر `day = 31` و ماه موردنظر روز 31 نداشت، آن ماه **skip** شود؛ روز به آخر ماه clamp نشود.

### nth weekday

پشتیبانی حداقل از:

- first
- second
- third
- fourth
- last

مثال:

- سومین دوشنبه هر ماه
- آخرین جمعه هر 2 ماه

ورودی:

- pattern
- every N months
- local time
- anchor month/date
- end condition

## 7.5 Yearly

ورودی:

- month
- day
- local time
- anchor/start year
- end condition

اگر تاریخ در یک سال وجود نداشته باشد (مثلاً Feb 29)، آن سال skip شود و recurrence به سال معتبر بعدی برسد.

## 7.6 Custom Interval

برای الگوهای elapsed-time ساده.

حداقل:

- every N hours
- every N days
- every N weeks

ورودی:

- amount
- unit
- first occurrence / anchor datetime
- end condition

تفاوت مهم:

- calendar rules باید local calendar semantics را حفظ کنند.
- interval ساعتی elapsed-time semantics دارد.

در UI لازم نیست این تفاوت فنی توضیح داده شود.

---

# 8. End Condition

پایان بخشی از **خود Rule** است، نه تنظیم عمومی REMInder.

برای recurring rules:

1. `UNLIMITED`
2. `UNTIL_DATE`
3. `AFTER_N_EXECUTIONS`

One-time به‌طور طبیعی count=1 دارد.

## 8.1 UNTIL_DATE

Occurrence زمانی معتبر است که:

```text
scheduled_for <= end boundary
```

مرز زمانی با timezone Rule/Version درست تفسیر شود.

## 8.2 AFTER_N_EXECUTIONS

Count بر اساس **occurrence/اجرای Rule** است، نه تعداد Targetها.

اگر یک execution به سه Target ارسال شود، برای Rule یک اجرا محسوب می‌شود.

Manual `Run now` این count را افزایش نمی‌دهد.

اگر دو Rule دقیقاً در یک لحظه overlap کنند و یک Execution مشترک بسازند، هر Rule مشارکت‌کننده یک occurrence از count خودش مصرف می‌کند.

---

# 9. Decision Tree ساخت Rule

UI Rule باید context-sensitive باشد.

Root:

```text
این زمان‌بندی چطور تکرار شود؟

[فقط یک بار]
[هر چند روز]
[هفتگی]
[ماهانه]
[سالانه]
[فاصله‌ای]
```

## 9.1 One-time

```text
تاریخ؟
→ ساعت؟
→ خلاصه
```

هیچ سؤال recurrence/end اضافه نمایش داده نشود.

## 9.2 Every N days

```text
هر چند روز؟
→ چه ساعتی؟
→ اولین چرخه از چه تاریخی؟
→ تا چه زمانی؟
   [نامحدود]
   [تا تاریخ]
   [بعد از N اجرا]
→ خلاصه
```

## 9.3 Weekly

```text
چه روز/روزهایی؟
→ هر چند هفته؟
→ ساعت؟
→ چرخه از کدام هفته/تاریخ حساب شود؟
→ پایان؟
→ خلاصه
```

## 9.4 Monthly

```text
نوع روز؟
  [روز عددی ماه]
  [موقعیت یک روز هفته]

اگر عددی:
  روز چندم؟
اگر weekday:
  first/second/third/fourth/last
  → weekday

→ هر چند ماه؟
→ ساعت؟
→ شروع چرخه؟
→ پایان؟
→ خلاصه
```

## 9.5 Yearly

```text
ماه؟
→ روز؟
→ ساعت؟
→ شروع از کدام سال؟
→ پایان؟
→ خلاصه
```

## 9.6 Interval

```text
واحد؟
→ تعداد؟
→ اولین اجرا؟
→ پایان؟
→ خلاصه
```

### اصل UX

عبارت‌های فنی مثل `anchor_at` در UI دیده نشوند.

به‌جای آن از عبارت‌های طبیعی استفاده شود:

- «اولین اجرا چه زمانی باشد؟»
- «این چرخه از کدام هفته حساب شود؟»

---

# 10. Calendar و Timezone

## 10.1 Canonical storage

تمام timestampهای DB:

- `TIMESTAMPTZ`
- canonical UTC

اما recurrence calculation باید در timezone مربوطه انجام شود.

## 10.2 REMInderVersion timezone

برای ساده نگه داشتن V1، هر REMInderVersion یک timezone اصلی دارد و تمام Ruleهایش از همان timezone استفاده می‌کنند.

اگر در آینده Rule-level timezone لازم شد، schema قابل توسعه باشد، اما V1 UI آن را expose نکند.

## 10.3 default timezone

User profile یک `default_timezone` دارد.

هنگام ساخت REMInder، timezone از User profile snapshot می‌شود و وارد REMInderVersion می‌شود.

تغییر default timezone کاربر نباید REMInderهای قدیمی را بی‌صدا جابه‌جا کند.

## 10.4 DST

Recurrenceهای calendar-based باید local wall-clock time را حفظ کنند.

برای زمان‌های مبهم یا nonexistent در DST:

- behavior مشخص و deterministic باشد.
- ترجیح: library معتبر timezone semantics استفاده شود.
- تست اختصاصی نوشته شود.

## 10.5 Persian/Jalali calendar

این تصمیم محصولی هنوز عمداً نهایی نشده است.

برای جلوگیری از قفل معماری:

- Scheduler core را مستقیم به formatting شمسی گره نزن.
- canonical recurrence V1 می‌تواند Gregorian باشد.
- field/abstraction برای `calendar_system` در Domain در نظر گرفته شود یا حداقل interface محاسبه recurrence طوری باشد که بعداً Persian calendar اضافه شود.
- UI date parser/formatter از recurrence engine جدا باشد.
- اعداد فارسی/عربی در ورودی text normalize شوند.

Codex نباید بدون تصمیم بعدی UX پیچیده‌ی تقویم شمسی بسازد.

---

# 11. Deduplication بین Ruleها

اگر دو یا چند Rule از یک REMInderVersion دقیقاً یک `scheduled_for` مشترک تولید کنند:

- فقط یک Execution ساخته شود.
- یک Delivery برای هر Target ساخته شود.
- Content فقط یک بار به هر Target ارسال شود.
- Execution به تمام Ruleهای contributing لینک شود.

Unique key پیشنهادی:

```text
(reminder_id, reminder_version_id, scheduled_for, trigger_kind='scheduled')
```

یا یک `dedupe_key` معادل.

مثال:

```text
Rule A: هر دوشنبه ساعت 18
Rule B: روز سوم هر ماه ساعت 18

اگر سوم ماه دوشنبه باشد:
→ 1 Execution
→ نه 2 Execution
```

---

# 12. Wizard ساخت REMInder

روش اصلی UI: conversation + Inline Keyboard.

Flow پیشنهادی و تأییدشده:

```text
/new
  ↓
نام یادآور
  ↓
دریافت Content Package
  ↓
ساخت Schedule Rule اول
  ↓
آیا Rule دیگری اضافه شود؟
  ↓
انتخاب Targetها
  ↓
Preview کامل
  ↓
Confirm
  ↓
REMInder ACTIVE
```

## 12.1 دریافت محتوا

ربات وارد Content Capture Mode می‌شود.

کاربر می‌تواند چند پیام/مدیا بفرستد.

دکمه:

```text
✅ محتوای من تمام شد
```

تا آن زمان هر پیام قابل پشتیبانی بخشی از Draft است.

## 12.2 افزودن Ruleهای بیشتر

بعد از Rule:

```text
[✅ ذخیره]
[✏️ ویرایش]
[➕ زمان‌بندی دیگر]
```

## 12.3 Target selection

Targetهای ثبت‌شده با checkbox/inline keyboard نمایش داده شوند.

کاربر chat_id تایپ نمی‌کند.

## 12.4 Final preview

حداقل:

- نام
- تعداد/خلاصه‌ی محتوا
- Ruleها به زبان طبیعی
- Targetها
- timezone
- 3 تا 5 occurrence آینده
- وضعیت پایان Ruleها

سپس:

```text
[✅ ساخت یادآور]
[✏️ ویرایش]
[❌ لغو]
```

## 12.5 /cancel

`/cancel` در تمام wizardها:

- session را cancel کند.
- Draft را غیر فعال کند.
- REMInder فعال یا version جاری را دست‌کاری نکند.
- اگر content قبلاً در Storage کپی شده، لازم نیست در V1 فوراً حذف شود؛ می‌تواند orphan/GC candidate بماند.

---

# 13. Draft Model

ساخت/ویرایش را مستقیم روی Version active انجام نده.

استفاده از Draft ضروری است.

دو حالت:

### New REMInder Draft

هنوز REMInder active وجود ندارد.

### Edit Draft

از current REMInderVersion clone منطقی گرفته می‌شود و کاربر چند تغییر می‌دهد.

تا وقتی Save/Confirm نشده:

- Version جدید active نشود.
- Scheduler تغییر را نبیند.

هنگام Save:

1. validate کامل
2. archive هر content جدید
3. transaction DB
4. create immutable REMInderVersion
5. activate new version
6. retire old version
7. initialize new ScheduleCursors
8. commit

اگر transaction fail شد، version قبلی active می‌ماند.

یک edit session می‌تواند چند تغییر UI داشته باشد اما در نهایت **یک Version جدید** در Save تولید کند.

برای one-click structural changes مثل «Disable Rule» می‌توان بلافاصله یک Version جدید ساخت.

---

# 14. Versioning

## 14.1 REMInder stable identity

`REMInder` identity ثابت می‌ماند.

مثال:

```text
REMInder #42
Version 1 → retired
Version 2 → retired
Version 3 → current
```

کاربر فقط REMInder #42 را می‌بیند.

## 14.2 چه چیزهایی Version جدید می‌سازند؟

تمام تغییرات تعریف‌کننده:

- name
- Content Package
- content order
- text/caption
- ScheduleRule add/edit/remove
- Rule enabled/disabled
- Target add/remove
- timezone
- missed-run policy
- delivery behavior settings

## 14.3 چه چیزهایی Version جدید نمی‌سازند؟

Runtime state:

- Pause/Resume کل REMInder
- Run now
- retry
- delivery status
- execution counters
- last run
- errors/logs
- operational locks

## 14.4 Retire، نه DELETE

Version قبلی delete نشود.

فیلدهای پیشنهادی:

- `activated_at`
- `retired_at`
- `superseded_by_version_id` optional

History باید همیشه بتواند بگوید Execution با کدام definition اجرا شده است.

---

# 15. رفتار Version Change هنگام Execution

Race condition مهم:

فرض:

- Execution قدیمی due شده.
- کاربر همان لحظه REMInder را edit می‌کند.

قاعده:

### اگر Execution هنوز شروع نشده

Pending Execution/Deliveryهای Version قبلی که دیگر نباید اجرا شوند cancel شوند.

### اگر Execution وارد PROCESSING شده

همان Execution با Version قدیمی تا پایان ادامه پیدا کند.

علت:

- ممکن است بخشی از Targetها قبلاً ارسال شده باشند.
- توقف وسط کار می‌تواند وضعیت مقصدها را ناسازگارتر کند.

پس activation نسخه‌ی جدید:

- old cursors را deactivate می‌کند.
- pending old executions را تا حد امن cancel می‌کند.
- processing old executions را دست‌کاری نمی‌کند.
- cursorهای Version جدید را از `effective_at` به بعد محاسبه می‌کند.

---

# 16. Pause / Resume

REMInder operational state:

- `ACTIVE`
- `PAUSED`
- `DELETED`

Pause Version جدید نمی‌سازد.

## 16.1 هنگام Pause

- occurrence جدید ایجاد نشود.
- pending scheduled executions که هنوز processing نشده‌اند cancel شوند یا طبق policy واضح internal متوقف شوند.
- processing execution فعلی اجازه دارد کامل شود.

## 16.2 Resume

دوره‌ی Pause **catch-up نمی‌شود**.

Pause عمدی کاربر است؛ پس occurrenceهای زمان توقف باید skip شوند، مستقل از missed-run policy downtime.

در Resume:

- cursorها بر اساس Rule اصلی به اولین occurrence معتبر **بعد از resume time** برده شوند.
- anchor اصلی Rule تغییر نکند.
- چرخه shift نشود.

مثلاً «یک جمعه در میان» بعد از Resume همچنان همان parity هفته‌های قبلی را حفظ کند.

---

# 17. Run now و Preview

## 17.1 Preview content

کاربر بتواند Content Package را در Private Chat با REMI preview کند.

این preview:

- Execution schedule محسوب نمی‌شود.
- targetهای واقعی را درگیر نمی‌کند.
- count هیچ Rule را تغییر نمی‌دهد.

## 17.2 Run now

`Run now` اجرای دستی current REMInderVersion روی Targetهای current است.

قبل از اجرا confirmation مناسب داشته باشد.

Manual Execution:

- `trigger_kind = MANUAL`
- Rule counter را مصرف نمی‌کند.
- end condition را جلو نمی‌برد.
- در History مشخص است که دستی بوده.

---

# 18. Duplicate

Duplicate جزو V1 است.

رفتار:

```text
REMInder 42 / Version 5
   ↓ duplicate
REMInder 87 / Version 1
```

کپی شود:

- name با suffix ساده مثل «کپی ...» یا UX مناسب
- Content references
- ScheduleRules
- Targets
- timezone/settings

کپی نشود:

- History
- Executions
- Delivery states
- runtime counters
- last_run
- old versions

REMInder جدید:

- `PAUSED` ساخته شود.
- کاربر قبل از فعال‌سازی بتواند آن را ویرایش کند.

Duplicate با Versioning فرق دارد.

---

# 19. Delete

Delete در UI confirmation می‌خواهد.

V1:

- soft delete
- scheduler متوقف
- pending غیرشروع‌شده cancel
- history حفظ
- storage content فوراً پاک نشود.

پاک‌سازی دائمی و retention policy می‌تواند بعداً اضافه شود.

---

# 20. Target Management

## 20.1 Target registry

REMI باید Targetها را بشناسد بدون اینکه کاربر chat_id بداند.

اطلاعات Target:

- Telegram chat ID
- type: group/supergroup/channel
- title
- username optional
- bot membership status
- permission snapshot
- active/reachable
- discovered_at
- updated_at

## 20.2 Discovery

از Telegram updates مثل `my_chat_member` برای تشخیص:

- bot added
- bot removed
- bot promoted/demoted

استفاده شود.

همچنین هنگام انتخاب/ارسال Target با `getChat`/`getChatMember` یا API مناسب صحت دسترسی validate شود.

## 20.3 Permission

### Group/Supergroup reminder delivery

Bot باید حق ارسال پیام داشته باشد.

لزومی به admin بودن برای REMInder معمولی نیست، اگر chat permissions اجازه‌ی ارسال بدهد.

### Channel reminder delivery

Bot باید permission مناسب برای post داشته باشد؛ معمولاً admin با `can_post_messages`.

### Daily Header pinning

برای pin/unpin:

- group: `can_pin_messages`
- channel: `can_edit_messages`
- private chat: Telegram Bot API اجازه‌ی pin پیام‌های غیر-service را می‌دهد.

## 20.4 target loss

اگر bot از chat حذف شد یا permission از دست رفت:

- Target record حذف نشود؛ inactive/unreachable شود.
- Delivery با خطای روشن fail شود.
- owner در control chat notification مختصر بگیرد یا در History قابل مشاهده باشد.
- REMInderهای دیگر خراب نشوند.

## 20.5 Group migration

`migrate_to_chat_id` / تغییر basic group به supergroup مدیریت شود و Target referenceها به ID جدید migrate شوند.

## 20.6 Forum topics

Target به topic خاص در V1 لازم نیست.

V1 کل group/supergroup را هدف می‌گیرد.

---

# 21. Commands و Main Menu

حداقل commandها:

- `/start`
- `/new`
- `/reminders`
- `/targets`
- `/cancel`
- `/help`
- `/settings` در صورت نیاز

از commandهای syntax-heavy اجتناب شود.

نمونه‌ی Main Menu:

```text
[➕ یادآور جدید]
[📋 یادآورها]
[📍 مقصدها]
[⚙️ تنظیمات]
```

Commandها shortcut هستند؛ UI اصلی دکمه‌ای/مکالمه‌ای است.

---

# 22. REMInder list / management UI

`/reminders`:

- active
- paused
- شاید archived/deleted در submenu جدا
- pagination

هر row/item:

- نام
- وضعیت
- next execution
- تعداد Rule/Target در صورت مفید بودن

صفحه‌ی REMInder:

```text
🎬 ویدیوهای MBA
🟢 فعال
اجرای بعدی: ...

[📦 محتوا]
[🕓 زمان‌بندی‌ها]
[📍 مقصدها]
[⚙️ تنظیمات]
[▶️ اجرای الآن]
[⏸ توقف]
[📄 Duplicate]
[📜 تاریخچه]
[🗑 حذف]
```

چیدمان دقیق بعداً قابل تغییر است؛ Domain به متن/keyboard خاص وابسته نشود.

---

# 23. Rule management UX

نمایش:

```text
🕓 زمان‌بندی‌ها

1. یک جمعه در میان، ساعت 18:00
2. روز سوم هر ماه، ساعت 21:00

[➕ افزودن]
```

انتخاب Rule:

```text
[✏️ ویرایش]
[📄 Duplicate Rule]
[⏸ غیرفعال/فعال]
[🗑 حذف]
```

Edit:

- همان Rule Wizard
- prefilled current values
- Save → Version جدید REMInder

Rule Duplicate:

- clone config داخل Edit Draft
- کاربر می‌تواند clone را تغییر دهد
- Save → Version جدید

این primitiveها برای ساخت scheduleهای پیچیده کافی هستند.

---

# 24. Next Occurrences Preview

هر REMInder باید بتواند حداقل 3 و ترجیحاً 5 occurrence آینده را محاسبه و نمایش دهد.

این محاسبه:

- side-effect free
- از همان recurrence engine واقعی Scheduler استفاده کند
- از منطق جداگانه‌ی UI استفاده نکند.

Preview مهم‌ترین ابزار کشف تنظیم اشتباه است.

برای چند Rule، خروجی:

- merge
- sort
- dedupe exact simultaneous occurrences

---

# 25. Execution Model

سه سطح:

```text
ScheduleRule
   ↓ produces time
Execution
   ↓ fans out
Delivery per Target
   ↓ contains
DeliveryItem per content unit
```

## 25.1 Execution

یک occurrence واقعی REMInder.

فیلدهای مفهومی:

- reminder
- reminder_version
- scheduled_for
- trigger_kind
- state
- created_at
- started_at
- completed_at
- dedupe_key

State نمونه:

- `PENDING`
- `PROCESSING`
- `SUCCEEDED`
- `PARTIAL_FAILED`
- `FAILED`
- `CANCELLED`

## 25.2 ExecutionRule

join table برای Ruleهای contributing.

لازم برای overlap/dedup و Rule count.

## 25.3 Delivery

یک Execution × یک Target.

State:

- `PENDING`
- `PROCESSING`
- `SUCCEEDED`
- `FAILED_RETRYABLE`
- `FAILED_PERMANENT`
- `UNKNOWN`
- `CANCELLED`

## 25.4 DeliveryItem

برای جلوگیری از replay کامل Content Package بعد از failure وسط کار.

هر ContentItem یا album-group باید delivery progress داشته باشد.

اگر آیتم‌های 1 و 2 موفق و آیتم 3 fail شد:

- retry از آیتم 3 ادامه دهد.
- 1 و 2 دوباره ارسال نشوند.

---

# 26. محدودیت Exactly-once و رفتار امن

Bot API کل سیستم transactional نیست.

اگر درخواست ارسال به Telegram انجام شده ولی connection قبل از دریافت response قطع شود، ممکن است:

- پیام واقعاً ارسال شده باشد.
- REMI response موفق را ندیده باشد.

پس **exactly-once delivery صددرصد قابل تضمین نیست**.

هدف:

- DB-level duplicate جلوگیری شود.
- concurrent workers duplicate نسازند.
- آیتم‌های ثبت‌شده‌ی موفق دوباره ارسال نشوند.
- در ambiguous network outcome کورکورانه retry نشود.

پیشنهاد:

اگر نتیجه‌ی request واقعاً نامعلوم است:

```text
DeliveryItem → UNKNOWN
```

و automatic resend متوقف شود تا از duplicate بدتر جلوگیری شود.

در History به owner نشان داده شود و گزینه‌ی retry دستی بعداً فراهم باشد.

برای خطاهای واضح retryable مثل Telegram 429 / 5xx:

- retry با backoff
- `retry_after` Telegram رعایت شود.

---

# 27. Scheduler Architecture

## 27.1 بدون Redis در V1

PostgreSQL هم persistence است و هم coordination.

دو loop منطقی:

1. **Schedule producer**
2. **Delivery worker**

می‌توانند در همان Node process اجرا شوند، اما module مستقل باشند.

## 27.2 ScheduleCursor

چون REMInderVersion immutable است، runtime cursor داخل ScheduleRule ذخیره نشود.

جدول جدا:

```text
ScheduleCursor
- schedule_rule_id
- next_due_at
- consumed_count
- active
- last_due_at
- updated_at
```

ScheduleRule config immutable است؛ Cursor mutable runtime است.

## 27.3 Scheduler tick

هر چند ثانیه:

1. due cursorها را query کن.
2. با transaction و `FOR UPDATE SKIP LOCKED` claim کن.
3. pause/version validity را چک کن.
4. missed-run policy را اعمال کن.
5. Execution را با unique dedupe key create/upsert کن.
6. contributing Rule linkها را create کن.
7. Targetهای Version را snapshot/Delivery بساز.
8. cursor هر Rule را به occurrence بعدی advance کن.
9. transaction commit.

Scheduler precision در حد دقیقه است؛ tick مثلاً 5 تا 15 ثانیه کافی است و env-configurable باشد.

## 27.4 Cursor advance

Recurrence engine function خالص:

```text
nextOccurrence(ruleConfig, afterInstant, timezone)
```

و برای preview:

```text
nextOccurrences(ruleConfig, afterInstant, limit)
```

Scheduler و UI هر دو همین engine را استفاده کنند.

---

# 28. Missed-run Policy

سه policy:

- `SKIP`
- `CATCH_UP`
- `LATEST_ONLY`

Default: **LATEST_ONLY**

## 28.1 دلیل

اگر سرویس مدتی down باشد، کاربر معمولاً نمی‌خواهد بعد از بازگشت چندین پیام قدیمی پشت سر هم در گروه ارسال شود.

## 28.2 SKIP

تمام occurrenceهای گذشته تا `now` skip شوند.

Cursor به اولین occurrence آینده advance شود.

Skipped occurrenceها Rule execution count را مصرف نمی‌کنند.

## 28.3 LATEST_ONLY

اگر چند occurrence از دست رفته:

- فقط آخرین occurrence مناسب ساخته شود.
- بقیه skip شوند.
- cursor به آینده advance شود.

تنها Rule occurrenceای که واقعاً Execution ساخته، count را مصرف می‌کند.

## 28.4 CATCH_UP

Occurrenceهای missed به‌ترتیب اجرا شوند.

اما internal safety cap لازم است تا outage طولانی flood ایجاد نکند.

مثلاً env/config:

```text
MAX_CATCH_UP_EXECUTIONS_PER_RULE
```

Default محافظه‌کارانه.

اگر backlog بیش از limit شد:

- log/owner notification
- باقی‌مانده بدون تصمیم کورکورانه flood نشود.

## 28.5 Pause با downtime فرق دارد

در Pause همیشه missed period skip است؛ policy بالا برای downtime/worker unavailability است، نه Pause عمدی.

---

# 29. Delivery Worker

Worker:

1. PENDING/RETRYABLE delivery را claim کند.
2. Target availability/permissions را validate کند اگر لازم است.
3. content delivery units را به‌ترتیب بفرستد.
4. state هر DeliveryItem را persist کند.
5. failure را classify کند.
6. Delivery state نهایی را set کند.
7. Execution aggregate state را update کند.

## 29.1 Concurrency

Concurrency محدود و configurable باشد.

ترتیب آیتم‌های یک Delivery باید serial باشد.

Targetهای مختلف یک Execution می‌توانند با concurrency کنترل‌شده parallel شوند.

## 29.2 Rate limits

- Telegram 429 → `retry_after`
- exponential backoff برای 5xx/network retryable
- jitter کوچک
- max attempts معقول

Permanent examples:

- bot kicked
- chat not found
- forbidden
- no post permission

در permanent failure Target inactive/unreachable علامت‌گذاری شود اگر مناسب است.

---

# 30. Sending Strategy از Storage

اصل:

- اگر مجموعه‌ای از canonical storage messageها بدون تغییر باید کپی شود، از `copyMessages` در batchهای <= 100 استفاده کن.
- message IDs باید طبق محدودیت API ordered باشند.
- album grouping با `copyMessages` حفظ می‌شود.
- اگر per-item control/retry لازم است، delivery units طوری chunk شوند که failure recovery قابل فهم باشد.

به دلیل اینکه Content version در Storage canonical شده، هنگام Delivery ترجیحاً caption/text transform انجام نشود.

هر edit باید قبل‌تر canonical message جدید ساخته باشد.

این کار Delivery را deterministic می‌کند.

---

# 31. Data Model پیشنهادی

نام دقیق tableها قابل تغییر است، ولی semantics حفظ شود.

## 31.1 users

```text
id UUID PK
telegram_user_id BIGINT UNIQUE NOT NULL
display_name
username nullable
default_timezone NOT NULL
locale default 'fa'
created_at
updated_at
```

## 31.2 targets

```text
id UUID PK
owner_user_id FK
telegram_chat_id BIGINT NOT NULL
chat_type ENUM(group, supergroup, channel)
title
username nullable
membership_status
can_send boolean
can_pin boolean
is_active boolean
last_checked_at
created_at
updated_at

UNIQUE(owner_user_id, telegram_chat_id)
```

## 31.3 reminders

```text
id UUID PK
owner_user_id FK
status ENUM(ACTIVE, PAUSED, DELETED)
current_version_id UUID nullable
created_at
paused_at nullable
deleted_at nullable
updated_at
```

نام user-visible داخل Version باشد، چون name هم versioned است.

## 31.4 reminder_versions

```text
id UUID PK
reminder_id FK
version_no INT
name TEXT
timezone TEXT
missed_run_policy ENUM
created_at
activated_at
retired_at nullable
superseded_by_version_id nullable

UNIQUE(reminder_id, version_no)
```

در هر REMInder فقط یک current active version.

## 31.5 content_items

```text
id UUID PK
reminder_version_id FK
position INT
content_type ENUM/TEXT
storage_chat_id BIGINT
storage_message_id BIGINT
telegram_file_id TEXT nullable
telegram_file_unique_id TEXT nullable
media_group_key TEXT nullable
caption/text metadata JSONB nullable
created_at

UNIQUE(reminder_version_id, position)
```

اگر یک content item منطقی چند storage message دارد، schema را با `content_groups` یا granularity مناسب normalize کن. اصل: order + album grouping واضح بماند.

## 31.6 schedule_rules

```text
id UUID PK
reminder_version_id FK
position INT
rule_type ENUM
config JSONB
end_type ENUM(UNLIMITED, UNTIL_DATE, AFTER_N_EXECUTIONS)
end_at TIMESTAMPTZ nullable
end_count INT nullable
enabled BOOLEAN
created_at
```

`config` با Zod/discriminated union validate شود.

نمونه‌های conceptual:

```json
{
  "type": "WEEKLY",
  "weekdays": [5],
  "everyNWeeks": 2,
  "localTime": "18:00",
  "anchorLocalDate": "2026-10-09"
}
```

## 31.7 reminder_version_targets

```text
reminder_version_id FK
target_id FK
position optional
PRIMARY KEY(reminder_version_id, target_id)
```

## 31.8 schedule_cursors

```text
schedule_rule_id PK/FK
next_due_at TIMESTAMPTZ nullable
last_due_at TIMESTAMPTZ nullable
consumed_count INT default 0
active BOOLEAN
updated_at
```

## 31.9 executions

```text
id UUID PK
reminder_id FK
reminder_version_id FK
scheduled_for TIMESTAMPTZ
trigger_kind ENUM(SCHEDULED, MANUAL)
state ENUM
dedupe_key TEXT UNIQUE
created_at
started_at nullable
completed_at nullable
cancel_reason nullable
```

برای Manual dedupe key جداگانه/UUID.

## 31.10 execution_rules

```text
execution_id FK
schedule_rule_id FK
PRIMARY KEY(execution_id, schedule_rule_id)
```

## 31.11 deliveries

```text
id UUID PK
execution_id FK
target_id FK
state ENUM
attempt_count INT
next_attempt_at nullable
last_error_code nullable
last_error_message nullable
started_at nullable
completed_at nullable
created_at

UNIQUE(execution_id, target_id)
```

## 31.12 delivery_items

```text
id UUID PK
delivery_id FK
content_item_id FK
sequence INT
state ENUM(PENDING, SENDING, SENT, FAILED_RETRYABLE, FAILED_PERMANENT, UNKNOWN)
attempt_count INT
sent_message_ids JSONB nullable
last_error...
updated_at

UNIQUE(delivery_id, content_item_id)
```

برای album ممکن است یک delivery unit به چند content item نگاشت شود؛ اگر لازم شد table/group جدا بساز.

## 31.13 wizard_sessions

```text
id UUID PK
user_id FK
kind ENUM(CREATE_REMINDER, EDIT_REMINDER, ADD_TARGET, ...)
state TEXT
payload JSONB
expires_at
created_at
updated_at
```

Session فقط in-memory نباشد تا restart bot wizard را بی‌جهت خراب نکند.

## 31.14 reminder_drafts

می‌تواند JSONB validated یا normalize شده باشد.

هدف:

- current edit state
- clone از version قبلی
- content refs
- rule configs
- target IDs

پس از commit قابل discard/expire است.

## 31.15 daily_header_configs

```text
id UUID PK
owner_user_id FK
telegram_chat_id BIGINT
timezone TEXT
local_time TIME
enabled BOOLEAN
pin_enabled BOOLEAN
last_header_message_id BIGINT nullable
last_header_local_date DATE nullable
created_at
updated_at
```

---

# 32. DB Constraints و Indexها

حداقل:

- unique active/current version invariant
- executions `dedupe_key UNIQUE`
- deliveries `(execution_id, target_id) UNIQUE`
- target chat ID unique per owner
- schedule cursor index on `(active, next_due_at)`
- delivery queue index on `(state, next_attempt_at)`
- reminder list index `(owner_user_id, status)`
- version index `(reminder_id, version_no DESC)`

از transaction برای activation version و creation execution استفاده شود.

---

# 33. Access Control

این پروژه در اصل یک ربات شخصی است.

V1 پیشنهادی:

- `OWNER_TELEGRAM_USER_ID` یا allowlist کوچک env-based
- فقط owner اجازه‌ی control commands و wizard دارد.
- پیام private از user دیگر پاسخ کوتاه «ربات خصوصی است» بگیرد.
- group messages برای feature اصلی لازم نیست parse شوند.

با این حال schema با `owner_user_id` طراحی شود تا multi-user شدن بعدی نیازمند rewrite کامل نباشد.

هیچ preference سیاسی/شخصی یا داده‌ی غیرضروری ذخیره نشود.

---

# 34. Telegram Update Handling

Update handlers لازم:

- private `message`
- `callback_query`
- `my_chat_member`
- migration-related messages
- optional channel/group membership updates as needed

Privacy Mode group bot می‌تواند روشن بماند؛ REMI برای REMInder عادی نیاز ندارد تمام پیام‌های گروه را بخواند.

Control interaction فقط private chat.

---

# 35. State Machine UI

Telegram handler نباید مجموعه‌ای از `if`های پراکنده باشد.

Wizard state machine تعریف شود.

مثال creation:

```text
IDLE
→ CREATE_NAME
→ CAPTURE_CONTENT
→ RULE_TYPE
→ RULE_DETAILS...
→ RULE_LIST
→ TARGET_SELECT
→ FINAL_PREVIEW
→ COMMITTING
→ IDLE
```

هر callback:

- user/session ownership validate
- stale callback handle
- idempotent as practical
- expiration friendly

اگر callback مربوط به message قدیمی است، پاسخ کاربرپسند بدهد نه exception.

---

# 36. Callback Data

Telegram callback_data محدودیت اندازه دارد؛ payload بزرگ داخل button نگذار.

Pattern:

```text
action:short_id
```

یا token کوتاه mapping به server-side state.

هر callback باید:

- version/session context داشته باشد
- forged IDs را validate کند
- user ownership را check کند.

---

# 37. Error UX

کاربر stack trace نمی‌بیند.

نمونه‌ی دسته‌ها:

### validation
«این تاریخ قبل از امروز است.»

### permission
«REMI دیگر اجازه‌ی ارسال در این کانال را ندارد.»

### content unsupported
«این نوع پیام فعلاً قابل ذخیره‌سازی نیست؛ بقیه‌ی محتوا محفوظ مانده است.»

### transient
«ارسال موقتاً ناموفق بود و دوباره تلاش می‌شود.»

### unknown delivery
«نتیجه‌ی این ارسال به‌دلیل قطع ارتباط مشخص نیست؛ برای جلوگیری از ارسال تکراری خودکار دوباره فرستاده نشد.»

جزئیات فنی در structured logs.

---

# 38. History

برای هر REMInder:

- latest executions
- time
- scheduled/manual
- version number internal/debug
- overall state
- per-target delivery result
- error summary

UI V1 می‌تواند ساده و paginated باشد.

History برای:

- اعتماد
- debugging
- retry
- فهم target permission loss

است.

---

# 39. Retry Policy

Classify:

## Retryable

- HTTP/network transient before known delivery
- Telegram 429
- Telegram 5xx
- temporary gateway issues

## Permanent

- forbidden
- kicked
- chat not found
- missing channel post permission
- unsupported content

## Ambiguous

request ممکن است ارسال شده باشد ولی response نامعلوم است.

→ `UNKNOWN`, نه automatic blind retry.

Backoff:

- exponential
- cap
- honor Telegram `retry_after`
- max attempts configurable

---

# 40. Daily Header

Feature مستقل از REMInder.

هدف:

هر روز پیام تاریخ روز ارسال شود؛ header قبلی خود REMI unpin و header جدید pin شود.

## 40.1 مقصدها

- private control chat
- group
- supergroup
- channel

## 40.2 رفتار pin

فقط message ID قبلی که **خود Daily Header REMI** ذخیره کرده unpin شود.

هرگز `unpinAll` روی chat کاربر اجرا نکن.

Flow:

1. local date change / scheduled time
2. send header
3. pin new header
4. اگر previous REMI header ID وجود داشت، همان را unpin کن
5. persist new message ID

ترتیب 3 و 4 می‌تواند برای حفظ pin در failure طراحی شود؛ safe behavior مهم‌تر از aesthetics است.

## 40.3 Permission

قبل از فعال‌سازی برای group/channel capability check شود.

اگر pin ممکن نیست، می‌توان UI اجازه دهد send-only یا feature را رد کند؛ جزئیات UX بعداً.

## 40.4 متن تاریخ

Formatting دقیق شمسی/میلادی هنوز UX decision بعدی است.

Formatter جدا از scheduler باشد.

---

# 41. Cron و Advanced Scheduling

در V1:

- هیچ cron input در UI
- هیچ requirement برای cron parser

اگر بعداً نیاز شد:

```text
Advanced → Cron
```

می‌تواند feature جدا باشد.

اما structured rule engine source of truth باقی بماند.

---

# 42. AI / Natural Language

V1 به AI وابسته نیست.

Future:

```text
«یک جمعه در میان ساعت ۸ برای گروه خوابگاه»
```

می‌تواند توسط parser/LLM به Draft Rule تبدیل شود.

حتی در آن حالت:

- AI فقط ورودی را parse می‌کند.
- structured Rule ساخته می‌شود.
- Preview و confirmation لازم است.
- Scheduler deterministic باقی می‌ماند.

---

# 43. معماری پیشنهادی Runtime

## 43.1 زبان

**Node.js + TypeScript**

دلایل:

- مناسب Telegram bot
- ecosystem خوب
- async I/O
- deployment ساده
- تست و typing مناسب

نسخه‌ی دقیق runtime در زمان پیاده‌سازی latest stable/LTS انتخاب و lock شود.

## 43.2 Telegram framework

پیشنهاد: **grammY**

اما Domain به grammY couple نشود.

Adapter layer:

```text
Telegram Adapter
→ Application Services
→ Domain
→ Repositories
```

اگر در زمان پیاده‌سازی دلیل فنی قوی برای framework دیگری وجود داشت، تغییر framework نباید Domain را تغییر دهد.

## 43.3 Database

**PostgreSQL**

از SQLite برای production scheduler استفاده نشود.

دلیل:

- transactions
- row locks
- `FOR UPDATE SKIP LOCKED`
- reliable concurrency
- Darkube PostgreSQL؛ سرور/کلاستر می‌تواند مشترک باشد، اما دیتابیس، user، رمز و مجوزهای REMI باید مستقل و محدود به همان دیتابیس باشند
- future scaling

## 43.4 ORM/query

ترجیح:

- Drizzle ORM + migrations
- و raw SQL کنترل‌شده برای scheduler locking/queryهای خاص

یا stack مشابه سبک.

از ORMای که queryهای scheduler را مبهم/سنگین کند اجتناب شود.

## 43.5 Validation

Zod یا equivalent.

Rule config باید discriminated union strongly validated باشد.

## 43.6 Logging

Pino یا structured JSON logger.

هر execution/delivery traceable باشد.

## 43.7 Tests

Vitest یا equivalent.

---

# 44. Service Topology

V1 ساده:

```text
One Node service
  ├── Telegram long-polling adapter
  ├── Scheduler producer loop
  ├── Delivery worker loop
  └── lightweight health HTTP server

PostgreSQL
Telegram Storage Channel
```

Redis لازم نیست.

## 44.1 Long polling

برای V1 ساده‌ترین است.

محدودیت:

- فقط یک bot update consumer فعال باشد.

اگر روزی horizontal scaling ingress لازم شد، webhook می‌تواند جایگزین شود.

Scheduler/worker از قبل با DB locking قابل scale طراحی شود.

---

# 45. Health / Readiness

HTTP lightweight endpoints:

- `/healthz`: process alive
- `/readyz`: DB reachable + bot initialized

برای Darkube مناسب.

هیچ admin panel وب لازم نیست.

---

# 46. Environment Variables

حداقل:

```text
BOT_TOKEN=
OWNER_TELEGRAM_USER_ID=
DATABASE_URL=
STORAGE_CHAT_ID=
DEFAULT_TIMEZONE=
LOG_LEVEL=info

SCHEDULER_POLL_MS=...
DELIVERY_CONCURRENCY=...
MAX_DELIVERY_ATTEMPTS=...
MAX_CATCH_UP_EXECUTIONS_PER_RULE=...
```

Optional:

```text
NODE_ENV=
HEALTH_PORT=
```

Secrets فقط environment.

`.env.example` بدون مقدار واقعی commit شود.

---

# 47. Repository Structure پیشنهادی

```text
src/
  app/
    commands/
    services/
    dto/

  domain/
    reminder/
    schedule/
      recurrence/
    execution/
    target/
    daily-header/

  infrastructure/
    db/
      schema/
      repositories/
      migrations/
    telegram/
      bot.ts
      handlers/
      keyboards/
      storage/
      sender/
    scheduler/
      producer.ts
      delivery-worker.ts
      locks.ts
    logging/
    config/

  ui/
    fa/
      messages.ts
      formatters.ts
      keyboards.ts

  health/
    server.ts

tests/
  unit/
    recurrence/
    versioning/
    formatters/
  integration/
    db/
    scheduler/
    telegram-adapter/

scripts/
```

ساختار دقیق قابل تغییر است، separation concerns حفظ شود.

---

# 48. Recurrence Engine — الزامات تست

این بخش critical است.

Unit tests حداقل:

### one-time
- future valid
- past invalid

### every N days
- N=1
- N=2
- timezone
- DST

### weekly
- one weekday
- multiple weekdays
- every 2 weeks anchor parity
- cross-year

### monthly day
- day 1
- day 28
- day 29/30/31
- missing day skip
- every N months

### nth weekday
- first Monday
- third Monday
- last Friday
- months with varying layout

### yearly
- normal
- Feb 29 behavior

### end conditions
- until inclusive
- count exact
- unlimited

### merge/dedupe
- two rules same timestamp
- two rules close but different minute → two executions

### pause/resume
- missed paused occurrences not caught up
- original anchor preserved

### version edit
- new version next occurrences
- old pending cancellation
- processing old allowed complete

### missed policy
- skip
- latest only
- catch up + cap

---

# 49. Telegram Adapter Tests

Bot API را mock/fake کن.

Test:

- storage copy
- content order
- album handling
- channel permission failure
- bot removed target
- 429 retry_after
- 5xx retry
- ambiguous timeout → UNKNOWN
- partial package send resume
- callback stale session
- `/cancel`
- unauthorized user

---

# 50. Integration Tests با PostgreSQL

ترجیحاً ephemeral/test DB.

Test:

- unique dedupe under concurrent scheduler workers
- `SKIP LOCKED` claiming
- no duplicate delivery row
- atomic version activation
- crash between execution create and cursor advance
- crash between DeliveryItems
- retry queue
- soft delete
- duplicate reminder independent history

Scheduler integration test باید نشان دهد دو worker همزمان یک due occurrence را دوبار execute نمی‌کنند.

---

# 51. Observability

هر log JSON حداقل:

- timestamp
- level
- event
- reminder_id optional
- version_id optional
- execution_id optional
- delivery_id optional
- target_id optional
- telegram_error_code optional

Token، raw secret یا private message content در logs dump نشود.

Event examples:

```text
reminder.version.activated
scheduler.execution.created
scheduler.execution.deduped
delivery.started
delivery.item.sent
delivery.retry_scheduled
delivery.unknown
target.permission_lost
wizard.cancelled
daily_header.sent
```

---

# 52. Darkube Deployment

هدف deployment باید ساده باشد.

Components:

1. Darkube Service برای Node bot
2. دیتابیس و user مستقل REMI روی PostgreSQL مشترک یا مستقل Darkube
3. Telegram Storage Channel خارجی

Service start:

```text
migrate database
start app
```

ترجیحاً migration step safe و explicit باشد.

## 52.1 Restart

Restart نباید:

- scheduleها را از دست بدهد.
- wizard state ضروری را بی‌دلیل نابود کند.
- delivery موفق را دوباره replay کند.

## 52.2 Filesystem

هیچ state مهمی روی ephemeral filesystem Darkube نباشد.

---

# 53. Security

- Bot token secret.
- DB SSL/config مناسب hosting.
- owner authorization on every private handler/callback.
- callback entity ownership checked.
- SQL parameterized.
- no arbitrary chat ID input in normal UI.
- storage chat inaccessible/public نباشد.
- content logs redacted.
- Telegram IDs با `BIGINT`/safe representation نگهداری شوند؛ در JS بهتر است string/bigint handling بدون precision loss رعایت شود.

---

# 54. Behavior on Bot Startup

Startup sequence:

1. validate env
2. DB connect
3. migrations/version check
4. verify bot token (`getMe`)
5. verify storage chat access
6. start scheduler/worker
7. start update polling
8. ready=true

اگر storage unavailable است:

- creation/edit content که نیاز به archive دارد fail friendly
- existing delivery ممکن است fail
- process لزوماً crash-loop نکند مگر config fundamental invalid باشد.

---

# 55. Product UX Principle

هرجا حالت پیچیده‌ای لازم است، ابتدا ببین آیا با ترکیب primitiveهای ساده حل می‌شود.

مثال:

به‌جای صفحه‌ای با ۳۰ option:

```text
Rule 1
+ Rule 2
+ Rule 3
```

به‌جای یک Content editor حرفه‌ای:

```text
Add
Replace
Delete
Reorder
Edit caption
```

به‌جای schedule-specific content:

```text
REMInder A with Content A
REMInder B with Content B
```

REMI باید powerful باشد چون primitiveها compose می‌شوند، نه چون هر edge case دکمه‌ی مخصوص دارد.

---

# 56. چیزهایی که V1 نباید overengineer کند

- Cron UI
- AI dependency
- Web dashboard
- Mobile app
- Redis/BullMQ فقط برای «شاید بعداً»
- user account / MTProto برای Saved Messages
- schedule-specific content
- forum-topic targets
- complex permissions/roles برای چند کاربر
- trash/recycle-bin حرفه‌ای
- full undo UI
- arbitrary template language
- visual calendar builder
- custom scripting

معماری می‌تواند extension point داشته باشد؛ feature نساز.

---

# 57. قابلیت‌های Future که معماری نباید مسدود کند

- Natural-language Quick Add
- Cron Advanced
- Persian/Jalali recurrence
- multi-user
- rule-level timezone
- undo/restore old REMInderVersion
- richer Daily Header (weather, agenda, etc.)
- webhook + horizontally scaled ingress
- external targets غیر Telegram
- notification preferences
- storage GC
- richer retry/reconciliation UI

---

# 58. Definition of Done — Core V1

V1 Core زمانی قابل قبول است که سناریوی زیر end-to-end کار کند:

1. owner `/start`.
2. REMI مقصدهایی که bot در آن‌ها دسترسی دارد شناسایی می‌کند.
3. owner `/new`.
4. نام وارد می‌کند.
5. چند پیام شامل text/video/photo می‌فرستد.
6. REMI آن‌ها را در Storage archive می‌کند.
7. owner یک Rule «هر دو هفته جمعه ساعت X» می‌سازد.
8. یک Rule ماهانه دیگر اضافه می‌کند.
9. دو Target انتخاب می‌کند.
10. REMI 5 occurrence آینده را درست preview می‌کند.
11. REMInder ساخته و active می‌شود.
12. در زمان due فقط یک Execution درست ساخته می‌شود.
13. Content به‌ترتیب به هر دو Target می‌رسد.
14. اگر دو Rule overlap کنند، duplicate send رخ نمی‌دهد.
15. History نتیجه‌ی هر Target را نشان می‌دهد.
16. owner REMInder را edit می‌کند.
17. Version جدید ساخته و قبلی retire می‌شود.
18. History قدیمی همچنان Version قدیمی را منعکس می‌کند.
19. Pause/Resume چرخه را بدون catch-up زمان pause حفظ می‌کند.
20. Duplicate یک REMInder مستقل و paused می‌سازد.
21. restart app schedule/history را از دست نمی‌دهد.
22. concurrent scheduler claim duplicate execution نمی‌سازد.

---

# 59. Definition of Done — Daily Header

بعد از Core:

1. owner Daily Header config می‌سازد.
2. private/group/channel قابل انتخاب است.
3. هر روز طبق timezone header ارسال می‌شود.
4. header جدید pin می‌شود.
5. فقط header قبلی REMI unpin می‌شود.
6. permission loss gracefully ثبت می‌شود.
7. restart باعث duplicate header همان local day نشود.

برای dedupe Daily Header unique key مثل:

```text
(config_id, local_date)
```

داشته باش.

---

# 60. ترتیب پیاده‌سازی پیشنهادی برای Codex

## Phase 0 — Bootstrap

- Node + TypeScript
- lint/format/test
- config validation
- logging
- PostgreSQL
- migrations
- health endpoints
- basic bot `/start`
- owner gate

**خروجی:** skeleton deployable.

## Phase 1 — Domain + Recurrence

- types/schema Rule
- recurrence engine
- end conditions
- timezone
- preview merge/dedupe
- unit tests گسترده

**هنوز Telegram wizard کامل نساز.**

## Phase 2 — Targets + Storage

- `my_chat_member`
- target registry
- storage verify
- content archive adapter
- basic content capture tests

## Phase 3 — REMInder Creation

- Draft
- wizard persisted
- name/content/rule/target
- final preview
- atomic create Version 1
- `/cancel`

## Phase 4 — Scheduler Core

- cursors
- due claim
- execution dedupe
- delivery rows
- missed policies
- DB concurrency tests

## Phase 5 — Telegram Delivery

- copy/copyMessages
- ordered package
- albums
- delivery item state
- retry/error classification
- History

## Phase 6 — Management

- reminder list
- pause/resume
- run now
- content edit
- rule edit/add/remove/duplicate
- target edit
- immutable version activation
- duplicate reminder
- delete

## Phase 7 — Reliability

- restart tests
- race tests
- partial failures
- UNKNOWN outcome
- rate limit
- permission loss
- logging cleanup

## Phase 8 — Daily Header

- config
- daily scheduler
- pin/unpin previous own message
- dedupe per date
- private/group/channel

## Phase 9 — Darkube polish

- Dockerfile/Nixpacks strategy
- start/migrate docs
- `.env.example`
- README
- deployment steps
- backup notes
- smoke test checklist

---

# 61. نحوه‌ی تحویل هر Phase توسط Codex

برای هر Phase:

1. تغییرات را کوچک و coherent نگه دار.
2. schema/migration را همراه کد بده.
3. testها را اجرا کن.
4. نتیجه‌ی testها را گزارش کن.
5. TODOهای عمدی را واضح بگو.
6. چیزی را که کار نمی‌کند «کامل» اعلام نکن.
7. قبل از Phase بعد، repository باید runnable باشد.

گزارش پیشنهادی:

```text
Implemented:
- ...

Tests:
- X passed
- Y failed (if any)

Architecture notes:
- ...

Remaining for next phase:
- ...
```

---

# 62. README مورد انتظار

README باید شامل:

- REMI چیست
- architecture کوتاه
- prerequisites
- BotFather setup
- Storage Channel setup
- env vars
- PostgreSQL
- local run
- tests
- migration
- Darkube deploy
- permissions لازم برای group/channel
- recovery basics
- known V1 limitations

README نباید جای این spec را بگیرد.

---

# 63. نکات رسمی Telegram Bot API که پیاده‌سازی باید بر اساس آن‌ها باشد

این موارد در زمان تهیه‌ی این سند با مستندات رسمی Telegram Bot API تطبیق داده شده‌اند:

- media موجود روی Telegram را می‌توان با `file_id` بدون re-upload ارسال کرد؛ `file_id` bot-specific است.
- `copyMessage` پیام را بدون link به original کپی می‌کند.
- `copyMessages` تا 100 message ID می‌گیرد و album grouping را حفظ می‌کند.
- برای pin در group حق `can_pin_messages` و در channel حق `can_edit_messages` لازم است.
- `my_chat_member` برای تغییر وضعیت عضویت خود bot در chat قابل استفاده است.
- Telegram chat IDs ممکن است بزرگ باشند؛ type ذخیره‌سازی باید امن باشد.

Reference اصلی:
`https://core.telegram.org/bots/api`

Codex هنگام شروع implementation باید API فعلی را دوباره بررسی کند و اگر Telegram Bot API تغییر کرده بود، adapter را با نسخه‌ی فعلی هماهنگ کند بدون اینکه semantics این سند را تغییر دهد.

---

# 64. تصمیم‌های صریح نهایی که نباید دوباره بدون دلیل تغییر کنند

- اسم: **REMI**
- فارسی: واحد اصلی = **یادآور**
- Private Chat = control center
- REMInder Targets = فقط group/supergroup/channel
- Daily Header می‌تواند private هم باشد
- یک REMInder = یک multi-item Content Package
- چند Schedule Rule روی همان محتوا
- چند Target همزمان
- Ruleها OR
- overlap exact → یک send
- end condition داخل Rule
- one-time / daily-N / weekly-N / monthly / yearly / interval
- UI context-sensitive wizard
- `/cancel` همه جا
- minimal useful commands
- Telegram-backed media storage
- Content order محفوظ
- Targetها بدون chat_id manual
- timezone صریح
- missed-run policy
- default missed policy = Latest Only
- retry/history/idempotency از ابتدا
- Preview next runs
- Run now دستی count را مصرف نمی‌کند
- Pause/Resume
- Duplicate در V1 و نسخه‌ی جدید paused
- structural edit = immutable REMInderVersion جدید
- old Version retire، نه hard delete
- runtime state version جدید نمی‌سازد
- Execution/Delivery تفکیک‌شده
- Rule-level enable/disable structural change است
- UI ساده، composable primitives، نه Advanced explosion
- AI اختیاری و Future
- Cron اختیاری و Future
- Daily Header feature مستقل
- Redis برای V1 لازم نیست
- PostgreSQL source of truth

---

# 65. چند تصمیم ریز که عمداً Deferred هستند

این‌ها مانع شروع کدنویسی Core نیستند و Codex نباید برایشان سیستم پیچیده بسازد:

- wording دقیق تمام دکمه‌های فارسی
- نمایش نهایی شمسی/میلادی
- calendar system قابل انتخاب در UI
- حداکثر تعداد ContentItem/Rule/Target در UI
- UX دقیق drag/reorder (Telegram drag ندارد؛ با move up/down یا روش ساده حل شود)
- notification preferences مالک
- manual retry UI برای UNKNOWN
- retention/GC Storage
- Undo UI
- Daily Header template نهایی
- AI Quick Add

برای هرکدام extension point ساده کافی است.

---

# 66. اولین کار پیشنهادی به Codex

بعد از خواندن کامل این سند، **مستقیماً همه‌ی featureها را یک‌جا نساز**.

اول Phase 0 و Phase 1 را انجام بده:

1. repository و TypeScript project را آماده کن.
2. config + logging + PostgreSQL + migration setup بساز.
3. Domain types Ruleها را تعریف کن.
4. recurrence engine مستقل از Telegram پیاده کن.
5. unit testهای recurrence را کامل کن.
6. یک README اولیه و architecture note بساز.
7. testها را اجرا و نتیجه را گزارش کن.

تا وقتی recurrence و domain semantics درست و تست‌شده نیست، وارد wizard بزرگ Telegram و Scheduler production نشو.

---

## خلاصه‌ی یک‌خطی برای تیم توسعه

> **REMI یک bot شخصی Telegram است که در private chat کنترل می‌شود و بسته‌های چندپیامی را طبق چند Rule ساده و قابل‌ترکیب، به چند گروه/کانال ارسال می‌کند؛ پشت UI ساده، Versioning immutable، PostgreSQL scheduler، Telegram-backed storage و execution/delivery history قابل اتکا قرار دارد.**
