/**
 * WebDAV 存储驱动与诊断客户端 (#9)
 * 支持 Nextcloud、群晖 NAS、Alist 等标准 WebDAV 服务器
 * 核心特性：三态精准诊断（认证失败 / 路径不存在 / 网络超时）+ 外部异常绝不阻断本地事务
 */
export class WebDavStorageDriver {
  /**
   * @param {object} options
   * @param {string} [options.url] WebDAV 服务端根 URL
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {boolean} [options.enabled=false]
   * @param {number} [options.timeoutMs=8000]
   */
  constructor(options = {}) {
    this.url = (options.url || '').replace(/\/+$/, '');
    this.username = options.username || '';
    this.password = options.password || '';
    this.enabled = Boolean(options.enabled);
    this.timeoutMs = Number(options.timeoutMs) || 8000;
  }

  updateConfig({ url, username, password, enabled, timeoutMs }) {
    if (url !== undefined) this.url = url.replace(/\/+$/, '');
    if (username !== undefined) this.username = username;
    if (password !== undefined) this.password = password;
    if (enabled !== undefined) this.enabled = Boolean(enabled);
    if (timeoutMs !== undefined) this.timeoutMs = Number(timeoutMs) || 8000;
  }

  getAuthHeader() {
    if (!this.username) return {};
    const creds = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }

  /**
   * 三态错误分类诊断函数 (#9)
   * @param {Error|null} err 网络错误或异常
   * @param {number} [status] HTTP 响应状态码
   * @returns {{ code: 'AUTH_FAILED' | 'NOT_FOUND' | 'NETWORK_TIMEOUT' | 'UNKNOWN', message: string }}
   */
  diagnoseError(err, status = null) {
    if (status === 401 || status === 403) {
      return { code: 'AUTH_FAILED', message: 'WebDAV 认证失败：用户名或密码错误或无权限 (401/403)' };
    }
    if (status === 404) {
      return { code: 'NOT_FOUND', message: 'WebDAV 远端目标目录或资源不存在 (404)' };
    }
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.message?.includes('timeout') || err.message?.includes('fetch failed'))) {
      return { code: 'NETWORK_TIMEOUT', message: `WebDAV 连接超时或网络不可达: ${err.message}` };
    }
    return { code: 'UNKNOWN', message: err?.message || `HTTP ${status}` };
  }

  /**
   * 上传文件至 WebDAV (PUT)
   * @param {string} relPath
   * @param {Buffer} buffer
   */
  async put(relPath, buffer) {
    if (!this.enabled || !this.url) {
      return { success: false, error: 'WebDAV driver not enabled or URL empty' };
    }

    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const targetUrl = `${this.url}/${encodeURI(cleanRel)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(targetUrl, {
        method: 'PUT',
        headers: {
          ...this.getAuthHeader(),
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buffer.length),
        },
        body: buffer,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok || resp.status === 201 || resp.status === 204) {
        return { success: true, url: targetUrl, status: resp.status };
      }

      const diag = this.diagnoseError(null, resp.status);
      console.warn(`[cfgsync:webdav] PUT ${cleanRel} failed: ${diag.code} - ${diag.message}`);
      return { success: false, ...diag, status: resp.status };
    } catch (err) {
      clearTimeout(timer);
      const diag = this.diagnoseError(err);
      console.warn(`[cfgsync:webdav] PUT ${cleanRel} error: ${diag.code} - ${diag.message}`);
      return { success: false, ...diag };
    }
  }

  /**
   * 从 WebDAV 下载文件 (GET)
   * @param {string} relPath
   * @returns {Promise<{ success: boolean, buffer?: Buffer, code?: string, error?: string }>}
   */
  async get(relPath) {
    if (!this.enabled || !this.url) return { success: false, error: 'Driver disabled' };
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const targetUrl = `${this.url}/${encodeURI(cleanRel)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers: this.getAuthHeader(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        return { success: true, buffer: Buffer.from(arrayBuf) };
      }

      const diag = this.diagnoseError(null, resp.status);
      return { success: false, ...diag, status: resp.status };
    } catch (err) {
      clearTimeout(timer);
      return { success: false, ...this.diagnoseError(err) };
    }
  }

  /**
   * 删除 WebDAV 文件 (DELETE)
   */
  async delete(relPath) {
    if (!this.enabled || !this.url) return;
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const targetUrl = `${this.url}/${encodeURI(cleanRel)}`;

    try {
      await fetch(targetUrl, {
        method: 'DELETE',
        headers: this.getAuthHeader(),
      });
    } catch {}
  }

  /**
   * WebDAV 连接连通性健康探测 (PROPFIND / OPTIONS)
   * 返回精准诊断结果
   */
  async checkHealth(timeoutMs = 3000) {
    if (!this.url) {
      return { healthy: false, code: 'NOT_CONFIGURED', message: 'WebDAV URL 未配置' };
    }

    const effectiveTimeout = Math.min(Number(timeoutMs) || 3000, Number(this.timeoutMs) || 8000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const resp = await fetch(this.url, {
        method: 'PROPFIND',
        headers: {
          ...this.getAuthHeader(),
          'Depth': '0',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      // WebDAV PROPFIND 通常返回 207 Multi-Status 或 200
      if (resp.status === 207 || resp.status === 200 || resp.status === 204) {
        return { healthy: true, status: resp.status, message: 'WebDAV 服务连接正常' };
      }

      // 部分服务器不支持 PROPFIND 时降级尝试 HEAD / OPTIONS
      if (resp.status === 405 || resp.status === 501) {
        const headResp = await fetch(this.url, {
          method: 'OPTIONS',
          headers: this.getAuthHeader(),
        });
        if (headResp.ok) {
          return { healthy: true, status: headResp.status, message: 'WebDAV (OPTIONS) 连接正常' };
        }
      }

      const diag = this.diagnoseError(null, resp.status);
      return { healthy: false, ...diag, status: resp.status };
    } catch (err) {
      clearTimeout(timer);
      const diag = this.diagnoseError(err);
      return { healthy: false, ...diag };
    }
  }
}
