/** Formatting is deliberately separate from recurrence/calendar semantics. */
export function formatDailyHeader(localDate: string) {
  const date = new Date(`${localDate}T12:00:00Z`);
  return (
    '📅 امروز\n' +
    new Intl.DateTimeFormat('fa-IR-u-ca-gregory', {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date)
  );
}
