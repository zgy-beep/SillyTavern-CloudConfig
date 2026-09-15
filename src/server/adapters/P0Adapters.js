import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonConfigAdapter } from './JsonConfigAdapter.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

/**
 * Settings 适配器（单文件）
 */
export class SettingsAdapter extends JsonConfigAdapter {
  constructor() {
    super('settings');
  }

  getFilePath(directories) {
    const baseDir = directories?.user || directories?.root || '.';
    return path.join(baseDir, 'settings.json');
  }

  async listItems(directories) {
    const filePath = this.getFilePath(directories);
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      return [];
    }
    const sourceRef = 'settings.json';
    return [{
      itemUid: makeItemUid(this.contentType, sourceRef),
      displayName: '通用设置 (settings.json)',
      sourceRef,
    }];
  }

  async read(directories, itemUid) {
    const filePath = this.getFilePath(directories);
    const content = await this.safeReadJson(filePath);
    if (!content) {
      throw new Error(`Settings file not found at ${filePath}`);
    }
    return content;
  }

  async apply(directories, itemUid, operation, content) {
    const filePath = this.getFilePath(directories);
    if (operation === 'UPSERT') {
      await this.safeWriteJson(filePath, content);
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }

  getReloadStrategy() {
    return ReloadStrategy.SETTINGS;
  }
}

/**
 * 目录型 JSON 配置抽象基类（Presets, World Info 等）
 */
export class DirectoryJsonConfigAdapter extends JsonConfigAdapter {
  /**
   * @param {string} contentType
   * @param {(directories: any) => string} getDirPath
   * @param {string} reloadStrategy
   */
  constructor(contentType, getDirPath, reloadStrategy) {
    super(contentType);
    this.getDirPath = getDirPath;
    this.reloadStrategy = reloadStrategy;
  }

  async ensureDir(directories) {
    const dir = this.getDirPath(directories);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async listItems(directories) {
    const dir = this.getDirPath(directories);
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const items = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const sourceRef = file;
        const displayName = path.basename(file, '.json');
        items.push({
          itemUid: makeItemUid(this.contentType, sourceRef),
          displayName,
          sourceRef,
        });
      }
    }
    return items;
  }

  resolveFilePath(directories, itemUid, items) {
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) {
      throw new Error(`Item ${itemUid} not found for type ${this.contentType}`);
    }
    const dir = this.getDirPath(directories);
    return path.join(dir, item.sourceRef);
  }

  async read(directories, itemUid) {
    const items = await this.listItems(directories);
    const filePath = this.resolveFilePath(directories, itemUid, items);
    const content = await this.safeReadJson(filePath);
    if (!content) {
      throw new Error(`Content not found for ${itemUid}`);
    }
    return content;
  }

  async apply(directories, itemUid, operation, content) {
    const dir = await this.ensureDir(directories);
    const items = await this.listItems(directories);
    const existing = items.find(i => i.itemUid === itemUid);

    // 若本地文件尚不存在，由内容或 itemUid 默认命名
    let targetFileName = existing ? existing.sourceRef : null;
    if (!targetFileName) {
      const name = content?.name || content?.displayName || `cfg_${itemUid.slice(0, 8)}`;
      targetFileName = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
    }
    const filePath = path.join(dir, targetFileName);

    if (operation === 'UPSERT') {
      await this.safeWriteJson(filePath, content);
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }

  getReloadStrategy() {
    return this.reloadStrategy;
  }
}

/**
 * 创建所有 P0 适配器实例字典
 */
export function createP0Adapters() {
  const adapters = new Map();

  // Settings
  adapters.set('settings', new SettingsAdapter());

  // Presets
  const presetTypes = [
    { type: 'openai_preset', subDir: 'openai' },
    { type: 'textgen_preset', subDir: 'textgen' },
    { type: 'novel_preset', subDir: 'novel' },
    { type: 'kobold_preset', subDir: 'kobold' },
  ];

  for (const { type, subDir } of presetTypes) {
    adapters.set(
      type,
      new DirectoryJsonConfigAdapter(
        type,
        (dirs) => {
          if (dirs?.[type]) return dirs[type];
          const base = dirs?.user || dirs?.root || '.';
          return path.join(base, 'presets', subDir);
        },
        ReloadStrategy.PRESET_LIST
      )
    );
  }

  // World Info
  adapters.set(
    'world',
    new DirectoryJsonConfigAdapter(
      'world',
      (dirs) => {
        if (dirs?.worlds) return dirs.worlds;
        const base = dirs?.user || dirs?.root || '.';
        return path.join(base, 'worlds');
      },
      ReloadStrategy.WORLD_INFO
    )
  );

  return adapters;
}
