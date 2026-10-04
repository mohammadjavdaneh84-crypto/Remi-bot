export interface HistoryEntry {
  id: string;
  reminderId: string;
  name: string;
  timezone: string;
  scheduledFor: string;
  trigger: string;
  state: string;
  deliveries: {
    title: string;
    state: string;
    error: string | null;
    sent: number;
    total: number;
    nextAttempt: string | null;
  }[];
}
export interface HistoryRepository {
  page(
    owner: string,
    page: number,
    reminder?: string,
  ): Promise<{ entries: HistoryEntry[]; hasNext: boolean }>;
}
