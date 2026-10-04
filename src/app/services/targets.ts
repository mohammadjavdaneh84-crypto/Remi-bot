import type {
  Target,
  TargetRepository,
  TargetSnapshot,
} from '../../domain/target/target.js';
import type { ContentKind } from '../../domain/content/archive.js';

export interface TargetInspector {
  inspect(chatId: string): Promise<TargetSnapshot>;
}
export class TargetUnavailable extends Error {}
export class Targets {
  constructor(
    readonly ownerId: string,
    private readonly repository: TargetRepository,
    private readonly inspector: TargetInspector,
  ) {}
  known(chatId: string) {
    return this.repository.byChat(this.ownerId, chatId);
  }
  async discover(snapshot: TargetSnapshot, allowNew: boolean) {
    const known = await this.repository.byChat(this.ownerId, snapshot.chatId);
    if ((!known && !allowNew) || known?.migratedToId) return;
    await this.repository.save(this.ownerId, snapshot);
  }
  list(page = 0) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000)
      throw new Error('Invalid page');
    return this.repository.list(this.ownerId, page * 10, 11);
  }
  async resolve(id: string): Promise<Target> {
    const visited = new Set<string>();
    while (!visited.has(id)) {
      visited.add(id);
      const target = await this.repository.byId(this.ownerId, id);
      if (!target) throw new Error('Target not found');
      if (!target.migratedToId) return target;
      id = target.migratedToId;
    }
    throw new Error('Invalid target redirect');
  }
  async revalidate(
    id: string,
    kinds: readonly ContentKind[] = [],
  ): Promise<Target> {
    const target = await this.resolve(id);
    let snapshot: TargetSnapshot;
    try {
      snapshot = await this.inspector.inspect(target.chatId);
    } catch (error) {
      if (error instanceof TargetUnavailable)
        await this.repository.save(this.ownerId, {
          ...target,
          reachable: false,
          membership: 'unavailable',
        });
      throw error;
    }
    if (snapshot.chatId !== target.chatId)
      throw new Error('Unexpected chat identity');
    const refreshed = await this.repository.save(this.ownerId, snapshot);
    if (
      !refreshed.reachable ||
      kinds.some((kind) => !refreshed.permissions.send[kind])
    )
      throw new TargetUnavailable('Target permission unavailable');
    return refreshed;
  }
  async migrate(oldChatId: string, newChatId: string) {
    const old = await this.repository.byChat(this.ownerId, oldChatId);
    if (
      !old ||
      old.migratedToId ||
      old.type !== 'group' ||
      oldChatId === newChatId
    )
      return;
    let destination: TargetSnapshot;
    try {
      destination = await this.inspector.inspect(newChatId);
      if (destination.type !== 'supergroup' || destination.chatId !== newChatId)
        throw new Error('Invalid destination');
    } catch {
      destination = {
        ...old,
        chatId: newChatId,
        type: 'supergroup',
        reachable: false,
        membership: 'unknown',
        permissions: {
          canPin: false,
          send: {
            text: false,
            photo: false,
            video: false,
            animation: false,
            document: false,
            audio: false,
            voice: false,
            video_note: false,
            sticker: false,
          },
        },
      };
    }
    await this.repository.migrate(this.ownerId, oldChatId, destination);
  }
}
