import fs from 'node:fs/promises';
import path from 'node:path';
import { BinaryConfigAdapter } from './BinaryConfigAdapter.js';
import { autoBackupLocalFile } from './P0Adapters.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

export function resolveAvatarDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.['User Avatars']
    || dirs?.['user avatars']
    || dirs?.userAvatars
    || dirs?.avatars
    || (dirs?.user ? path.join(dirs.user, 'User Avatars') : null)
    || (dirs?.root ? path.join(dirs.root, 'User Avatars') : null)
    || path.join(process.cwd(), 'data', userHandle, 'User Avatars');

  const candidates = Array.from(new Set([
    primary,
    dirs?.['User Avatars'],
    dirs?.['user avatars'],
    dirs?.userAvatars,
    dirs?.avatars,
    dirs?.user ? path.join(dirs.user, 'User Avatars') : null,
    dirs?.user ? path.join(dirs.user, 'user avatars') : null,
    dirs?.root ? path.join(dirs.root, 'User Avatars') : null,
    path.join(process.cwd(), 'data', userHandle, 'User Avatars'),
    path.join(process.cwd(), 'data', userHandle, 'user avatars'),
  ].filter(Boolean)));

  return { primary, candidates };
}

const SUPPORTED_AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * 人设头像 (Avatar) 适配器
 * 动态从 directories 提取 User Avatars 目录（自适应大小写与空格）
 * 遵循 REPLACE 写入策略与覆盖前 .bak 自动备份
 */
export class AvatarAdapter extends BinaryConfigAdapter {
  constructor() {
    super(
      'avatar',
      (dirs) => resolveAvatarDirs(dirs).primary,
      (dirs) => resolveAvatarDirs(dirs).candidates,
      ReloadStrategy.NONE
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
        if (!SUPPORTED_AVATAR_EXTENSIONS.has(ext)) continue;

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
    const dir = candidates[0] || path.join(directories?.root || '.', 'User Avatars');
    return path.join(dir, item.sourceRef);
  }

  async read(directories, itemUid) {
    const items = await this.listItems(directories);
    const filePath = this.resolveFilePath(directories, itemUid, items);
    const buffer = await this.safeReadFile(filePath);
    if (!buffer) {
      throw new Error(`Content not found for avatar ${itemUid}`);
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
      const name = displayName || `avatar_${itemUid.slice(0, 8)}`;
      let ext = path.extname(name);
      if (!ext) {
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
        throw new Error('Invalid content format for avatar write');
      }

      await this.safeWriteFile(filePath, bufferToWrite);
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }

  /**
   * 优雅查找人设对应头像的辅助函数 (User Avatars/<personaName>.png 等)
   * 若不存在则安全返回 null，绝不抛异常
   * @param {Record<string, string>} directories
   * @param {string} personaName
   * @returns {Promise<string | null>}
   */
  async findAvatarForPersona(directories, personaName) {
    if (!personaName) return null;
    const candidates = this.getCandidateDirs(directories);
    const safeBaseName = personaName.trim();
    const extensions = ['.png', '.jpg', '.jpeg', '.webp'];

    for (const dir of candidates) {
      for (const ext of extensions) {
        const candidateFile = path.join(dir, `${safeBaseName}${ext}`);
        try {
          await fs.access(candidateFile);
          return candidateFile;
        } catch {}
      }
    }
    return null;
  }
}
