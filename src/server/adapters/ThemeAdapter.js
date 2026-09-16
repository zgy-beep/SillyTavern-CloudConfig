import path from 'node:path';
import { DirectoryJsonConfigAdapter } from './P0Adapters.js';
import { MergeStrategy } from './ConfigAdapter.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolveThemeDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.themes
    || (dirs?.root ? path.join(dirs.root, 'themes') : null)
    || (dirs?.user ? path.join(dirs.user, 'themes') : null)
    || path.join(process.cwd(), 'data', userHandle, 'themes');

  const candidates = Array.from(new Set([
    primary,
    dirs?.themes,
    dirs?.root ? path.join(dirs.root, 'themes') : null,
    dirs?.user ? path.join(dirs.user, 'themes') : null,
    path.join(process.cwd(), 'data', userHandle, 'themes'),
    path.join(process.cwd(), 'public', 'themes'),
    path.join(process.cwd(), 'themes'),
  ].filter(Boolean)));

  return { primary, candidates };
}

/**
 * 主题 (Theme) 适配器
 * 遵循 REPLACE 写入策略，覆盖前自动生成 .bak 备份
 */
export class ThemeAdapter extends DirectoryJsonConfigAdapter {
  constructor() {
    super(
      'theme',
      (dirs) => resolveThemeDirs(dirs).primary,
      (dirs) => resolveThemeDirs(dirs).candidates,
      ReloadStrategy.NONE,
      MergeStrategy.REPLACE
    );
  }
}
