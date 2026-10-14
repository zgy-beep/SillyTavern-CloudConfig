import fs from 'node:fs/promises';
import path from 'node:path';
import { DeterministicZip } from '../utils/DeterministicZip.js';
import { SnapshotCommitter } from '../storage/SnapshotCommitter.js';
import { validateSegment } from '../utils/SafePaths.js';
import { sha256 } from '../../common/utils.js';
import { createP0Adapters } from '../adapters/P0Adapters.js';
import { createP1Adapters } from '../adapters/P1Adapters.js';
import { createP2Adapters } from '../adapters/P2Adapters.js';

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
  constructor({ dbClient, snapshotStore, auditService = null, adapters = null }) {
    this.db = dbClient;
    this.store = snapshotStore;
    this.audit = auditService;
    this.committer = new SnapshotCommitter(snapshotStore);
    this.adapters = adapters || new Map([...createP0Adapters(), ...createP1Adapters(), ...createP2Adapters()]);
  }

  /**
   * 导出全量灾备包 (#7)
   * @param {string} [ownerHandle] 若指定则仅导出该用户，不指定则导出全部
   * @returns {Promise<{ buffer: Buffer, fileName: string, recordCount: number, versionCount: number }>}
   */
  async exportBackup(ownerHandle = null) {
    const records = ownerHandle
      ? this.db.prepare('SELECT * FROM config_records WHERE owner_handle = :owner').all({ ':owner': ownerHandle })
      : this.db.prepare('SELECT * FROM config_records').all();

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
          throw new Error(`Backup incomplete: cannot read ${v.content_type}/${v.item_uid} version ${v.version}: ${readErr.message}`);
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
    const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
    if (!requesterHandle) fail('An authenticated account is required');
    const entries = DeterministicZip.unpack(zipBuffer);
    if (new Set(entries.map(e => e.name)).size !== entries.length) fail('Duplicate ZIP entries');
    const entryMap = new Map(entries.map(e => [e.name, e.data]));
    let manifest;
    try { manifest = JSON.parse(entryMap.get('manifest.json')?.toString('utf8')); }
    catch { fail('Invalid backup manifest'); }
    if (manifest?.version !== 1 || !Array.isArray(manifest.records) || !Array.isArray(manifest.versions)) fail('Unsupported backup format');
    if (manifest.records.length > 10000 || manifest.versions.length > 50000) fail('Backup contains too many records');

    const recordKey = r => JSON.stringify([r.owner_handle, r.content_type, r.item_uid]);
    const destinationKey = r => JSON.stringify([r.content_type, r.item_uid]);
    const seen = new Set();
    const versionsByRecord = new Map();
    for (const v of manifest.versions) {
      validateSegment(v.content_type, 'content_type'); validateSegment(v.item_uid, 'item_uid');
      validateSegment(v.ext || 'bin', 'extension');
      if (!Number.isSafeInteger(v.version) || v.version < 1 || !['UPSERT', 'DELETE'].includes(v.operation)) fail('Invalid archive version');
      const key = recordKey(v);
      const list = versionsByRecord.get(key) || [];
      if (list.some(row => row.version === v.version)) fail('Duplicate archive version');
      list.push(v); versionsByRecord.set(key, list);
    }
    const plans = [];
    const staged = [];
    let importedVersions = 0;
    let importedRecords = 0;
    let conflictCount = 0;
    const details = [];
    try {
      // Validate every object and stage every file before changing any metadata.
      for (const rec of manifest.records) {
        validateSegment(rec.content_type, 'content_type'); validateSegment(rec.item_uid, 'item_uid');
        const adapter = this.adapters.get(rec.content_type);
        if (!adapter) fail('Unsupported archive content type: ' + rec.content_type);
        if (seen.has(destinationKey(rec))) fail('Archive maps multiple source accounts to the same object; export one account at a time');
        seen.add(destinationKey(rec));
        const incoming = (versionsByRecord.get(recordKey(rec)) || []).sort((a,b) => a.version - b.version);
        const head = incoming.find(v => v.version === rec.current_version);
        if (!head) fail('Archive current version is missing');
        if (Boolean(rec.is_deleted) !== (head.operation === 'DELETE')) fail('Archive deletion metadata is inconsistent');
        for (const v of incoming) {
          if (v.operation === 'DELETE') continue;
          const bytes = entryMap.get(v.blob_entry_name);
          if (!bytes) fail('Archive snapshot file is missing');
          let content;
          try { content = adapter.deserialize(bytes, v.mime_type); } catch { fail('Invalid archive snapshot content'); }
          if (!adapter.validate(content) || sha256(adapter.canonicalize(content)) !== v.checksum) fail('Archive snapshot checksum mismatch');
        }
        if (rec.current_checksum !== head.checksum) fail('Archive current checksum is inconsistent');
        const existing = this.db.prepare('SELECT * FROM config_records WHERE owner_handle=? AND content_type=? AND item_uid=?').get(requesterHandle, rec.content_type, rec.item_uid);
        const history = this.db.prepare('SELECT * FROM config_versions WHERE owner_handle=? AND content_type=? AND item_uid=? ORDER BY version').all(requesterHandle, rec.content_type, rec.item_uid);
        const sequence = this.db.prepare('SELECT last_version FROM version_sequences WHERE owner_handle=? AND content_type=? AND item_uid=?').get(requesterHandle, rec.content_type, rec.item_uid);
        let next = Math.max(existing?.current_version || 0, sequence?.last_version || 0, ...history.map(v => v.version), 0);
        const mapped = new Map();
        const additions = [];
        const sourceKey = v => JSON.stringify([v.owner_handle, v.version, v.operation, v.checksum]);
        for (const v of incoming) {
          const receipt = this.db.prepare('SELECT mapped_version FROM import_mappings WHERE owner_handle=? AND content_type=? AND item_uid=? AND source_key=?').get(requesterHandle,rec.content_type,rec.item_uid,sourceKey(v));
          const same = history.find(h => h.version === (receipt?.mapped_version || v.version) && h.operation === v.operation && h.checksum === v.checksum);
          if (same) { mapped.set(v.version, same); continue; }
          const number = existing ? ++next : v.version;
          let blobPath = null;
          if (v.operation === 'UPSERT') {
            if (!directories) fail('Account directories are required to import new snapshots');
            blobPath = await this.committer.stage(directories, rec.content_type, rec.item_uid, number, v.ext || 'bin', entryMap.get(v.blob_entry_name));
            staged.push(blobPath);
          }
          const added = { ...v, version: number, blob_path: blobPath, size_bytes: v.operation === 'DELETE' ? 0 : entryMap.get(v.blob_entry_name).length };
          mapped.set(v.version, added); additions.push(added);
        }
        let target = mapped.get(rec.current_version);
        const identical = existing && existing.current_checksum === rec.current_checksum && Boolean(existing.is_deleted) === Boolean(rec.is_deleted);
        if (!additions.length && identical) { details.push({ itemUid: rec.item_uid, status: 'identical' }); continue; }
        // The published head must be newer than every imported historical version.
        if (existing && target.version < Math.max(next, ...additions.map(v => v.version))) {
          target = { ...target, version: ++next };
          additions.push(target);
          mapped.set(rec.current_version, target);
        }
        const conflict = existing && !identical;
        if (conflict) conflictCount++;
        plans.push({ rec, existing, additions, target, mappings: incoming.map(v => ({ sourceKey: sourceKey(v), version: mapped.get(v.version).version })) });
        details.push({ itemUid: rec.item_uid, status: existing ? (conflict ? 'conflict_resolved_as_new_version' : 'history_imported') : 'created', newVersion: target.version });
      }
      this.db.transaction(() => {
        for (const plan of plans) {
          const { rec, existing, additions, target } = plan;
          const live = this.db.prepare('SELECT current_version,current_checksum,is_deleted FROM config_records WHERE owner_handle=? AND content_type=? AND item_uid=?').get(requesterHandle, rec.content_type, rec.item_uid);
          if (Boolean(live) !== Boolean(existing) || (live && (live.current_version !== existing.current_version || live.current_checksum !== existing.current_checksum || live.is_deleted !== existing.is_deleted))) fail('Configuration changed during import; retry with the latest state', 409);
          for (const v of additions) {
            this.db.prepare('INSERT INTO config_versions (owner_handle,content_type,item_uid,version,operation,checksum,mime_type,ext,blob_path,version_title,size_bytes,is_locked,created_at,created_by_client) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
              requesterHandle, rec.content_type, rec.item_uid, v.version, v.operation, v.checksum || null,
              v.mime_type || null, v.ext || null, v.blob_path || null, String(v.version_title || '灾备导入快照').slice(0,64),
              v.size_bytes || 0, v.is_locked ? 1 : 0, Date.now(), 'disaster_recovery_import');
            importedVersions++;
          }
          const lastVersion = Math.max(target.version, ...additions.map(v => v.version));
          this.db.prepare('INSERT INTO version_sequences (owner_handle,content_type,item_uid,last_version) VALUES (?,?,?,?) ON CONFLICT(owner_handle,content_type,item_uid) DO UPDATE SET last_version=MAX(last_version,excluded.last_version)').run(requesterHandle,rec.content_type,rec.item_uid,lastVersion);
          for (const mapping of plan.mappings) this.db.prepare('INSERT INTO import_mappings (owner_handle,content_type,item_uid,source_key,mapped_version) VALUES (?,?,?,?,?) ON CONFLICT(owner_handle,content_type,item_uid,source_key) DO UPDATE SET mapped_version=excluded.mapped_version').run(requesterHandle,rec.content_type,rec.item_uid,mapping.sourceKey,mapping.version);
          this.db.prepare('INSERT INTO config_records (owner_handle,content_type,item_uid,display_name,current_version,current_checksum,mime_type,ext,is_deleted,updated_at,updated_by_client) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_handle,content_type,item_uid) DO UPDATE SET display_name=excluded.display_name,current_version=excluded.current_version,current_checksum=excluded.current_checksum,mime_type=excluded.mime_type,ext=excluded.ext,is_deleted=excluded.is_deleted,updated_at=excluded.updated_at,updated_by_client=excluded.updated_by_client').run(
            requesterHandle,rec.content_type,rec.item_uid,String(rec.display_name || rec.item_uid),target.version,target.checksum || null,
            target.mime_type || null,target.ext || null,target.operation === 'DELETE' ? 1 : 0,Date.now(),'disaster_recovery_import');
          this.db.prepare('INSERT INTO change_events (owner_handle,content_type,item_uid,version,operation,created_at) VALUES (?,?,?,?,?,?)').run(requesterHandle,rec.content_type,rec.item_uid,target.version,target.operation,Date.now());
          importedRecords++;
        }
      });
    } catch (error) {
      await this.committer.discard(staged);
      throw error;
    }
    this.audit?.log({ actor: requesterHandle, action: 'import_backup', result: 'success', details: { importedRecords, importedVersions, conflictCount } });
    return { success: true, importedRecords, importedVersions, conflictCount, details };
  }
}
