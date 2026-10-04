import type { Api } from 'grammy';
import type { ContentKind } from '../../../domain/content/archive.js';
import { permissions } from '../permissions.js';

export type StorageApi = Pick<
  Api,
  'getChat' | 'getChatMember' | 'copyMessage' | 'copyMessages'
>;
export class StorageUnavailable extends Error {
  constructor() {
    super('Storage is unavailable or lacks required permissions');
  }
}
export async function verifyStorage(
  api: Pick<Api, 'getChat' | 'getChatMember'>,
  chatId: string,
  botId: number,
  kinds: readonly ContentKind[],
) {
  try {
    const chat = await api.getChat(chatId);
    if (
      (chat.type !== 'channel' && chat.type !== 'supergroup') ||
      String(chat.id) !== chatId ||
      chat.username ||
      chat.active_usernames?.length ||
      chat.has_protected_content
    )
      throw new StorageUnavailable();
    const member = await api.getChatMember(chatId, botId);
    if (
      member.status === 'left' ||
      member.status === 'kicked' ||
      (member.status === 'restricted' && !member.is_member)
    )
      throw new StorageUnavailable();
    const rights = permissions(chat, member);
    if (!kinds.every((kind) => rights.send[kind]))
      throw new StorageUnavailable();
    return rights;
  } catch {
    throw new StorageUnavailable();
  }
}
