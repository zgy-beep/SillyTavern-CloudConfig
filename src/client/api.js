/**
 * REST API 客户端封装
 */
export class CloudConfigApi {
  constructor(baseUrl = '/api/plugins/cfgsync') {
    this.baseUrl = baseUrl;
  }

  async getHeaders() {
    let stHeaders = {};
    if (typeof window !== 'undefined') {
      if (typeof window.getRequestHeaders === 'function') {
        try {
          stHeaders = window.getRequestHeaders();
        } catch {}
      } else if (window.SillyTavern?.getContext?.()?.getRequestHeaders) {
        try {
          stHeaders = window.SillyTavern.getContext().getRequestHeaders();
        } catch {}
      } else {
        try {
          const utils = await import('/scripts/utils.js').catch(() => null);
          if (utils && typeof utils.getRequestHeaders === 'function') {
            stHeaders = utils.getRequestHeaders();
          }
        } catch {}
      }

      if (!stHeaders['X-CSRF-Token'] && !stHeaders['x-csrf-token']) {
        const metaCsrf = typeof document !== 'undefined' && document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (metaCsrf) {
          stHeaders['X-CSRF-Token'] = metaCsrf;
        }
      }
    }
    return stHeaders;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const stHeaders = await this.getHeaders();
    const headers = {
      'Content-Type': 'application/json',
      ...stHeaders,
      ...options.headers,
    };

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const error = new Error(data.message || `Request failed with status ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async getContentTypes() {
    return this.request('/content-types');
  }

  async getOwners() {
    return this.request('/owners');
  }

  async getItems(contentType, owner = '', scope = 'cloud', allOwners = false) {
    const params = new URLSearchParams({
      content_type: contentType,
      scope,
    });
    if (allOwners) params.append('all_owners', 'true');
    if (owner && !allOwners) params.append('owner', owner);
    return this.request(`/items?${params.toString()}`);
  }

  async pull(contentType, itemUid, owner = '', version = null, apply = false) {
    const params = new URLSearchParams({
      content_type: contentType,
      item_uid: itemUid,
    });
    if (owner) params.append('owner', owner);
    if (version) params.append('version', String(version));
    if (apply) params.append('apply', 'true');
    return this.request(`/pull?${params.toString()}`);
  }

  async push({ contentType, itemUid, displayName, baseVersion, operation, checksum, payload, clientId, versionTitle, force, excludeHeavy, exclude_heavy }) {
    const effExcludeHeavy = excludeHeavy !== undefined ? excludeHeavy : exclude_heavy;
    return this.request('/push', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        display_name: displayName,
        base_version: baseVersion,
        operation,
        checksum,
        payload,
        client_id: clientId,
        version_title: versionTitle,
        force,
        exclude_heavy: effExcludeHeavy,
      }),
    });
  }

  async getConfig() {
    return this.request('/config');
  }

  async updateConfig(config) {
    return this.request('/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async getChanges(sinceSeq = 0, limit = 100) {
    const params = new URLSearchParams({
      since: String(sinceSeq),
      limit: String(limit),
    });
    return this.request(`/changes?${params.toString()}`);
  }

  async getVersions(contentType, itemUid, owner = '') {
    const params = new URLSearchParams({
      content_type: contentType,
      item_uid: itemUid,
    });
    if (owner) params.append('owner', owner);
    return this.request(`/versions?${params.toString()}`);
  }

  async getStats() {
    return this.request('/stats');
  }

  async cleanOrphans(dryRun = true, targetOwner = null) {
    return this.request('/clean-orphans', {
      method: 'POST',
      body: JSON.stringify({
        dry_run: dryRun,
        target_owner: targetOwner,
      }),
    });
  }

  async deleteVersion({ contentType, itemUid, version, owner = null }) {
    return this.request('/versions', {
      method: 'DELETE',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        version,
        owner,
      }),
    });
  }

  async setVersionLock({ contentType, itemUid, version, locked, owner = null }) {
    return this.request('/versions/lock', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        version,
        locked,
        owner,
      }),
    });
  }

  async rollback({ contentType, itemUid, targetVersion, baseVersion, clientId }) {
    return this.request('/rollback', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        target_version: targetVersion,
        base_version: baseVersion,
        client_id: clientId,
      }),
    });
  }

  // --- Phase 2: 分享与认领 API ---

  async createShareCode({ contentType, itemUid, scopeType = 'ITEM', codeUsage = 'single_use', maxUses = 1, expiresInMs, injectSecrets = false }) {
    return this.request('/shares/create-code', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        scope_type: scopeType,
        code_usage: codeUsage,
        max_uses: maxUses,
        expires_in_ms: expiresInMs,
        inject_secrets: injectSecrets,
      }),
    });
  }

  async claimShareCode(shareCode, clientId) {
    return this.request('/shares/claim-code', {
      method: 'POST',
      body: JSON.stringify({
        share_code: shareCode,
        client_id: clientId,
      }),
    });
  }

  async quickPublic({ contentType, itemUid, scopeType = 'ITEM', enabled = true, injectSecrets = false }) {
    return this.request('/shares/quick-public', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        scope_type: scopeType,
        enabled,
        inject_secrets: injectSecrets,
      }),
    });
  }

  async revokeShare({ grantId, shareCodeHash }) {
    return this.request('/shares/revoke', {
      method: 'POST',
      body: JSON.stringify({
        grant_id: grantId,
        share_code_hash: shareCodeHash,
      }),
    });
  }

  async getOutgoingShares() {
    return this.request('/shares/outgoing');
  }

  async getIncomingShares() {
    return this.request('/shares/incoming');
  }

  async getAuditLogs(limit = 50, since = 0) {
    const params = new URLSearchParams({
      limit: String(limit),
      since: String(since),
    });
    return this.request(`/audit?${params.toString()}`);
  }

  async deleteItem({ contentType, itemUid, deleteCloud = true, deleteLocal = false }) {
    return this.request('/items', {
      method: 'DELETE',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        delete_cloud: deleteCloud,
        delete_local: deleteLocal,
      }),
    });
  }

  async setLock({ contentType, itemUid, owner = null, locked = true }) {
    return this.request('/lock', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        item_uid: itemUid,
        owner,
        locked,
      }),
    });
  }

  /**
   * 导出全量灾备归档包 (ZIP)
   * @returns {Promise<{ blob: Blob, fileName: string }>}
   */
  async exportBackup() {
    const url = `${this.baseUrl}/backup/export`;
    const stHeaders = await this.getHeaders();
    const res = await fetch(url, {
      method: 'GET',
      headers: stHeaders,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `导出灾备包失败 (${res.status})`);
    }

    const disposition = res.headers.get('content-disposition');
    let fileName = 'cfgsync-backup.zip';
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) fileName = match[1];
    }

    const blob = await res.blob();
    return { blob, fileName };
  }

  /**
   * 导入灾备归档包 (支持 File, Blob, ArrayBuffer, Buffer)
   * 采用标准 application/octet-stream 原始二进制流传输，绝无 JSON 内存膨胀 (BUG-P6-01)
   * @param {Blob | ArrayBuffer | Buffer} data
   */
  async importBackup(data) {
    const url = `${this.baseUrl}/backup/import`;
    const stHeaders = await this.getHeaders();
    const headers = {
      ...stHeaders,
      'Content-Type': 'application/octet-stream',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: data,
    });

    const resData = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(resData.message || `导入灾备包失败 (${res.status})`);
      err.status = res.status;
      err.data = resData;
      throw err;
    }
    return resData;
  }

  /**
   * 检查外部存储驱动与挂载点健康状态 (BUG-P6-04)
   */
  async getStorageHealth() {
    return this.request('/storage/health');
  }
}

