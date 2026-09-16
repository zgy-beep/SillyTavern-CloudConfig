import { CharacterAdapter } from './CharacterAdapter.js';
import { ThemeAdapter } from './ThemeAdapter.js';

/**
 * 创建 Phase 2 资产适配器实例字典 (character, theme)
 * @returns {Map<string, import('./ConfigAdapter.js').ConfigAdapter>}
 */
export function createP2Adapters() {
  const adapters = new Map();
  adapters.set('character', new CharacterAdapter());
  adapters.set('theme', new ThemeAdapter());
  return adapters;
}
