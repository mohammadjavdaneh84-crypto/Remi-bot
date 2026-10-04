import type { HeaderSettings } from '../../domain/daily-header/schedule.js';
export interface HeaderConfig extends HeaderSettings {
  id: string;
  ownerId: string;
  targetId: string | null;
  chatId: string;
  title: string;
  enabled: boolean;
  revision: number;
  nextDue: Date;
}
export interface HeaderDraft extends HeaderSettings {
  step: 'TARGET' | 'TIME' | 'TIMEZONE' | 'PIN' | 'CONFIRM';
  configId: string | null;
  baseRevision: number | null;
  targetId: string | null;
  chatId: string;
  title: string;
}
export interface HeaderSession {
  token: string;
  revision: number;
  payload: HeaderDraft;
}
export interface HeaderTransport {
  check(
    owner: string,
    target: string | null,
    chat: string,
    pin: boolean,
  ): Promise<{ chatId: string; title: string }>;
  send(chat: string, localDate: string): Promise<number>;
  pin(chat: string, message: number): Promise<void>;
  unpin(chat: string, message: number): Promise<void>;
}
export class HeaderConflict extends Error {
  constructor(
    message = 'این دکمه قدیمی است یا تنظیمات اکنون در حال اجراست؛ /daily را دوباره باز کنید.',
  ) {
    super(message);
  }
}
