/**
 * 变更事件服务 (ChangeEventBus)
 * 负责轮询事件的查询、可见性过滤与最新版本去重
 */
export class ChangeEventBus {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   * @param {import('../config/ConfigService.js').ConfigService} [configService]
   */
  constructor(dbClient, configService = null) {
    this.db = dbClient;
    this.configService = configService;
    this.prepareStatements();
  }

  prepareStatements() {
    // 查询指定 since 之后的全部原始事件
    this.stmtGetEventsSince = this.db.prepare(`
      SELECT e.seq, e.owner_handle, e.content_type, e.item_uid, e.version, e.operation, e.created_at
      FROM change_events e
      WHERE e.seq > :since
        AND (
          e.owner_handle = :requester
          OR (
            (e.content_type <> 'settings' OR :allowSettingsSharing = 1)
            AND EXISTS (
              SELECT 1 FROM share_grants g
              WHERE g.owner_handle = e.owner_handle
                AND (g.grantee_handle = :requester OR (g.is_public = 1 AND g.grantee_handle IS NULL))
                AND g.content_type = e.content_type
                AND (g.content_type <> 'settings' OR :allowSettingsSharing = 1)
                AND g.status = 'active'
                AND (g.expires_at IS NULL OR g.expires_at > :now)
                AND (g.scope_type = 'CONTENT_TYPE' OR (g.scope_type = 'ITEM' AND g.item_uid = e.item_uid))
            )
          )
        )
      ORDER BY e.seq ASC
    `);

    this.stmtGetMaxSeq = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) as max_seq FROM change_events
    `);
  }

  /**
   * 记录一次新变更事件
   * （通常在 SyncService 事务内直接插入，此方法供通用调用）
   */
  recordEvent(ownerHandle, contentType, itemUid, version, operation) {
    const stmt = this.db.prepare(`
      INSERT INTO change_events (owner_handle, content_type, item_uid, version, operation, created_at)
      VALUES (:owner, :ct, :uid, :version, :op, :now)
    `);
    const now = Date.now();
    const info = stmt.run({
      ':owner': ownerHandle,
      ':ct': contentType,
      ':uid': itemUid,
      ':version': version,
      ':op': operation,
      ':now': now,
    });
    return info.lastInsertRowid;
  }

  /**
   * 获取可见变更事件列表（按对象去重保留最高版本）
   * @param {string} requesterHandle 请求者账号 handle
   * @param {number} [sinceSeq=0] 客户端最后已确认的序列号
   * @param {number} [limit=100] 最大返回数量
   * @returns {{ events: Array<any>, latest_seq: number }}
   */
  getChanges(requesterHandle, sinceSeq = 0, limit = 100) {
    const now = Date.now();
    const allowSettingsSharing = Boolean(this.configService?.get('allowSettingsSharing')) ? 1 : 0;
    const rawEvents = this.stmtGetEventsSince.all({
      ':since': Number(sinceSeq) || 0,
      ':requester': requesterHandle,
      ':allowSettingsSharing': allowSettingsSharing,
      ':now': now,
    });

    if (rawEvents.length === 0) {
      const maxRow = this.stmtGetMaxSeq.get();
      return {
        events: [],
        latest_seq: Number(sinceSeq) || 0,
        server_max_seq: maxRow ? Number(maxRow.max_seq) : 0,
      };
    }

    // 最新 seq 游标
    let maxSeenSeq = Number(sinceSeq) || 0;

    // 对同一 owner + content_type + item_uid 去重，只保留版本号最大的一条
    const dedupMap = new Map();

    for (const evt of rawEvents) {
      if (evt.seq > maxSeenSeq) {
        maxSeenSeq = evt.seq;
      }

      const key = `${evt.owner_handle}:${evt.content_type}:${evt.item_uid}`;
      const existing = dedupMap.get(key);
      if (!existing || evt.version > existing.version) {
        dedupMap.set(key, evt);
      }
    }

    const dedupedEvents = Array.from(dedupMap.values());
    // 按 seq 升序返回，并限制 limit
    dedupedEvents.sort((a, b) => a.seq - b.seq);
    const sliced = dedupedEvents.slice(0, limit);

    return {
      events: sliced,
      latest_seq: maxSeenSeq,
    };
  }
}
