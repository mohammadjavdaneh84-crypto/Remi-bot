export const contentKinds = [
  'text',
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'video_note',
  'sticker',
] as const;
export type ContentKind = (typeof contentKinds)[number];
export interface CapturedItem {
  readonly sourceMessageId: number;
  readonly kind: ContentKind;
  readonly fileId: string | null;
  readonly fileUniqueId: string | null;
  readonly mediaGroupKey: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface ArchivedItem extends CapturedItem {
  readonly position: number;
  readonly storageMessageId: number;
}
export type ArchiveState = 'COPYING' | 'READY' | 'REJECTED' | 'UNKNOWN';
export interface Archive {
  readonly id: string;
  readonly ownerId: string;
  readonly storageChatId: string;
  readonly state: ArchiveState;
  readonly errorCode: string | null;
  readonly items: readonly ArchivedItem[];
}
export interface ArchiveRepository {
  claim(
    ownerId: string,
    sourceKey: string,
    sourceChatId: string,
    storageChatId: string,
  ): Promise<{ acquired: boolean; archive: Archive }>;
  complete(
    id: string,
    ownerId: string,
    items: readonly ArchivedItem[],
  ): Promise<Archive>;
  fail(
    id: string,
    ownerId: string,
    state: 'REJECTED' | 'UNKNOWN',
    code: string,
    copiedIds: readonly number[],
  ): Promise<void>;
}
