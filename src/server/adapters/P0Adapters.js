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

  /**
   * 获取当前请求用户自身专有的 settings.json 主路径（写入时严格使用此路径）
   */
  getUserPrimaryPath(directories) {
    if (directories?.root) {
      return path.join(directories.root, 'settings.json');
    }
    if (directories?.user) {
      return path.join(directories.user, 'settings.json');
    }
    if (directories?.handle) {
      return path.join(process.cwd(), 'data', directories.handle, 'settings.json');
    }
    return path.join(process.cwd(), 'data', 'default-user', 'settings.json');
  }

  async getFilePath(directories) {
    const primary = this.getUserPrimaryPath(directories);
    if (await fs.access(primary).then(() => true).catch(() => false)) {
      return primary;
    }

    const candidates = [
      primary,
      directories?.root ? path.join(directories.root, 'settings.json') : null,
      directories?.user ? path.join(directories.user, 'settings.json') : null,
      directories?.user ? path.join(path.dirname(directories.user), 'settings.json') : null,
      directories?.handle ? path.join(process.cwd(), 'data', directories.handle, 'settings.json') : null,
      path.join(process.cwd(), 'data', directories?.handle || 'default-user', 'settings.json'),
      path.join(process.cwd(), 'data', 'default-user', 'settings.json'),
      path.join(process.cwd(), 'data', 'default', 'settings.json'),
      path.join(process.cwd(), 'public', 'settings.json'),
      path.join(process.cwd(), 'settings.json'),
    ];

    for (const p of candidates) {
      if (p) {
        const exists = await fs.access(p).then(() => true).catch(() => false);
        if (exists) return p;
      }
    }

    return primary;
  }

  async listItems(directories) {
    const filePath = await this.getFilePath(directories);
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
    const filePath = await this.getFilePath(directories);
    const content = await this.safeReadJson(filePath);
    if (!content) {
      throw new Error(`Settings file not found at ${filePath}`);
    }
    return content;
  }

  async apply(directories, itemUid, operation, content) {
    // 写入时严格锁定为当前用户专有的 settings 路径，杜绝误写到其它用户目录
    const filePath = this.getUserPrimaryPath(directories);
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
   * @param {(directories: any) => string} getPrimaryDirFn
   * @param {(directories: any) => string[]} getCandidateDirs
   * @param {string} reloadStrategy
   */
  constructor(contentType, getPrimaryDirFn, getCandidateDirs, reloadStrategy) {
    super(contentType);
    this.getPrimaryDirFn = getPrimaryDirFn;
    this.getCandidateDirs = getCandidateDirs;
    this.reloadStrategy = reloadStrategy;
  }

  async getPrimaryDir(directories) {
    // 严格获取当前用户专有的目录，并确保目录存在
    const primary = this.getPrimaryDirFn(directories);
    await fs.mkdir(primary, { recursive: true });
    return primary;
  }

  async listItems(directories) {
    const candidates = this.getCandidateDirs(directories);
    const seenFiles = new Set();
    const items = [];

    for (const dir of candidates) {
      if (!dir) continue;
      let files = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (file.endsWith('.json') && !seenFiles.has(file)) {
          seenFiles.add(file);
          const sourceRef = file;
          const displayName = path.basename(file, '.json');
          items.push({
            itemUid: makeItemUid(this.contentType, sourceRef),
            displayName,
            sourceRef,
            actualDir: dir,
          });
        }
      }
    }
    return items;
  }

  resolveFilePath(directories, itemUid, items) {
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) {
      throw new Error(`Item ${itemUid} not found for type ${this.contentType}`);
    }
    if (item.actualDir) {
      return path.join(item.actualDir, item.sourceRef);
    }
    const candidates = this.getCandidateDirs(directories);
    const dir = candidates[0] || path.join(directories?.root || '.', this.contentType);
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
    // 写入时严格写向当前用户专有的 primaryDir
    const primaryDir = await this.getPrimaryDir(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primaryDir);
    const existingAny = items.find(i => i.itemUid === itemUid);

    let targetFileName = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!targetFileName) {
      const name = content?.name || content?.displayName || `cfg_${itemUid.slice(0, 8)}`;
      targetFileName = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
    }
    const filePath = path.join(primaryDir, targetFileName);

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

  // OpenAI Presets
  adapters.set(
    'openai_preset',
    new DirectoryJsonConfigAdapter(
      'openai_preset',
      (dirs) => dirs?.openAI_Settings || dirs?.['OpenAI Settings'] || (dirs?.root ? path.join(dirs.root, 'OpenAI Settings') : path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'OpenAI Settings')),
      (dirs) => [
        dirs?.openAI_Settings,
        dirs?.['OpenAI Settings'],
        dirs?.root ? path.join(dirs.root, 'OpenAI Settings') : null,
        dirs?.user ? path.join(dirs.user, 'OpenAI Settings') : null,
        dirs?.user ? path.join(path.dirname(dirs.user), 'OpenAI Settings') : null,
        path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'OpenAI Settings'),
        path.join(process.cwd(), 'data', 'default-user', 'OpenAI Settings'),
        path.join(process.cwd(), 'data', 'default', 'OpenAI Settings'),
        path.join(process.cwd(), 'public', 'OpenAI Settings'),
        path.join(process.cwd(), 'default', 'OpenAI Settings'),
        path.join(process.cwd(), 'public', 'presets', 'openai'),
        path.join(process.cwd(), 'default', 'content', 'presets', 'openai'),
      ].filter(Boolean),
      ReloadStrategy.PRESET_LIST
    )
  );

  // TextGen Presets
  adapters.set(
    'textgen_preset',
    new DirectoryJsonConfigAdapter(
      'textgen_preset',
      (dirs) => dirs?.textGen_Settings || dirs?.['TextGen Settings'] || (dirs?.root ? path.join(dirs.root, 'TextGen Settings') : path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'TextGen Settings')),
      (dirs) => [
        dirs?.textGen_Settings,
        dirs?.['TextGen Settings'],
        dirs?.root ? path.join(dirs.root, 'TextGen Settings') : null,
        dirs?.user ? path.join(dirs.user, 'TextGen Settings') : null,
        dirs?.user ? path.join(path.dirname(dirs.user), 'TextGen Settings') : null,
        path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'TextGen Settings'),
        path.join(process.cwd(), 'data', 'default-user', 'TextGen Settings'),
        path.join(process.cwd(), 'data', 'default', 'TextGen Settings'),
        path.join(process.cwd(), 'public', 'TextGen Settings'),
        path.join(process.cwd(), 'default', 'TextGen Settings'),
        path.join(process.cwd(), 'public', 'presets', 'textgen'),
        path.join(process.cwd(), 'default', 'content', 'presets', 'textgen'),
      ].filter(Boolean),
      ReloadStrategy.PRESET_LIST
    )
  );

  // NovelAI Presets
  adapters.set(
    'novel_preset',
    new DirectoryJsonConfigAdapter(
      'novel_preset',
      (dirs) => dirs?.novelAI_Settings || dirs?.['NovelAI Settings'] || (dirs?.root ? path.join(dirs.root, 'NovelAI Settings') : path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'NovelAI Settings')),
      (dirs) => [
        dirs?.novelAI_Settings,
        dirs?.['NovelAI Settings'],
        dirs?.root ? path.join(dirs.root, 'NovelAI Settings') : null,
        dirs?.user ? path.join(dirs.user, 'NovelAI Settings') : null,
        dirs?.user ? path.join(path.dirname(dirs.user), 'NovelAI Settings') : null,
        path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'NovelAI Settings'),
        path.join(process.cwd(), 'data', 'default-user', 'NovelAI Settings'),
        path.join(process.cwd(), 'data', 'default', 'NovelAI Settings'),
        path.join(process.cwd(), 'public', 'NovelAI Settings'),
        path.join(process.cwd(), 'default', 'NovelAI Settings'),
        path.join(process.cwd(), 'public', 'presets', 'novel'),
        path.join(process.cwd(), 'default', 'content', 'presets', 'novel'),
      ].filter(Boolean),
      ReloadStrategy.PRESET_LIST
    )
  );

  // KoboldAI Presets
  adapters.set(
    'kobold_preset',
    new DirectoryJsonConfigAdapter(
      'kobold_preset',
      (dirs) => dirs?.koboldAI_Settings || dirs?.['KoboldAI Settings'] || (dirs?.root ? path.join(dirs.root, 'KoboldAI Settings') : path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'KoboldAI Settings')),
      (dirs) => [
        dirs?.koboldAI_Settings,
        dirs?.['KoboldAI Settings'],
        dirs?.root ? path.join(dirs.root, 'KoboldAI Settings') : null,
        dirs?.user ? path.join(dirs.user, 'KoboldAI Settings') : null,
        dirs?.user ? path.join(path.dirname(dirs.user), 'KoboldAI Settings') : null,
        path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'KoboldAI Settings'),
        path.join(process.cwd(), 'data', 'default-user', 'KoboldAI Settings'),
        path.join(process.cwd(), 'data', 'default', 'KoboldAI Settings'),
        path.join(process.cwd(), 'public', 'KoboldAI Settings'),
        path.join(process.cwd(), 'default', 'KoboldAI Settings'),
        path.join(process.cwd(), 'public', 'presets', 'kobold'),
        path.join(process.cwd(), 'default', 'content', 'presets', 'kobold'),
      ].filter(Boolean),
      ReloadStrategy.PRESET_LIST
    )
  );

  // World Info
  adapters.set(
    'world',
    new DirectoryJsonConfigAdapter(
      'world',
      (dirs) => dirs?.worlds || (dirs?.root ? path.join(dirs.root, 'worlds') : path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'worlds')),
      (dirs) => [
        dirs?.worlds,
        dirs?.root ? path.join(dirs.root, 'worlds') : null,
        dirs?.user ? path.join(dirs.user, 'worlds') : null,
        dirs?.user ? path.join(path.dirname(dirs.user), 'worlds') : null,
        path.join(process.cwd(), 'data', dirs?.handle || 'default-user', 'worlds'),
        path.join(process.cwd(), 'data', 'default-user', 'worlds'),
        path.join(process.cwd(), 'data', 'default', 'worlds'),
        path.join(process.cwd(), 'public', 'worlds'),
        path.join(process.cwd(), 'default', 'worlds'),
        path.join(process.cwd(), 'default', 'content', 'worlds'),
      ].filter(Boolean),
      ReloadStrategy.WORLD_INFO
    )
  );

  return adapters;
}
