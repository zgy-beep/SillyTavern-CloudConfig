import { LocalPathStorageDriver } from '../storage/LocalPathStorageDriver.js';
import { WebDavStorageDriver } from '../storage/WebDavStorageDriver.js';

/**
 * 多目标镜像存储服务 (N-3, #9, #18)
 * 优先级：LocalPath (SMB/外挂盘) > WebDAV (异地网盘)
 * 关键不变性：外部镜像完全异步进行，任何外部错误绝对不阻断或回滚本地 CAS 提交
 */
export class StorageMirrorService {
  /**
   * @param {object} options
   * @param {import('../config/ConfigService.js').ConfigService} options.configService
   * @param {LocalPathStorageDriver} [options.localDriver]
   * @param {WebDavStorageDriver} [options.webdavDriver]
   */
  constructor({ configService, localDriver = null, webdavDriver = null } = {}) {
    this.configService = configService;
    this.localDriver = localDriver || new LocalPathStorageDriver({
      basePath: configService?.get('localPath') || '',
      enabled: Boolean(configService?.get('localPathEnabled')),
    });
    this.webdavDriver = webdavDriver || new WebDavStorageDriver({
      url: configService?.get('webdavUrl') || '',
      username: configService?.get('webdavUsername') || '',
      password: configService?.get('webdavPassword') || '',
      enabled: Boolean(configService?.get('webdavEnabled')),
    });
  }

  refreshConfig() {
    if (!this.configService) return;
    this.localDriver.updateConfig({
      basePath: this.configService.get('localPath') || '',
      enabled: Boolean(this.configService.get('localPathEnabled')),
    });
    this.webdavDriver.updateConfig({
      url: this.configService.get('webdavUrl') || '',
      username: this.configService.get('webdavUsername') || '',
      password: this.configService.get('webdavPassword') || '',
      enabled: Boolean(this.configService.get('webdavEnabled')),
    });
  }

  /**
   * 异步镜像存储快照 Blob（安全包裹，零异常抛出）
   * @param {string} relPath 相对路径 (如 blobs/character/uid/v1.png)
   * @param {Buffer} buffer 数据
   */
  async mirrorBlob(relPath, buffer) {
    this.refreshConfig();
    const results = {
      local: null,
      webdav: null,
    };

    // 1. 优先写入 LocalPath (SMB/本地外挂盘)
    if (this.localDriver.enabled) {
      try {
        results.local = await this.localDriver.write(relPath, buffer);
      } catch (err) {
        results.local = { success: false, error: err.message };
      }
    }

    // 2. 写入 WebDAV
    if (this.webdavDriver.enabled) {
      try {
        results.webdav = await this.webdavDriver.put(relPath, buffer);
      } catch (err) {
        results.webdav = { success: false, error: err.message };
      }
    }

    return results;
  }

  /**
   * 检查所有启用的外部驱动健康状态（带超时保护，绝不阻塞事件循环）
   * @param {number} [timeoutMs=3000]
   */
  async checkHealth(timeoutMs = 3000) {
    this.refreshConfig();
    const localHealth = this.localDriver.enabled
      ? await this.localDriver.checkHealth(timeoutMs).catch(err => ({ healthy: false, error: err.message }))
      : { enabled: false, healthy: true };

    const webdavHealth = this.webdavDriver.enabled
      ? await this.webdavDriver.checkHealth(timeoutMs).catch(err => ({ healthy: false, error: err.message }))
      : { enabled: false, healthy: true };

    return {
      healthy: (!this.localDriver.enabled || localHealth.healthy) && (!this.webdavDriver.enabled || webdavHealth.healthy),
      local: { enabled: this.localDriver.enabled, ...localHealth },
      webdav: { enabled: this.webdavDriver.enabled, ...webdavHealth },
    };
  }
}


