export interface RuntimeEvent {
  event: string;
  delivery_id?: string;
  execution_id?: string;
  reminder_id?: string;
  target_id?: string;
  config_id?: string;
  code?: string;
}
export type ReportEvent = (event: RuntimeEvent) => void;
/** Diagnostics must never interrupt a committed state transition. */
export function reportSafely(report: ReportEvent, event: RuntimeEvent) {
  try {
    report(event);
  } catch {
    // A failed log sink must not trigger another Telegram send.
  }
}
