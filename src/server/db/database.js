import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export class DatabaseClient {
  /**
   * @param {string} dbPath 数据库文件绝对路径或 ':memory:'
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  init() {
    // 启用 WAL 模式与外键约束
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);

    // 模式版本守卫与增量迁移（Phase 2: user_version 2; Phase 3: user_version 3）
    const versionRow = this.db.prepare('PRAGMA user_version;').get();
    const currentVersion = versionRow ? versionRow.user_version : 0;
    if (currentVersion < 2) {
      this.transaction(() => {
        const tableInfo = this.db.prepare("PRAGMA table_info('share_grants');").all();
        const colNames = tableInfo.map(c => c.name);
        if (!colNames.includes('is_public')) {
          this.db.exec('ALTER TABLE share_grants ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;');
        }
        if (!colNames.includes('max_uses')) {
          this.db.exec('ALTER TABLE share_grants ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0;');
        }
        // 仅迁移历史存量 active 记录（历史公开分享），绝对不修改后续新代码创建的 pending 邀请码
        this.db.exec(`
          UPDATE share_grants 
          SET is_public = 1 
          WHERE grantee_handle IS NULL AND is_public = 0 AND status = 'active';
        `);
        this.db.exec('PRAGMA user_version = 2;');
      });
    }

    if (currentVersion < 3) {
      this.transaction(() => {
        const verInfo = this.db.prepare("PRAGMA table_info('config_versions');").all();
        const verCols = verInfo.map(c => c.name);
        if (!verCols.includes('version_title')) {
          this.db.exec('ALTER TABLE config_versions ADD COLUMN version_title TEXT;');
        }
        if (!verCols.includes('size_bytes')) {
          this.db.exec('ALTER TABLE config_versions ADD COLUMN size_bytes INTEGER DEFAULT 0;');
        }

        const grantInfo = this.db.prepare("PRAGMA table_info('share_grants');").all();
        const grantCols = grantInfo.map(c => c.name);
        if (!grantCols.includes('inject_secrets')) {
          this.db.exec('ALTER TABLE share_grants ADD COLUMN inject_secrets INTEGER NOT NULL DEFAULT 0;');
        }

        this.db.exec('PRAGMA user_version = 3;');
      });
    }
  }

  /**
   * 执行 SQL 语句
   * @param {string} sql
   */
  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * 预编译语句
   * @param {string} sql
   */
  prepare(sql) {
    return this.db.prepare(sql);
  }

  /**
   * 以 BEGIN IMMEDIATE 执行同步事务
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略回滚本身的次级异常
      }
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}
