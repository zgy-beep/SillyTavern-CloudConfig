import { Permission } from '../../common/constants.js';

/**
 * 权限控制服务
 */
export class AuthorizationService {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   */
  constructor(dbClient) {
    this.db = dbClient;
    this.prepareStatements();
  }

  prepareStatements() {
    this.stmtCheckGrant = this.db.prepare(`
      SELECT 1 FROM share_grants
      WHERE owner_handle = :owner
        AND grantee_handle = :grantee
        AND content_type = :contentType
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > :now)
        AND (
          scope_type = 'CONTENT_TYPE'
          OR (scope_type = 'ITEM' AND item_uid = :itemUid)
        )
      LIMIT 1
    `);
  }

  /**
   * 校验请求者是否有权执行指定操作
   * @param {string} action Permission 枚举 (READ, WRITE, ROLLBACK, SHARE, etc.)
   * @param {string} requesterHandle 发起请求的用户 handle
   * @param {string} ownerHandle 资源所有者的 handle
   * @param {string} contentType 配置类别
   * @param {string} [itemUid] 对象 UID
   * @returns {boolean}
   */
  can(action, requesterHandle, ownerHandle, contentType, itemUid) {
    if (!requesterHandle || !ownerHandle) {
      return false;
    }

    // 所有者对其名下的所有对象拥有全部权限
    if (requesterHandle === ownerHandle) {
      return true;
    }

    // 第一版：非本人访问一律只能是 READ，且 settings 绝不允许跨账号未授权读取
    if (action !== Permission.READ) {
      return false;
    }

    // 通用设置（settings）包含 API Key 等私有敏感信息，禁止跨账号未授权共享读取
    if (contentType === 'settings') {
      return false;
    }

    // 跨账号只读访问必须具有有效且经过审批的授权（share_grants）
    return this.hasApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid);
  }

  /**
   * 查询是否存在有效的授权记录
   */
  hasApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid) {
    const now = Date.now();
    const row = this.stmtCheckGrant.get({
      ':owner': ownerHandle,
      ':grantee': requesterHandle,
      ':contentType': contentType,
      ':itemUid': itemUid || '',
      ':now': now,
    });
    return Boolean(row);
  }
}
