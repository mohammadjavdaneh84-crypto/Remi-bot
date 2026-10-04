import { createHash } from 'node:crypto';
import { GrammyError } from 'grammy';
import type { Message } from 'grammy/types';
import type {
  Archive,
  ArchiveRepository,
  CapturedItem,
  ContentKind,
} from '../../../domain/content/archive.js';
import { verifyStorage, type StorageApi } from './verify.js';

export type CaptureError =
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED'
  | 'INVALID_ALBUM'
  | 'STORAGE_UNAVAILABLE'
  | 'COPY_REJECTED'
  | 'TEMPORARY'
  | 'UNKNOWN';
export type CaptureResult =
  | { ok: true; archive: Archive }
  | { ok: false; code: CaptureError; message: string };
const messages: Record<CaptureError, string> = {
  UNAUTHORIZED: 'دریافت محتوا فقط در پیوی مالک مجاز است.',
  UNSUPPORTED:
    'این نوع پیام فعلاً قابل ذخیره‌سازی نیست؛ بقیهٔ محتوا محفوظ مانده است.',
  INVALID_ALBUM: 'آلبوم کامل دریافت نشده است؛ لطفاً آن را دوباره بفرستید.',
  STORAGE_UNAVAILABLE:
    'ذخیره‌سازی موقتاً در دسترس نیست؛ بقیهٔ محتوا محفوظ مانده است.',
  COPY_REJECTED:
    'تلگرام اجازهٔ ذخیرهٔ این محتوا را نداد؛ بقیهٔ محتوا محفوظ مانده است.',
  TEMPORARY:
    'ذخیره‌سازی موقتاً ناموفق بود؛ لطفاً بعداً محتوا را دوباره بفرستید.',
  UNKNOWN:
    'نتیجهٔ ذخیره‌سازی مشخص نیست؛ برای جلوگیری از کپی تکراری، دوباره تلاش خودکار نشد.',
};
const failure = (code: CaptureError): CaptureResult => ({
  ok: false,
  code,
  message: messages[code],
});

export function captureItem(message: Message): CapturedItem | null {
  if (
    message.has_protected_content ||
    'paid_media' in message ||
    'invoice' in message ||
    !Number.isSafeInteger(message.message_id) ||
    message.message_id <= 0
  )
    return null;
  let kind: ContentKind;
  let file: { file_id: string; file_unique_id: string } | undefined;
  if ('animation' in message) {
    kind = 'animation';
    file = message.animation;
  } else if ('photo' in message) {
    kind = 'photo';
    file = message.photo.at(-1);
  } else if ('video' in message) {
    kind = 'video';
    file = message.video;
  } else if ('document' in message) {
    kind = 'document';
    file = message.document;
  } else if ('audio' in message) {
    kind = 'audio';
    file = message.audio;
  } else if ('voice' in message) {
    kind = 'voice';
    file = message.voice;
  } else if ('video_note' in message) {
    kind = 'video_note';
    file = message.video_note;
  } else if ('sticker' in message) {
    kind = 'sticker';
    file = message.sticker;
  } else if ('text' in message) kind = 'text';
  else return null;
  if (kind !== 'text' && !file) return null;
  return {
    sourceMessageId: message.message_id,
    kind,
    fileId: file?.file_id ?? null,
    fileUniqueId: file?.file_unique_id ?? null,
    mediaGroupKey:
      'media_group_id' in message ? (message.media_group_id ?? null) : null,
    metadata: {
      text: 'text' in message ? message.text : null,
      entities: 'entities' in message ? (message.entities ?? []) : [],
      caption: 'caption' in message ? (message.caption ?? null) : null,
      captionEntities:
        'caption_entities' in message ? (message.caption_entities ?? []) : [],
      showCaptionAboveMedia:
        'show_caption_above_media' in message &&
        message.show_caption_above_media === true,
      hasSpoiler:
        'has_media_spoiler' in message && message.has_media_spoiler === true,
      editDate: message.edit_date ?? null,
    },
  };
}

/** One standalone message or one complete album; the persisted wizard owns collection/flush. */
export class ContentCapture {
  constructor(
    private readonly api: StorageApi,
    private readonly repository: ArchiveRepository,
    private readonly ownerId: string,
    private readonly ownerTelegramId: string,
    private readonly storageChatId: string,
    private readonly botId: () => number,
  ) {}

  async archiveUnit(input: readonly Message[]): Promise<CaptureResult> {
    if (!input.length || input.length > 10) return failure('INVALID_ALBUM');
    if (
      input.some(
        (m) =>
          m.chat.type !== 'private' ||
          String(m.chat.id) !== this.ownerTelegramId ||
          String(m.from?.id) !== this.ownerTelegramId,
      )
    )
      return failure('UNAUTHORIZED');
    const sorted = [...input].sort((a, b) => a.message_id - b.message_id);
    const extracted = sorted.map(captureItem);
    if (extracted.some((item) => item === null)) return failure('UNSUPPORTED');
    const items = extracted as CapturedItem[];
    const album = items[0]!.mediaGroupKey;
    if (
      new Set(items.map((i) => i.sourceMessageId)).size !== items.length ||
      (album
        ? items.length < 2 ||
          items.some(
            (i) =>
              i.mediaGroupKey !== album ||
              !['photo', 'video', 'audio', 'document'].includes(i.kind),
          )
        : items.length !== 1)
    )
      return failure('INVALID_ALBUM');
    if (
      album &&
      ((items.some((i) => i.kind === 'audio') &&
        items.some((i) => i.kind !== 'audio')) ||
        (items.some((i) => i.kind === 'document') &&
          items.some((i) => i.kind !== 'document')))
    )
      return failure('INVALID_ALBUM');
    try {
      await verifyStorage(
        this.api,
        this.storageChatId,
        this.botId(),
        items.map((i) => i.kind),
      );
    } catch {
      return failure('STORAGE_UNAVAILABLE');
    }
    const sourceKey = createHash('sha256')
      .update(JSON.stringify([this.storageChatId, this.ownerTelegramId, items]))
      .digest('hex');
    let claimed: Awaited<ReturnType<ArchiveRepository['claim']>>;
    try {
      claimed = await this.repository.claim(
        this.ownerId,
        sourceKey,
        this.ownerTelegramId,
        this.storageChatId,
      );
    } catch {
      // No copy has started, and the caller can keep its existing draft intact.
      return failure('TEMPORARY');
    }
    if (!claimed.acquired) {
      if (claimed.archive.state === 'READY')
        return { ok: true, archive: claimed.archive };
      if (claimed.archive.state === 'REJECTED')
        return failure(
          claimed.archive.errorCode === 'TEMPORARY'
            ? 'TEMPORARY'
            : 'COPY_REJECTED',
        );
      return failure('UNKNOWN');
    }
    let copiedIds: number[] = [];
    try {
      const copied = album
        ? await this.api.copyMessages(
            this.storageChatId,
            this.ownerTelegramId,
            items.map((i) => i.sourceMessageId),
          )
        : [
            await this.api.copyMessage(
              this.storageChatId,
              this.ownerTelegramId,
              items[0]!.sourceMessageId,
            ),
          ];
      copiedIds = copied.map((m) => m.message_id);
      // copyMessages silently skips uncopyable messages, making positional mapping unsafe.
      if (
        copiedIds.length !== items.length ||
        new Set(copiedIds).size !== items.length ||
        copiedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      )
        throw new Error('Partial copy');
      const archive = await this.repository.complete(
        claimed.archive.id,
        this.ownerId,
        items.map((item, position) => ({
          ...item,
          position,
          storageMessageId: copiedIds[position]!,
        })),
      );
      return { ok: true, archive };
    } catch (error) {
      const rejected =
        error instanceof GrammyError &&
        error.error_code >= 400 &&
        error.error_code < 500;
      const code: CaptureError = rejected
        ? error.error_code === 429
          ? 'TEMPORARY'
          : 'COPY_REJECTED'
        : 'UNKNOWN';
      try {
        await this.repository.fail(
          claimed.archive.id,
          this.ownerId,
          rejected ? 'REJECTED' : 'UNKNOWN',
          code,
          copiedIds,
        );
      } catch {
        /* COPYING remains non-replayable if persistence is unavailable. */
      }
      return failure(code);
    }
  }
}
