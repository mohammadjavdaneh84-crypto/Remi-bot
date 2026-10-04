import type { ContentKind } from '../content/archive.js';
export interface Permissions {
  readonly send: Readonly<Record<ContentKind, boolean>>;
  readonly canPin: boolean;
}
export interface TargetSnapshot {
  readonly chatId: string;
  readonly type: 'group' | 'supergroup' | 'channel';
  readonly title: string;
  readonly username: string | null;
  readonly membership: string;
  readonly permissions: Permissions;
  readonly reachable: boolean;
}
export interface Target extends TargetSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly migratedToId: string | null;
}
export interface TargetRepository {
  byChat(ownerId: string, chatId: string): Promise<Target | null>;
  byId(ownerId: string, id: string): Promise<Target | null>;
  save(ownerId: string, snapshot: TargetSnapshot): Promise<Target>;
  list(ownerId: string, offset: number, limit: number): Promise<Target[]>;
  migrate(
    ownerId: string,
    oldChatId: string,
    destination: TargetSnapshot,
  ): Promise<void>;
}
