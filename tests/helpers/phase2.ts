import { randomUUID } from 'node:crypto';
import { Api } from 'grammy';
import type {
  Message,
  ChatFullInfo,
  ChatMember,
  UserFromGetMe,
} from 'grammy/types';
import type {
  Archive,
  ArchiveRepository,
  ArchivedItem,
} from '../../src/domain/content/archive.js';
import { contentKinds } from '../../src/domain/content/archive.js';
import type {
  Target,
  TargetRepository,
  TargetSnapshot,
} from '../../src/domain/target/target.js';

export const botInfo: UserFromGetMe = {
  id: 456,
  is_bot: true,
  first_name: 'REMI',
  username: 'remi_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
export const allSend = Object.fromEntries(
  contentKinds.map((k) => [k, true]),
) as Record<(typeof contentKinds)[number], boolean>;
export const snapshot: TargetSnapshot = {
  chatId: '-1001',
  type: 'channel',
  title: 'Target',
  username: null,
  membership: 'administrator',
  reachable: true,
  permissions: { send: allSend, canPin: true },
};
export const chat = {
  id: -1001,
  type: 'channel',
  title: 'Storage',
  accent_color_id: 0,
  max_reaction_count: 1,
  accepted_gift_types: {
    unlimited_gifts: false,
    limited_gifts: false,
    unique_gifts: false,
    premium_subscription: false,
  },
} as ChatFullInfo;
export const admin = {
  user: botInfo,
  status: 'administrator',
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: true,
} as unknown as ChatMember;
export function textMessage(id = 1): Message {
  return {
    message_id: id,
    date: 1,
    chat: { id: 123, type: 'private', first_name: 'Owner' },
    from: { id: 123, is_bot: false, first_name: 'Owner' },
    text: `text ${id}`,
  };
}
export function mediaMessage(kind: string, id = 1, group?: string): Message {
  const { text: _text, ...base } = textMessage(id) as Message.TextMessage;
  void _text;
  const file = {
    file_id: `${kind}-id`,
    file_unique_id: `${kind}-unique`,
    width: 1,
    height: 1,
    duration: 1,
    type: 'regular',
    is_animated: false,
    is_video: false,
  };
  return {
    ...base,
    [kind]: kind === 'photo' ? [file] : file,
    ...(group ? { media_group_id: group } : {}),
  } as Message;
}
export function fakeApi(
  handler?: (method: string, payload: Record<string, unknown>) => unknown,
) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api('123:test-token');
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result = handler
      ? handler(method, payload)
      : method === 'getChat'
        ? chat
        : method === 'getChatMember'
          ? admin
          : method === 'copyMessages'
            ? (payload as { message_ids: number[] }).message_ids.map((id) => ({
                message_id: id + 100,
              }))
            : { message_id: 101 };
    return { ok: true, result } as never;
  });
  return { api, calls };
}
export class MemoryArchives implements ArchiveRepository {
  entries = new Map<string, Archive>();
  keys = new Map<string, string>();
  async claim(
    ownerId: string,
    key: string,
    _sourceChatId: string,
    storageChatId: string,
  ) {
    const existing = this.keys.get(`${ownerId}:${key}`);
    if (existing)
      return { acquired: false, archive: this.entries.get(existing)! };
    const archive: Archive = {
      id: randomUUID(),
      ownerId,
      storageChatId,
      state: 'COPYING',
      errorCode: null,
      items: [],
    };
    this.entries.set(archive.id, archive);
    this.keys.set(`${ownerId}:${key}`, archive.id);
    return { acquired: true, archive };
  }
  async complete(id: string, ownerId: string, items: readonly ArchivedItem[]) {
    const old = this.entries.get(id)!;
    if (old.ownerId !== ownerId || old.state !== 'COPYING')
      throw new Error('Not writable');
    const archive: Archive = { ...old, items, state: 'READY' };
    this.entries.set(id, archive);
    return archive;
  }
  async fail(
    id: string,
    ownerId: string,
    state: 'REJECTED' | 'UNKNOWN',
    code: string,
  ) {
    const old = this.entries.get(id)!;
    if (old.ownerId === ownerId && old.state === 'COPYING')
      this.entries.set(id, { ...old, state, errorCode: code });
  }
}
export class MemoryTargets implements TargetRepository {
  entries = new Map<string, Target>();
  async byChat(ownerId: string, chatId: string) {
    return (
      [...this.entries.values()].find(
        (r) => r.ownerId === ownerId && r.chatId === chatId,
      ) ?? null
    );
  }
  async byId(ownerId: string, id: string) {
    const row = this.entries.get(id);
    return row?.ownerId === ownerId ? row : null;
  }
  async save(ownerId: string, s: TargetSnapshot) {
    const old = await this.byChat(ownerId, s.chatId);
    if (old?.migratedToId) return old;
    const row: Target = {
      ...s,
      ownerId,
      id: old?.id ?? randomUUID(),
      migratedToId: null,
    };
    this.entries.set(row.id, row);
    return row;
  }
  async list(ownerId: string, offset: number, limit: number) {
    return [...this.entries.values()]
      .filter((r) => r.ownerId === ownerId && !r.migratedToId)
      .slice(offset, offset + limit);
  }
  async migrate(
    ownerId: string,
    oldChatId: string,
    destination: TargetSnapshot,
  ) {
    const old = await this.byChat(ownerId, oldChatId);
    if (!old || old.migratedToId) return;
    const next = await this.save(ownerId, destination);
    this.entries.set(old.id, {
      ...old,
      reachable: false,
      migratedToId: next.id,
    });
  }
}
