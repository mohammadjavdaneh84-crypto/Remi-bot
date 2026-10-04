import { randomBytes, randomUUID } from 'node:crypto';
import {
  emptyWork,
  type Session,
  type View,
  type WizardRepository,
  type WizardUnitOfWork,
} from '../../src/app/wizard/model.js';

export class MemoryWizardRepository implements WizardRepository {
  sessions = new Map<string, Session>();
  receipts = new Set<string>();
  commits = 0;
  timezone = 'Asia/Tehran';
  async run(
    ownerId: string,
    updateId: number,
    operation: (work: WizardUnitOfWork) => Promise<View | null>,
  ) {
    const key = `${ownerId}:${updateId}`;
    if (this.receipts.has(key)) return null;
    const snapshot = structuredClone(this.sessions),
      oldCommits = this.commits;
    try {
      const result = await operation({
        current: async (now) => {
          const s = this.sessions.get(ownerId);
          if (!s || s.status !== 'ACTIVE') return null;
          if (Date.parse(s.expiresAt) <= Date.parse(now)) {
            s.status = 'EXPIRED';
            return null;
          }
          return structuredClone(s);
        },
        create: async (now) => {
          const s: Session = {
            id: randomUUID(),
            token: randomBytes(6).toString('base64url'),
            ownerId,
            revision: 0,
            step: 'NAME',
            status: 'ACTIVE',
            expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
            work: emptyWork(),
            draft: {
              name: '',
              timezone: this.timezone,
              archives: [],
              pending: [],
              rules: [],
              targets: [],
            },
          };
          this.sessions.set(ownerId, structuredClone(s));
          return s;
        },
        save: async (s) => {
          this.sessions.set(ownerId, structuredClone(s));
        },
        commit: async (s) => {
          this.commits++;
          s.status = 'COMMITTED';
          s.revision++;
          this.sessions.set(ownerId, structuredClone(s));
          return randomUUID();
        },
      });
      this.receipts.add(key);
      return result;
    } catch (error) {
      this.sessions = snapshot;
      this.commits = oldCommits;
      throw error;
    }
  }
}
export function findButton(
  view: View | null,
  action: string,
  arg?: string,
): string {
  const suffix = `:${action}${arg === undefined ? '' : ':' + arg}`;
  const found = view?.buttons.flat().find((b) => b.data.endsWith(suffix));
  if (!found) throw new Error(`Button not found ${suffix}: ${view?.text}`);
  return found.data;
}
