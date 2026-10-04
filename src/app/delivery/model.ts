import type { ContentKind } from '../../domain/content/archive.js';

export type FailureState = 'FAILED_RETRYABLE' | 'FAILED_PERMANENT' | 'UNKNOWN';
export interface DeliveryFailure {
  state: FailureState;
  code: string;
  retryAfter?: number;
  targetUnavailable?: boolean;
  knownIds?: number[];
}
export interface DeliveryUnit {
  id: string;
  sequence: number;
  contentIds: string[];
  storageChatId: string;
  messageIds: number[];
  kinds: ContentKind[];
  state: string;
  attempts: number;
}
export interface DeliverySession {
  id: string;
  ownerId: string;
  targetId: string;
  attempts: number;
  units: DeliveryUnit[];
  destination(target: {
    id: string;
    chatId: string;
    title: string;
  }): Promise<boolean>;
  sending(unit: DeliveryUnit, chatId: string): Promise<void>;
  sent(unit: DeliveryUnit, messageIds: number[]): Promise<void>;
  fail(
    unit: DeliveryUnit | null,
    failure: DeliveryFailure,
    nextAttempt: string | null,
  ): Promise<void>;
  complete(): Promise<void>;
}
export interface DeliveryRepository {
  runNext(
    now: string,
    work: (session: DeliverySession) => Promise<void>,
  ): Promise<boolean>;
}

export interface CanonicalContent {
  id: string;
  archiveId: string;
  archivePosition: number;
  storageChatId: string;
  messageId: number;
  kind: ContentKind;
  album: string | null;
}
/** A standalone item or a contiguous canonical album is one durable retry unit. */
export function deliveryUnits(
  content: CanonicalContent[],
): Omit<DeliveryUnit, 'id'>[] {
  const result: Omit<DeliveryUnit, 'id'>[] = [];
  for (const [index, item] of content.entries()) {
    if (!Number.isSafeInteger(item.messageId) || item.messageId < 1)
      throw new Error('Invalid canonical message ID');
    const previous = content[index - 1];
    const sameAlbum =
      item.album &&
      previous?.album === item.album &&
      previous.archiveId === item.archiveId &&
      previous.storageChatId === item.storageChatId &&
      previous.archivePosition + 1 === item.archivePosition;
    if (sameAlbum) {
      const unit = result.at(-1)!;
      if (
        unit.messageIds.at(-1)! >= item.messageId ||
        unit.messageIds.length >= 10
      )
        throw new Error('Invalid canonical album order');
      unit.contentIds.push(item.id);
      unit.messageIds.push(item.messageId);
      unit.kinds.push(item.kind);
    } else
      result.push({
        sequence: result.length,
        contentIds: [item.id],
        storageChatId: item.storageChatId,
        messageIds: [item.messageId],
        kinds: [item.kind],
        state: 'PENDING',
        attempts: 0,
      });
  }
  return result;
}

export function retryAt(
  now: string,
  attempt: number,
  retryAfter = 0,
  random = Math.random,
): string {
  const delay = Math.max(
    Math.min(300_000, 1000 * 2 ** Math.min(20, Math.max(0, attempt - 1))),
    Math.max(0, retryAfter) * 1000,
  );
  return new Date(
    Date.parse(now) + delay + Math.floor(random() * 250),
  ).toISOString();
}
