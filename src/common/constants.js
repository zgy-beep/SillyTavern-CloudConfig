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
  'textgen_preset',
  'novel_preset',
  'kobold_preset',
  'world',
];

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
  NONE: 'none',
};

export const DEFAULT_MAX_VERSIONS = 20;
