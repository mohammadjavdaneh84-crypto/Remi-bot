/** Parsing/formatting stays outside recurrence; no Jalali recurrence in Phase 1. */
export function normalizeDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (c) =>
    String(c.charCodeAt(0) - (c >= '۰' ? 0x06f0 : 0x0660)),
  );
}
