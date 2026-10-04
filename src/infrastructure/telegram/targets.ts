import { GrammyError, type Api } from 'grammy';
import type { Chat, ChatMemberUpdated } from 'grammy/types';
import type { Targets, TargetInspector } from '../../app/services/targets.js';
import { TargetUnavailable } from '../../app/services/targets.js';
import { targetSnapshot } from './permissions.js';

export class TelegramTargetInspector implements TargetInspector {
  constructor(
    private readonly api: Pick<Api, 'getChat' | 'getChatMember'>,
    private readonly botId: () => number,
  ) {}
  async inspect(chatId: string) {
    try {
      const chat = await this.api.getChat(chatId);
      const member = await this.api.getChatMember(chatId, this.botId());
      return targetSnapshot(chat, member);
    } catch (error) {
      if (
        error instanceof GrammyError &&
        (error.error_code === 403 ||
          (error.error_code === 400 &&
            /chat not found/i.test(error.description)))
      )
        throw new TargetUnavailable();
      throw error;
    }
  }
}
export async function handleMembership(
  update: ChatMemberUpdated,
  targets: Targets,
  api: Pick<Api, 'getChat'>,
  ownerTelegramId: string,
  storageChatId: string,
) {
  if (
    update.chat.type === 'private' ||
    String(update.chat.id) === storageChatId
  )
    return;
  const known = await targets.known(String(update.chat.id));
  if (
    known?.migratedToId ||
    (!known && String(update.from.id) !== ownerTelegramId)
  )
    return;
  let chat: Chat = update.chat;
  // On removal Telegram may no longer allow getChat. The membership event is sufficient.
  if (!['left', 'kicked'].includes(update.new_chat_member.status)) {
    try {
      chat = await api.getChat(update.chat.id);
    } catch (error) {
      // Do not replace a known permission snapshot on a transient API outage.
      if (
        known &&
        (!(error instanceof GrammyError) ||
          ![400, 403].includes(error.error_code))
      )
        throw error;
    }
  }
  await targets.discover(
    targetSnapshot(chat, update.new_chat_member),
    String(update.from.id) === ownerTelegramId,
  );
}
