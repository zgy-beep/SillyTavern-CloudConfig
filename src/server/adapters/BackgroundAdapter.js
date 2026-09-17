import fs from 'node:fs/promises';
import path from 'node:path';
import { BinaryConfigAdapter } from './BinaryConfigAdapter.js';
import { autoBackupLocalFile } from './P0Adapters.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolveBackgroundDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.backgrounds
    || (dirs?.root ? path.join(dirs.root, 'backgrounds') : null)
    || (dirs?.user ? path.join(dirs.user, 'backgrounds') : null)
    || path.join(process.cwd(), 'data', userHandle, 'backgrounds');

  // P6-1: 严禁硬编码 public/backgrounds，严格定位在用户数据目录
  const candidates = Array.from(new Set([
    primary,
    dirs?.backgrounds,
    dirs?.root ? path.join(dirs.root, 'backgrounds') : null,
    dirs?.user ? path.join(dirs.user, 'backgrounds') : null,
    path.join(process.cwd(), 'data', userHandle, 'backgrounds'),
  ].filter(Boolean)));

  return { primary, candidates };
}

const SUPPORTED_BG_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * 聊天背景 (Background) 适配器
 * 路径严格为 data/<user>/backgrounds/，支持中文与空格文件名
 * 遵循 REPLACE 写入策略与覆盖前 .bak 自动备份
 */
export class BackgroundAdapter extends BinaryConfigAdapter {
  constructor() {
    super(
      'background',
      (dirs) => resolveBackgroundDirs(dirs).primary,
      (dirs) => resolveBackgroundDirs(dirs).candidates,
      ReloadStrategy.BACKGROUND_CACHE
    );
  }

  async listItems(directories) {
    const candidates = this.getCandidateDirs(directories);
    const seenUids = new Set();
    const items = [];

    for (const dir of candidates) {
      const exists = await fs.access(dir).then(() => true).catch(() => false);
      if (!exists) continue;

      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_BG_EXTENSIONS.has(ext)) continue;

        const sourceRef = entry.name;
        const itemUid = makeItemUid(this.contentType, sourceRef);
        if (seenUids.has(itemUid)) continue;
        seenUids.add(itemUid);

        items.push({
          itemUid,
          displayName: entry.name,
          sourceRef,
          actualDir: dir,
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
    const buffer = await this.safeReadFile(filePath);
    if (!buffer) {
      throw new Error(`Content not found for background ${itemUid}`);
    }
    return buffer;
  }

  async getFilePath(directories, itemUid) {
    const items = await this.listItems(directories);
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) return null;
    return this.resolveFilePath(directories, itemUid, items);
  }

  async apply(directories, itemUid, operation, content, displayName = null) {
    const primaryDir = await this.getPrimaryDir(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primaryDir);
    const existingAny = items.find(i => i.itemUid === itemUid);

    let targetFileName = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!targetFileName) {
      const name = displayName || `bg_${itemUid.slice(0, 8)}`;
      let ext = path.extname(name);
      if (!ext) {
        // 嗅探扩展名
        if (Buffer.isBuffer(content) && content.length >= 4) {
          if (content[0] === 0x89 && content[1] === 0x50) ext = '.png';
          else if (content[0] === 0xFF && content[1] === 0xD8) ext = '.jpg';
          else if (content[0] === 0x52 && content[1] === 0x49) ext = '.webp';
          else ext = '.png';
        } else {
          ext = '.png';
        }
        targetFileName = `${name}${ext}`;
      } else {
        targetFileName = name;
      }
    }

    const targetDir = (existingInPrimary || existingAny)?.actualDir || primaryDir;
    const filePath = path.join(targetDir, targetFileName);

    if (operation === 'UPSERT') {
      await autoBackupLocalFile(filePath);

      let bufferToWrite = null;
      if (Buffer.isBuffer(content)) {
        bufferToWrite = content;
      } else if (content && Buffer.isBuffer(content.buffer)) {
        bufferToWrite = content.buffer;
      } else if (typeof content === 'string') {
        bufferToWrite = Buffer.from(content, 'utf8');
      } else {
        throw new Error('Invalid content format for background write');
      }

      await this.safeWriteFile(filePath, bufferToWrite);
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }
}
