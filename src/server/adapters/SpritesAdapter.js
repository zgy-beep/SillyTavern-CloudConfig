import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigAdapter, MergeStrategy } from './ConfigAdapter.js';
import { resolveCharacterDirs } from './CharacterAdapter.js';
import { DeterministicZip } from '../utils/DeterministicZip.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

/**
 * 备份本地贴图目录为 <dirPath>.bak-<timestamp>
 */
export async function autoBackupSpriteDir(dirPath) {
  try {
    const exists = await fs.access(dirPath).then(() => true).catch(() => false);
    if (!exists) return;

    const parentDir = path.dirname(dirPath);
    const baseName = path.basename(dirPath);
    const timestamp = Date.now();
    const backupName = `${baseName}.bak-${timestamp}`;
    const backupPath = path.join(parentDir, backupName);

    await fs.cp(dirPath, backupPath, { recursive: true });

    // 最多保留最近 3 份备份
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    const prefix = `${baseName}.bak-`;
    const backups = entries
      .filter(e => e.isDirectory() && e.name.startsWith(prefix))
      .map(e => e.name)
      .sort();

    if (backups.length > 3) {
      for (const oldBackup of backups.slice(0, backups.length - 3)) {
        await fs.rm(path.join(parentDir, oldBackup), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[cfgsync] autoBackupSpriteDir warning:', err.message);
  }
}

/**
 * 角色表情贴图包 (Sprites) 适配器 (P6-2)
 * 基于确定性字节稳定 ZIP 规范打包与解压
 * 位于 characters/<charName>/ 目录下
 */
export class SpritesAdapter extends ConfigAdapter {
  constructor() {
    super('sprites', MergeStrategy.REPLACE);
    this.reloadStrategy = ReloadStrategy.NONE;
  }

  getReloadStrategy() {
    return this.reloadStrategy;
  }

  canonicalize(content) {
    if (Buffer.isBuffer(content)) return content;
    if (content && Buffer.isBuffer(content.buffer)) return content.buffer;
    if (typeof content === 'string') return Buffer.from(content, 'utf8');
    return Buffer.from('');
  }

  serialize(content) {
    let buf = null;
    if (Buffer.isBuffer(content)) {
      buf = content;
    } else if (content && Buffer.isBuffer(content.buffer)) {
      buf = content.buffer;
    } else {
      buf = Buffer.from(content || '');
    }

    return {
      buffer: buf,
      mimeType: 'application/zip',
      ext: 'zip',
    };
  }

  deserialize(buffer, mimeType = 'application/zip') {
    return buffer;
  }

  validate(content) {
    if (Buffer.isBuffer(content) && content.length >= 22) return true;
    if (content && Buffer.isBuffer(content.buffer) && content.buffer.length >= 22) return true;
    return false;
  }

  async getPrimaryDir(directories) {
    const { primary } = resolveCharacterDirs(directories);
    await fs.mkdir(primary, { recursive: true });
    return primary;
  }

  getCandidateDirs(directories) {
    return resolveCharacterDirs(directories).candidates;
  }

  /**
   * 扫描发现所有角色表情贴图包目录 (characters/<charName>/)
   */
  async listItems(directories) {
    const candidates = this.getCandidateDirs(directories);
    const seenUids = new Set();
    const items = [];

    for (const baseDir of candidates) {
      const exists = await fs.access(baseDir).then(() => true).catch(() => false);
      if (!exists) continue;

      let entries = [];
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'backups' || entry.name === 'vectors' || entry.name.startsWith('.')) continue;
        if (entry.name.includes('.bak-')) continue;

        // 检查子目录是否包含文件
        const subDirPath = path.join(baseDir, entry.name);
        let subFiles = [];
        try {
          subFiles = await fs.readdir(subDirPath);
        } catch {
          continue;
        }

        const validFiles = subFiles.filter(f => !f.includes('.bak-') && !f.endsWith('.tmp'));
        if (validFiles.length === 0) continue;

        const sourceRef = entry.name;
        const itemUid = makeItemUid(this.contentType, sourceRef);
        if (seenUids.has(itemUid)) continue;
        seenUids.add(itemUid);

        items.push({
          itemUid,
          displayName: `${entry.name} 表情贴图包`,
          sourceRef,
          actualDir: baseDir,
          characterName: entry.name,
          spriteCount: validFiles.length,
        });
      }
    }

    return items;
  }

  resolveSpriteDir(directories, itemUid, items) {
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) {
      throw new Error(`Sprite item ${itemUid} not found`);
    }
    if (item.actualDir) {
      return path.join(item.actualDir, item.sourceRef);
    }
    const candidates = this.getCandidateDirs(directories);
    const dir = candidates[0] || path.join(directories?.root || '.', 'characters');
    return path.join(dir, item.sourceRef);
  }

  /**
   * 读取贴图包并打包为确定性 ZIP
   */
  async read(directories, itemUid) {
    const items = await this.listItems(directories);
    const spriteDir = this.resolveSpriteDir(directories, itemUid, items);
    return await DeterministicZip.packDirectory(spriteDir);
  }

  async getFilePath(directories, itemUid) {
    const items = await this.listItems(directories);
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) return null;
    return this.resolveSpriteDir(directories, itemUid, items);
  }

  /**
   * 解压贴图包到本地 characters/<charName>/ 目录
   * 采用覆盖前自动备份与非破坏性增量解压（不删本地独有贴图）
   */
  async apply(directories, itemUid, operation, content, displayName = null) {
    const primaryDir = await this.getPrimaryDir(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primaryDir);
    const existingAny = items.find(i => i.itemUid === itemUid);

    let charName = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!charName) {
      charName = displayName ? displayName.replace(/ 表情贴图包$/, '').trim() : `sprites_${itemUid.slice(0, 8)}`;
      charName = charName.replace(/[\\/:*?"<>|]/g, '_');
    }

    const targetBaseDir = (existingInPrimary || existingAny)?.actualDir || primaryDir;
    const targetDir = path.join(targetBaseDir, charName);

    if (operation === 'UPSERT') {
      let zipBuf = null;
      if (Buffer.isBuffer(content)) {
        zipBuf = content;
      } else if (content && Buffer.isBuffer(content.buffer)) {
        zipBuf = content.buffer;
      } else {
        throw new Error('Invalid content format for sprites write: expected ZIP buffer');
      }

      // 覆盖前自动备份已有目录
      await autoBackupSpriteDir(targetDir);

      // 解压写入（安全加法写入，不删本地已有独有贴图）
      await DeterministicZip.unpackToDirectory(zipBuf, targetDir);
    } else if (operation === 'DELETE') {
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
