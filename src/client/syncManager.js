import { SyncState, SyncMode } from '../common/constants.js';
import { getClientInstanceId } from './db/idb.js';

/**
 * 客户端同步状态机与生命周期管理
 */
export class ClientSyncManager {
  /**
   * @param {import('./api.js').CloudConfigApi} api
   * @param {import('./db/idb.js').IdbStorage} storage
   */
  constructor(api, storage) {
    this.api = api;
    this.storage = storage;
    this.clientId = getClientInstanceId();
  }

  /**
   * 开启某项配置的云同步
   */
  async enableSync(accountHandle, contentType, itemUid, displayName, localContent = null, sourceOwnerHandle = null) {
    const sourceOwner = sourceOwnerHandle || accountHandle;
    const bindingUid = this.storage.makeBindingUid(accountHandle, sourceOwner, contentType, itemUid);
    let binding = await this.storage.getBinding(bindingUid);

    // 1. 如果此前处于 DISABLED_RESTORED 或全新开启，创建冷备份
    if (!binding || binding.state === SyncState.DISABLED_RESTORED || binding.state === SyncState.DISABLED) {
      if (localContent) {
        await this.storage.saveBackup(bindingUid, accountHandle, localContent);
      }

      binding = {
        binding_uid: bindingUid,
        account_handle: accountHandle,
        content_type: contentType,
        item_uid: itemUid,
        display_name: displayName,
        source_owner_handle: sourceOwner,
        sync_mode: sourceOwner !== accountHandle ? SyncMode.SUBSCRIBE : SyncMode.OWN,
        enabled: true,
        state: SyncState.BACKUP_CREATED,
        last_notified_version: 0,
        last_synced_version: 0,
        last_synced_checksum: null,
        local_backup_ref: bindingUid,
      };
      await this.storage.saveBinding(binding);
    } else {
      binding.enabled = true;
      await this.storage.saveBinding(binding);
    }

    return binding;
  }

  /**
   * 关闭同步并支持回滚到冷备份
   * @param {string} bindingUid
   * @param {boolean} shouldRestore 是否恢复备份
   * @param {(content: any) => Promise<void>} applyLocalCb 恢复本地的回调函数
   */
  async disableSync(bindingUid, shouldRestore = false, applyLocalCb = null) {
    const binding = await this.storage.getBinding(bindingUid);
    if (!binding) return;

    if (shouldRestore) {
      const backup = await this.storage.getBackup(bindingUid);
      if (backup && backup.snapshot_content && applyLocalCb) {
        await applyLocalCb(backup.snapshot_content);
      }
      binding.state = SyncState.DISABLED_RESTORED;
    } else {
      binding.state = SyncState.DISABLED;
    }

    binding.enabled = false;
    await this.storage.saveBinding(binding);
    return binding;
  }

  /**
   * 将本地配置推送到云端（带 CAS 检查）
   */
  async pushLocal(binding, localPayload) {
    try {
      const res = await this.api.push({
        contentType: binding.content_type,
        itemUid: binding.item_uid,
        displayName: binding.display_name,
        baseVersion: binding.last_synced_version || 0,
        operation: 'UPSERT',
        payload: localPayload,
        clientId: this.clientId,
      });

      binding.last_synced_version = res.version;
      binding.last_notified_version = res.version;
      binding.last_synced_checksum = res.checksum;
      binding.state = SyncState.SYNCED;
      await this.storage.saveBinding(binding);

      return { success: true, version: res.version };
    } catch (err) {
      if (err.status === 409) {
        binding.state = SyncState.CONFLICT;
        binding.last_notified_version = err.data?.server_version || (binding.last_synced_version + 1);
        await this.storage.saveBinding(binding);
        return {
          success: false,
          conflict: true,
          serverVersion: err.data?.server_version,
          isDeleted: err.data?.is_deleted,
        };
      }
      throw err;
    }
  }

  /**
   * 从云端拉取配置并覆盖本地
   */
  async pullCloud(binding, applyLocalCb = null) {
    const res = await this.api.pull(
      binding.content_type,
      binding.item_uid,
      binding.source_owner_handle || '',
      null,
      true
    );

    if (applyLocalCb) {
      await applyLocalCb(res.content);
    }

    binding.last_synced_version = res.version;
    binding.last_notified_version = res.version;
    binding.last_synced_checksum = res.checksum;
    if (res.owner_handle) {
      binding.source_owner_handle = res.owner_handle;
    }
    binding.state = SyncState.SYNCED;
    await this.storage.saveBinding(binding);

    return res;
  }

  /**
   * 处理 409 冲突决策
   */
  async resolveConflict(binding, choice, localPayload = null, applyLocalCb = null) {
    if (choice === 'PULL_CLOUD') {
      return await this.pullCloud(binding, applyLocalCb);
    } else if (choice === 'OVERWRITE_CLOUD') {
      // 强制覆盖：以云端最新已知版本作为 base_version 再次提交
      const res = await this.api.push({
        contentType: binding.content_type,
        itemUid: binding.item_uid,
        displayName: binding.display_name,
        baseVersion: binding.last_notified_version,
        operation: 'UPSERT',
        payload: localPayload,
        clientId: this.clientId,
      });

      binding.last_synced_version = res.version;
      binding.last_notified_version = res.version;
      binding.last_synced_checksum = res.checksum;
      binding.state = SyncState.SYNCED;
      await this.storage.saveBinding(binding);
      return res;
    } else {
      // CANCEL: 保持 CONFLICT 状态
      return null;
    }
  }
}
