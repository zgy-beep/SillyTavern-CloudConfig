import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  allowSettingsSharing: false, // 默认关闭（多用户安全底线）
  forcePush: true,             // 默认开启网盘直传模式
  maxVersions: 20,             // 快照上限
  maxVersionsByType: {
    character: 5,              // 二进制角色卡（单卡 ~3.1MB，5 版约 15MB）
    theme: 5,                  // 主题配置
    background: 3,             // 聊天背景（3 版）
    avatar: 5,                 // 人设头像（5 版）
    persona: 20,               // 用户人设（20 版）
    group: 20,                 // 群组定义（20 版）
    group_chat: 5,             // 群聊历史（5 版）
    sprites: 3,                // 表情贴图包（3 版）
    chat: 5,                   // 聊天记录（5 版）
  },
  excludeHeavyExtensions: true, // 默认排除酒馆助手巨大缓存 (~4.7MB)
  autoSyncEnabled: false,      // 客户端静默自动同步默认关闭 (P6-4, 保守默认)
  webdavEnabled: false,        // 外部 WebDAV 默认关闭 (保守默认)
  localPathEnabled: false,     // 外部 LocalPath 默认关闭 (保守默认)
});

/**
 * 集中运行期配置服务（单一真实来源）
 */
export class ConfigService {
  /**
   * @param {string} [configPath]
   * @param {object} [initialConfig]
   */
  constructor(configPath = null, initialConfig = {}) {
    this.configPath = configPath;
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
    this.load();
  }

  load() {
    if (!this.configPath) return;
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (err) {
      console.warn('[cfgsync] Failed to load config from disk, using defaults:', err.message);
    }
  }

  save() {
    if (!this.configPath) return;
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[cfgsync] Failed to save config to disk:', err.message);
    }
  }

  get(key) {
    return this.config[key] !== undefined ? this.config[key] : DEFAULT_CONFIG[key];
  }

  getMaxVersions(contentType) {
    const byType = this.config.maxVersionsByType || DEFAULT_CONFIG.maxVersionsByType;
    if (byType && typeof byType === 'object' && byType[contentType] !== undefined) {
      return Number(byType[contentType]) || 5;
    }
    return Number(this.get('maxVersions')) || 20;
  }

  getAll() {
    return { ...this.config };
  }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  update(partial) {
    this.config = { ...this.config, ...partial };
    this.save();
    return this.getAll();
  }
}
