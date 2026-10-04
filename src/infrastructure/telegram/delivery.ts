import { GrammyError, type Api } from 'grammy';
import type { DeliveryTransport } from '../../app/delivery/worker.js';
import type {
  DeliveryFailure,
  DeliveryUnit,
} from '../../app/delivery/model.js';
import type { ContentKind } from '../../domain/content/archive.js';
import { Targets, TargetUnavailable } from '../../app/services/targets.js';
import { PgTargetRepository } from '../db/targets.js';
import { TelegramTargetInspector } from './targets.js';
import type { Pool } from 'pg';

export class UncertainCopy extends Error {
  constructor(readonly knownIds: number[]) {
    super('Uncertain copy response');
  }
}
export function classifyDelivery(
  error: unknown,
  sending: boolean,
): DeliveryFailure {
  if (error instanceof UncertainCopy)
    return {
      state: 'UNKNOWN',
      code: 'PARTIAL_RESPONSE',
      knownIds: error.knownIds,
    };
  if (error instanceof TargetUnavailable)
    return { state: 'FAILED_PERMANENT', code: 'TARGET_UNAVAILABLE' };
  if (error instanceof GrammyError) {
    if (error.error_code === 429)
      return {
        state: 'FAILED_RETRYABLE',
        code: 'RATE_LIMIT',
        retryAfter: error.parameters.retry_after ?? 1,
      };
    if (error.error_code >= 500)
      return { state: 'FAILED_RETRYABLE', code: 'TELEGRAM_SERVER' };
    const unavailable =
      error.error_code === 403 ||
      /chat not found|not enough rights|bot was kicked/i.test(
        error.description,
      );
    return {
      state: 'FAILED_PERMANENT',
      code: unavailable ? 'TARGET_UNAVAILABLE' : 'COPY_REJECTED',
      targetUnavailable: unavailable,
    };
  }
  // A transport timeout does not prove that Telegram did not accept a copy.
  return sending
    ? { state: 'UNKNOWN', code: 'NETWORK_UNKNOWN' }
    : { state: 'FAILED_RETRYABLE', code: 'PREFLIGHT_TEMPORARY' };
}
export async function copyUnit(
  api: Pick<Api, 'copyMessage' | 'copyMessages'>,
  chatId: string,
  unit: DeliveryUnit,
): Promise<number[]> {
  // grammY types its signal with the abort-controller shim; node-fetch accepts the native signal protocol.
  const signal = AbortSignal.timeout(30_000) as unknown as NonNullable<
    Parameters<Api['copyMessage']>[4]
  >;
  const responses =
    unit.messageIds.length === 1
      ? [
          await api.copyMessage(
            chatId,
            unit.storageChatId,
            unit.messageIds[0]!,
            {},
            signal,
          ),
        ]
      : await api.copyMessages(
          chatId,
          unit.storageChatId,
          unit.messageIds,
          {},
          signal,
        );
  const ids = responses
    .map((r) => r.message_id)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length !== unit.messageIds.length || new Set(ids).size !== ids.length)
    throw new UncertainCopy(ids);
  return ids;
}
export class TelegramDeliveryTransport implements DeliveryTransport {
  constructor(
    private readonly pool: Pool,
    private readonly api: Api,
    private readonly botId: () => number,
  ) {}
  private targets(owner: string) {
    return new Targets(
      owner,
      new PgTargetRepository(this.pool),
      new TelegramTargetInspector(this.api, this.botId),
    );
  }
  check(owner: string, target: string, kinds: ContentKind[]) {
    return this.targets(owner).revalidate(target, kinds);
  }
  copy(chat: string, unit: DeliveryUnit) {
    return copyUnit(this.api, chat, unit);
  }
  classify = classifyDelivery;
  async unavailable(owner: string, target: string) {
    const current = await this.targets(owner).resolve(target);
    await new PgTargetRepository(this.pool).save(owner, {
      ...current,
      reachable: false,
      membership: 'unavailable',
    });
  }
}
