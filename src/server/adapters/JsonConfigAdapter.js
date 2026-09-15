import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigAdapter } from './ConfigAdapter.js';
import { canonicalizeJson } from '../../common/utils.js';

/**
 * 针对纯 JSON 类配置的统一抽象基类
 */
export class JsonConfigAdapter extends ConfigAdapter {
  constructor(contentType) {
    super(contentType);
  }

  serialize(content) {
    const jsonStr = JSON.stringify(content, null, 2);
    return {
      buffer: Buffer.from(jsonStr, 'utf8'),
      mimeType: 'application/json',
      ext: 'json',
    };
  }

  deserialize(buffer, mimeType = 'application/json') {
    const text = buffer.toString('utf8');
    return JSON.parse(text);
  }

  canonicalize(content) {
    return canonicalizeJson(content);
  }

  validate(content) {
    return content !== null && typeof content === 'object';
  }

  /**
   * 安全原子写入 JSON 文件（先写 tmp 再 rename）
   * @param {string} filePath
   * @param {any} data
   */
  async safeWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  /**
   * 安全读取 JSON 文件，若不存在返回 null
   * @param {string} filePath
   * @returns {Promise<any | null>}
   */
  async safeReadJson(filePath) {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      return JSON.parse(text);
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
}
