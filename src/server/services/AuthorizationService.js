import { Permission, isShareableContentType } from '../../common/constants.js';

/**
 * 权限控制服务
 */
export class AuthorizationService {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   * @param {import('../config/ConfigService.js').ConfigService} [configService]
   */
  constructor(dbClient, configService = null) {
    this.db = dbClient;
    this.configService = configService;
    this.prepareStatements();
  }

  isCategoryShareable(contentType) {
    if (contentType === 'settings') {
      return Boolean(this.configService?.get('allowSettingsSharing'));
    }
    return isShareableContentType(contentType);
  }

  prepareStatements() {
    this.stmtCheckGrant = this.db.prepare(`
      SELECT id, inject_secrets FROM share_grants
      WHERE owner_handle = :owner
        AND (grantee_handle = :grantee OR (is_public = 1 AND grantee_handle IS NULL))
        AND content_type = :contentType
        AND (content_type <> 'settings' OR :allowSettingsSharing = 1)
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

    // 第一版：非本人访问一律只能是 READ
    if (action !== Permission.READ) {
      return false;
    }

    // 校验类别是否开放共享
    if (!this.isCategoryShareable(contentType)) {
      return false;
    }

    // 跨账号只读访问必须具有有效且经过审批的授权（share_grants）
    return this.hasApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid);
  }

  /**
   * 获取经审批的有效授权详情
   */
  getApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid) {
    if (!this.isCategoryShareable(contentType)) {
      return null;
    }
    const now = Date.now();
    const allowSettingsSharing = Boolean(this.configService?.get('allowSettingsSharing')) ? 1 : 0;
    const row = this.stmtCheckGrant.get({
      ':owner': ownerHandle,
      ':grantee': requesterHandle,
      ':contentType': contentType,
      ':itemUid': itemUid || '',
      ':allowSettingsSharing': allowSettingsSharing,
      ':now': now,
    });
    return row || null;
  }

  /**
   * 查询是否存在有效的授权记录
   */
  hasApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid) {
    return Boolean(this.getApprovedGrant(ownerHandle, requesterHandle, contentType, itemUid));
  }
}
