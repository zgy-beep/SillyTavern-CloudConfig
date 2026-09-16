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

  async push({ contentType, itemUid, displayName, baseVersion, operation, checksum, payload, clientId, versionTitle, force }) {
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
}
