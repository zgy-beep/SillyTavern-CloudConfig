/**
 * SillyTavern-CloudConfig 常量定义
 */

export const ContentTypeGroup = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
};

export const P0ContentTypes = [
  'settings',
  'openai_preset',
  'world',
  // 保留代码备用，默认不展示低频类型：
  // 'textgen_preset',
  // 'novel_preset',
  // 'kobold_preset',
];

export const AllP0ContentTypes = [
  'settings',
  'openai_preset',
  'textgen_preset',
  'novel_preset',
  'kobold_preset',
  'world',
];

export const P1ContentTypes = [
  'instruct',
  'context',
  'sysprompt',
  'quick_replies',
];

/**
 * 跨账号禁止共享的敏感类别黑名单
 * settings 包含 API 密钥、密码等敏感信息，任何情况下禁止跨账号读取或共享
 */
export const NON_SHAREABLE_CONTENT_TYPES = Object.freeze(['settings', 'chat']);

/**
 * 允许跨账号共享的类别白名单
 */
export const SHAREABLE_CONTENT_TYPES = Object.freeze([
  'openai_preset',
  'world',
  'textgen_preset',
  'novel_preset',
  'kobold_preset',
  'character',
  'instruct',
  'context',
  'sysprompt',
  'reasoning',
  'quick_replies',
  'background',
  'avatar',
  'sprites',
  'theme',
  'workflow',
]);

/**
 * 校验指定类别是否允许跨账号共享
 * @param {string} contentType
 * @returns {boolean}
 */
export function isShareableContentType(contentType) {
  return Boolean(contentType && !NON_SHAREABLE_CONTENT_TYPES.includes(contentType));
}

export const OperationType = {
  UPSERT: 'UPSERT',
  DELETE: 'DELETE',
};

export const Permission = {
  READ: 'read',
  WRITE: 'write',
  ROLLBACK: 'rollback',
  SHARE: 'share',
  APPROVE: 'approve',
};

export const SyncState = {
  DISABLED: 'DISABLED',
  BACKUP_CREATED: 'BACKUP_CREATED',
  SYNCED: 'SYNCED',
  CONFLICT: 'CONFLICT',
  DISABLED_RESTORED: 'DISABLED_RESTORED',
};

export const SyncMode = {
  OWN: 'OWN',
  SHARED_READONLY: 'SHARED_READONLY',
};

export const ReloadStrategy = {
  SETTINGS: 'reload-settings',
  PRESET_LIST: 'reload-preset-list',
  WORLD_INFO: 'reload-world-info',
  CHARACTER_LIST: 'refresh-character-list',
  BACKGROUND_CACHE: 'refresh-background-cache',
  CHAT: 'reload-chat',
  NONE: 'none',
};

export const DEFAULT_MAX_VERSIONS = 20;
