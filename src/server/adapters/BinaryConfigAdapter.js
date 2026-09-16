import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigAdapter, MergeStrategy } from './ConfigAdapter.js';
import { autoBackupLocalFile } from './P0Adapters.js';

/**
 * 针对二进制资产（角色卡、主题、背景等）的通用适配器基类
 * 遵循严格的原始字节 SHA-256 Checksum 与 REPLACE 写入语义
 */
export class BinaryConfigAdapter extends ConfigAdapter {
  /**
   * @param {string} contentType
   * @param {(directories: any) => string} getPrimaryDirFn
   * @param {(directories: any) => string[]} getCandidateDirs
   * @param {string} [reloadStrategy]
   */
  constructor(contentType, getPrimaryDirFn, getCandidateDirs, reloadStrategy = 'none') {
    super(contentType, MergeStrategy.REPLACE);
    this.getPrimaryDirFn = getPrimaryDirFn;
    this.getCandidateDirsFn = getCandidateDirs;
    this.reloadStrategy = reloadStrategy;
  }

  /**
   * 规范化用于 Checksum 计算的字节流：一律输出原始文件字节 Buffer (P5-1)
   * @param {Buffer | { buffer: Buffer }} content
   * @returns {Buffer}
   */
  canonicalize(content) {
    if (Buffer.isBuffer(content)) {
      return content;
    }
    if (content && Buffer.isBuffer(content.buffer)) {
      return content.buffer;
    }
    if (typeof content === 'string') {
      return Buffer.from(content, 'utf8');
    }
    return Buffer.from('');
  }

  /**
   * 序列化为存储 Blob
   * @param {Buffer | { buffer: Buffer, mimeType?: string, ext?: string }} content
   * @returns {{ buffer: Buffer, mimeType: string, ext: string }}
   */
  serialize(content) {
    let buf = null;
    let mimeType = 'application/octet-stream';
    let ext = 'bin';

    if (Buffer.isBuffer(content)) {
      buf = content;
    } else if (content && Buffer.isBuffer(content.buffer)) {
      buf = content.buffer;
      if (content.mimeType) mimeType = content.mimeType;
      if (content.ext) ext = content.ext;
    } else {
      buf = Buffer.from(content || '');
    }

    // 简单 MIME 嗅探
    if (mimeType === 'application/octet-stream' && buf.length >= 8) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        mimeType = 'image/png';
        ext = 'png';
      } else if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        mimeType = 'image/jpeg';
        ext = 'jpg';
      } else if (buf[0] === 0x7B || buf[0] === 0x5B) {
        mimeType = 'application/json';
        ext = 'json';
      }
    }

    return {
      buffer: buf,
      mimeType,
      ext,
    };
  }

  /**
   * 从存储 Blob 反序列化：二进制类保持原始 Buffer
   * @param {Buffer} buffer
   * @param {string} [mimeType]
   * @returns {Buffer}
   */
  deserialize(buffer, mimeType = 'application/octet-stream') {
    return buffer;
  }

  /**
   * 校验内容有效性
   * @param {any} content
   * @returns {boolean}
   */
  validate(content) {
    if (Buffer.isBuffer(content)) return true;
    if (content && Buffer.isBuffer(content.buffer)) return true;
    return typeof content === 'string';
  }

  /**
   * 安全原子写入二进制文件（先写 tmp 再 rename）
   * @param {string} filePath
   * @param {Buffer} buffer
   */
  async safeWriteFile(filePath, buffer) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);
  }

  /**
   * 安全读取文件
   * @param {string} filePath
   * @returns {Promise<Buffer | null>}
   */
  async safeReadFile(filePath) {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * 安全删除文件，忽略不存在错误
   * @param {string} filePath
   */
  async safeDeleteFile(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async getPrimaryDir(directories) {
    const primary = this.getPrimaryDirFn(directories);
    await fs.mkdir(primary, { recursive: true });
    return primary;
  }

  getCandidateDirs(directories) {
    return this.getCandidateDirsFn ? this.getCandidateDirsFn(directories) : [this.getPrimaryDirFn(directories)];
  }

  getReloadStrategy() {
    return this.reloadStrategy;
  }
}
