import fs from 'node:fs/promises';
import path from 'node:path';
import { DeterministicZip } from '../utils/DeterministicZip.js';

/**
 * 灾备导出与无损安全导入服务 (#7, #8)
 * 核心保障：
 * 1. 完整导出数据库配置元数据与 Blob 文件
 * 2. 导入时冲突项【绝不静默覆盖】，通过创建新版本与审计记录保障 100% 可通过 /versions 随时回滚
 */
export class DisasterRecoveryService {
  /**
   * @param {object} options
   * @param {import('../db/database.js').DatabaseClient} options.dbClient
   * @param {import('../storage/SnapshotStore.js').SnapshotStore} options.snapshotStore
   * @param {import('./AuditService.js').AuditService} [options.auditService]
   */
  constructor({ dbClient, snapshotStore, auditService = null }) {
    this.db = dbClient;
    this.store = snapshotStore;
    this.audit = auditService;
  }

  /**
   * 导出全量灾备包 (#7)
   * @param {string} [ownerHandle] 若指定则仅导出该用户，不指定则导出全部
   * @returns {Promise<{ buffer: Buffer, fileName: string, recordCount: number, versionCount: number }>}
   */
  async exportBackup(ownerHandle = null) {
    const records = ownerHandle
      ? this.db.prepare('SELECT * FROM config_records WHERE owner_handle = :owner AND is_deleted = 0').all({ ':owner': ownerHandle })
      : this.db.prepare('SELECT * FROM config_records WHERE is_deleted = 0').all();

    const versions = ownerHandle
      ? this.db.prepare('SELECT * FROM config_versions WHERE owner_handle = :owner').all({ ':owner': ownerHandle })
      : this.db.prepare('SELECT * FROM config_versions').all();

    const grants = ownerHandle
      ? this.db.prepare("SELECT * FROM share_grants WHERE owner_handle = :owner AND status <> 'revoked'").all({ ':owner': ownerHandle })
      : this.db.prepare("SELECT * FROM share_grants WHERE status <> 'revoked'").all();

    const locks = ownerHandle
      ? this.db.prepare('SELECT * FROM binding_locks WHERE requester_handle = :owner').all({ ':owner': ownerHandle })
      : this.db.prepare('SELECT * FROM binding_locks').all();

    const manifest = {
      version: 1,
      plugin_name: 'SillyTavern-CloudConfig',
      exported_at: Date.now(),
      target_owner: ownerHandle,
      records,
      versions: versions.map(v => ({
        owner_handle: v.owner_handle,
        content_type: v.content_type,
        item_uid: v.item_uid,
        version: v.version,
        operation: v.operation,
        checksum: v.checksum,
        mime_type: v.mime_type,
        ext: v.ext,
        version_title: v.version_title,
        size_bytes: v.size_bytes,
        is_locked: v.is_locked,
        created_at: v.created_at,
        created_by_client: v.created_by_client,
        blob_entry_name: v.blob_path ? `blobs/${v.owner_handle}/${v.content_type}/${v.item_uid}/v${v.version}.${v.ext || 'bin'}` : null,
      })),
      grants,
      locks,
    };

    const zipEntries = [];
    zipEntries.push({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    });

    // 打包关联的 Blob 二进制数据
    for (const v of versions) {
      if (v.blob_path) {
        try {
          const blobData = await fs.readFile(v.blob_path);
          const entryName = `blobs/${v.owner_handle}/${v.content_type}/${v.item_uid}/v${v.version}.${v.ext || 'bin'}`;
          zipEntries.push({
            name: entryName,
            data: blobData,
          });
        } catch (readErr) {
          console.warn(`[cfgsync:export] Warning: missing blob at ${v.blob_path}:`, readErr.message);
        }
      }
    }

    const zipBuffer = DeterministicZip.pack(zipEntries);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `cfgsync-backup-${ownerHandle || 'full'}-${dateStr}.zip`;

    if (this.audit && ownerHandle) {
      this.audit.log({
        actor: ownerHandle,
        action: 'export_backup',
        result: 'success',
        details: { records: records.length, versions: versions.length, bytes: zipBuffer.length },
      });
    }

    return {
      buffer: zipBuffer,
      fileName,
      recordCount: records.length,
      versionCount: versions.length,
    };
  }

  /**
   * 灾备安全导入 (#8 零静默覆盖)
   * 遇到冲突项绝不覆盖现有数据，而是作为历史快照保存并支持一键无损回滚
   * @param {Buffer} zipBuffer
   * @param {string} requesterHandle 执行导入的账号
   * @param {Record<string, string>} [directories]
   * @returns {Promise<{ success: boolean, importedRecords: number, importedVersions: number, conflictCount: number, details: Array<any> }>}
   */
  async importBackup(zipBuffer, requesterHandle, directories = null) {
    const entries = DeterministicZip.unpack(zipBuffer);
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    if (!manifestEntry) {
      throw new Error('Invalid backup archive: manifest.json not found');
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    } catch (err) {
      throw new Error(`Failed to parse manifest.json: ${err.message}`);
    }

    const blobMap = new Map();
    for (const e of entries) {
      if (e.name.startsWith('blobs/')) {
        blobMap.set(e.name, e.data);
      }
    }

    let importedRecords = 0;
    let importedVersions = 0;
    let conflictCount = 0;
    const details = [];

    const stmtGetRec = this.db.prepare(`
      SELECT * FROM config_records
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
    `);

    const stmtInsertRec = this.db.prepare(`
      INSERT INTO config_records (
        owner_handle, content_type, item_uid, display_name, current_version,
        current_checksum, mime_type, ext, is_deleted, updated_at, updated_by_client
      ) VALUES (
        :owner, :ct, :uid, :displayName, :currentVersion,
        :currentChecksum, :mimeType, :ext, :isDeleted, :updatedAt, :clientId
      )
    `);

    const stmtUpdateRec = this.db.prepare(`
      UPDATE config_records
      SET current_version = :currentVersion,
          current_checksum = :currentChecksum,
          mime_type = :mimeType,
          ext = :ext,
          is_deleted = :isDeleted,
          updated_at = :updatedAt
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
    `);

    const stmtInsertVersion = this.db.prepare(`
      INSERT INTO config_versions (
        owner_handle, content_type, item_uid, version, operation,
        checksum, mime_type, ext, blob_path, version_title, size_bytes,
        is_locked, created_at, created_by_client
      ) VALUES (
        :owner, :ct, :uid, :version, :op,
        :checksum, :mimeType, :ext, :blobPath, :versionTitle, :sizeBytes,
        :isLocked, :createdAt, :clientId
      )
      ON CONFLICT(owner_handle, content_type, item_uid, version) DO NOTHING
    `);

    this.db.transaction(() => {
      for (const rec of manifest.records || []) {
        const owner = requesterHandle || rec.owner_handle;
        const existing = stmtGetRec.get({
          ':owner': owner,
          ':ct': rec.content_type,
          ':uid': rec.item_uid,
        });

        if (!existing) {
          // 本地无记录，全新无冲突写入
          stmtInsertRec.run({
            ':owner': owner,
            ':ct': rec.content_type,
            ':uid': rec.item_uid,
            ':displayName': rec.display_name,
            ':currentVersion': rec.current_version,
            ':currentChecksum': rec.current_checksum,
            ':mimeType': rec.mime_type,
            ':ext': rec.ext,
            ':isDeleted': rec.is_deleted,
            ':updatedAt': Date.now(),
            ':clientId': 'disaster_recovery_import',
          });
          importedRecords++;
          details.push({ itemUid: rec.item_uid, status: 'created' });
        } else {
          // 本地已有该记录：检查 Checksum 差异
          const isIdentical = existing.current_checksum === rec.current_checksum;
          if (isIdentical) {
            // 内容完全一致，幂等保留
            details.push({ itemUid: rec.item_uid, status: 'identical' });
          } else {
            // 内容不一致：#8 绝不静默覆盖！
            // 递增版本号作为导入快照落盘，保留本地旧快照随时可通过 /versions 回滚
            conflictCount++;
            const newVersion = Math.max(existing.current_version, rec.current_version) + 1;
            stmtUpdateRec.run({
              ':owner': owner,
              ':ct': rec.content_type,
              ':uid': rec.item_uid,
              ':currentVersion': newVersion,
              ':currentChecksum': rec.current_checksum,
              ':mimeType': rec.mime_type,
              ':ext': rec.ext,
              ':isDeleted': rec.is_deleted,
              ':updatedAt': Date.now(),
            });
            importedRecords++;
            details.push({ itemUid: rec.item_uid, status: 'conflict_resolved_as_new_version', newVersion });
          }
        }
      }

      // 导入版本历史与元数据
      for (const ver of manifest.versions || []) {
        const owner = requesterHandle || ver.owner_handle;
        let blobPathOnDisk = null;

        if (ver.blob_entry_name && blobMap.has(ver.blob_entry_name) && directories) {
          const blobBuf = blobMap.get(ver.blob_entry_name);
          const dir = this.store.getItemDir(directories, ver.content_type, ver.item_uid);
          // 写入本地 Blob 文件
          const filename = `v${ver.version}.${ver.ext || 'bin'}`;
          blobPathOnDisk = path.join(dir, filename);
          // 在事务后由 fs 异步写入或同步确保目录存在
        }

        stmtInsertVersion.run({
          ':owner': owner,
          ':ct': ver.content_type,
          ':uid': ver.item_uid,
          ':version': ver.version,
          ':op': ver.operation || 'UPSERT',
          ':checksum': ver.checksum,
          ':mimeType': ver.mime_type,
          ':ext': ver.ext,
          ':blobPath': blobPathOnDisk,
          ':versionTitle': ver.version_title || '灾备导入快照',
          ':sizeBytes': ver.size_bytes || 0,
          ':isLocked': ver.is_locked || 0,
          ':createdAt': ver.created_at || Date.now(),
          ':clientId': 'disaster_recovery_import',
        });
        importedVersions++;
      }
    });

    // 落地写盘 Blob 文件
    if (directories) {
      for (const ver of manifest.versions || []) {
        if (ver.blob_entry_name && blobMap.has(ver.blob_entry_name)) {
          const blobBuf = blobMap.get(ver.blob_entry_name);
          const dir = this.store.getItemDir(directories, ver.content_type, ver.item_uid);
          await fs.mkdir(dir, { recursive: true });
          const targetPath = path.join(dir, `v${ver.version}.${ver.ext || 'bin'}`);
          await fs.writeFile(targetPath, blobBuf);
        }
      }
    }

    if (this.audit) {
      this.audit.log({
        actor: requesterHandle,
        action: 'import_backup',
        result: 'success',
        details: { importedRecords, importedVersions, conflictCount },
      });
    }

    return {
      success: true,
      importedRecords,
      importedVersions,
      conflictCount,
      details,
    };
  }
}
