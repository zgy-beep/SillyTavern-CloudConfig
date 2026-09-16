/**
 * 审计日志服务 (AuditService)
 * 记录关键操作与被拦截行为，支持 30 天 / 50k 条上限自动修剪，以及自作用域过滤查询
 */
export class AuditService {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   */
  constructor(dbClient) {
    this.db = dbClient;
    this.prepareStatements();
  }

  prepareStatements() {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO audit_logs (
        actor_handle, action, target_handle, content_type, item_uid,
        result, client_instance_id, ip, details, created_at
      ) VALUES (
        :actor, :action, :target, :contentType, :itemUid,
        :result, :clientId, :ip, :details, :now
      )
    `);

    this.stmtQuerySelf = this.db.prepare(`
      SELECT id, actor_handle, action, target_handle, content_type, item_uid,
             result, client_instance_id, ip, details, created_at
      FROM audit_logs
      WHERE (actor_handle = :requester OR target_handle = :requester)
        AND (:since = 0 OR created_at > :since)
      ORDER BY created_at DESC
      LIMIT :limit
    `);

    this.stmtPruneTime = this.db.prepare(`
      DELETE FROM audit_logs WHERE created_at < :retentionCutoff
    `);

    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) as total FROM audit_logs
    `);

    this.stmtPruneCap = this.db.prepare(`
      DELETE FROM audit_logs
      WHERE id NOT IN (
        SELECT id FROM audit_logs ORDER BY id DESC LIMIT 50000
      )
    `);
  }

  /**
   * 记录审计日志
   * @param {object} params
   * @param {string} params.actor 操作者 handle
   * @param {string} params.action 行为 (push, pull, delete, rollback, grant, revoke, claim_code, denied 等)
   * @param {string} [params.target] 目标资源归属者 handle
   * @param {string} [params.contentType]
   * @param {string} [params.itemUid]
   * @param {string} [params.result='success'] success | denied | failed
   * @param {string} [params.clientId]
   * @param {string} [params.ip]
   * @param {string|object} [params.details]
   */
  log({
    actor,
    action,
    target = null,
    contentType = null,
    itemUid = null,
    result = 'success',
    clientId = null,
    ip = null,
    details = null,
  }) {
    if (!actor || !action) return;

    const now = Date.now();
    const detailsStr = typeof details === 'object' && details !== null
      ? JSON.stringify(details)
      : (details ? String(details) : null);

    try {
      this.stmtInsert.run({
        ':actor': actor,
        ':action': action,
        ':target': target,
        ':contentType': contentType,
        ':itemUid': itemUid,
        ':result': result,
        ':clientId': clientId,
        ':ip': ip,
        ':details': detailsStr,
        ':now': now,
      });

      // 1% 概率执行异步修剪，保证低开销
      if (Math.random() < 0.01) {
        this.prune(now);
      }
    } catch (err) {
      console.error('[cfgsync:audit] Failed to write audit log:', err);
    }
  }

  /**
   * 执行过期清理与容量上限控制（保留 30 天，最大 50,000 条）
   * @param {number} [now=Date.now()]
   */
  prune(now = Date.now()) {
    try {
      const retentionCutoff = now - (30 * 24 * 60 * 60 * 1000);
      this.stmtPruneTime.run({ ':retentionCutoff': retentionCutoff });

      const countRow = this.stmtCount.get();
      if (countRow && countRow.total > 50000) {
        this.stmtPruneCap.run();
      }
    } catch (err) {
      console.warn('[cfgsync:audit] Pruning warning:', err.message);
    }
  }

  /**
   * 查询与当前请求者相关的审计日志（严格自作用域过滤，防枚举旁路）
   * @param {string} requesterHandle
   * @param {object} [options]
   * @param {number} [options.limit=50] 最大 100
   * @param {number} [options.since=0]
   * @returns {Array<object>}
   */
  getLogs(requesterHandle, { limit = 50, since = 0 } = {}) {
    if (!requesterHandle) return [];

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const safeSince = Number(since) || 0;

    return this.stmtQuerySelf.all({
      ':requester': requesterHandle,
      ':since': safeSince,
      ':limit': safeLimit,
    });
  }
}
