import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_VERSIONS } from '../../common/constants.js';

/**
 * 负责 Blob 历史版本文件的磁盘安全读写、修剪与清理
 */
export class SnapshotStore {
  /**
   * 获取 Blob 目标根目录
   * @param {Record<string, string>} directories
   * @param {string} contentType
   * @param {string} itemUid
   * @returns {string}
   */
  getItemDir(directories, contentType, itemUid) {
    const baseDir = directories?.user || directories?.root || '.';
    return path.join(baseDir, '.cfgsync', contentType, itemUid);
  }

  /**
   * 写入临时 Blob 文件（fsync 落盘）
   * @param {Record<string, string>} directories
   * @param {string} contentType
   * @param {string} itemUid
   * @param {number} version
   * @param {string} ext
   * @param {Buffer} buffer
   * @returns {Promise<{ tmpPath: string, targetPath: string }>}
   */
  async prepareTempBlob(directories, contentType, itemUid, version, ext, buffer) {
    const dir = this.getItemDir(directories, contentType, itemUid);
    await fs.mkdir(dir, { recursive: true });

    const fileName = `v${version}.${ext}`;
    const targetPath = path.join(dir, fileName);
    const tmpPath = path.join(dir, `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);

    // 写入临时文件并落盘
    const fileHandle = await fs.open(tmpPath, 'w');
    try {
      await fileHandle.write(buffer);
      await fileHandle.sync(); // 强制写入硬件
    } finally {
      await fileHandle.close();
    }

    return { tmpPath, targetPath };
  }

  /**
   * 提交临时 Blob 文件（原子重命名为正式版本）
   * @param {string} tmpPath
   * @param {string} targetPath
   * @returns {Promise<string>} targetPath
   */
  async commitBlob(tmpPath, targetPath) {
    await fs.rename(tmpPath, targetPath);
    return targetPath;
  }

  /**
   * 写入 Blob 文件（一步到位）
   */
  async writeBlob(directories, contentType, itemUid, version, ext, buffer) {
    const { tmpPath, targetPath } = await this.prepareTempBlob(directories, contentType, itemUid, version, ext, buffer);
    return await this.commitBlob(tmpPath, targetPath);
  }

  /**
   * 读取特定版本的 Blob
   * @param {string} blobPath
   * @returns {Promise<Buffer>}
   */
  async readBlob(blobPath) {
    return await fs.readFile(blobPath);
  }

  /**
   * 删除指定的 Blob 文件
   * @param {string} blobPath
   */
  async deleteBlob(blobPath) {
    try {
      if (blobPath) {
        await fs.unlink(blobPath);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * 修剪历史版本文件（保留最新的 maxVersions 个）
   * @param {Array<{ version: number, blob_path: string }>} versions 按 version DESC 排序的列表
   * @param {number} [maxVersions]
   * @returns {Promise<string[]>} 被删除的 blob 路径列表
   */
  async pruneOldVersions(versions, maxVersions = DEFAULT_MAX_VERSIONS) {
    if (!versions || versions.length <= maxVersions) {
      return [];
    }

    const pruned = [];
    const toDelete = versions.slice(maxVersions);
    for (const v of toDelete) {
      if (v.blob_path) {
        await this.deleteBlob(v.blob_path);
        pruned.push(v.blob_path);
      }
    }
    return pruned;
  }

  /**
   * 清理孤儿文件（未记录在 config_versions 中的 blob）
   * @param {Record<string, string>} directories
   * @param {Set<string>} activeBlobPaths 数据库中已记录的有效路径集合
   * @param {number} [maxAgeMs] 超过多少毫秒的孤儿文件才清理（默认2小时，避免清理当前写入中的临时文件）
   */
  async cleanupOrphans(directories, activeBlobPaths, maxAgeMs = 2 * 3600 * 1000) {
    const baseDir = directories?.user || directories?.root || '.';
    const syncDir = path.join(baseDir, '.cfgsync');
    
    if (!fsSync.existsSync(syncDir)) {
      return;
    }

    const now = Date.now();
    const scanDir = async (currentDir) => {
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          // 检查是否为临时文件或孤儿 blob
          try {
            const stat = await fs.stat(fullPath);
            const age = now - stat.mtimeMs;
            if (age > maxAgeMs && !activeBlobPaths.has(fullPath)) {
              await fs.unlink(fullPath);
            }
          } catch {
            // 忽略并发删除异常
          }
        }
      }
    };

    await scanDir(syncDir);
  }
}
