import { Router } from 'express';
import { AuthContext } from '../auth/AuthContext.js';
import { P0ContentTypes, ContentTypeGroup, Permission } from '../../common/constants.js';
import { ShareService } from '../services/ShareService.js';
import { AuditService } from '../services/AuditService.js';

/**
 * 创建 Express 路由
 * @param {object} context
 * @param {import('../services/SyncService.js').SyncService} context.syncService
 * @param {import('../services/ChangeEventBus.js').ChangeEventBus} context.changeBus
 * @param {import('../services/AuthorizationService.js').AuthorizationService} context.authService
 * @param {Map<string, import('../adapters/ConfigAdapter.js').ConfigAdapter>} context.adapters
 * @param {import('../services/ShareService.js').ShareService} [context.shareService]
 * @param {import('../services/AuditService.js').AuditService} [context.auditService]
 * @returns {Router}
 */
export function createPluginRouter({
  syncService,
  changeBus,
  authService,
  adapters,
  shareService,
  auditService,
  configService,
}) {
  const router = Router();
  const audit = auditService || (syncService?.db ? new AuditService(syncService.db) : null);
  const shares = shareService || (syncService?.db && audit ? new ShareService(syncService.db, audit, configService) : null);

  // 统一错误包装辅助函数
  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  /**
   * 鉴权中间件：从 req 提取 AuthContext
   */
  const requireAuth = (req, res, next) => {
    try {
      req.authContext = AuthContext.fromRequest(req);
      next();
    } catch (err) {
      res.status(401).json({ error: 'Unauthorized', message: err.message });
    }
  };

  router.use(requireAuth);

  // 1. GET /content-types
  router.get('/content-types', (req, res) => {
    res.json({
      groups: {
        [ContentTypeGroup.P0]: P0ContentTypes,
        [ContentTypeGroup.P1]: ['character', 'instruct', 'context', 'sysprompt', 'reasoning', 'quick_replies'],
        [ContentTypeGroup.P2]: ['background', 'avatar', 'sprites', 'theme', 'workflow'],
      },
      activeTypes: Array.from(adapters.keys()),
      current_user: req.authContext.handle,
    });
  });

  // 1.5 GET /owners?content_type=
  router.get('/owners', asyncHandler(async (req, res) => {
    const requester = req.authContext.handle;
    const contentType = req.query.content_type;
    const allowSettingsSharing = Boolean(configService?.get('allowSettingsSharing')) ? 1 : 0;

    let stmt;
    let params;

    if (contentType) {
      stmt = syncService.db.prepare(`
        SELECT DISTINCT owner_handle FROM config_records 
        WHERE owner_handle = :requester AND content_type = :ct AND is_deleted = 0
        UNION
        SELECT DISTINCT owner_handle FROM share_grants
        WHERE (grantee_handle = :requester OR (is_public = 1 AND grantee_handle IS NULL))
          AND content_type = :ct
          AND (content_type <> 'settings' OR :allowSettingsSharing = 1)
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > :now)
        ORDER BY owner_handle ASC
      `);
      params = { ':requester': requester, ':ct': contentType, ':allowSettingsSharing': allowSettingsSharing, ':now': Date.now() };
    } else {
      stmt = syncService.db.prepare(`
        SELECT DISTINCT owner_handle FROM config_records 
        WHERE owner_handle = :requester AND is_deleted = 0
        UNION
        SELECT DISTINCT owner_handle FROM share_grants
        WHERE (grantee_handle = :requester OR (is_public = 1 AND grantee_handle IS NULL))
          AND (content_type <> 'settings' OR :allowSettingsSharing = 1)
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > :now)
        ORDER BY owner_handle ASC
      `);
      params = { ':requester': requester, ':allowSettingsSharing': allowSettingsSharing, ':now': Date.now() };
    }

    const rows = stmt.all(params);
    res.json({
      owners: rows.map(r => r.owner_handle),
      current_user: requester,
      content_type: contentType || null,
    });
  }));

  // 2. GET /items?content_type=&owner=&scope=(local|cloud)&all_owners=
  router.get('/items', asyncHandler(async (req, res) => {
    const contentType = req.query.content_type;
    const isAllOwners = req.query.all_owners === 'true' || req.query.owner === 'all';
    const owner = isAllOwners ? 'all' : (req.query.owner || req.authContext.handle);
    const scope = req.query.scope || 'cloud';

    if (!contentType) {
      return res.status(400).json({ error: 'BadRequest', message: 'content_type is required' });
    }

    const adapter = adapters.get(contentType);
    if (!adapter) {
      return res.status(400).json({ error: 'BadRequest', message: `Unsupported content_type: ${contentType}` });
    }

    if (scope === 'local') {
      // 发现本地 ST 目录下的对象（始终使用当前用户的真实数据目录）
      const localItems = await adapter.listItems(req.authContext.directories);
      return res.json({ items: localItems });
    }

    // 查询云端记录
    let records = [];
    const allowSettingsSharing = Boolean(configService?.get('allowSettingsSharing')) ? 1 : 0;
    if (isAllOwners) {
      // 仅查询当前用户自身的数据，以及授权给当前用户的云端数据，绝不泄露全站未授权用户数据
      // 敏感类别（如 settings）绝对禁止跨账号共享，即使存在授权记录也不在列表中展示
      const stmt = syncService.db.prepare(`
        SELECT DISTINCT c.owner_handle, c.item_uid, c.display_name, c.current_version, c.current_checksum, c.updated_at
        FROM config_records c
        WHERE c.content_type = :ct AND c.is_deleted = 0
          AND (
            c.owner_handle = :requester
            OR (
              (:ct <> 'settings' OR :allowSettingsSharing = 1)
              AND EXISTS (
                SELECT 1 FROM share_grants g
                WHERE g.owner_handle = c.owner_handle
                  AND (g.grantee_handle = :requester OR (g.is_public = 1 AND g.grantee_handle IS NULL))
                  AND g.content_type = :ct
                  AND (g.content_type <> 'settings' OR :allowSettingsSharing = 1)
                  AND g.status = 'active'
                  AND (g.expires_at IS NULL OR g.expires_at > :now)
                  AND (g.scope_type = 'CONTENT_TYPE' OR (g.scope_type = 'ITEM' AND g.item_uid = c.item_uid))
              )
            )
          )
        ORDER BY c.updated_at DESC
      `);
      records = stmt.all({
        ':ct': contentType,
        ':requester': req.authContext.handle,
        ':allowSettingsSharing': allowSettingsSharing,
        ':now': Date.now(),
      });
    } else {
      if (!authService.can(Permission.READ, req.authContext.handle, owner, contentType)) {
        return res.status(403).json({ error: 'ForbiddenError', message: 'No read permission on requested target' });
      }
      const stmt = syncService.db.prepare(`
        SELECT DISTINCT c.owner_handle, c.item_uid, c.display_name, c.current_version, c.current_checksum, c.updated_at
        FROM config_records c
        WHERE c.content_type = :ct AND c.owner_handle = :owner AND c.is_deleted = 0
        ORDER BY c.updated_at DESC
      `);
      records = stmt.all({
        ':ct': contentType,
        ':owner': owner,
      });
    }

    res.json({
      owner,
      content_type: contentType,
      items: records.map(r => ({
        owner_handle: r.owner_handle,
        item_uid: r.item_uid,
        display_name: r.display_name,
        current_version: r.current_version,
        current_checksum: r.current_checksum,
        updated_at: r.updated_at,
      })),
    });
  }));

  // 3. GET /pull?content_type=&item_uid=&owner=&version=&apply=
  router.get('/pull', asyncHandler(async (req, res) => {
    const { content_type: contentType, item_uid: itemUid, apply: shouldApply } = req.query;
    const owner = req.query.owner || req.authContext.handle;
    const targetVersion = req.query.version ? Number(req.query.version) : null;

    if (!contentType || !itemUid) {
      return res.status(400).json({ error: 'BadRequest', message: 'content_type and item_uid are required' });
    }

    // 鉴权与服务端授权推导（绝不依赖任何前端入参伪造）
    const isSelf = req.authContext.handle === owner;
    let validatedGrant = null;
    if (!isSelf) {
      validatedGrant = authService.getApprovedGrant(owner, req.authContext.handle, contentType, itemUid);
      if (!validatedGrant) {
        return res.status(403).json({ error: 'ForbiddenError', message: 'No read permission on requested target' });
      }
    }

    const result = await syncService.pull(req.authContext, owner, contentType, itemUid, targetVersion);
    if (shouldApply === 'true' || shouldApply === true) {
      const adapter = adapters.get(contentType);
      if (adapter) {
        const injectSecrets = Boolean(validatedGrant?.inject_secrets);
        await adapter.apply(
          req.authContext.directories,
          itemUid,
          'UPSERT',
          result.content,
          result.display_name,
          {
            sourceOwner: owner, // 经服务端鉴权验证后的唯一合法所有者
            injectSecrets,
            audit,
          }
        );
      }
    }

    audit?.log({
      actor: req.authContext.handle,
      action: 'pull',
      target: owner,
      contentType,
      itemUid,
      result: 'success',
      details: { version: result.version },
    });

    res.json(result);
  }));

  // 4. POST /push
  router.post('/push', asyncHandler(async (req, res) => {
    const {
      content_type: contentType,
      item_uid: itemUid,
      display_name: displayName,
      version_title: versionTitle,
      base_version: baseVersion,
      force,
      operation = 'UPSERT',
      checksum = null,
      payload = null,
      client_id: clientId = 'unknown',
    } = req.body;

    if (!contentType || !itemUid || (baseVersion === undefined && !force)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'content_type and item_uid are required',
      });
    }

    const result = await syncService.push({
      authContext: req.authContext,
      ownerHandle: req.authContext.handle, // 写操作仅能推给自身
      contentType,
      itemUid,
      displayName,
      versionTitle,
      baseVersion: baseVersion !== undefined ? Number(baseVersion) : 0,
      force: force === true || force === 'true',
      operation,
      checksum,
      payload,
      clientId,
    });

    audit?.log({
      actor: req.authContext.handle,
      action: operation === 'DELETE' ? 'delete' : 'push',
      target: req.authContext.handle,
      contentType,
      itemUid,
      result: 'success',
      clientId,
      details: { version: result.version, operation, version_title: result.version_title },
    });

    res.json({
      success: true,
      ...result,
    });
  }));

  // 5. GET /changes?since=
  router.get('/changes', asyncHandler(async (req, res) => {
    const since = Number(req.query.since) || 0;
    const result = changeBus.getChanges(req.authContext.handle, since);
    res.json(result);
  }));

  // 6. GET /versions?content_type=&item_uid=&owner=
  router.get('/versions', asyncHandler(async (req, res) => {
    const { content_type: contentType, item_uid: itemUid } = req.query;
    const owner = req.query.owner || req.authContext.handle;

    if (!contentType || !itemUid) {
      return res.status(400).json({ error: 'BadRequest', message: 'content_type and item_uid are required' });
    }

    const versions = await syncService.getVersions(req.authContext, owner, contentType, itemUid);
    res.json({ versions: versions.map(v => ({ ...v, size_bytes: v.size_bytes || 0 })) });
  }));

  // 7. POST /rollback
  router.post('/rollback', asyncHandler(async (req, res) => {
    const {
      content_type: contentType,
      item_uid: itemUid,
      target_version: targetVersion,
      base_version: baseVersion,
      client_id: clientId,
    } = req.body;

    if (!contentType || !itemUid || targetVersion === undefined || baseVersion === undefined) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'content_type, item_uid, target_version, and base_version are required',
      });
    }

    const result = await syncService.rollback({
      authContext: req.authContext,
      ownerHandle: req.authContext.handle,
      contentType,
      itemUid,
      targetVersion: Number(targetVersion),
      baseVersion: Number(baseVersion),
      clientId,
    });

    audit?.log({
      actor: req.authContext.handle,
      action: 'rollback',
      target: req.authContext.handle,
      contentType,
      itemUid,
      result: 'success',
      clientId,
      details: { targetVersion, newVersion: result.version },
    });

    res.json({
      success: true,
      ...result,
    });
  }));

  // 8. POST /shares/create-code
  router.post('/shares/create-code', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const {
      content_type: contentType,
      item_uid: itemUid,
      scope_type: scopeType = 'ITEM',
      code_usage: codeUsage = 'single_use',
      max_uses: maxUses = 1,
      inject_secrets: injectSecrets = false,
      expires_in_ms: expiresInMs,
    } = req.body;

    const result = shares.createShareCode(req.authContext, {
      contentType,
      itemUid,
      scopeType,
      codeUsage,
      maxUses,
      injectSecrets: injectSecrets === true || injectSecrets === 'true',
      expiresInMs,
    });
    res.json(result);
  }));

  // 9. POST /shares/claim-code
  router.post('/shares/claim-code', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const { share_code: code, client_id: clientId } = req.body;
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress;

    const result = shares.claimShareCode(req.authContext, {
      code,
      ip,
      clientId,
    });
    res.json(result);
  }));

  // 10. POST /shares/quick-public
  router.post('/shares/quick-public', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const {
      content_type: contentType,
      item_uid: itemUid,
      scope_type: scopeType = 'ITEM',
      enabled = true,
      inject_secrets: injectSecrets = false,
    } = req.body;

    const result = shares.setPublicShare(req.authContext, {
      contentType,
      itemUid,
      scopeType,
      enabled: enabled === true || enabled === 'true',
      injectSecrets: injectSecrets === true || injectSecrets === 'true',
    });
    res.json(result);
  }));

  // 10.5 GET /config & POST /config
  router.get('/config', (req, res) => {
    res.json({ config: configService?.getAll() || {} });
  });

  router.post('/config', (req, res) => {
    const updated = configService?.update(req.body) || {};
    res.json({ success: true, config: updated });
  });

  // 11. POST /shares/revoke
  router.post('/shares/revoke', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const { grant_id: grantId, share_code_hash: shareCodeHash } = req.body;
    const result = shares.revokeShare(req.authContext, {
      grantId,
      shareCodeHash,
    });
    res.json(result);
  }));

  // 12. GET /shares/outgoing
  router.get('/shares/outgoing', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const list = shares.getOutgoingShares(req.authContext);
    res.json({ shares: list });
  }));

  // 13. GET /shares/incoming
  router.get('/shares/incoming', asyncHandler(async (req, res) => {
    if (!shares) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'ShareService is not available' });
    }
    const list = shares.getIncomingShares(req.authContext);
    res.json({ shares: list });
  }));

  // 14. GET /audit
  router.get('/audit', asyncHandler(async (req, res) => {
    if (!audit) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'AuditService is not available' });
    }
    const limit = Number(req.query.limit) || 50;
    const since = Number(req.query.since) || 0;
    const logs = audit.getLogs(req.authContext.handle, { limit, since });
    res.json({ logs });
  }));

  // 统一错误捕获处理（特别是 409 Conflict 与 审计拒绝记录）
  router.use((err, req, res, next) => {
    if (audit && (err.status === 403 || err.status === 429)) {
      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      audit.log({
        actor: req.authContext?.handle || 'anonymous',
        action: req.path.replace(/^\//, '') || 'unknown',
        target: req.query?.owner || req.body?.owner || null,
        contentType: req.query?.content_type || req.body?.content_type || null,
        itemUid: req.query?.item_uid || req.body?.item_uid || null,
        result: 'denied',
        ip,
        details: err.message,
      });
    }

    if (err.name === 'ConflictError') {
      return res.status(409).json({
        error: 'Conflict',
        message: err.message,
        server_version: err.serverVersion,
        current_checksum: err.currentChecksum,
        is_deleted: err.isDeleted,
      });
    }

    if (err.status) {
      return res.status(err.status).json({
        error: err.name,
        message: err.message,
      });
    }

    console.error('[cfgsync] Server error:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: err.message,
    });
  });

  return router;
}
