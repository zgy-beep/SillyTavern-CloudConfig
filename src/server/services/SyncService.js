import { OperationType, Permission, DEFAULT_MAX_VERSIONS } from '../../common/constants.js';
import { calcJsonChecksum } from '../../common/utils.js';

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
  constructor(dbClient, adapters, snapshotStore, authService, maxVersions = DEFAULT_MAX_VERSIONS) {
    this.db = dbClient;
    this.adapters = adapters;
    this.store = snapshotStore;
    this.auth = authService;
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

    this.stmtInsertVersion = this.db.prepare(`
      INSERT INTO config_versions (
        owner_handle, content_type, item_uid, version, operation,
        checksum, mime_type, ext, blob_path, created_at, created_by_client
      )
      VALUES (
        :owner, :ct, :uid, :version, :op,
        :checksum, :mimeType, :ext, :blobPath, :now, :clientId
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
      SELECT version, blob_path, operation, checksum, created_at, created_by_client
      FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
      ORDER BY version DESC
    `);

    this.stmtDeleteVersionRow = this.db.prepare(`
      DELETE FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid AND version = :version
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
    baseVersion,
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

    let serialized = null;
    let actualChecksum = checksum;

    // 2. 数据校验与序列化
    if (operation === OperationType.UPSERT) {
      if (!adapter.validate(payload)) {
        throw new BadRequestError(`Invalid payload for content_type: ${contentType}`);
      }
      serialized = adapter.serialize(payload);
      // 服务端根据规范化输出独立重新计算校验和
      actualChecksum = calcJsonChecksum(payload);
    }

    // 3. base_version = 0 时尝试初始化占位行（ON CONFLICT DO NOTHING）
    if (baseVersion === 0) {
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
    }

    // 4. 计算预期版本号
    const nextVersion = baseVersion + 1;
    let tempBlobInfo = null;

    // 5. 写入临时 Blob 并落盘（DELETE 操作跳过）
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

    // 6. 执行原子 CAS 事务
    let txSuccess = false;
    let committedVersion = 0;
    try {
      this.db.transaction(() => {
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
          const currentRecord = this.stmtGetRecord.get({
            ':owner': ownerHandle,
            ':ct': contentType,
            ':uid': itemUid,
          });
          const serverVer = currentRecord ? currentRecord.current_version : 0;
          const currentChk = currentRecord ? currentRecord.current_checksum : null;
          const isDel = currentRecord ? Boolean(currentRecord.is_deleted) : false;
          throw new ConflictError(
            `Version conflict: expected base_version ${baseVersion}, but server is at version ${serverVer}`,
            serverVer,
            currentChk,
            isDel
          );
        }

        committedVersion = nextVersion;

        // 记录历史版本（指向正式的 targetPath）
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
          ':now': now,
          ':clientId': clientId,
        });

        // 插入全局变更事件
        this.stmtInsertEvent.run({
          ':owner': ownerHandle,
          ':ct': contentType,
          ':uid': itemUid,
          ':version': committedVersion,
          ':op': operation,
          ':now': now,
        });
      });

      // 事务提交后，原子重命名临时 blob 为正式 blob
      if (tempBlobInfo) {
        await this.store.commitBlob(tempBlobInfo.tmpPath, tempBlobInfo.targetPath);
      }

      txSuccess = true;
    } finally {
      // 若事务失败或 CAS 冲突，仅清理未提交的临时 blob，绝不破坏已存在的正式版本文件
      if (!txSuccess && tempBlobInfo) {
        await this.store.deleteBlob(tempBlobInfo.tmpPath);
      }
    }

    // 7. 异步触发历史版本修剪
    this.pruneVersions(ownerHandle, contentType, itemUid).catch(() => {});

    return {
      version: committedVersion,
      checksum: actualChecksum,
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

    const record = this.stmtGetRecord.get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    if (!record) {
      throw new NotFoundError(`Config record not found: ${ownerHandle}/${contentType}/${itemUid}`);
    }

    if (record.is_deleted && targetVersion === null) {
      throw new NotFoundError(`Config record has been deleted: ${ownerHandle}/${contentType}/${itemUid}`);
    }

    const versionToFetch = targetVersion ?? record.current_version;
    const versionRow = this.stmtGetVersion.get({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': versionToFetch,
    });

    if (!versionRow) {
      throw new NotFoundError(`Version ${versionToFetch} not found for ${ownerHandle}/${contentType}/${itemUid}`);
    }

    if (versionRow.operation === OperationType.DELETE) {
      throw new NotFoundError(`Version ${versionToFetch} is a tombstone delete`);
    }

    const buffer = await this.store.readBlob(versionRow.blob_path);
    const content = adapter.deserialize(buffer, versionRow.mime_type);

    return {
      owner_handle: ownerHandle,
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
   * 异步修剪超额历史版本
   */
  async pruneVersions(ownerHandle, contentType, itemUid) {
    const versions = this.stmtGetVersionsDesc.all({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
    });

    if (versions.length <= this.maxVersions) {
      return;
    }

    const toPrune = versions.slice(this.maxVersions);
    for (const v of toPrune) {
      if (v.blob_path) {
        await this.store.deleteBlob(v.blob_path);
      }
      this.stmtDeleteVersionRow.run({
        ':owner': ownerHandle,
        ':ct': contentType,
        ':uid': itemUid,
        ':version': v.version,
      });
    }
  }
}
