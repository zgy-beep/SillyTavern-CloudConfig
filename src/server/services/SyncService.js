import { OperationType, Permission, DEFAULT_MAX_VERSIONS } from '../../common/constants.js';
import { calcJsonChecksum, sha256 } from '../../common/utils.js';

export class ConflictError extends Error {
  constructor(message, serverVersion, currentChecksum, isDeleted = false) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.serverVersion = serverVersion;
    this.currentChecksum = currentChecksum;
    this.isDeleted = isDeleted;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
  }
}

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
  }
}

/**
 * 核心配置同步引擎
 */
export class SyncService {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   * @param {Map<string, import('../adapters/ConfigAdapter.js').ConfigAdapter>} adapters
   * @param {import('../storage/SnapshotStore.js').SnapshotStore} snapshotStore
   * @param {import('./AuthorizationService.js').AuthorizationService} authService
   * @param {number} [maxVersions]
   */
  constructor(dbClient, adapters, snapshotStore, authService, configService = null, maxVersions = DEFAULT_MAX_VERSIONS) {
    if (configService && typeof configService === 'number') {
      maxVersions = configService;
      configService = null;
    }
    this.db = dbClient;
    this.adapters = adapters;
    this.store = snapshotStore;
    this.auth = authService;
    this.configService = configService;
    this.maxVersions = maxVersions;

    this.prepareStatements();
  }

  prepareStatements() {
    this.stmtGetRecord = this.db.prepare(`
      SELECT * FROM config_records
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
    `);

    this.stmtInitRecord = this.db.prepare(`
      INSERT INTO config_records (
        owner_handle, content_type, item_uid, display_name, current_version,
        current_checksum, mime_type, ext, is_deleted, updated_at, updated_by_client
      )
      VALUES (
        :owner, :ct, :uid, :displayName, 0,
        NULL, :mimeType, :ext, 0, :now, :clientId
      )
      ON CONFLICT(owner_handle, content_type, item_uid) DO NOTHING
    `);

    this.stmtCasUpdate = this.db.prepare(`
      UPDATE config_records
      SET current_version = current_version + 1,
          display_name = COALESCE(:displayName, display_name),
          current_checksum = :checksum,
          mime_type = :mimeType,
          ext = :ext,
          is_deleted = :isDeleted,
          updated_at = :now,
          updated_by_client = :clientId
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
        AND current_version = :baseVersion
    `);

    this.stmtDirectUpdate = this.db.prepare(`
      UPDATE config_records
      SET current_version = :nextVersion,
          display_name = COALESCE(:displayName, display_name),
          current_checksum = :checksum,
          mime_type = :mimeType,
          ext = :ext,
          is_deleted = :isDeleted,
          updated_at = :now,
          updated_by_client = :clientId
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
    `);

    this.stmtInsertVersion = this.db.prepare(`
      INSERT INTO config_versions (
        owner_handle, content_type, item_uid, version, operation,
        checksum, mime_type, ext, blob_path, version_title, size_bytes,
        created_at, created_by_client
      )
      VALUES (
        :owner, :ct, :uid, :version, :op,
        :checksum, :mimeType, :ext, :blobPath, :versionTitle, :sizeBytes,
        :now, :clientId
      )
    `);

    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO change_events (
        owner_handle, content_type, item_uid, version, operation, created_at
      )
      VALUES (
        :owner, :ct, :uid, :version, :op, :now
      )
    `);

    this.stmtGetVersion = this.db.prepare(`
      SELECT * FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version
    `);

    this.stmtGetVersionsDesc = this.db.prepare(`
      SELECT version, version_title, size_bytes, blob_path, operation, checksum, created_at, created_by_client, is_locked
      FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
      ORDER BY version DESC
    `);

    this.stmtSetVersionLock = this.db.prepare(`
      UPDATE config_versions
      SET is_locked = :locked
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version
    `);

    this.stmtDeleteVersionRow = this.db.prepare(`
      DELETE FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version
    `);

    this.stmtFindAnyRecord = this.db.prepare(`
      SELECT * FROM config_records
      WHERE content_type = :ct AND item_uid = :uid AND is_deleted = 0
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    this.stmtGetLock = this.db.prepare(`
      SELECT locked FROM binding_locks
      WHERE requester_handle = :requester AND owner_handle = :owner AND content_type = :ct AND item_uid = :uid
    `);

    this.stmtSetLock = this.db.prepare(`
      INSERT INTO binding_locks (requester_handle, owner_handle, content_type, item_uid, locked, locked_at)
      VALUES (:requester, :owner, :ct, :uid, :locked, :now)
      ON CONFLICT(requester_handle, owner_handle, content_type, item_uid)
      DO UPDATE SET locked = :locked, locked_at = :now
    `);

    this.stmtGetLocksByRequester = this.db.prepare(`
      SELECT owner_handle, item_uid, locked FROM binding_locks
      WHERE requester_handle = :requester AND content_type = :ct
    `);

    this.stmtDeleteLocksForItem = this.db.prepare(`
      DELETE FROM binding_locks
      WHERE (owner_handle = :owner OR requester_handle = :owner) AND content_type = :ct AND item_uid = :uid
    `);
  }

  getAdapter(contentType) {
    const adapter = this.adapters.get(contentType);
    if (!adapter) {
      throw new BadRequestError(`Unsupported content_type: ${contentType}`);
    }
    return adapter;
  }

  /**
   * 核心原子 CAS 写入入口（统一支持创建、更新、删除）
   * @param {object} params
   * @param {import('../auth/AuthContext.js').AuthContext} params.authContext
   * @param {string} params.ownerHandle
   * @param {string} params.contentType
   * @param {string} params.itemUid
   * @param {string} [params.displayName]
   * @param {number} params.baseVersion
   * @param {'UPSERT' | 'DELETE'} params.operation
   * @param {string} [params.checksum]
   * @param {any} [params.payload]
   * @param {string} [params.clientId]
   * @returns {Promise<{ version: number, checksum: string | null }>}
   */
  async push({
    authContext,
    ownerHandle,
    contentType,
    itemUid,
    displayName = null,
    versionTitle = null,
    baseVersion,
    force = null,
    excludeHeavy = null,
    exclude_heavy = null,
    operation = OperationType.UPSERT,
    checksum = null,
    payload = null,
    clientId = 'unknown',
  }) {
    // 1. 权限校验：写操作仅限所有者
    if (!this.auth.can(Permission.WRITE, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no write permission on '${ownerHandle}/${contentType}/${itemUid}'`);
    }

    const adapter = this.getAdapter(contentType);
    const now = Date.now();

    // 清洗 versionTitle：单行化、去空格、限长 64 字符、空串回退默认秒级时间名
    let cleanTitle = null;
    if (typeof versionTitle === 'string') {
      cleanTitle = versionTitle.replace(/[\r\n]/g, ' ').trim().slice(0, 64);
    }
    if (!cleanTitle) {
      const d = new Date(now);
      const pad = (n) => String(n).padStart(2, '0');
      cleanTitle = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 备份`;
    }

    if (!displayName && adapter && typeof adapter.listItems === 'function') {
      try {
        const localItems = await adapter.listItems(authContext.directories);
        const matched = localItems.find(i => i.itemUid === itemUid);
        if (matched?.displayName) {
          displayName = matched.displayName;
        }
      } catch {}
    }

    let serialized = null;
    let actualChecksum = checksum;

    // 2. 数据校验与序列化
    if (operation === OperationType.UPSERT) {
      // 若客户端未提供 payload，则由适配器从本地真实文件读取
      if (payload === null || payload === undefined || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
        // D-1 优先级：按次入参 > 全局 ConfigService > 默认 true
        const perPushVal = excludeHeavy !== null && excludeHeavy !== undefined ? excludeHeavy : exclude_heavy;
        const effectiveExcludeHeavy = (perPushVal !== null && perPushVal !== undefined)
          ? Boolean(perPushVal)
          : (this.configService?.get('excludeHeavyExtensions') !== undefined
              ? Boolean(this.configService.get('excludeHeavyExtensions'))
              : true);

        try {
          payload = await adapter.read(authContext.directories, itemUid, { excludeHeavy: effectiveExcludeHeavy });
        } catch (readErr) {
          if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
            throw new BadRequestError(`No payload provided and failed to read local file: ${readErr.message}`);
          }
        }
      }

      if (!adapter.validate(payload)) {
        throw new BadRequestError(`Invalid payload for content_type: ${contentType}`);
      }
      serialized = adapter.serialize(payload);
      actualChecksum = sha256(adapter.canonicalize(payload));
    }

    const sizeBytes = serialized ? serialized.buffer.length : 0;

    // 判断是否采用直推模式
    const isForce = force !== null && force !== undefined
      ? Boolean(force)
      : Boolean(this.configService?.get('forcePush'));

    // 获取当前云端记录
    let currentRecord = this.stmtGetRecord.get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    if (!currentRecord) {
      this.stmtInitRecord.run({
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
        ':displayName': displayName || `item_${itemUid.slice(0, 8)}`,
        ':mimeType': serialized ? serialized.mimeType : null,
        ':ext': serialized ? serialized.ext : null,
        ':now': now,
        ':clientId': clientId,
      });
      currentRecord = this.stmtGetRecord.get({
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
      });
    }

    // 计算预期版本号
    const nextVersion = isForce
      ? (currentRecord ? currentRecord.current_version : 0) + 1
      : (baseVersion !== undefined ? baseVersion + 1 : (currentRecord ? currentRecord.current_version : 0) + 1);

    let tempBlobInfo = null;

    // 写入临时 Blob 并落盘（DELETE 操作跳过）
    if (operation === OperationType.UPSERT && serialized) {
      tempBlobInfo = await this.store.prepareTempBlob(
        authContext.directories,
        contentType,
        itemUid,
        nextVersion,
        serialized.ext,
        serialized.buffer
      );
    }

    // 执行原子事务
    let txSuccess = false;
    let committedVersion = 0;
    let committedSeq = null;
    try {
      this.db.transaction(() => {
        if (isForce) {
          // 直推模式：直接覆盖递增版本，墓碑自动复活 (is_deleted = 0)
          this.stmtDirectUpdate.run({
            ':displayName': displayName,
            ':checksum': actualChecksum,
            ':mimeType': serialized ? serialized.mimeType : null,
            ':ext': serialized ? serialized.ext : null,
            ':isDeleted': operation === OperationType.DELETE ? 1 : 0,
            ':now': now,
            ':clientId': clientId,
            ':owner': ownerHandle,
            ':ct': contentType,
            ':uid': itemUid,
            ':nextVersion': nextVersion,
          });
        } else {
          // CAS 模式
          const updateInfo = this.stmtCasUpdate.run({
            ':displayName': displayName,
            ':checksum': actualChecksum,
            ':mimeType': serialized ? serialized.mimeType : null,
            ':ext': serialized ? serialized.ext : null,
            ':isDeleted': operation === OperationType.DELETE ? 1 : 0,
            ':now': now,
            ':clientId': clientId,
            ':owner': ownerHandle,
            ':ct': contentType,
            ':uid': itemUid,
            ':baseVersion': baseVersion,
          });

          // CAS 竞争失败（受影响行数为 0）
          if (updateInfo.changes === 0) {
            const currentRec = this.stmtGetRecord.get({
              ':owner': ownerHandle,
              ':ct': contentType,
              ':uid': itemUid,
            });
            const serverVer = currentRec ? currentRec.current_version : 0;
            const currentChk = currentRec ? currentRec.current_checksum : null;
            const isDel = currentRec ? Boolean(currentRec.is_deleted) : false;
            throw new ConflictError(
              `Version conflict: expected base_version ${baseVersion}, but server is at version ${serverVer}`,
              serverVer,
              currentChk,
              isDel
            );
          }
        }

        committedVersion = nextVersion;

        // 记录历史版本（包含 version_title 与 size_bytes）
        this.stmtInsertVersion.run({
          ':owner': ownerHandle,
          ':ct': contentType,
          ':uid': itemUid,
          ':version': committedVersion,
          ':op': operation,
          ':checksum': actualChecksum,
          ':mimeType': serialized ? serialized.mimeType : null,
          ':ext': serialized ? serialized.ext : null,
          ':blobPath': tempBlobInfo ? tempBlobInfo.targetPath : null,
          ':versionTitle': cleanTitle,
          ':sizeBytes': sizeBytes,
          ':now': now,
          ':clientId': clientId,
        });

        // 插入全局变更事件
        const eventRes = this.stmtInsertEvent.run({
          ':owner': ownerHandle,
          ':ct': contentType,
          ':uid': itemUid,
          ':version': committedVersion,
          ':op': operation,
          ':now': now,
        });
        committedSeq = eventRes.lastInsertRowid;
      });

      // 事务提交后，原子重命名临时 blob 为正式 blob
      if (tempBlobInfo) {
        await this.store.commitBlob(tempBlobInfo.tmpPath, tempBlobInfo.targetPath);
      }

      txSuccess = true;
    } finally {
      // 若事务失败，清理未提交的临时 blob
      if (!txSuccess && tempBlobInfo) {
        await this.store.deleteBlob(tempBlobInfo.tmpPath);
      }
    }

    // 触发历史版本修剪
    try {
      await this.pruneVersions(ownerHandle, contentType, itemUid);
    } catch (e) {
      console.warn('[cfgsync] Pruning versions failed:', e.message);
    }

    return {
      version: committedVersion,
      checksum: actualChecksum,
      version_title: cleanTitle,
      size_bytes: sizeBytes,
      seq: committedSeq,
    };
  }

  /**
   * 拉取指定对象内容
   * @param {import('../auth/AuthContext.js').AuthContext} authContext
   * @param {string} ownerHandle
   * @param {string} contentType
   * @param {string} itemUid
   * @param {number} [targetVersion] 可选指定历史版本号，不填默认当前最新
   */
  async pull(authContext, ownerHandle, contentType, itemUid, targetVersion = null) {
    if (!this.auth.can(Permission.READ, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no read permission on '${ownerHandle}/${contentType}/${itemUid}'`);
    }

    const adapter = this.getAdapter(contentType);

    let targetOwner = ownerHandle;
    let record = this.stmtGetRecord.get({
      ':owner': targetOwner,
      ':ct': contentType,
      ':uid': itemUid,
    });

    // 智能跨账号回退：若当前指定 owner 下未找到记录，但在云端其他账号（如 default-user）下存在该配置，自动回退拉取
    if (!record) {
      const anyRecord = this.stmtFindAnyRecord.get({
        ':ct': contentType,
        ':uid': itemUid,
      });
      if (anyRecord && this.auth.can(Permission.READ, authContext.handle, anyRecord.owner_handle, contentType, itemUid)) {
        record = anyRecord;
        targetOwner = anyRecord.owner_handle;
      }
    }

    if (!record) {
      throw new NotFoundError(`Config record not found: ${ownerHandle}/${contentType}/${itemUid}`);
    }

    if (record.is_deleted && targetVersion === null) {
      throw new NotFoundError(`Config record has been deleted: ${targetOwner}/${contentType}/${itemUid}`);
    }

    const versionToFetch = targetVersion ?? record.current_version;
    const versionRow = this.stmtGetVersion.get({
      ':owner': targetOwner,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': versionToFetch,
    });

    if (!versionRow) {
      throw new NotFoundError(`Version ${versionToFetch} not found for ${targetOwner}/${contentType}/${itemUid}`);
    }

    if (versionRow.operation === OperationType.DELETE) {
      throw new NotFoundError(`Version ${versionToFetch} is a tombstone delete`);
    }

    const buffer = await this.store.readBlob(versionRow.blob_path);
    const content = adapter.deserialize(buffer, versionRow.mime_type);

    return {
      owner_handle: targetOwner,
      content_type: contentType,
      item_uid: itemUid,
      display_name: record.display_name,
      version: versionRow.version,
      checksum: versionRow.checksum,
      mime_type: versionRow.mime_type,
      content,
      reload_strategy: adapter.getReloadStrategy(),
    };
  }

  /**
   * 回滚到指定历史版本
   * 内部等价于一次特殊的 UPSERT push，将历史版本的内容通过 CAS 写入为最新版本
   */
  async rollback({ authContext, ownerHandle, contentType, itemUid, targetVersion, baseVersion, clientId }) {
    if (!this.auth.can(Permission.ROLLBACK, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no rollback permission`);
    }

    const versionRow = this.stmtGetVersion.get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': targetVersion,
    });

    if (!versionRow) {
      throw new NotFoundError(`Target history version ${targetVersion} not found`);
    }

    if (versionRow.operation === OperationType.DELETE) {
      throw new BadRequestError(`Cannot rollback to a DELETE tombstone version`);
    }

    const adapter = this.getAdapter(contentType);
    const buffer = await this.store.readBlob(versionRow.blob_path);
    const payload = adapter.deserialize(buffer, versionRow.mime_type);

    const record = this.stmtGetRecord.get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    return await this.push({
      authContext,
      ownerHandle,
      contentType,
      itemUid,
      displayName: record ? record.display_name : null,
      baseVersion,
      operation: OperationType.UPSERT,
      payload,
      clientId: clientId || 'rollback_client',
    });
  }

  /**
   * 查询历史版本列表
   */
  async getVersions(authContext, ownerHandle, contentType, itemUid) {
    if (!this.auth.can(Permission.READ, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no read permission`);
    }

    const rows = this.stmtGetVersionsDesc.all({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    return rows;
  }

  /**
   * 异步修剪超额历史版本（防替换保护：已锁定的版本永不被轮转修剪；最新的版本永不修剪）
   */
  async pruneVersions(ownerHandle, contentType, itemUid) {
    const versions = this.stmtGetVersionsDesc.all({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    const maxLimit = this.configService?.getMaxVersions
      ? this.configService.getMaxVersions(contentType)
      : (Number(this.configService?.get('maxVersions')) || this.maxVersions || 20);
    if (versions.length <= maxLimit) {
      return;
    }

    const toPrune = [];
    let currentCount = versions.length;
    // 从最旧的历史版本向新版本遍历（保留最新的 index 0 版本不剪裁）
    // 只要该版本被用户锁定（is_locked === 1），绝对不自动剪裁/替换！
    for (let i = versions.length - 1; i >= 1; i--) {
      if (currentCount <= maxLimit) break;
      const v = versions[i];
      if (!v.is_locked) {
        toPrune.push(v);
        currentCount--;
      }
    }

    for (const v of toPrune) {
      if (v.blob_path) {
        await this.store.deleteBlob(v.blob_path).catch(() => {});
      }
      this.stmtDeleteVersionRow.run({
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
        ':version': v.version,
      });
    }
  }

  /**
   * 锁定或解锁指定快照版本（锁定后滚动超出限制时永不被替换删除）
   */
  async setVersionLock(authContext, ownerHandle, contentType, itemUid, targetVersion, locked) {
    if (!this.auth.can(Permission.WRITE, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no write permission to lock version`);
    }

    const lockVal = locked ? 1 : 0;
    const result = this.stmtSetVersionLock.run({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': targetVersion,
      ':locked': lockVal,
    });

    if (result.changes === 0) {
      throw new NotFoundError(`Version ${targetVersion} of ${contentType}/${itemUid} not found`);
    }

    return {
      success: true,
      version: targetVersion,
      is_locked: Boolean(locked),
    };
  }

  /**
   * 手动删除指定历史版本快照
   */
  async deleteVersion(authContext, ownerHandle, contentType, itemUid, targetVersion) {
    if (!this.auth.can(Permission.WRITE, authContext.handle, ownerHandle, contentType, itemUid)) {
      throw new ForbiddenError(`User '${authContext.handle}' has no write permission to delete version`);
    }

    const row = this.db.prepare(`
      SELECT version, blob_path FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version
    `).get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': targetVersion,
    });

    if (!row) return false;

    if (row.blob_path) {
      await this.store.deleteBlob(row.blob_path).catch(() => {});
    }

    this.stmtDeleteVersionRow.run({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': targetVersion,
    });

    // 检查是否还有剩余快照版本
    const remaining = this.stmtGetVersionsDesc.all({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    if (remaining.length > 0) {
      const highest = remaining[0];
      this.db.prepare(`
        UPDATE config_records
        SET current_version = :ver, current_checksum = :chk, updated_at = :now
        WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
      `).run({
        ':ver': highest.version,
        ':chk': highest.checksum,
        ':now': Date.now(),
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
      });
    } else {
      // 最后一个快照也被删除了，标记为墓碑
      this.db.prepare(`
        UPDATE config_records
        SET is_deleted = 1, updated_at = :now
        WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
      `).run({
        ':now': Date.now(),
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
      });
    }

    return true;
  }

  /**
   * 检查指定四元组是否处于防替换锁定状态
   */
  isLocked(requesterHandle, ownerHandle, contentType, itemUid) {
    const row = this.stmtGetLock.get({
      ':requester': requesterHandle,
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });
    return Boolean(row && row.locked === 1);
  }

  /**
   * 设置或解除防替换锁定
   */
  setLock({ requesterHandle, ownerHandle, contentType, itemUid, locked }) {
    const val = locked ? 1 : 0;
    this.stmtSetLock.run({
      ':requester': requesterHandle,
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':locked': val,
      ':now': Date.now(),
    });
    return { locked: val === 1 };
  }

  /**
   * 批量获取指定请求者在某类别下的所有激活锁定
   */
  getLockMap(requesterHandle, contentType) {
    const rows = this.stmtGetLocksByRequester.all({
      ':requester': requesterHandle,
      ':ct': contentType,
    });
    const map = new Map();
    for (const r of rows) {
      if (r.locked === 1) {
        map.set(`${r.owner_handle}:${r.item_uid}`, true);
        if (r.owner_handle === requesterHandle) {
          map.set(r.item_uid, true);
        }
      }
    }
    return map;
  }

  /**
   * 清理与指定配置项相关的所有锁记录（联动清理）
   */
  deleteLocksForItem(ownerHandle, contentType, itemUid) {
    this.stmtDeleteLocksForItem.run({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });
  }

  /**
   * 获取存储与配置统计指标 (P5-6, N-8, TC9)
   * @param {string} requesterHandle
   * @param {boolean} [isAdmin=false]
   */
  getStats(requesterHandle, isAdmin = false) {
    // 1. 用户自身视角统计
    const userSummaryStmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_versions,
        COALESCE(SUM(size_bytes), 0) as total_logical_bytes,
        COUNT(DISTINCT item_uid) as total_items,
        COUNT(DISTINCT content_type) as total_content_types
      FROM config_versions
      WHERE owner_handle = :requester
    `);
    const userSummary = userSummaryStmt.get({ ':requester': requesterHandle }) || {};

    const userRecordsStmt = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN is_deleted = 0 THEN 1 END) as active_items,
        COUNT(CASE WHEN is_deleted = 1 THEN 1 END) as deleted_items
      FROM config_records
      WHERE owner_handle = :requester
    `);
    const userRecords = userRecordsStmt.get({ ':requester': requesterHandle }) || {};

    const userDedupStmt = this.db.prepare(`
      SELECT
        COUNT(DISTINCT blob_path) as unique_blobs,
        COALESCE(SUM(size_bytes), 0) as unique_bytes
      FROM (
        SELECT blob_path, size_bytes
        FROM config_versions
        WHERE owner_handle = :requester AND blob_path IS NOT NULL
        GROUP BY blob_path
      )
    `);
    const userDedup = userDedupStmt.get({ ':requester': requesterHandle }) || {};

    const userByTypeStmt = this.db.prepare(`
      SELECT
        content_type,
        COUNT(*) as version_count,
        COALESCE(SUM(size_bytes), 0) as total_bytes,
        COUNT(DISTINCT item_uid) as item_count
      FROM config_versions
      WHERE owner_handle = :requester
      GROUP BY content_type
      ORDER BY total_bytes DESC
    `);
    const userByType = userByTypeStmt.all({ ':requester': requesterHandle });

    const userStats = {
      handle: requesterHandle,
      total_versions: Number(userSummary.total_versions || 0),
      total_logical_bytes: Number(userSummary.total_logical_bytes || 0),
      unique_blobs: Number(userDedup.unique_blobs || 0),
      unique_bytes: Number(userDedup.unique_bytes || 0),
      active_items: Number(userRecords.active_items || 0),
      deleted_items: Number(userRecords.deleted_items || 0),
      by_type: userByType,
    };

    // 2. 管理员全站视角（去重后的真实磁盘占用） (N-8)
    let globalStats = null;
    if (isAdmin) {
      const globalSummaryStmt = this.db.prepare(`
        SELECT
          COUNT(*) as total_versions,
          COALESCE(SUM(size_bytes), 0) as total_logical_bytes,
          COUNT(DISTINCT owner_handle) as total_users,
          COUNT(DISTINCT item_uid) as total_items,
          COUNT(CASE WHEN is_locked = 1 THEN 1 END) as locked_versions
        FROM config_versions
      `);
      const globalSummary = globalSummaryStmt.get() || {};

      const globalDedupStmt = this.db.prepare(`
        SELECT
          COUNT(DISTINCT blob_path) as deduplicated_blobs,
          COALESCE(SUM(size_bytes), 0) as deduplicated_disk_bytes
        FROM (
          SELECT blob_path, size_bytes
          FROM config_versions
          WHERE blob_path IS NOT NULL
          GROUP BY blob_path
        )
      `);
      const globalDedup = globalDedupStmt.get() || {};

      const globalByTypeStmt = this.db.prepare(`
        SELECT
          content_type,
          COUNT(*) as version_count,
          COUNT(DISTINCT blob_path) as deduplicated_blob_count,
          COALESCE(SUM(size_bytes), 0) as logical_bytes
        FROM config_versions
        GROUP BY content_type
        ORDER BY logical_bytes DESC
      `);
      const globalByType = globalByTypeStmt.all();

      globalStats = {
        total_users: Number(globalSummary.total_users || 0),
        total_items: Number(globalSummary.total_items || 0),
        total_versions: Number(globalSummary.total_versions || 0),
        total_logical_bytes: Number(globalSummary.total_logical_bytes || 0),
        deduplicated_blobs: Number(globalDedup.deduplicated_blobs || 0),
        deduplicated_disk_bytes: Number(globalDedup.deduplicated_disk_bytes || 0),
        locked_versions: Number(globalSummary.locked_versions || 0),
        by_type: globalByType,
      };
    }

    return {
      user: userStats,
      global: globalStats,
      is_admin: isAdmin,
    };
  }

  /**
   * 孤儿快照两阶段清理与分析 (P5-6, N-8, TC10)
   * @param {object} options
   * @param {string} [options.ownerHandle]
   * @param {boolean} [options.dryRun=true]
   * @param {boolean} [options.isAdmin=false]
   */
  async cleanOrphanSnapshots({ ownerHandle = null, dryRun = true, isAdmin = false } = {}) {
    // 查找候选待清理版本：必须是已软删除记录（墓碑）下的版本，且 is_locked = 0
    let query = `
      SELECT v.owner_handle, v.content_type, v.item_uid, v.version, v.version_title, v.size_bytes, v.blob_path, v.is_locked
      FROM config_versions v
      JOIN config_records r ON v.owner_handle = r.owner_handle AND v.content_type = r.content_type AND v.item_uid = r.item_uid
      WHERE r.is_deleted = 1 AND v.is_locked = 0
    `;
    const params = {};
    if (!isAdmin && ownerHandle) {
      query += ` AND v.owner_handle = :owner`;
      params[':owner'] = ownerHandle;
    } else if (ownerHandle) {
      query += ` AND v.owner_handle = :owner`;
      params[':owner'] = ownerHandle;
    }
    query += ` ORDER BY v.created_at ASC`;

    const candidates = this.db.prepare(query).all(params);

    // 计算去重后可回收的字节数 (N-8)
    const uniqueBlobMap = new Map();
    for (const cand of candidates) {
      if (cand.blob_path && !uniqueBlobMap.has(cand.blob_path)) {
        uniqueBlobMap.set(cand.blob_path, Number(cand.size_bytes) || 0);
      }
    }
    const reclaimableBytes = Array.from(uniqueBlobMap.values()).reduce((a, b) => a + b, 0);

    if (dryRun) {
      return {
        dry_run: true,
        candidate_count: candidates.length,
        unique_blobs_count: uniqueBlobMap.size,
        reclaimable_bytes: reclaimableBytes,
        candidates: candidates.map(c => ({
          owner_handle: c.owner_handle,
          content_type: c.content_type,
          item_uid: c.item_uid,
          version: c.version,
          version_title: c.version_title,
          size_bytes: c.size_bytes,
        })),
      };
    }

    // 执行阶段 (dry_run: false)
    let deletedCount = 0;
    let actualFreedBytes = 0;

    const stmtDeleteVersion = this.db.prepare(`
      DELETE FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version AND is_locked = 0
    `);

    const stmtCountOtherRefs = this.db.prepare(`
      SELECT COUNT(*) as count FROM config_versions WHERE blob_path = :blobPath AND NOT (owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version)
    `);

    for (const cand of candidates) {
      if (cand.is_locked === 1) continue;

      if (cand.blob_path) {
        const refRow = stmtCountOtherRefs.get({
          ':blobPath': cand.blob_path,
          ':owner': cand.owner_handle,
          ':ct': cand.content_type,
          ':uid': cand.item_uid,
          ':version': cand.version,
        });
        if (!refRow || refRow.count === 0) {
          try {
            await this.store.deleteBlob(cand.blob_path);
            actualFreedBytes += Number(cand.size_bytes) || 0;
          } catch (e) {
            console.warn('[cfgsync] Failed to delete orphan blob file:', cand.blob_path, e.message);
          }
        }
      }

      const res = stmtDeleteVersion.run({
        ':owner': cand.owner_handle,
        ':ct': cand.content_type,
        ':uid': cand.item_uid,
        ':version': cand.version,
      });
      if (res.changes > 0) {
        deletedCount++;
      }
    }

    return {
      dry_run: false,
      deleted_count: deletedCount,
      freed_bytes: actualFreedBytes,
    };
  }
}
