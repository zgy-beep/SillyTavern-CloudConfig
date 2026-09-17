import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * 本地外挂盘 / SMB 挂载目录存储驱动 (N-3, #18)
 * 面向 SMB/CIFS 挂载目录与外挂盘（如 /mnt/huawei_storage, D:\Backups）
 * 核心原则：外部驱动失败绝不阻断本地 CAS 提交流程
 */
export class LocalPathStorageDriver {
  /**
   * @param {object} options
   * @param {string} [options.basePath] 镜像目标根目录
   * @param {boolean} [options.enabled=false] 是否启用
   */
  constructor(options = {}) {
    this.basePath = options.basePath || '';
    this.enabled = Boolean(options.enabled);
  }

  updateConfig({ basePath, enabled }) {
    if (basePath !== undefined) this.basePath = basePath;
    if (enabled !== undefined) this.enabled = Boolean(enabled);
  }

  /**
   * 写入文件（镜像写入，原子 tmp + rename）
   * @param {string} relPath 相对路径
   * @param {Buffer} buffer 数据
   * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
   */
  async write(relPath, buffer) {
    if (!this.enabled || !this.basePath) {
      return { success: false, error: 'Driver not enabled or basePath empty' };
    }

    try {
      const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
      const fullPath = path.join(this.basePath, normalizedRel);

      // 安全防目录穿越
      const resolved = path.resolve(fullPath);
      const resolvedBase = path.resolve(this.basePath);
      if (!resolved.startsWith(resolvedBase)) {
        throw new Error(`Path traversal denied: ${relPath}`);
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      const tmpPath = `${fullPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, buffer);
      await fs.rename(tmpPath, fullPath);

      return { success: true, path: fullPath };
    } catch (err) {
      // 外部驱动异常绝不抛出，记录告警
      console.warn(`[cfgsync:localpath] Failed to mirror write to ${relPath}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 读取镜像文件
   * @param {string} relPath
   * @returns {Promise<Buffer | null>}
   */
  async read(relPath) {
    if (!this.enabled || !this.basePath) return null;
    try {
      const fullPath = path.join(this.basePath, relPath.replace(/\\/g, '/'));
      return await fs.readFile(fullPath);
    } catch (err) {
      return null;
    }
  }

  /**
   * 删除镜像文件
   * @param {string} relPath
   */
  async delete(relPath) {
    if (!this.enabled || !this.basePath) return;
    try {
      const fullPath = path.join(this.basePath, relPath.replace(/\\/g, '/'));
      await fs.unlink(fullPath);
    } catch (err) {
      // 忽略文件不存在或删除失败
    }
  }

  /**
   * 驱动健康检查（测试挂载点可用性与可写性）
   */
  async checkHealth() {
    if (!this.basePath) {
      return { healthy: false, path: '', error: 'basePath not configured' };
    }

    try {
      await fs.mkdir(this.basePath, { recursive: true });
      const testFile = path.join(this.basePath, `.cfgsync_health_${Date.now()}.tmp`);
      await fs.writeFile(testFile, 'healthcheck');
      await fs.unlink(testFile);
      return { healthy: true, path: this.basePath, error: null };
    } catch (err) {
      return { healthy: false, path: this.basePath, error: err.message };
    }
  }
}
