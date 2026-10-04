import type { Api } from 'grammy';
import type { Pool } from 'pg';
import type { HeaderTransport } from '../../app/daily-header/model.js';
import { TargetUnavailable, Targets } from '../../app/services/targets.js';
import { PgTargetRepository } from '../db/targets.js';
import { TelegramTargetInspector } from './targets.js';
import { formatDailyHeader } from '../../ui/fa/daily-header.js';

export class TelegramHeaderTransport implements HeaderTransport {
  constructor(
    private readonly pool: Pool,
    private readonly api: Api,
    private readonly botId: () => number,
  ) {}
  async check(
    owner: string,
    target: string | null,
    chat: string,
    pin: boolean,
  ) {
    if (target) {
      const t = await new Targets(
        owner,
        new PgTargetRepository(this.pool),
        new TelegramTargetInspector(this.api, this.botId),
      ).revalidate(target, ['text']);
      if (pin && !t.permissions.canPin)
        throw new TargetUnavailable('Header pin permission missing');
      return { chatId: t.chatId, title: t.title };
    }
    if (
      !(
        await this.pool.query(
          'SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2',
          [owner, chat],
        )
      ).rowCount
    )
      throw new TargetUnavailable('Not owner private chat');
    return { chatId: chat, title: 'پیوی من' };
  }
  async send(chat: string, date: string) {
    return (
      await this.api.sendMessage(
        chat,
        formatDailyHeader(date),
        {},
        AbortSignal.timeout(30_000) as never,
      )
    ).message_id;
  }
  async pin(chat: string, message: number) {
    await this.api.pinChatMessage(
      chat,
      message,
      { disable_notification: true },
      AbortSignal.timeout(30_000) as never,
    );
  }
  async unpin(chat: string, message: number) {
    await this.api.unpinChatMessage(
      chat,
      message,
      {},
      AbortSignal.timeout(30_000) as never,
    );
  }
}
