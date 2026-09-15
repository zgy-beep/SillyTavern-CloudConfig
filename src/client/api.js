/**
 * REST API 客户端封装
 */
export class CloudConfigApi {
  constructor(baseUrl = '/api/plugins/cfgsync') {
    this.baseUrl = baseUrl;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
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

  async getItems(contentType, owner = '', scope = 'cloud') {
    const params = new URLSearchParams({
      content_type: contentType,
      scope,
    });
    if (owner) params.append('owner', owner);
    return this.request(`/items?${params.toString()}`);
  }

  async pull(contentType, itemUid, owner = '', version = null) {
    const params = new URLSearchParams({
      content_type: contentType,
      item_uid: itemUid,
    });
    if (owner) params.append('owner', owner);
    if (version) params.append('version', String(version));
    return this.request(`/pull?${params.toString()}`);
  }

  async push({ contentType, itemUid, displayName, baseVersion, operation, checksum, payload, clientId }) {
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
      }),
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
}
