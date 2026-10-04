import type {
  Chat,
  ChatFullInfo,
  ChatMember,
  ChatPermissions,
} from 'grammy/types';
import {
  contentKinds,
  type ContentKind,
} from '../../domain/content/archive.js';
import type {
  Permissions,
  TargetSnapshot,
} from '../../domain/target/target.js';

const fields: Record<ContentKind, keyof ChatPermissions> = {
  text: 'can_send_messages',
  photo: 'can_send_photos',
  video: 'can_send_videos',
  animation: 'can_send_other_messages',
  document: 'can_send_documents',
  audio: 'can_send_audios',
  voice: 'can_send_voice_notes',
  video_note: 'can_send_video_notes',
  sticker: 'can_send_other_messages',
};
export function permissions(
  chat: Chat | ChatFullInfo,
  member: ChatMember,
): Permissions {
  const present =
    member.status !== 'left' &&
    member.status !== 'kicked' &&
    (member.status !== 'restricted' || member.is_member);
  const admin =
    member.status === 'creator' || member.status === 'administrator';
  const defaults = 'permissions' in chat ? chat.permissions : undefined;
  const rights = member.status === 'restricted' ? member : defaults;
  const channelPost =
    member.status === 'creator' ||
    (member.status === 'administrator' && member.can_post_messages === true);
  const send = Object.fromEntries(
    contentKinds.map((kind) => [
      kind,
      present &&
        (chat.type === 'channel'
          ? channelPost
          : admin || rights?.[fields[kind]] === true),
    ]),
  ) as Record<ContentKind, boolean>;
  const canPin =
    present &&
    (member.status === 'creator' ||
      (member.status === 'administrator' &&
        (chat.type === 'channel'
          ? member.can_edit_messages === true
          : member.can_pin_messages === true)));
  return { send, canPin };
}
export function targetSnapshot(
  chat: Chat | ChatFullInfo,
  member: ChatMember,
): TargetSnapshot {
  if (chat.type === 'private')
    throw new Error('Private chats are not reminder targets');
  if (!Number.isSafeInteger(chat.id))
    throw new Error('Unsafe Telegram chat ID');
  return {
    chatId: String(chat.id),
    type: chat.type,
    title: chat.title,
    username: 'username' in chat ? (chat.username ?? null) : null,
    membership: member.status,
    permissions: permissions(chat, member),
    reachable:
      member.status !== 'left' &&
      member.status !== 'kicked' &&
      (member.status !== 'restricted' || member.is_member),
  };
}
