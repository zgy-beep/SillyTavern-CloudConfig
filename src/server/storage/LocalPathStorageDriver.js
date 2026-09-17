import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * 带有超时保护的异步执行器，防范断开的 SMB/CIFS 挂载死锁 Node.js 线程池 (BUG-P6-04)
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms 超时毫秒
 * @param {string} [errorMsg]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms = 3000, errorMsg = 'Operation timed out') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMsg);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * 本地外挂盘 / SMB 挂载目录存储驱动 (N-3, #18, BUG-P6-03, BUG-P6-04)
 * 面向 SMB/CIFS 挂载目录与外挂盘（如 /mnt/huawei_storage, D:\Backups）
 * 核心原则：
 * 1. 外部驱动失败绝不阻断本地 CAS 提交流程
 * 2. 外部与文件 IO 强制超时保护（≤3s/5s），死锁与假死挂载点快速失败，绝不卡住 Node 事件循环
 * 3. 容器环境自动探测与回显容器内绝对路径，防止误写容器易失层 (BUG-P6-03)
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

  get resolvedPath() {
    return this.basePath ? path.resolve(this.basePath) : '';
  }

  isContainerEnvironment() {
    return LocalPathStorageDriver.isContainerEnvironment();
  }

  /**
   * 检测是否处于 Docker/Podman 容器环境中
   * @returns {boolean}
   */
  static isContainerEnvironment() {
    try {
      if (fsSync.existsSync('/.dockerenv') || fsSync.existsSync('/run/.containerenv')) {
        return true;
      }
      if (fsSync.existsSync('/proc/1/cgroup')) {
        const cgroup = fsSync.readFileSync('/proc/1/cgroup', 'utf8');
        if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  /**
   * 写入文件（镜像写入，原子 tmp + rename，支持超时保护）
   * @param {string} relPath 相对路径
   * @param {Buffer} buffer 数据
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
   */
  async write(relPath, buffer, timeoutMs = 5000) {
    if (!this.enabled || !this.basePath) {
      return { success: false, error: 'Driver not enabled or basePath empty' };
    }

    const writeOp = async () => {
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
    };

    try {
      return await withTimeout(writeOp(), timeoutMs, `LocalPath 写入超时（挂载点未响应，限时 ${timeoutMs}ms）`);
    } catch (err) {
      console.warn(`[cfgsync:localpath] Failed to mirror write to ${relPath}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 读取镜像文件
   * @param {string} relPath
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<Buffer | null>}
   */
  async read(relPath, timeoutMs = 3000) {
    if (!this.enabled || !this.basePath) return null;
    try {
      const fullPath = path.join(this.basePath, relPath.replace(/\\/g, '/'));
      return await withTimeout(fs.readFile(fullPath), timeoutMs, `LocalPath 读取超时（限时 ${timeoutMs}ms）`);
    } catch (err) {
      return null;
    }
  }

  /**
   * 删除镜像文件
   * @param {string} relPath
   * @param {number} [timeoutMs=3000]
   */
  async delete(relPath, timeoutMs = 3000) {
    if (!this.enabled || !this.basePath) return;
    try {
      const fullPath = path.join(this.basePath, relPath.replace(/\\/g, '/'));
      await withTimeout(fs.unlink(fullPath), timeoutMs);
    } catch (err) {
      // 忽略文件不存在或删除失败
    }
  }

  /**
   * 驱动健康检查（测试挂载点可用性与可写性，带超时保护与容器路径解析）
   * 严禁任何长时间阻塞事件循环的操作 (BUG-P6-03, BUG-P6-04)
   * @param {number} [timeoutMs=3000]
   */
  async checkHealth(timeoutMs = 3000) {
    const isContainer = this.isContainerEnvironment();
    const resolvedPath = this.resolvedPath;

    if (!this.basePath) {
      return {
        healthy: false,
        path: '',
        resolvedPath: '',
        isContainer,
        error: 'basePath not configured',
      };
    }

    const checkOp = async () => {
      await fs.mkdir(this.basePath, { recursive: true });
      const testFile = path.join(this.basePath, `.cfgsync_health_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      await fs.writeFile(testFile, 'healthcheck');
      await fs.unlink(testFile).catch(() => {});

      let containerWarning = null;
      if (isContainer) {
        containerWarning = `⚠️ 当前 SillyTavern 运行在 Docker 容器内，所配置路径已解析为容器内路径「${resolvedPath}」。请务必确认该路径在 docker run 或 docker-compose 中已配置卷映射挂载（-v /宿主机路径:${resolvedPath}），否则容器重启后备份数据将会丢失。`;
      }

      return {
        healthy: true,
        path: this.basePath,
        resolvedPath,
        isContainer,
        containerWarning,
        error: null,
      };
    };

    try {
      return await withTimeout(checkOp(), timeoutMs, `LocalPath 访问超时（挂载目录未就绪或 SMB/CIFS 已断开，限时 ${timeoutMs}ms）`);
    } catch (err) {
      return {
        healthy: false,
        path: this.basePath,
        resolvedPath,
        isContainer,
        code: err.code || 'TIMEOUT',
        error: err.message,
      };
    }
  }
}
