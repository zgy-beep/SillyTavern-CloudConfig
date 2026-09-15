/**
 * 客户端 IndexedDB 存储管理
 * 严格基于 account_handle 物理隔离所有数据
 */

const DB_NAME = 'ST_CloudConfig_DB';
const DB_VERSION = 1;

export function getClientInstanceId() {
  const KEY = 'st_cfgsync_client_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = 'client_' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(KEY, id);
  }
  return id;
}

export class IdbStorage {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = req.result;

        // 1. sync_bindings 表
        if (!db.objectStoreNames.contains('sync_bindings')) {
          const store = db.createObjectStore('sync_bindings', { keyPath: 'binding_uid' });
          store.createIndex('account_handle', 'account_handle', { unique: false });
        }

        // 2. local_backup 表
        if (!db.objectStoreNames.contains('local_backup')) {
          const store = db.createObjectStore('local_backup', { keyPath: 'binding_uid' });
          store.createIndex('account_handle', 'account_handle', { unique: false });
        }

        // 3. cursors 表
        if (!db.objectStoreNames.contains('cursors')) {
          db.createObjectStore('cursors', { keyPath: 'account_handle' });
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 生成 binding_uid
   * 格式: account_handle + ':' + source_owner_handle + ':' + content_type + ':' + item_uid
   */
  makeBindingUid(accountHandle, sourceOwnerHandle, contentType, itemUid) {
    return `${accountHandle}:${sourceOwnerHandle}:${contentType}:${itemUid}`;
  }

  async getBindingsByAccount(accountHandle) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_bindings', 'readonly');
      const store = tx.objectStore('sync_bindings');
      const index = store.index('account_handle');
      const req = index.getAll(accountHandle);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getBinding(bindingUid) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_bindings', 'readonly');
      const store = tx.objectStore('sync_bindings');
      const req = store.get(bindingUid);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveBinding(binding) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_bindings', 'readwrite');
      const store = tx.objectStore('sync_bindings');
      const req = store.put({
        ...binding,
        updated_at: Date.now(),
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBinding(bindingUid) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_bindings', 'readwrite');
      const store = tx.objectStore('sync_bindings');
      const req = store.delete(bindingUid);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Local Backup 操作
  async saveBackup(bindingUid, accountHandle, content) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('local_backup', 'readwrite');
      const store = tx.objectStore('local_backup');
      const req = store.put({
        binding_uid: bindingUid,
        account_handle: accountHandle,
        snapshot_content: content,
        created_at: Date.now(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getBackup(bindingUid) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('local_backup', 'readonly');
      const store = tx.objectStore('local_backup');
      const req = store.get(bindingUid);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBackup(bindingUid) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('local_backup', 'readwrite');
      const store = tx.objectStore('local_backup');
      const req = store.delete(bindingUid);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 游标操作
  async getLastAckedSeq(accountHandle) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cursors', 'readonly');
      const store = tx.objectStore('cursors');
      const req = store.get(accountHandle);
      req.onsuccess = () => resolve(req.result ? req.result.last_acked_seq : 0);
      req.onerror = () => reject(req.error);
    });
  }

  async saveLastAckedSeq(accountHandle, seq) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cursors', 'readwrite');
      const store = tx.objectStore('cursors');
      const req = store.put({
        account_handle: accountHandle,
        last_acked_seq: seq,
        updated_at: Date.now(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
