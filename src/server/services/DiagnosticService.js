import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { CRITICAL_TABLES } from './MigrationService.js';

export const TESTED_ST_VERSION_MIN = '1.18.0';
export const TESTED_ST_VERSION_MAX = '1.20.0';

export class DiagnosticService {
  /**
   * @param {object} options
   * @param {import('../db/database.js').DatabaseClient} options.dbClient
   * @param {import('../config/ConfigService.js').ConfigService} options.configService
   * @param {string} [options.stRoot]
   * @param {string} [options.activeDataRoot]
   */
  constructor({ dbClient, configService, stRoot = process.cwd(), activeDataRoot = null }) {
    this.dbClient = dbClient;
    this.configService = configService;
    this.stRoot = stRoot;
    this.activeDataRoot = activeDataRoot;
  }

  /**
   * 检测 SillyTavern 当前版本并执行双向校验 (N-5)
   * @returns {{ version: string, status: 'compatible' | 'below_recommended' | 'above_tested', message: string }}
   */
  detectSillyTavernVersion() {
    let version = 'unknown';
    try {
      const pkgPath = path.join(this.stRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        version = pkg.version || 'unknown';
      }
    } catch {}

    if (version === 'unknown') {
      return {
        version,
        status: 'compatible',
        message: '未能读取到 SillyTavern package.json 版本号，请确保运行在官方酒馆目录。',
      };
    }

    const cmp = (v1, v2) => {
      const parts1 = v1.split('.').map(Number);
      const parts2 = v2.split('.').map(Number);
      for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
      }
      return 0;
    };

    if (cmp(version, TESTED_ST_VERSION_MIN) < 0) {
      return {
        version,
        status: 'below_recommended',
        message: `当前 SillyTavern 版本 (${version}) 低于推荐版本 (${TESTED_ST_VERSION_MIN})，部分多用户接口与插件功能可能受限。`,
      };
    }

    if (cmp(version, TESTED_ST_VERSION_MAX) > 0) {
      return {
        version,
        status: 'above_tested',
        message: `检测到当前 SillyTavern 版本 (${version}) 高于插件已知测试版本 (${TESTED_ST_VERSION_MAX})，建议使用前先进行本地配置备份。`,
      };
    }

    return {
      version,
      status: 'compatible',
      message: `当前 SillyTavern 版本 (${version}) 完全在已知测试兼容范围内。`,
    };
  }

  /**
   * 递归遮蔽值中的高熵敏感串 (≥32 字符且匹配 Token/Secret/Hex 特征) (N-10)
   * 遮蔽只做在值上，保留原始 JSON 键名与嵌套结构
   * @param {any} val
   * @returns {any}
   */
  static maskSensitiveValues(val) {
    if (typeof val === 'string') {
      // 敏感键对应值的特定匹配或长度 >= 32 且为高熵字符
      if (val.length >= 32) {
        // 如果是纯数字或含空格句子，可能不是 key，但如果是连续无空格 token 或 hex，进行遮蔽
        if (/^[a-zA-Z0-9_\-\.\/+=]{32,}$/.test(val)) {
          return '***REDACTED***';
        }
      }
      return val;
    }

    if (Array.isArray(val)) {
      return val.map(item => this.maskSensitiveValues(item));
    }

    if (val !== null && typeof val === 'object') {
      const masked = {};
      for (const [k, v] of Object.entries(val)) {
        // 显式敏感字段直接遮蔽
        if (/^(api_key|secret|password|token|share_code_hash|authorization)$/i.test(k)) {
          masked[k] = '***REDACTED***';
        } else {
          masked[k] = this.maskSensitiveValues(v);
        }
      }
      return masked;
    }

    return val;
  }

  /**
   * 生成白名单脱敏诊断报告 (N-4, N-10)
   * @returns {object}
   */
  generateReport() {
    const stVersionCheck = this.detectSillyTavernVersion();

    // 1. 数据库状态统计
    let dbStatus = {
      userVersion: 0,
      integrity: 'unknown',
      tableCounts: {},
      sizeBytes: 0,
      walSizeBytes: 0,
    };

    if (this.dbClient && this.dbClient.db) {
      try {
        const uVer = this.dbClient.db.prepare('PRAGMA user_version;').get();
        dbStatus.userVersion = uVer?.user_version || 0;

        const integ = this.dbClient.db.prepare('PRAGMA integrity_check;').get();
        dbStatus.integrity = integ?.integrity_check || 'unknown';

        for (const tbl of CRITICAL_TABLES) {
          try {
            const countRow = this.dbClient.db.prepare(`SELECT COUNT(*) as count FROM ${tbl};`).get();
            dbStatus.tableCounts[tbl] = countRow?.count || 0;
          } catch {
            dbStatus.tableCounts[tbl] = -1;
          }
        }

        if (this.dbClient.dbPath && this.dbClient.dbPath !== ':memory:' && fs.existsSync(this.dbClient.dbPath)) {
          dbStatus.sizeBytes = fs.statSync(this.dbClient.dbPath).size;
          const wal = `${this.dbClient.dbPath}-wal`;
          if (fs.existsSync(wal)) {
            dbStatus.walSizeBytes = fs.statSync(wal).size;
          }
        }
      } catch (err) {
        dbStatus.error = err.message;
      }
    }

    // 2. 白名单非敏感配置读取
    const rawConfig = this.configService?.config || {};
    const whitelistedConfig = {
      allowSettingsSharing: Boolean(rawConfig.allowSettingsSharing),
      maxVersionsByType: rawConfig.maxVersionsByType || {},
      autoBackupLocalFile: rawConfig.autoBackupLocalFile !== false,
      autoSyncEnabled: Boolean(rawConfig.autoSyncEnabled),
      webdavEnabled: Boolean(rawConfig.webdavEnabled),
      localPathEnabled: Boolean(rawConfig.localPathEnabled),
    };

    // 3. 提取最近 50 条审计日志，并严格剔除 ip 与 item_uid (N-10)
    let sanitizedAudits = [];
    if (this.dbClient && this.dbClient.db) {
      try {
        const rows = this.dbClient.db.prepare(`
          SELECT id, created_at, actor_handle, target_handle, action, content_type, result
          FROM audit_logs
          ORDER BY created_at DESC
          LIMIT 50;
        `).all();

        sanitizedAudits = rows.map(r => ({
          createdAt: r.created_at,
          action: r.action,
          contentType: r.content_type,
          result: r.result,
          actor: r.actor_handle ? `${r.actor_handle.slice(0, 2)}***` : 'anon',
        }));
      } catch {}
    }

    // 4. 组装整份白名单诊断包
    const report = {
      generatedAt: new Date().toISOString(),
      system: {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      },
      sillytavern: stVersionCheck,
      plugin: {
        id: 'cfgsync',
        version: '0.1.0',
        activeDataRoot: this.activeDataRoot ? path.basename(this.activeDataRoot) : 'default',
      },
      database: dbStatus,
      config: whitelistedConfig,
      recentAuditEvents: sanitizedAudits,
      readme: [
        '========================================================================',
        '【SillyTavern-CloudConfig 诊断包安全检查与声明】',
        '1. 本诊断包已对已知敏感字段进行白名单过滤，并对所有长凭据（>=32字符）进行遮蔽；',
        '2. 导出的审计事件已完全剔除 IP 地址与具体的 item_uid；',
        '3. 在将本诊断信息提交至 GitHub Issue 或公开论坛前，请自行检查是否含有个人隐私；',
        '========================================================================',
      ].join('\n'),
    };

    // 执行最后全局高熵值安全遮蔽扫描
    return DiagnosticService.maskSensitiveValues(report);
  }
}
