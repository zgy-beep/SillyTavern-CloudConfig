import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { JsonConfigAdapter } from './JsonConfigAdapter.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

/**
 * 递归深度合并两个设置对象：
 * 1. 云端有的键覆盖本地对应键
 * 2. 成员本地独有的键（如 api_server, preset_settings）予以保留
 * 3. 快照排除的键（如成员本地已有 tavern_helper）予以保留
 * 4. 数组字段按 id / identifier 逐条合并，云端顺序优先，本地独有项追加在后
 */
export function deepMergeSettings(local, incoming) {
  if (local === null || typeof local !== 'object' || Array.isArray(local)) {
    return incoming;
  }
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return incoming;
  }

  const result = { ...local };
  for (const [key, incomingVal] of Object.entries(incoming)) {
    if (!(key in local)) {
      result[key] = incomingVal;
    } else {
      const localVal = local[key];
      if (Array.isArray(incomingVal) && Array.isArray(localVal)) {
        result[key] = mergeArrays(localVal, incomingVal);
      } else if (
        localVal && typeof localVal === 'object' && !Array.isArray(localVal) &&
        incomingVal && typeof incomingVal === 'object' && !Array.isArray(incomingVal)
      ) {
        result[key] = deepMergeSettings(localVal, incomingVal);
      } else {
        result[key] = incomingVal;
      }
    }
  }
  return result;
}

function mergeArrays(localArr, incomingArr) {
  if (incomingArr.length === 0) return [...localArr];
  const firstIncoming = incomingArr[0];
  // 对象数组（带有 id, name 或 identifier）
  if (firstIncoming && typeof firstIncoming === 'object') {
    const idKey = ['id', 'name', 'identifier', 'key'].find(k => k in firstIncoming);
    if (idKey) {
      const incomingIds = new Set(incomingArr.map(item => item[idKey]));
      const localExtra = localArr.filter(item => item && typeof item === 'object' && !incomingIds.has(item[idKey]));
      return [...incomingArr, ...localExtra];
    }
  }
  // 基础值有序数组（如 prompt_order）
  if (typeof firstIncoming === 'string' || typeof firstIncoming === 'number') {
    const incomingSet = new Set(incomingArr);
    const localExtra = localArr.filter(x => !incomingSet.has(x));
    return [...incomingArr, ...localExtra];
  }
  return [...incomingArr];
}

/**
 * 自动备份本地文件：settings.json.bak-<timestamp>（绝不以 .json 结尾，防扫描器误扫）
 */
export async function autoBackupLocalFile(filePath) {
  try {
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!exists) return;
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const timestamp = Date.now();
    const backupName = `${baseName}.bak-${timestamp}`;
    const backupPath = path.join(dir, backupName);
    await fs.copyFile(filePath, backupPath);

    // 最多保留最近 3 份备份
    const files = await fs.readdir(dir);
    const prefix = `${baseName}.bak-`;
    const backups = files.filter(f => f.startsWith(prefix)).sort();
    if (backups.length > 3) {
      for (const oldBackup of backups.slice(0, backups.length - 3)) {
        await fs.unlink(path.join(dir, oldBackup)).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[cfgsync] autoBackupLocalFile warning:', err.message);
  }
}

/**
 * 获取用户的主数据根目录（兼容 SillyTavern 单用户及多用户模式）
 * 在 ST 多用户模式下：directories.user 指向 <accountRoot>/user，而 secrets.json 和 settings.json 位于 <accountRoot>
 */
export function getUserAccountRoot(directories) {
  if (directories?.root && fsSync.existsSync(path.join(directories.root, 'settings.json'))) {
    return directories.root;
  }
  if (directories?.user) {
    if (path.basename(directories.user) === 'user') {
      return path.dirname(directories.user);
    }
    return directories.user;
  }
  if (directories?.root) {
    return directories.root;
  }
  const userHandle = directories?.handle || 'default-user';
  return path.join(process.cwd(), 'data', userHandle);
}

/**
 * 方案 B 密钥注入：从服务端 sourceOwner 的 secrets.json 中读取并安全注水到目标用户
 */
export async function injectSecrets(sourceOwnerHandle, targetDirectories, audit = null) {
  try {
    const targetAccountRoot = getUserAccountRoot(targetDirectories);
    const targetUserHandle = targetDirectories?.handle || 'default-user';

    // 确定源用户的 secrets.json 查找路径
    const targetParentDir = path.dirname(targetAccountRoot);
    const rootDir = targetDirectories?.root ? path.dirname(targetDirectories.root) : process.cwd();

    const sourceSecretsCandidates = [
      path.join(targetParentDir, sourceOwnerHandle, 'secrets.json'),
      path.join(targetParentDir, `user_${sourceOwnerHandle}`, 'secrets.json'),
      targetDirectories?.root ? path.join(targetDirectories.root, '..', sourceOwnerHandle, 'secrets.json') : null,
      targetDirectories?.root ? path.join(targetDirectories.root, sourceOwnerHandle, 'secrets.json') : null,
      path.join(rootDir, 'data', sourceOwnerHandle, 'secrets.json'),
      path.join(rootDir, 'data', `user_${sourceOwnerHandle}`, 'secrets.json'),
      path.join(process.cwd(), 'data', sourceOwnerHandle, 'secrets.json'),
      path.join(process.cwd(), 'secrets.json'),
    ].filter(Boolean);

    let sourceSecrets = null;
    for (const p of sourceSecretsCandidates) {
      try {
        const text = await fs.readFile(p, 'utf8');
        sourceSecrets = JSON.parse(text);
        if (sourceSecrets) break;
      } catch {}
    }
    if (!sourceSecrets) return;

    // 目标用户的 secrets.json 必须写入到 accountRoot/secrets.json
    await fs.mkdir(targetAccountRoot, { recursive: true });
    const targetSecretsPath = path.join(targetAccountRoot, 'secrets.json');

    let targetSecrets = {};
    try {
      const text = await fs.readFile(targetSecretsPath, 'utf8');
      targetSecrets = JSON.parse(text);
    } catch {}

    const merged = { ...sourceSecrets, ...targetSecrets };

    // 对 api_key_custom 等数组按 id 逐条合并，注入共享密钥并保留成员自有独有条目
    for (const key of Object.keys(sourceSecrets)) {
      if (Array.isArray(sourceSecrets[key])) {
        const srcArr = sourceSecrets[key];
        const tgtArr = Array.isArray(targetSecrets[key]) ? targetSecrets[key] : [];
        const srcIds = new Set(srcArr.map(item => item?.id || item?.name || JSON.stringify(item)));
        const tgtExtra = tgtArr.filter(item => !srcIds.has(item?.id || item?.name || JSON.stringify(item)));
        merged[key] = [...srcArr, ...tgtExtra];
      }
    }

    const tmpPath = `${targetSecretsPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf8');
    await fs.rename(tmpPath, targetSecretsPath);

    // 清理可能误写在 targetDirectories.user/secrets.json 的残留文件（防御性清理）
    if (targetDirectories?.user && path.resolve(targetDirectories.user) !== path.resolve(targetAccountRoot)) {
      const straySecretsPath = path.join(targetDirectories.user, 'secrets.json');
      try {
        await fs.unlink(straySecretsPath);
      } catch {}
    }

    if (audit) {
      audit.log({
        actor: targetUserHandle,
        action: 'inject_secrets',
        target: sourceOwnerHandle,
        contentType: 'settings',
        result: 'success',
        details: { sensitive: true },
      });
    }
  } catch (err) {
    console.warn('[cfgsync] Failed to inject secrets:', err.message);
  }
}

/**
 * 扫描指定 data 目录，自愈清理因旧版本写入在各账号 user/secrets.json 的历史残留文件 (R-1)
 */
export async function cleanupStraySecrets(dataDir = null) {
  try {
    const targetDataDir = dataDir || path.join(process.cwd(), 'data');
    const exists = await fs.access(targetDataDir).then(() => true).catch(() => false);
    if (!exists) return;
    const entries = await fs.readdir(targetDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const strayPath = path.join(targetDataDir, entry.name, 'user', 'secrets.json');
        try {
          await fs.unlink(strayPath);
        } catch {}
      }
    }
  } catch (err) {
    // 忽略自愈扫描中的次要异常
  }
}

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
    const accountRoot = getUserAccountRoot(directories);
    if (fsSync.existsSync(path.join(accountRoot, 'settings.json'))) {
      return path.join(accountRoot, 'settings.json');
    }
    if (directories?.root && fsSync.existsSync(path.join(directories.root, 'settings.json'))) {
      return path.join(directories.root, 'settings.json');
    }
    if (directories?.user && fsSync.existsSync(path.join(directories.user, 'settings.json'))) {
      return path.join(directories.user, 'settings.json');
    }
    return path.join(accountRoot, 'settings.json');
  }

  async getFilePath(directories) {
    const primary = this.getUserPrimaryPath(directories);
    if (await fs.access(primary).then(() => true).catch(() => false)) {
      return primary;
    }

    const accountRoot = getUserAccountRoot(directories);
    const userHandle = directories?.handle || 'default-user';
    const candidates = [
      primary,
      path.join(accountRoot, 'settings.json'),
      directories?.root ? path.join(directories.root, 'settings.json') : null,
      directories?.user ? path.join(directories.user, 'settings.json') : null,
      path.join(process.cwd(), 'data', userHandle, 'settings.json'),
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

  async read(directories, itemUid, options = {}) {
    const filePath = await this.getFilePath(directories);
    const content = await this.safeReadJson(filePath);
    if (!content) {
      throw new Error(`Settings file not found at ${filePath}`);
    }
    // 默认精简排除酒馆助手庞大变量与脚本库 (~4.7MB)
    const excludeHeavy = options.excludeHeavy !== undefined ? options.excludeHeavy : true;
    if (excludeHeavy && content?.oai_settings?.extensions?.tavern_helper) {
      const cloned = JSON.parse(JSON.stringify(content));
      delete cloned.oai_settings.extensions.tavern_helper;
      return cloned;
    }
    return content;
  }

  async apply(directories, itemUid, operation, content, displayName = null, context = null) {
    // 写入时严格锁定为当前用户专有的 settings 路径，杜绝误写到其它用户目录
    const filePath = this.getUserPrimaryPath(directories);
    if (operation === 'UPSERT') {
      let finalContent = content;
      let fileExists = false;
      try {
        await fs.access(filePath);
        fileExists = true;
      } catch {}

      if (fileExists) {
        let localContent = null;
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          localContent = JSON.parse(raw);
        } catch (parseErr) {
          throw new Error(`Local settings.json is corrupted and cannot be parsed: ${parseErr.message}. Aborting apply to protect local file.`);
        }
        await autoBackupLocalFile(filePath);
        finalContent = deepMergeSettings(localContent, content);
      }

      await this.safeWriteJson(filePath, finalContent);

      // 方案 B：受控密钥注入（仅限鉴权推导合法且带有 inject_secrets 授权）
      if (context?.injectSecrets && context?.sourceOwner && context?.sourceOwner !== directories?.handle) {
        await injectSecrets(context.sourceOwner, directories, context.audit);
      }
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

  async apply(directories, itemUid, operation, content, displayName = null) {
    // 写入时严格写向当前用户专有的 primaryDir
    const primaryDir = await this.getPrimaryDir(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primaryDir);
    const existingAny = items.find(i => i.itemUid === itemUid);

    let targetFileName = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!targetFileName) {
      const name = displayName || content?.name || content?.displayName || `cfg_${itemUid.slice(0, 8)}`;
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
  const resolveUserDirs = (dirs, dirKey, subDirName) => {
    const userHandle = dirs?.handle || 'default-user';
    const primary = dirs?.[dirKey]
      || dirs?.[subDirName]
      || (dirs?.root ? path.join(dirs.root, subDirName) : null)
      || (dirs?.user ? path.join(dirs.user, subDirName) : null)
      || path.join(process.cwd(), 'data', userHandle, subDirName);

    const candidates = Array.from(new Set([
      primary,
      dirs?.[dirKey],
      dirs?.[subDirName],
      dirs?.root ? path.join(dirs.root, subDirName) : null,
      dirs?.user ? path.join(dirs.user, subDirName) : null,
      path.join(process.cwd(), 'data', userHandle, subDirName),
    ].filter(Boolean)));

    return { primary, candidates };
  };

  // OpenAI Presets
  adapters.set(
    'openai_preset',
    new DirectoryJsonConfigAdapter(
      'openai_preset',
      (dirs) => resolveUserDirs(dirs, 'openAI_Settings', 'OpenAI Settings').primary,
      (dirs) => resolveUserDirs(dirs, 'openAI_Settings', 'OpenAI Settings').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // TextGen Presets
  adapters.set(
    'textgen_preset',
    new DirectoryJsonConfigAdapter(
      'textgen_preset',
      (dirs) => resolveUserDirs(dirs, 'textGen_Settings', 'TextGen Settings').primary,
      (dirs) => resolveUserDirs(dirs, 'textGen_Settings', 'TextGen Settings').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // NovelAI Presets
  adapters.set(
    'novel_preset',
    new DirectoryJsonConfigAdapter(
      'novel_preset',
      (dirs) => resolveUserDirs(dirs, 'novelAI_Settings', 'NovelAI Settings').primary,
      (dirs) => resolveUserDirs(dirs, 'novelAI_Settings', 'NovelAI Settings').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // KoboldAI Presets
  adapters.set(
    'kobold_preset',
    new DirectoryJsonConfigAdapter(
      'kobold_preset',
      (dirs) => resolveUserDirs(dirs, 'koboldAI_Settings', 'KoboldAI Settings').primary,
      (dirs) => resolveUserDirs(dirs, 'koboldAI_Settings', 'KoboldAI Settings').candidates,
      ReloadStrategy.PRESET_LIST
    )
  );

  // World Info
  adapters.set(
    'world',
    new DirectoryJsonConfigAdapter(
      'world',
      (dirs) => resolveUserDirs(dirs, 'worlds', 'worlds').primary,
      (dirs) => resolveUserDirs(dirs, 'worlds', 'worlds').candidates,
      ReloadStrategy.WORLD_INFO
    )
  );

  return adapters;
}
