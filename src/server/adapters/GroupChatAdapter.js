import path from 'node:path';
import { ChatAdapter } from './ChatAdapter.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolveGroupChatDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.['group chats']
    || dirs?.groupChats
    || (dirs?.user ? path.join(dirs.user, 'group chats') : null)
    || (dirs?.root ? path.join(dirs.root, 'group chats') : null)
    || path.join(process.cwd(), 'data', userHandle, 'group chats');

  const candidates = Array.from(new Set([
    primary,
    dirs?.['group chats'],
    dirs?.groupChats,
    dirs?.user ? path.join(dirs.user, 'group chats') : null,
    dirs?.root ? path.join(dirs.root, 'group chats') : null,
    path.join(process.cwd(), 'data', userHandle, 'group chats'),
  ].filter(Boolean)));

  return { primary, candidates };
}

/**
 * 群聊历史 (Group Chat) 适配器
 * 存放于 data/<user>/group chats/*.jsonl (带空格)
 * 继承 ChatAdapter，采用完全相同的 APPEND_MERGE、N-10 复合键合并及本地优先元数据合并
 * 铁律：400 跨账号分享坚决硬拒
 */
export class GroupChatAdapter extends ChatAdapter {
  constructor() {
    super('group_chat');
  }

  resolveChatDirs(directories) {
    return resolveGroupChatDirs(directories);
  }
}
