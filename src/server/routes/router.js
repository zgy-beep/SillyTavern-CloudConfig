import { Router } from 'express';
import { AuthContext } from '../auth/AuthContext.js';
import { P0ContentTypes, ContentTypeGroup, Permission } from '../../common/constants.js';

/**
 * 创建 Express 路由
 * @param {object} context
 * @param {import('../services/SyncService.js').SyncService} context.syncService
 * @param {import('../services/ChangeEventBus.js').ChangeEventBus} context.changeBus
 * @param {import('../services/AuthorizationService.js').AuthorizationService} context.authService
 * @param {Map<string, import('../adapters/ConfigAdapter.js').ConfigAdapter>} context.adapters
 * @returns {Router}
 */
export function createPluginRouter({ syncService, changeBus, authService, adapters }) {
  const router = Router();

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

  // 2. GET /items?content_type=&owner=&scope=(local|cloud)
  router.get('/items', asyncHandler(async (req, res) => {
    const contentType = req.query.content_type;
    const owner = req.query.owner || req.authContext.handle;
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

    if (!authService.can(Permission.READ, req.authContext.handle, owner, contentType)) {
      return res.status(403).json({ error: 'Forbidden', message: 'No read permission on requested target' });
    }

    // 查询云端记录
    const stmt = syncService.db.prepare(`
      SELECT item_uid, display_name, current_version, current_checksum, updated_at
      FROM config_records
      WHERE owner_handle = :owner AND content_type = :ct AND is_deleted = 0
      ORDER BY updated_at DESC
    `);

    const records = stmt.all({
      ':owner': owner,
      ':ct': contentType,
    });

    res.json({
      owner,
      content_type: contentType,
      items: records.map(r => ({
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

    const result = await syncService.pull(req.authContext, owner, contentType, itemUid, targetVersion);
    if (shouldApply === 'true' || shouldApply === true) {
      const adapter = adapters.get(contentType);
      if (adapter) {
        await adapter.apply(req.authContext.directories, itemUid, 'UPSERT', result.content);
      }
    }
    res.json(result);
  }));

  // 4. POST /push
  router.post('/push', asyncHandler(async (req, res) => {
    const {
      content_type: contentType,
      item_uid: itemUid,
      display_name: displayName,
      base_version: baseVersion,
      operation = 'UPSERT',
      checksum = null,
      payload = null,
      client_id: clientId = 'unknown',
    } = req.body;

    if (!contentType || !itemUid || baseVersion === undefined) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'content_type, item_uid, and base_version are required',
      });
    }

    const result = await syncService.push({
      authContext: req.authContext,
      ownerHandle: req.authContext.handle, // 写操作仅能推给自身
      contentType,
      itemUid,
      displayName,
      baseVersion: Number(baseVersion),
      operation,
      checksum,
      payload,
      clientId,
    });

    res.json({
      success: true,
      ...result,
    });
  }));

  // 5. GET /changes?since=
  router.get('/changes', asyncHandler(async (req, res) => {
    const since = Number(req.query.since) || 0;
    const limit = Number(req.query.limit) || 100;

    const result = changeBus.getChanges(req.authContext.handle, since, limit);
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
    res.json({ versions });
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

    res.json({
      success: true,
      ...result,
    });
  }));

  // 统一错误捕获处理（特别是 409 Conflict）
  router.use((err, req, res, next) => {
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
