import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { timezoneSchema } from '../schedule/rule.js';

export const headerSettingsSchema = z.object({
  timezone: timezoneSchema,
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  pin: z.boolean(),
});
export type HeaderSettings = z.infer<typeof headerSettingsSchema>;
/** Latest local day only. Temporal compatible resolves gaps forward and overlaps earlier. */
export function headerDay(now: string, settings: HeaderSettings) {
  const local = Temporal.Instant.from(now).toZonedDateTimeISO(
    settings.timezone,
  );
  const date = local.toPlainDate();
  const at = date
    .toPlainDateTime(settings.localTime)
    .toZonedDateTime(settings.timezone, { disambiguation: 'compatible' });
  const next = date
    .add({ days: 1 })
    .toPlainDateTime(settings.localTime)
    .toZonedDateTime(settings.timezone, { disambiguation: 'compatible' });
  return {
    date: date.toString(),
    due: Temporal.Instant.compare(at.toInstant(), now) <= 0,
    at: at.toInstant().toString(),
    next: next.toInstant().toString(),
  };
}
