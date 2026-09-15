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
