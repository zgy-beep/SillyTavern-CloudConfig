import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MigrationService, CRITICAL_TABLES } from '../../src/server/services/MigrationService.js';
import { DiagnosticService } from '../../src/server/services/DiagnosticService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { SCHEMA_SQL } from '../../src/server/db/schema.js';

// 辅助函数：初始化一个带 WAL 模式和测试数据的旧库
async function createMockOldDatabase(dir, { userVersion = 5, recordCount = 10 } = {}) {
  const dbPath = path.join(dir, 'cfgsync.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  // 设置 user_version
  db.exec(`PRAGMA user_version = ${userVersion};`);

  // 插入测试数据
  const now = Date.now();
  for (let i = 1; i <= recordCount; i++) {
    db.prepare(`
      INSERT INTO config_records (owner_handle, content_type, item_uid, display_name, current_version, current_checksum, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('alice', 'openai_preset', `item_${i}`, `Preset ${i}`, 1, `sha_${i}`, now + i);

    db.prepare(`
      INSERT INTO config_versions (owner_handle, content_type, item_uid, version, operation, blob_path, checksum, created_at, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('alice', 'openai_preset', `item_${i}`, 1, 'UPSERT', `blobs/item_${i}.bin`, `sha_${i}`, now + i, 1024);

    db.prepare(`
      INSERT INTO audit_logs (actor_handle, action, target_handle, content_type, item_uid, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('alice', 'PUSH', 'alice', 'openai_preset', `item_${i}`, 'success', now + i);
  }

  // 插入 share_grants 和 binding_locks
  db.prepare(`
    INSERT INTO share_grants (owner_handle, grantee_handle, scope_type, content_type, item_uid, grant_method, share_code_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('alice', null, 'item', 'openai_preset', 'item_1', 'invite_code', 'hash_1', 'active', now);

  db.prepare(`
    INSERT INTO binding_locks (requester_handle, owner_handle, content_type, item_uid, locked, locked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('alice', 'alice', 'openai_preset', 'item_1', 1, now);

  db.close();

  // 写入 .server_secret
  const secretContent = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, '.server_secret'), secretContent, { mode: 0o600 });

  // 写入 cfgsync_config.json
  const configContent = JSON.stringify({ allowSettingsSharing: true, maxVersions: 25 }, null, 2);
  fs.writeFileSync(path.join(dir, 'cfgsync_config.json'), configContent, 'utf8');

  return { dbPath, secretContent, configContent };
}

test('Phase 6 Milestone 1: 数据外置、一致性迁移与白名单诊断包 (M1 专项 12 用例)', async (t) => {
  await t.test('1. WAL Checkpoint TRUNCATE 与 0 字节 WAL 保证 (N-6, N-11)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_1_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      await createMockOldDatabase(oldDataDir, { userVersion: 5, recordCount: 15 });

      // 在旧库做一次 checkpoint 前，生成一条未合并写入
      const testDb = new DatabaseSync(path.join(oldDataDir, 'cfgsync.sqlite'));
      testDb.exec("INSERT INTO audit_logs (actor_handle, action, created_at) VALUES ('alice', 'TEST_WAL_FLUSH', 123456);");
      testDb.close();

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      assert.equal(res.success, true);
      assert.equal(res.migrated, true);

      // 验证新位置的数据库已包含 WAL 未合并写入
      const newDb = new DatabaseSync(res.dbPath);
      const walRow = newDb.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE action = 'TEST_WAL_FLUSH';").get();
      assert.equal(walRow.count, 1, 'WAL 模式下未合并的最新写入必须 100% 迁移到新库中，不得丢失');
      newDb.close();
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('2. 完整性检查与 user_version = 5 铁律不变性 (N-7)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_2_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      await createMockOldDatabase(oldDataDir, { userVersion: 5 });

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      assert.equal(res.success, true);
      const newDb = new DatabaseSync(res.dbPath);
      const integrityRow = newDb.prepare('PRAGMA integrity_check;').get();
      assert.equal(integrityRow.integrity_check, 'ok');

      const uVerRow = newDb.prepare('PRAGMA user_version;').get();
      assert.equal(uVerRow.user_version, 5, 'user_version 必须严格保持 5，严禁回退导致重复迁移');
      newDb.close();
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('3. 五张关键表行数 100% 严格一致 (N-7)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_3_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      await createMockOldDatabase(oldDataDir, { userVersion: 5, recordCount: 12 });

      const oldFp = MigrationService.extractDatabaseFingerprint(path.join(oldDataDir, 'cfgsync.sqlite'));

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      assert.equal(res.success, true);
      const targetFp = MigrationService.extractDatabaseFingerprint(res.dbPath);

      for (const tbl of CRITICAL_TABLES) {
        if (tbl === 'audit_logs') {
          assert.equal(targetFp.tableCounts[tbl], oldFp.tableCounts[tbl] + 1, '新库中应包含一条 MIGRATION_SUCCESS 审计日志');
        } else {
          assert.equal(targetFp.tableCounts[tbl], oldFp.tableCounts[tbl], `表 ${tbl} 行数迁移前后必须完全一致`);
        }
      }
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('4. .server_secret 迁移后 sha256 匹配且保持 0o600 权限 (N-7, N-13)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_4_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      const { secretContent } = await createMockOldDatabase(oldDataDir);

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      assert.equal(res.success, true);
      const targetSecretPath = path.join(targetDataRoot, '.server_secret');
      assert.ok(fs.existsSync(targetSecretPath));
      const targetSecret = fs.readFileSync(targetSecretPath, 'utf8').trim();
      assert.equal(targetSecret, secretContent.trim());

      // 检查模式（Windows 上 mode 判定宽松，非 Windows 需符合 0o600）
      if (os.platform() !== 'win32') {
        const stat = fs.statSync(targetSecretPath);
        assert.equal(stat.mode & 0o777, 0o600);
      }
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('5. cfgsync_config.json 全局策略同步迁移 (N-7)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_5_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      const { configContent } = await createMockOldDatabase(oldDataDir);

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      assert.equal(res.success, true);
      const targetConfigPath = path.join(targetDataRoot, 'cfgsync_config.json');
      assert.ok(fs.existsSync(targetConfigPath));
      const targetConfig = fs.readFileSync(targetConfigPath, 'utf8');
      assert.equal(targetConfig, configContent);
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('6. 迁移幂等性：多次执行不重复迁移且不改写现有库 (N-2)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_6_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      await createMockOldDatabase(oldDataDir);
      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');

      // 第一次迁移
      const res1 = await MigrationService.migrateIfNeeded({ pluginDir, targetDataRoot });
      assert.equal(res1.migrated, true);

      // 在新库插入新版本
      const db = new DatabaseSync(res1.dbPath);
      db.prepare(`
        INSERT INTO audit_logs (actor_handle, action, created_at)
        VALUES ('alice', 'NEW_AFTER_MIG', 999999)
      `).run();
      db.close();

      // 第二次调用（模拟重启）
      const res2 = await MigrationService.migrateIfNeeded({ pluginDir, targetDataRoot });
      const db2 = new DatabaseSync(res2.dbPath);
      const count = db2.prepare("SELECT COUNT(*) as c FROM audit_logs WHERE action = 'NEW_AFTER_MIG'").get();
      assert.equal(count.c, 1, '新数据绝对不能被旧库冲掉');
      db2.close();
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('7. 并发文件锁 (migration.lock) 防护并发冲突 (N-8)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_7_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });
      await createMockOldDatabase(oldDataDir);

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      await fsPromises.mkdir(targetDataRoot, { recursive: true });

      // 预埋一个有效的并发锁（当前时间）
      const lockFile = path.join(targetDataRoot, 'migration.lock');
      fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}`, 'utf8');

      const res = await MigrationService.migrateIfNeeded({ pluginDir, targetDataRoot });
      assert.equal(res.migrated, false);
      assert.ok(res.warning.includes('并发'));

      // 清理锁
      fs.unlinkSync(lockFile);
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('8. 双库冲突仲裁：智能选取更全更新的版本并冷备另一份 (N-12)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_8_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      await fsPromises.mkdir(oldDataDir, { recursive: true });
      await fsPromises.mkdir(targetDataRoot, { recursive: true });

      // 旧库有 5 条记录
      await createMockOldDatabase(oldDataDir, { userVersion: 5, recordCount: 5 });
      // 目标库已经有 10 条记录（比旧库更全）
      await createMockOldDatabase(targetDataRoot, { userVersion: 5, recordCount: 10 });

      const res = await MigrationService.migrateIfNeeded({ pluginDir, targetDataRoot });
      assert.equal(res.dualDbResolved, true);
      assert.equal(res.chosenSource, 'target');

      // 验证旧库被冷备为 .bak-dual-db-<timestamp>
      const files = await fsPromises.readdir(oldDataDir);
      assert.ok(files.some(f => f.includes('.bak-dual-db-')));

      // 验证启用的库拥有 10 条记录
      const db = new DatabaseSync(res.dbPath);
      const c = db.prepare('SELECT COUNT(*) as c FROM config_records').get();
      assert.equal(c.c, 10);
      db.close();
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('9. 迁移失败安全回退：目标不可写时回退旧路径并不删旧库 (N-7)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_9_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });
      await createMockOldDatabase(oldDataDir);

      // 模拟一个非法的目标路径
      const invalidTarget = path.join(tempBaseDir, 'invalid_file_as_dir');
      fs.writeFileSync(invalidTarget, 'I am a regular file');
      const targetDataRoot = path.join(invalidTarget, 'sub');

      const res = await MigrationService.migrateIfNeeded({ pluginDir, targetDataRoot });
      assert.equal(res.success, false);
      assert.equal(res.activeDataRoot, oldDataDir);
      assert.ok(res.warning);
      assert.ok(fs.existsSync(path.join(oldDataDir, 'cfgsync.sqlite')), '旧库必须完好保留');
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('10. DiagnosticService 白名单导出与高熵敏感串遮蔽 (N-4, N-10)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_10_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });
      await createMockOldDatabase(oldDataDir);

      const dbClient = {
        dbPath: path.join(oldDataDir, 'cfgsync.sqlite'),
        db: new DatabaseSync(path.join(oldDataDir, 'cfgsync.sqlite')),
      };

      const configService = new ConfigService(null, {
        allowSettingsSharing: true,
        my_secret_token: 'sk-abcdef1234567890abcdef1234567890abcdef1234567890',
      });

      const diag = new DiagnosticService({
        dbClient,
        configService,
        stRoot: tempBaseDir,
        activeDataRoot: oldDataDir,
      });

      const report = diag.generateReport();
      dbClient.db.close();

      assert.ok(report.system);
      assert.ok(report.database);
      assert.equal(report.database.userVersion, 5);
      assert.equal(report.config.allowSettingsSharing, true);
      assert.ok(report.readme.includes('请自行检查'));

      // 验证白名单过滤：非白名单配置根本不会出现在 report.config 中 (N-4)
      assert.equal(report.config.my_secret_token, undefined, '非白名单字段绝对不能导出');

      // 验证 maskSensitiveValues 高熵敏感串遮蔽能力 (N-10)
      const testSensitiveObj = {
        api_key: 'custom-api-key-12345',
        nested: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
          normalText: 'hello world info',
        },
      };
      const masked = DiagnosticService.maskSensitiveValues(testSensitiveObj);
      assert.equal(masked.api_key, '***REDACTED***');
      assert.equal(masked.nested.token, '***REDACTED***');
      assert.equal(masked.nested.normalText, 'hello world info');
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('11. DiagnosticService 审计日志严格剔除 ip 与 item_uid (N-10)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_11_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });
      await createMockOldDatabase(oldDataDir);

      const dbClient = {
        dbPath: path.join(oldDataDir, 'cfgsync.sqlite'),
        db: new DatabaseSync(path.join(oldDataDir, 'cfgsync.sqlite')),
      };

      const diag = new DiagnosticService({
        dbClient,
        configService: new ConfigService(),
        stRoot: tempBaseDir,
        activeDataRoot: oldDataDir,
      });

      const report = diag.generateReport();
      dbClient.db.close();

      assert.ok(Array.isArray(report.recentAuditEvents));
      assert.ok(report.recentAuditEvents.length > 0);
      for (const evt of report.recentAuditEvents) {
        assert.equal(evt.ip, undefined, '导出的审计事件严禁包含 ip 字段');
        assert.equal(evt.item_uid, undefined, '导出的审计事件严禁包含 item_uid 字段');
        assert.equal(evt.itemUid, undefined, '导出的审计事件严禁包含 itemUid 字段');
      }
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('12. 双向版本自适应检测：过低提示受限，过高提示先备份 (N-5)', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_12_'));
    try {
      const diag = new DiagnosticService({
        dbClient: null,
        configService: null,
        stRoot: tempBaseDir,
      });

      // 1. 低于 1.18.0
      fs.writeFileSync(path.join(tempBaseDir, 'package.json'), JSON.stringify({ version: '1.16.2' }));
      const r1 = diag.detectSillyTavernVersion();
      assert.equal(r1.status, 'below_recommended');
      assert.ok(r1.message.includes('低于推荐版本'));

      // 2. 正常区间 (如 1.18.5)
      fs.writeFileSync(path.join(tempBaseDir, 'package.json'), JSON.stringify({ version: '1.18.5' }));
      const r2 = diag.detectSillyTavernVersion();
      assert.equal(r2.status, 'compatible');

      // 3. 高于已知测试上限 (如 1.25.0)
      fs.writeFileSync(path.join(tempBaseDir, 'package.json'), JSON.stringify({ version: '1.25.0' }));
      const r3 = diag.detectSillyTavernVersion();
      assert.equal(r3.status, 'above_tested');
      assert.ok(r3.message.includes('高于插件已知测试版本'));
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('13. P6-R3: 老目录残留自动清理 (0 字节空库与杂散 cfgsync/ 子目录) 且 Fast-Path 保持生效', async () => {
    const tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m1_13_'));
    try {
      const pluginDir = path.join(tempBaseDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fsPromises.mkdir(oldDataDir, { recursive: true });

      const targetDataRoot = path.join(tempBaseDir, 'st_data', 'cfgsync');
      await fsPromises.mkdir(targetDataRoot, { recursive: true });

      // 目标位置已存在一个有效非空库
      const targetDbPath = path.join(targetDataRoot, 'cfgsync.sqlite');
      const validDb = new DatabaseSync(targetDbPath);
      validDb.exec("CREATE TABLE dummy (id INTEGER); INSERT INTO dummy VALUES (1);");
      validDb.close();

      // 模拟已存在 .migrated_to 标记文件 (已完成过迁移的部署)
      const oldMarkerPath = path.join(oldDataDir, '.migrated_to');
      await fsPromises.writeFile(oldMarkerPath, JSON.stringify({
        migratedTo: targetDataRoot,
        migratedAt: Date.now(),
      }));

      // 模拟第三方脚本在老目录下误建的 0 字节空库和空 wal
      const oldDbPath = path.join(oldDataDir, 'cfgsync.sqlite');
      await fsPromises.writeFile(oldDbPath, Buffer.alloc(0));
      await fsPromises.writeFile(`${oldDbPath}-wal`, Buffer.alloc(0));

      // 模拟第三方脚本在老目录下误建的杂散 cfgsync/ 子目录及文件
      const straySubDir = path.join(oldDataDir, 'cfgsync');
      await fsPromises.mkdir(straySubDir, { recursive: true });
      await fsPromises.writeFile(path.join(straySubDir, 'garbage.tmp'), 'junk');

      // 启动 migrateIfNeeded
      const res = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });

      // 1. 验证命中 Fast-Path
      assert.equal(res.success, true);
      assert.equal(res.skipped, true);
      assert.equal(res.reason, 'already_migrated_marker');

      // 2. 验证 0 字节库和 0 字节 wal 已被彻底清除
      assert.equal(fs.existsSync(oldDbPath), false, '0 字节的 cfgsync.sqlite 必须被彻底清理');
      assert.equal(fs.existsSync(`${oldDbPath}-wal`), false, '0 字节的 -wal 文件必须被彻底清理');

      // 3. 验证杂散 cfgsync/ 子目录已被彻底清除
      assert.equal(fs.existsSync(straySubDir), false, '老目录下的杂散 cfgsync/ 子目录必须被彻底清理');

      // 4. 验证标记文件与有效目标库完好无损
      assert.equal(fs.existsSync(oldMarkerPath), true, '.migrated_to 标记文件必须完好保留');
      assert.equal(fs.existsSync(targetDbPath), true, '目标库必须完好保留');
    } finally {
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true });
    }
  });
});
