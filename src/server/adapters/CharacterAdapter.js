import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { BinaryConfigAdapter } from './BinaryConfigAdapter.js';
import { autoBackupLocalFile } from './P0Adapters.js';
import { makeItemUid } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

/**
 * 安全从 PNG Buffer 中尝试提取角色卡内嵌名称（chara/ccv3）
 * 仅用于 displayName 展示；失败优雅降级，绝对不抛异常
 */
function tryExtractPngCharacterName(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;
  // 检查 PNG 魔数
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
    return null;
  }

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4; // +4 for CRC

    if (nextOffset > buffer.length) break;

    if (type === 'tEXt' || type === 'iTXt') {
      const chunkData = buffer.subarray(dataOffset, dataOffset + length);
      const nullIdx = chunkData.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = chunkData.subarray(0, nullIdx).toString('utf8');
        if (keyword === 'chara' || keyword === 'ccv3') {
          try {
            let rawText = '';
            if (type === 'tEXt') {
              rawText = chunkData.subarray(nullIdx + 1).toString('utf8');
            } else {
              // iTXt 结构: keyword\0 compressionFlag compressionMethod langTag\0 translatedKey\0 text
              const remaining = chunkData.subarray(nullIdx + 1);
              if (remaining.length > 4) {
                const compFlag = remaining[0];
                if (compFlag === 0) {
                  // 未压缩
                  let textStart = 3;
                  const langNull = remaining.indexOf(0, textStart);
                  if (langNull !== -1) {
                    textStart = langNull + 1;
                    const transNull = remaining.indexOf(0, textStart);
                    if (transNull !== -1) {
                      textStart = transNull + 1;
                      rawText = remaining.subarray(textStart).toString('utf8');
                    }
                  }
                }
              }
            }

            if (rawText) {
              let b64 = rawText.trim();
              // ccv3 可能有 3 字节头部标识，剥离非 base64 字符
              if (keyword === 'ccv3' && !b64.startsWith('{')) {
                const jsonStartIdx = b64.indexOf('{');
                if (jsonStartIdx !== -1) {
                  b64 = b64.slice(jsonStartIdx);
                }
              }

              let jsonStr = '';
              if (b64.startsWith('{')) {
                jsonStr = b64;
              } else {
                try {
                  jsonStr = Buffer.from(b64, 'base64').toString('utf8');
                  if (jsonStr.charCodeAt(0) === 0xFEFF) jsonStr = jsonStr.slice(1);
                  // 若前面有非 json 前缀，找到第一个 {
                  const firstBrace = jsonStr.indexOf('{');
                  if (firstBrace > 0) jsonStr = jsonStr.slice(firstBrace);
                } catch {}
              }

              if (jsonStr) {
                const parsed = JSON.parse(jsonStr);
                const charName = parsed?.data?.name || parsed?.name;
                if (typeof charName === 'string' && charName.trim()) {
                  return charName.trim();
                }
              }
            }
          } catch {}
        }
      }
    }

    if (type === 'IEND') break;
    offset = nextOffset;
  }
  return null;
}

export function resolveCharacterDirs(dirs) {
  const userHandle = dirs?.handle || 'default-user';
  const primary = dirs?.characters
    || (dirs?.root ? path.join(dirs.root, 'characters') : null)
    || (dirs?.user ? path.join(dirs.user, 'characters') : null)
    || path.join(process.cwd(), 'data', userHandle, 'characters');

  const candidates = Array.from(new Set([
    primary,
    dirs?.characters,
    dirs?.root ? path.join(dirs.root, 'characters') : null,
    dirs?.user ? path.join(dirs.user, 'characters') : null,
    path.join(process.cwd(), 'data', userHandle, 'characters'),
    path.join(process.cwd(), 'public', 'characters'),
  ].filter(Boolean)));

  return { primary, candidates };
}

/**
 * 角色卡 (Character) 适配器
 * 支持 .png（内置角色元数据）与 .json 格式
 * 严格基于原始文件字节计算 Checksum，落实 REPLACE 写入策略与覆盖前 .bak 备份
 */
export class CharacterAdapter extends BinaryConfigAdapter {
  constructor() {
    super(
      'character',
      (dirs) => resolveCharacterDirs(dirs).primary,
      (dirs) => resolveCharacterDirs(dirs).candidates,
      ReloadStrategy.CHARACTER_LIST
    );
  }

  /**
   * 发现该类型下当前有哪些可同步对象
   * P5-5 铁律：仅扫描根级直接文件，忽略任何子目录（如 characters/Seraphina/ 贴图包）
   */
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
        // P5-5: 仅处理普通文件，忽略所有子目录！
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '.png' && ext !== '.json') continue;

        const sourceRef = entry.name;
        const itemUid = makeItemUid(this.contentType, sourceRef);
        if (seenUids.has(itemUid)) continue;
        seenUids.add(itemUid);

        let displayName = path.basename(entry.name, ext);
        const fullPath = path.join(dir, entry.name);

        // 如果是 PNG，安全尝试读取内嵌名字
        if (ext === '.png') {
          try {
            const buf = await fs.readFile(fullPath);
            const embeddedName = tryExtractPngCharacterName(buf);
            if (embeddedName) {
              displayName = embeddedName;
            }
          } catch {}
        }

        items.push({
          itemUid,
          displayName,
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
      throw new Error(`Content not found for character ${itemUid}`);
    }
    return buffer;
  }

  async getFilePath(directories, itemUid) {
    const items = await this.listItems(directories);
    const item = items.find(i => i.itemUid === itemUid);
    if (!item) return null;
    return this.resolveFilePath(directories, itemUid, items);
  }

  /**
   * 写入角色卡（REPLACE 策略，强制覆盖前备份）
   */
  async apply(directories, itemUid, operation, content, displayName = null) {
    const primaryDir = await this.getPrimaryDir(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primaryDir);
    const existingAny = items.find(i => i.itemUid === itemUid);

    let targetFileName = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!targetFileName) {
      const ext = (Buffer.isBuffer(content) && content.length >= 4 && content[0] === 0x89) ? '.png' : '.json';
      const name = displayName || `chara_${itemUid.slice(0, 8)}`;
      targetFileName = `${name.replace(/[\\/:*?"<>|]/g, '_')}${ext}`;
    }

    const targetDir = (existingInPrimary || existingAny)?.actualDir || primaryDir;
    const filePath = path.join(targetDir, targetFileName);

    if (operation === 'UPSERT') {
      // P5-2: 覆盖前强制自动备份
      await autoBackupLocalFile(filePath);

      let bufferToWrite = null;
      if (Buffer.isBuffer(content)) {
        bufferToWrite = content;
      } else if (content && Buffer.isBuffer(content.buffer)) {
        bufferToWrite = content.buffer;
      } else if (typeof content === 'string') {
        bufferToWrite = Buffer.from(content, 'utf8');
      } else if (typeof content === 'object') {
        bufferToWrite = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
      } else {
        throw new Error('Invalid content format for character write');
      }

      // P5-2: 绝不调用 deepMergeSettings，直接原子写盘
      await this.safeWriteFile(filePath, bufferToWrite);
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }
}
