import path from 'node:path';
import { DirectoryJsonConfigAdapter } from './P0Adapters.js';
import { ReloadStrategy } from '../../common/constants.js';

const resolveUserDirs = (dirs, dirKey, subDirName) => {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.[dirKey]
    || dirs?.[subDirName]
    || (dirs?.root ? path.join(dirs.root, subDirName) : null)
    || (dirs?.user ? path.join(dirs.user, subDirName) : null)
    || path.join(process.cwd(), 'data', userHandle, subDirName);

  const candidates = Array.from(new Set([
    primary,
    dirs?.[dirKey],
    dirs?.[subDirName],
    dirs?.root ? path.join(dirs.root, subDirName) : null,
    dirs?.user ? path.join(dirs.user, subDirName) : null,
    path.join(process.cwd(), 'data', userHandle, subDirName),
  ].filter(Boolean)));

  return { primary, candidates };
};

/**
 * 创建 Phase 1 纯 JSON 扩展适配器实例字典 (instruct, context, sysprompt, quick_replies)
 * @returns {Map<string, DirectoryJsonConfigAdapter>}
 */
export function createP1Adapters() {
  const adapters = new Map();

  // 1. Instruct 预设
  adapters.set(
    'instruct',
    new DirectoryJsonConfigAdapter(
      'instruct',
      (dirs) => resolveUserDirs(dirs, 'instruct', 'instruct').primary,
      (dirs) => resolveUserDirs(dirs, 'instruct', 'instruct').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // 2. Context 上下文预设
  adapters.set(
    'context',
    new DirectoryJsonConfigAdapter(
      'context',
      (dirs) => resolveUserDirs(dirs, 'context', 'context').primary,
      (dirs) => resolveUserDirs(dirs, 'context', 'context').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // 3. Sysprompt 系统提示词预设
  adapters.set(
    'sysprompt',
    new DirectoryJsonConfigAdapter(
      'sysprompt',
      (dirs) => resolveUserDirs(dirs, 'sysprompt', 'sysprompt').primary,
      (dirs) => resolveUserDirs(dirs, 'sysprompt', 'sysprompt').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // 4. Quick Replies 快捷回复
  adapters.set(
    'quick_replies',
    new DirectoryJsonConfigAdapter(
      'quick_replies',
      (dirs) => resolveUserDirs(dirs, 'quickReplies', 'QuickReplies').primary,
      (dirs) => {
        const { candidates } = resolveUserDirs(dirs, 'quickReplies', 'QuickReplies');
        const userHandle = dirs?.handle || 'default-user';
        candidates.push(path.join(process.cwd(), 'data', userHandle, 'quick_replies'));
        return Array.from(new Set(candidates));
      },
      ReloadStrategy.NONE
    )
  );

  return adapters;
}
