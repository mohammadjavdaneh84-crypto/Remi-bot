import type { CanonicalContent } from '../delivery/model.js';
export type ManagementAction =
  'pause' | 'resume' | 'run' | 'duplicate' | 'delete' | 'preview';
export interface ReminderSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  revision: number;
  timezone: string;
  nextDue: string | null;
  rules: number;
  targets: number;
}
export interface ManagementRepository {
  list(
    owner: string,
    page: number,
  ): Promise<{ rows: ReminderSummary[]; hasNext: boolean }>;
  get(owner: string, id: string): Promise<ReminderSummary | null>;
  act(
    owner: string,
    id: string,
    revision: number,
    action: ManagementAction,
    updateId: number,
    now: string,
  ): Promise<string | null>;
  content(owner: string, id: string): Promise<CanonicalContent[]>;
}
export class ManagementConflict extends Error {}
