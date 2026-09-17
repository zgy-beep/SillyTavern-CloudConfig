import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isShareableContentType } from '../../common/constants.js';

const SAFE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 字符，排除 0, O, 1, I, l 等易混淆字符

export class ShareService {
  /**
   * @param {import('../db/database.js').DatabaseClient} dbClient
   * @param {import('./AuditService.js').AuditService} auditService
   * @param {import('../config/ConfigService.js').ConfigService|object} [configService]
   * @param {object} [options]
   * @param {string} [options.secretPath]
   * @param {string} [options.serverSecret]
   */
  constructor(dbClient, auditService, configService = null, options = {}) {
    if (configService && !configService.get && typeof configService === 'object' && !options.serverSecret) {
      options = configService;
      configService = null;
    }
    this.db = dbClient;
    this.audit = auditService;
    this.configService = configService;
    this.dataRoot = options.dataRoot || null;
    this.serverSecret = options.serverSecret || this.loadOrGenerateSecret(options.secretPath, this.dataRoot);

    // 内存失败限速器
    // 账号维度：5 次/小时；IP 维度：50 次/小时
    this.failedAttemptsByAccount = new Map();
    this.failedAttemptsByIp = new Map();

    this.prepareStatements();
  }

  isCategoryShareable(contentType) {
    if (contentType === 'settings') {
      return Boolean(this.configService?.get('allowSettingsSharing'));
    }
    if (contentType === 'chat') {
      return Boolean(this.configService?.get('allowChatSharing'));
    }
    return isShareableContentType(contentType);
  }

  /**
   * 加载或初始化持久化 HMAC 密钥
   * @param {string} [customPath]
   * @param {string} [dataRoot]
   * @returns {string}
   */
  loadOrGenerateSecret(customPath, dataRoot = null) {
    const targetDir = dataRoot || path.join(process.cwd(), 'data', 'cfgsync');
    const secretPath = customPath || process.env.CFGSYNC_SERVER_SECRET_PATH || path.join(targetDir, '.server_secret');

    if (process.env.CFGSYNC_SERVER_SECRET) {
      return process.env.CFGSYNC_SERVER_SECRET;
    }

    try {
      if (fs.existsSync(secretPath)) {
        const secret = fs.readFileSync(secretPath, 'utf8').trim();
        if (secret.length >= 32) return secret;
      }

      // 检查老路径 fallback (data/.server_secret)
      const legacyPath = path.join(process.cwd(), 'data', '.server_secret');
      if (fs.existsSync(legacyPath)) {
        const secret = fs.readFileSync(legacyPath, 'utf8').trim();
        if (secret.length >= 32) {
          // 尝试同步到新路径
          try {
            if (!fs.existsSync(path.dirname(secretPath))) {
              fs.mkdirSync(path.dirname(secretPath), { recursive: true });
            }
            fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
          } catch {}
          return secret;
        }
      }

      const dir = path.dirname(secretPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const newSecret = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(secretPath, newSecret, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // 部分 Windows 环境可能不支持 mode 参数，降级普通写入
        fs.writeFileSync(secretPath, newSecret, 'utf8');
      }
      return newSecret;
    } catch (err) {
      console.warn('[cfgsync:share] Unable to persist .server_secret to file, using memory fallback:', err.message);
      return crypto.randomBytes(32).toString('hex');
    }
  }

  prepareStatements() {
    this.stmtInsertGrant = this.db.prepare(`
      INSERT INTO share_grants (
        owner_handle, grantee_handle, scope_type, content_type, item_uid,
        permission, grant_method, share_code_hash, code_usage, code_used,
        max_uses, is_public, inject_secrets, status, expires_at, created_at
      ) VALUES (
        :owner, :grantee, :scopeType, :contentType, :itemUid,
        :permission, :grantMethod, :hash, :codeUsage, :codeUsed,
        :maxUses, :isPublic, :injectSecrets, :status, :expiresAt, :now
      )
    `);

    this.stmtCheckOwnership = this.db.prepare(`
      SELECT 1 FROM config_records
      WHERE owner_handle = :owner AND content_type = :ct
        AND (:st = 'CONTENT_TYPE' OR item_uid = :uid)
        AND is_deleted = 0
      LIMIT 1
    `);

    this.stmtFindGrantByHash = this.db.prepare(`
      SELECT * FROM share_grants
      WHERE share_code_hash = :hash
        AND status IN ('pending', 'active')
        AND (expires_at IS NULL OR expires_at > :now)
      LIMIT 1
    `);

    this.stmtFindClaimedByGrantee = this.db.prepare(`
      SELECT * FROM share_grants
      WHERE share_code_hash = :hash
        AND grantee_handle = :grantee
        AND status = 'active'
      LIMIT 1
    `);

    this.stmtClaimSingleUse = this.db.prepare(`
      UPDATE share_grants
      SET code_used = 1, grantee_handle = :grantee, status = 'active'
      WHERE id = :id
        AND status IN ('pending', 'active')
        AND (expires_at IS NULL OR expires_at > :now)
        AND (code_used = 0 OR grantee_handle = :grantee)
    `);

    this.stmtIncrementMultiUse = this.db.prepare(`
      UPDATE share_grants
      SET code_used = code_used + 1
      WHERE id = :id
        AND (max_uses = 0 OR code_used < max_uses)
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > :now)
    `);

    this.stmtFindPublicGrant = this.db.prepare(`
      SELECT id, status FROM share_grants
      WHERE owner_handle = :owner AND content_type = :ct
        AND scope_type = :st
        AND (:st = 'CONTENT_TYPE' OR item_uid = :uid)
        AND is_public = 1
        AND grantee_handle IS NULL
      LIMIT 1
    `);

    this.stmtUpdateGrantStatus = this.db.prepare(`
      UPDATE share_grants
      SET status = :status, inject_secrets = :injectSecrets
      WHERE id = :id
    `);

    this.stmtRevokePublicGrants = this.db.prepare(`
      UPDATE share_grants
      SET status = 'revoked'
      WHERE owner_handle = :owner AND content_type = :ct
        AND scope_type = :st
        AND (:st = 'CONTENT_TYPE' OR item_uid = :uid)
        AND is_public = 1
        AND grantee_handle IS NULL
    `);

    this.stmtRevokeByIdAndOwner = this.db.prepare(`
      UPDATE share_grants
      SET status = 'revoked'
      WHERE id = :id AND owner_handle = :owner
    `);

    this.stmtRevokeByHashAndOwner = this.db.prepare(`
      UPDATE share_grants
      SET status = 'revoked'
      WHERE share_code_hash = :hash AND owner_handle = :owner
    `);

    this.stmtOutgoingShares = this.db.prepare(`
      SELECT id, owner_handle, grantee_handle, scope_type, content_type, item_uid,
             permission, grant_method, code_usage, code_used, max_uses, is_public,
             inject_secrets, status, expires_at, created_at
      FROM share_grants
      WHERE owner_handle = :owner AND status <> 'revoked'
      ORDER BY created_at DESC
    `);

    this.stmtIncomingShares = this.db.prepare(`
      SELECT id, owner_handle, scope_type, content_type, item_uid,
             permission, grant_method, inject_secrets, expires_at, created_at
      FROM share_grants
      WHERE grantee_handle = :requester AND status = 'active'
        AND (expires_at IS NULL OR expires_at > :now)
      ORDER BY created_at DESC
    `);
  }

  /**
   * 生成 8 位无混淆大写随机分享码
   * @param {number} [len=8]
   * @returns {string}
   */
  generateCode(len = 8) {
    const bytes = crypto.randomBytes(len);
    let result = '';
    for (let i = 0; i < len; i++) {
      result += SAFE_CHARSET[bytes[i] % SAFE_CHARSET.length];
    }
    return result;
  }

  /**
   * 计算分享码的加盐 HMAC-SHA256
   * @param {string} code
   * @returns {string}
   */
  hashShareCode(code) {
    return crypto
      .createHmac('sha256', this.serverSecret)
      .update(String(code).trim().toUpperCase())
      .digest('hex');
  }

  /**
   * 限速校验（账号 5 次/小时，IP 50 次/小时）
   * @param {string} handle
   * @param {string} [ip]
   */
  checkRateLimit(handle, ip) {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    // 1. 账号维度检查
    if (handle) {
      const accRecord = this.failedAttemptsByAccount.get(handle);
      if (accRecord) {
        if (now < accRecord.lockedUntil) {
          const waitSec = Math.ceil((accRecord.lockedUntil - now) / 1000);
          const err = new Error(`Too many failed attempts on this account. Try again in ${waitSec}s.`);
          err.status = 429;
          err.name = 'TooManyRequestsError';
          throw err;
        }
        if (now - accRecord.firstAttemptAt > ONE_HOUR) {
          this.failedAttemptsByAccount.delete(handle);
        }
      }
    }

    // 2. IP 维度高阈值兜底检查
    if (ip) {
      const ipRecord = this.failedAttemptsByIp.get(ip);
      if (ipRecord) {
        if (now < ipRecord.lockedUntil) {
          const waitSec = Math.ceil((ipRecord.lockedUntil - now) / 1000);
          const err = new Error(`Too many failed attempts from this IP. Try again in ${waitSec}s.`);
          err.status = 429;
          err.name = 'TooManyRequestsError';
          throw err;
        }
        if (now - ipRecord.firstAttemptAt > ONE_HOUR) {
          this.failedAttemptsByIp.delete(ip);
        }
      }
    }
  }

  /**
   * 记录认领失败，更新限速计数
   * @param {string} handle
   * @param {string} [ip]
   */
  recordFailure(handle, ip) {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    if (handle) {
      let acc = this.failedAttemptsByAccount.get(handle);
      if (!acc || now - acc.firstAttemptAt > ONE_HOUR) {
        acc = { count: 1, firstAttemptAt: now, lockedUntil: 0 };
      } else {
        acc.count += 1;
      }
      if (acc.count >= 5) {
        acc.lockedUntil = now + ONE_HOUR;
      }
      this.failedAttemptsByAccount.set(handle, acc);
    }

    if (ip) {
      let ipRec = this.failedAttemptsByIp.get(ip);
      if (!ipRec || now - ipRec.firstAttemptAt > ONE_HOUR) {
        ipRec = { count: 1, firstAttemptAt: now, lockedUntil: 0 };
      } else {
        ipRec.count += 1;
      }
      if (ipRec.count >= 50) {
        ipRec.lockedUntil = now + ONE_HOUR;
      }
      this.failedAttemptsByIp.set(ip, ipRec);
    }
  }

  /**
   * 认领成功后清零账号失败计数
   * @param {string} handle
   */
  resetRateLimit(handle) {
    if (handle) {
      this.failedAttemptsByAccount.delete(handle);
    }
  }

  /**
   * 创建专属分享码 (单次或多次)
   */
  createShareCode(authContext, options = {}) {
    const owner = authContext?.handle;
    if (!owner) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const {
      contentType,
      itemUid,
      scopeType = 'ITEM',
      codeUsage = 'single_use',
      maxUses = 1,
      expiresInMs = 7 * 24 * 60 * 60 * 1000, // 默认 7 天
    } = options;

    if (!contentType) {
      const err = new Error('content_type is required');
      err.status = 400;
      throw err;
    }

    if (!this.isCategoryShareable(contentType)) {
      const err = new Error(`Category '${contentType}' is not shareable`);
      err.status = 400;
      throw err;
    }

    if (scopeType === 'ITEM' && !itemUid) {
      const err = new Error('item_uid is required for ITEM scope');
      err.status = 400;
      throw err;
    }

    // 校验发起者对目标的所有权
    const hasOwnership = this.stmtCheckOwnership.get({
      ':owner': owner,
      ':ct': contentType,
      ':st': scopeType,
      ':uid': itemUid || '',
    });

    if (!hasOwnership) {
      const err = new Error('Forbidden: you can only create share codes for configs you own');
      err.status = 403;
      throw err;
    }

    const code = this.generateCode(8);
    const hash = this.hashShareCode(code);
    const now = Date.now();
    const expiresAt = expiresInMs ? now + Number(expiresInMs) : null;

    // P0-1 核心修复：未认领邀请码初始严格为 is_public = 0
    // single_use 模板状态为 pending，grantee_handle 为 NULL
    // multi_use 模板状态为 active，grantee_handle 为 NULL，is_public 为 0
    const initialStatus = codeUsage === 'single_use' ? 'pending' : 'active';
    const effectiveMaxUses = codeUsage === 'single_use' ? 1 : Math.max(Number(maxUses) || 0, 0);

    const info = this.stmtInsertGrant.run({
      ':owner': owner,
      ':grantee': null,
      ':scopeType': scopeType,
      ':contentType': contentType,
      ':itemUid': itemUid || null,
      ':permission': 'read',
      ':grantMethod': 'CODE',
      ':hash': hash,
      ':codeUsage': codeUsage,
      ':codeUsed': 0,
      ':maxUses': effectiveMaxUses,
      ':isPublic': 0,
      ':injectSecrets': options.injectSecrets ? 1 : 0,
      ':status': initialStatus,
      ':expiresAt': expiresAt,
      ':now': now,
    });

    this.audit?.log({
      actor: owner,
      action: 'grant',
      target: null,
      contentType,
      itemUid,
      result: 'success',
      details: {
        grant_id: info.lastInsertRowid,
        code_usage: codeUsage,
        max_uses: effectiveMaxUses,
        inject_secrets: Boolean(options.injectSecrets),
        sensitive: contentType === 'settings',
      },
    });

    return {
      success: true,
      share_code: code,
      grant_id: info.lastInsertRowid,
      content_type: contentType,
      item_uid: itemUid || null,
      scope_type: scopeType,
      code_usage: codeUsage,
      max_uses: effectiveMaxUses,
      expires_at: expiresAt,
    };
  }

  /**
   * 切换公开分享 (setPublicShare)
   */
  setPublicShare(authContext, options = {}) {
    const owner = authContext?.handle;
    if (!owner) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const {
      contentType,
      itemUid,
      scopeType = 'ITEM',
      enabled = true,
      injectSecrets = false,
    } = options;

    if (!contentType) {
      const err = new Error('content_type is required');
      err.status = 400;
      throw err;
    }

    // 校验类别是否允许共享
    if (!this.isCategoryShareable(contentType)) {
      const err = new Error(`Category '${contentType}' is not shareable`);
      err.status = 400;
      throw err;
    }

    if (scopeType === 'ITEM' && !itemUid) {
      const err = new Error('item_uid is required for ITEM scope');
      err.status = 400;
      throw err;
    }

    const hasOwnership = this.stmtCheckOwnership.get({
      ':owner': owner,
      ':ct': contentType,
      ':st': scopeType,
      ':uid': itemUid || '',
    });

    if (!hasOwnership) {
      const err = new Error('Forbidden: you can only share configs you own');
      err.status = 403;
      throw err;
    }

    const now = Date.now();
    if (enabled) {
      const existing = this.stmtFindPublicGrant.get({
        ':owner': owner,
        ':ct': contentType,
        ':st': scopeType,
        ':uid': itemUid || '',
      });

      if (existing) {
        this.stmtUpdateGrantStatus.run({
          ':status': 'active',
          ':injectSecrets': injectSecrets ? 1 : 0,
          ':id': existing.id,
        });
      } else {
        this.stmtInsertGrant.run({
          ':owner': owner,
          ':grantee': null,
          ':scopeType': scopeType,
          ':contentType': contentType,
          ':itemUid': itemUid || null,
          ':permission': 'read',
          ':grantMethod': 'DIRECT',
          ':hash': null,
          ':codeUsage': null,
          ':codeUsed': 0,
          ':maxUses': 0,
          ':isPublic': 1,
          ':injectSecrets': injectSecrets ? 1 : 0,
          ':status': 'active',
          ':expiresAt': null,
          ':now': now,
        });
      }

      this.audit?.log({
        actor: owner,
        action: 'grant',
        target: null,
        contentType,
        itemUid,
        result: 'success',
        details: {
          type: 'public_share',
          enabled: true,
          inject_secrets: Boolean(injectSecrets),
          sensitive: contentType === 'settings',
        },
      });

      return { success: true, is_public: true };
    } else {
      // 取消公开只影响 is_public=1 模板行，绝不影响已被用户认领的定向授权
      this.stmtRevokePublicGrants.run({
        ':owner': owner,
        ':ct': contentType,
        ':st': scopeType,
        ':uid': itemUid || '',
      });

      this.audit?.log({
        actor: owner,
        action: 'revoke',
        target: null,
        contentType,
        itemUid,
        result: 'success',
        details: { type: 'public_share', enabled: false },
      });

      return { success: true, is_public: false };
    }
  }

  /**
   * 认领核销分享码 (claimShareCode)
   * 支持 single_use 原行原子更新与 multi_use 模板派生行，具备严格幂等性与限速保护
   */
  claimShareCode(authContext, options = {}) {
    const grantee = authContext?.handle;
    if (!grantee) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const { code, ip, clientId } = options;

    // 限速校验
    this.checkRateLimit(grantee, ip);

    if (!code || typeof code !== 'string' || !code.trim()) {
      const err = new Error('Valid share_code is required');
      err.status = 400;
      throw err;
    }

    const cleanCode = code.trim().toUpperCase();
    const hash = this.hashShareCode(cleanCode);
    const now = Date.now();

    return this.db.transaction(() => {
      // 1. 幂等性快速判断：当前账号如果已经拥有此 hash 的 active 授权，直接放行
      const alreadyClaimed = this.stmtFindClaimedByGrantee.get({
        ':hash': hash,
        ':grantee': grantee,
      });

      if (alreadyClaimed) {
        return {
          success: true,
          already_claimed: true,
          owner_handle: alreadyClaimed.owner_handle,
          content_type: alreadyClaimed.content_type,
          item_uid: alreadyClaimed.item_uid,
          scope_type: alreadyClaimed.scope_type,
        };
      }

      // 2. 查找匹配的有效码模板记录
      const grantRow = this.stmtFindGrantByHash.get({
        ':hash': hash,
        ':now': now,
      });

      if (!grantRow) {
        this.recordFailure(grantee, ip);
        this.audit?.log({
          actor: grantee,
          action: 'claim_code',
          result: 'denied',
          ip,
          clientId,
          details: 'invalid_or_expired_code',
        });
        const err = new Error('Share code is invalid or expired');
        err.status = 400;
        throw err;
      }

      // 严禁认领自己的码
      if (grantRow.owner_handle === grantee) {
        const err = new Error('Cannot claim your own share code');
        err.status = 400;
        throw err;
      }

      // 3. 分支 A: single_use 单次使用核销模型
      if (grantRow.code_usage === 'single_use') {
        const updateInfo = this.stmtClaimSingleUse.run({
          ':id': grantRow.id,
          ':grantee': grantee,
          ':now': now,
        });

        if (updateInfo.changes === 0) {
          // 被他人抢先核销
          this.recordFailure(grantee, ip);
          this.audit?.log({
            actor: grantee,
            action: 'claim_code',
            target: grantRow.owner_handle,
            contentType: grantRow.content_type,
            itemUid: grantRow.item_uid,
            result: 'denied',
            ip,
            clientId,
            details: 'code_already_claimed',
          });
          const err = new Error('Share code has already been claimed');
          err.status = 409;
          throw err;
        }

        // 成功，清零账号失败次数
        this.resetRateLimit(grantee);
        this.audit?.log({
          actor: grantee,
          action: 'claim_code',
          target: grantRow.owner_handle,
          contentType: grantRow.content_type,
          itemUid: grantRow.item_uid,
          result: 'success',
          ip,
          clientId,
          details: { code_usage: 'single_use' },
        });

        return {
          success: true,
          already_claimed: false,
          owner_handle: grantRow.owner_handle,
          content_type: grantRow.content_type,
          item_uid: grantRow.item_uid,
          scope_type: grantRow.scope_type,
        };
      }

      // 4. 分支 B: multi_use 多次使用模板派生模型
      if (grantRow.code_usage === 'multi_use') {
        if (grantRow.max_uses > 0 && grantRow.code_used >= grantRow.max_uses) {
          this.recordFailure(grantee, ip);
          this.audit?.log({
            actor: grantee,
            action: 'claim_code',
            target: grantRow.owner_handle,
            contentType: grantRow.content_type,
            itemUid: grantRow.item_uid,
            result: 'denied',
            ip,
            clientId,
            details: 'max_uses_reached',
          });
          const err = new Error('Share code has reached maximum uses');
          err.status = 400;
          throw err;
        }

        const incInfo = this.stmtIncrementMultiUse.run({
          ':id': grantRow.id,
          ':now': now,
        });

        if (incInfo.changes === 0) {
          this.recordFailure(grantee, ip);
          const err = new Error('Share code has reached maximum uses or expired');
          err.status = 400;
          throw err;
        }

        // 插入属于此认领者的专属有效授权行
        this.stmtInsertGrant.run({
          ':owner': grantRow.owner_handle,
          ':grantee': grantee,
          ':scopeType': grantRow.scope_type,
          ':contentType': grantRow.content_type,
          ':itemUid': grantRow.item_uid,
          ':permission': 'read',
          ':grantMethod': 'CODE',
          ':hash': hash,
          ':codeUsage': 'single_use',
          ':codeUsed': 1,
          ':maxUses': 1,
          ':isPublic': 0,
          ':injectSecrets': grantRow.inject_secrets || 0,
          ':status': 'active',
          ':expiresAt': grantRow.expires_at,
          ':now': now,
        });

        this.resetRateLimit(grantee);
        this.audit?.log({
          actor: grantee,
          action: 'claim_code',
          target: grantRow.owner_handle,
          contentType: grantRow.content_type,
          itemUid: grantRow.item_uid,
          result: 'success',
          ip,
          clientId,
          details: { code_usage: 'multi_use' },
        });

        return {
          success: true,
          already_claimed: false,
          owner_handle: grantRow.owner_handle,
          content_type: grantRow.content_type,
          item_uid: grantRow.item_uid,
          scope_type: grantRow.scope_type,
        };
      }

      const err = new Error('Invalid code usage type');
      err.status = 400;
      throw err;
    });
  }

  /**
   * 撤销分享
   */
  revokeShare(authContext, { grantId, shareCodeHash } = {}) {
    const owner = authContext?.handle;
    if (!owner) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    if (!grantId && !shareCodeHash) {
      const err = new Error('grant_id or share_code_hash is required');
      err.status = 400;
      throw err;
    }

    let affected = 0;
    if (grantId) {
      const res = this.stmtRevokeByIdAndOwner.run({ ':id': Number(grantId), ':owner': owner });
      affected += res.changes;
    } else if (shareCodeHash) {
      const res = this.stmtRevokeByHashAndOwner.run({ ':hash': shareCodeHash, ':owner': owner });
      affected += res.changes;
    }

    if (affected === 0) {
      const err = new Error('Forbidden or grant not found');
      err.status = 404;
      throw err;
    }

    this.audit?.log({
      actor: owner,
      action: 'revoke',
      result: 'success',
      details: { grant_id: grantId, affected },
    });

    return { success: true, affected };
  }

  /**
   * 查询当前用户发出的分享（不泄露哈希与私密字段）
   */
  getOutgoingShares(authContext) {
    const owner = authContext?.handle;
    if (!owner) return [];
    return this.stmtOutgoingShares.all({ ':owner': owner });
  }

  /**
   * 查询当前用户获赠/认领的生效分享
   */
  getIncomingShares(authContext) {
    const requester = authContext?.handle;
    if (!requester) return [];
    return this.stmtIncomingShares.all({
      ':requester': requester,
      ':now': Date.now(),
    });
  }
}
