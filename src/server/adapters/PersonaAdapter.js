import path from 'node:path';
import { DirectoryJsonConfigAdapter } from './P0Adapters.js';
import { MergeStrategy } from './ConfigAdapter.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolvePersonaDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.personas
    || (dirs?.root ? path.join(dirs.root, 'personas') : null)
    || (dirs?.user ? path.join(dirs.user, 'personas') : null)
    || path.join(process.cwd(), 'data', userHandle, 'personas');

  const candidates = Array.from(new Set([
    primary,
    dirs?.personas,
    dirs?.root ? path.join(dirs.root, 'personas') : null,
    dirs?.user ? path.join(dirs.user, 'personas') : null,
    path.join(process.cwd(), 'data', userHandle, 'personas'),
  ].filter(Boolean)));

  return { primary, candidates };
}

/**
 * 用户人设 (Persona) 适配器
 * 存放于 data/<user>/personas/*.json
 * 遵循 REPLACE 写入策略，覆盖前自动生成 .bak 备份
 */
export class PersonaAdapter extends DirectoryJsonConfigAdapter {
  constructor() {
    super(
      'persona',
      (dirs) => resolvePersonaDirs(dirs).primary,
      (dirs) => resolvePersonaDirs(dirs).candidates,
      ReloadStrategy.NONE,
      MergeStrategy.REPLACE
    );
  }
}
