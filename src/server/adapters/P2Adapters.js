import { CharacterAdapter } from './CharacterAdapter.js';
import { ThemeAdapter } from './ThemeAdapter.js';
import { ChatAdapter } from './ChatAdapter.js';
import { BackgroundAdapter } from './BackgroundAdapter.js';
import { PersonaAdapter } from './PersonaAdapter.js';
import { AvatarAdapter } from './AvatarAdapter.js';
import { GroupAdapter } from './GroupAdapter.js';
import { GroupChatAdapter } from './GroupChatAdapter.js';
import { SpritesAdapter } from './SpritesAdapter.js';

/**
 * 创建 Phase 2 及 Phase 6 资产适配器实例字典
 * @returns {Map<string, import('./ConfigAdapter.js').ConfigAdapter>}
 */
export function createP2Adapters() {
  const adapters = new Map();
  adapters.set('character', new CharacterAdapter());
  adapters.set('theme', new ThemeAdapter());
  adapters.set('chat', new ChatAdapter());
  adapters.set('background', new BackgroundAdapter());
  adapters.set('persona', new PersonaAdapter());
  adapters.set('avatar', new AvatarAdapter());
  adapters.set('group', new GroupAdapter());
  adapters.set('group_chat', new GroupChatAdapter());
  adapters.set('sprites', new SpritesAdapter());
  return adapters;
}
