import path from 'node:path';
import { DirectoryJsonConfigAdapter } from './P0Adapters.js';
import { MergeStrategy } from './ConfigAdapter.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolveGroupDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.groups
    || (dirs?.root ? path.join(dirs.root, 'groups') : null)
    || (dirs?.user ? path.join(dirs.user, 'groups') : null)
    || path.join(process.cwd(), 'data', userHandle, 'groups');

  const candidates = Array.from(new Set([
    primary,
    dirs?.groups,
    dirs?.root ? path.join(dirs.root, 'groups') : null,
    dirs?.user ? path.join(dirs.user, 'groups') : null,
    path.join(process.cwd(), 'data', userHandle, 'groups'),
  ].filter(Boolean)));

  return { primary, candidates };
}

/**
 * 群组定义 (Group) 适配器
 * 存放于 data/<user>/groups/*.json
 * 遵循 REPLACE 写入策略，覆盖前自动生成 .bak 备份
 */
export class GroupAdapter extends DirectoryJsonConfigAdapter {
  constructor() {
    super(
      'group',
      (dirs) => resolveGroupDirs(dirs).primary,
      (dirs) => resolveGroupDirs(dirs).candidates,
      ReloadStrategy.NONE,
      MergeStrategy.REPLACE
    );
  }
}
