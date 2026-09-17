import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';

import { LocalPathStorageDriver } from '../../src/server/storage/LocalPathStorageDriver.js';
import { WebDavStorageDriver } from '../../src/server/storage/WebDavStorageDriver.js';
import { StorageMirrorService } from '../../src/server/services/StorageMirrorService.js';
import { MigrationService } from '../../src/server/services/MigrationService.js';
import { DiskGuard, InsufficientStorageError } from '../../src/server/utils/DiskGuard.js';
import { DisasterRecoveryService } from '../../src/server/services/DisasterRecoveryService.js';
import { SchedulerService } from '../../src/server/services/SchedulerService.js';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { DeterministicZip } from '../../src/server/utils/DeterministicZip.js';
import { createPluginRouter } from '../../src/server/routes/router.js';

test('Phase 6 Milestone 3: 容灾备份、外部驱动镜像与断电自愈调度器 (M3 专项套件)', async (t) => {
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m3_'));
  const dbPath = path.join(tempBase, 'cfgsync.sqlite');
  const dbClient = new DatabaseClient(dbPath);
  const snapshotStore = new SnapshotStore();
  const auditService = new AuditService(dbClient);
  const configPath = path.join(tempBase, 'cfgsync_config.json');
  const configService = new ConfigService(configPath);
  const authService = new AuthorizationService(dbClient, configService);
  const adapters = createP0Adapters();

  t.after(async () => {
    try {
      dbClient.close();
      await fs.rm(tempBase, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. LocalPathStorageDriver: 目录写入、读取、路径穿越防护与错误安全隔离', async () => {
    const mirrorRoot = path.join(tempBase, 'local_mirror');
    const driver = new LocalPathStorageDriver({ basePath: mirrorRoot, enabled: true });

    // 写入与读取
    const content = Buffer.from('hello local mirror');
    const writeRes = await driver.write('test/dir/sample.txt', content);
    assert.strictEqual(writeRes.success, true);
    assert.ok(writeRes.path);

    const readBuf = await driver.read('test/dir/sample.txt');
    assert.ok(readBuf);
    assert.strictEqual(readBuf.toString('utf8'), 'hello local mirror');

    // 路径穿越防御 (Path traversal protection)
    const badRes = await driver.write('../../../etc/evil.txt', Buffer.from('attack'));
    assert.strictEqual(badRes.success, false);
    assert.match(badRes.error, /Path traversal denied/);

    // 驱动健康检查
    const health = await driver.checkHealth();
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(health.path, mirrorRoot);

    // 禁用态
    driver.updateConfig({ enabled: false });
    const disabledRes = await driver.write('test.txt', content);
    assert.strictEqual(disabledRes.success, false);
  });

  await t.test('2. WebDavStorageDriver: 三态精准错误诊断 (AUTH_FAILED / NOT_FOUND / NETWORK_TIMEOUT)', () => {
    const driver = new WebDavStorageDriver({ url: 'http://127.0.0.1:9999/webdav', enabled: true });

    // 1) 401 / 403 -> AUTH_FAILED
    const authDiag401 = driver.diagnoseError(null, 401);
    assert.strictEqual(authDiag401.code, 'AUTH_FAILED');
    const authDiag403 = driver.diagnoseError(null, 403);
    assert.strictEqual(authDiag403.code, 'AUTH_FAILED');

    // 2) 404 -> NOT_FOUND
    const notFoundDiag = driver.diagnoseError(null, 404);
    assert.strictEqual(notFoundDiag.code, 'NOT_FOUND');

    // 3) Timeout / Connection error -> NETWORK_TIMEOUT
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const timeoutDiag = driver.diagnoseError(abortErr);
    assert.strictEqual(timeoutDiag.code, 'NETWORK_TIMEOUT');

    const connectErr = new Error('fetch failed');
    const connDiag = driver.diagnoseError(connectErr);
    assert.strictEqual(connDiag.code, 'NETWORK_TIMEOUT');
  });

  await t.test('3. DiskGuard: 动态阈值 max(50MB, payload * 3) 与 507 异常抛出 (N-9, #10, #24)', () => {
    // 待写 10MB -> threshold = max(50MB, 30MB) = 50MB
    const payload10MB = 10 * 1024 * 1024;
    assert.throws(
      () => DiskGuard.checkSpace(tempBase, payload10MB, 40 * 1024 * 1024), // 可用 40MB < 50MB
      (err) => {
        assert.strictEqual(err.name, 'InsufficientStorageError');
        assert.strictEqual(err.status, 507);
        assert.strictEqual(err.code, 'INSUFFICIENT_STORAGE');
        assert.strictEqual(err.requiredBytes, 50 * 1024 * 1024);
        assert.strictEqual(err.availableBytes, 40 * 1024 * 1024);
        return true;
      }
    );

    // 待写 30MB -> threshold = max(50MB, 90MB) = 90MB
    const payload30MB = 30 * 1024 * 1024;
    assert.throws(
      () => DiskGuard.checkSpace(tempBase, payload30MB, 80 * 1024 * 1024), // 可用 80MB < 90MB
      (err) => {
        assert.strictEqual(err.status, 507);
        assert.strictEqual(err.requiredBytes, 90 * 1024 * 1024);
        return true;
      }
    );

    // 空间充足时安全放行
    const res = DiskGuard.checkSpace(tempBase, payload10MB, 100 * 1024 * 1024);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.requiredBytes, 50 * 1024 * 1024);
  });

  await t.test('4. SyncService.push 集成 DiskGuard: 空间不足阻断 (507) 与空间充足后外部镜像异步落地', async () => {
    const mirrorRoot = path.join(tempBase, 'sync_mirror');
    const localDriver = new LocalPathStorageDriver({ basePath: mirrorRoot, enabled: true });
    const storageMirror = new StorageMirrorService({ localDriver });
    const sync = new SyncService(dbClient, adapters, snapshotStore, authService, configService, 10, storageMirror);
    sync.dataRoot = tempBase;

    const userDirs = {
      handle: 'test_disk_user',
      user: path.join(tempBase, 'data', 'test_disk_user'),
      settings: path.join(tempBase, 'data', 'test_disk_user', 'settings.json'),
    };
    await fs.mkdir(path.dirname(userDirs.settings), { recursive: true });
    await fs.writeFile(userDirs.settings, JSON.stringify({ test: 123 }));

    // 模拟磁盘空间不足 (不足 50MB)
    sync.mockAvailableBytes = 10 * 1024 * 1024;
    await assert.rejects(
      async () => {
        await sync.push({
          authContext: { handle: 'test_disk_user', role: 'admin', directories: userDirs },
          ownerHandle: 'test_disk_user',
          contentType: 'settings',
          itemUid: 'settings',
          baseVersion: 0,
          clientId: 'cli-1',
        });
      },
      (err) => {
        assert.strictEqual(err.name, 'InsufficientStorageError');
        assert.strictEqual(err.status, 507);
        return true;
      }
    );

    // 恢复正常空间 (100MB)
    sync.mockAvailableBytes = 100 * 1024 * 1024;
    const pushRes = await sync.push({
      authContext: { handle: 'test_disk_user', role: 'admin', directories: userDirs },
      ownerHandle: 'test_disk_user',
      contentType: 'settings',
      itemUid: 'settings',
      baseVersion: 0,
      clientId: 'cli-1',
    });
    assert.strictEqual(pushRes.version, 1);
    assert.ok(pushRes.checksum);

    // 等待后台异步镜像落地
    await new Promise(resolve => setTimeout(resolve, 50));
    const mirrored = await localDriver.read(`blobs/test_disk_user/settings/settings/v1.json`);
    assert.ok(mirrored);
    const parsed = JSON.parse(mirrored.toString('utf8'));
    assert.strictEqual(parsed.test, 123);
  });

  await t.test('5. DisasterRecoveryService: 导出全量灾备 ZIP (含 manifest.json 与 Blobs)', async () => {
    const drService = new DisasterRecoveryService({ dbClient, snapshotStore, auditService });
    const exportResult = await drService.exportBackup('test_disk_user');

    assert.ok(Buffer.isBuffer(exportResult.buffer));
    assert.ok(exportResult.fileName.includes('cfgsync-backup-test_disk_user'));
    assert.ok(exportResult.recordCount >= 1);
    assert.ok(exportResult.versionCount >= 1);

    // 解包检验 manifest 与 blob 内容
    const entries = DeterministicZip.unpack(exportResult.buffer);
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    assert.ok(manifestEntry);
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    assert.strictEqual(manifest.version, 1);
    assert.strictEqual(manifest.target_owner, 'test_disk_user');
    assert.ok(manifest.records.some(r => r.content_type === 'settings'));

    const blobEntry = entries.find(e => e.name.startsWith('blobs/test_disk_user/settings/'));
    assert.ok(blobEntry);
    assert.ok(blobEntry.data.length > 0);
  });

  await t.test('6. DisasterRecoveryService: 零静默覆盖安全导入与历史版本保留 (#8 验收)', async () => {
    const drService = new DisasterRecoveryService({ dbClient, snapshotStore, auditService });
    const exportResult = await drService.exportBackup('test_disk_user');

    // 1) 首次原样重复导入 -> 幂等 (identical)
    const importRes1 = await drService.importBackup(exportResult.buffer, 'test_disk_user');
    assert.strictEqual(importRes1.success, true);
    assert.strictEqual(importRes1.conflictCount, 0);
    assert.strictEqual(importRes1.details[0].status, 'identical');

    // 2) 构造有差异的快照 ZIP (模拟异地导入同名但内容修改的配置)
    const entries = DeterministicZip.unpack(exportResult.buffer);
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    // 修改 checksum
    manifest.records[0].current_checksum = 'diff_checksum_12345';
    manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

    const modifiedZip = DeterministicZip.pack(entries);

    // 执行导入：#8 铁律绝不静默覆盖现有数据，而是作为递增新版本入库，保留回滚点
    const importRes2 = await drService.importBackup(modifiedZip, 'test_disk_user');
    assert.strictEqual(importRes2.success, true);
    assert.strictEqual(importRes2.conflictCount, 1);
    assert.strictEqual(importRes2.details[0].status, 'conflict_resolved_as_new_version');
    assert.strictEqual(importRes2.details[0].newVersion, 2);

    // 验证数据库记录现版本升级为 2，并且两版记录都在
    const rec = dbClient.prepare("SELECT * FROM config_records WHERE owner_handle = 'test_disk_user' AND content_type = 'settings'").get();
    assert.strictEqual(rec.current_version, 2);
    assert.strictEqual(rec.current_checksum, 'diff_checksum_12345');
  });

  await t.test('7. SchedulerService: 断电自愈补跑 (Power-off Catch-up Execution) (#11)', async () => {
    let backupRunCount = 0;
    let runReason = null;
    const backupFn = async (reason) => {
      backupRunCount++;
      runReason = reason;
      return { success: true };
    };

    // 配置为启用，且上次执行时间为 48 小时前 (远大于 24 小时周期)
    const fortyEightHoursAgo = Date.now() - 48 * 60 * 60 * 1000;
    configService.set('schedulerEnabled', true);
    configService.set('schedulerIntervalMs', 24 * 60 * 60 * 1000);
    configService.set('lastScheduledBackupAt', fortyEightHoursAgo);

    const scheduler = new SchedulerService({ configService, auditService, backupFn });
    const startResult = await scheduler.start();

    assert.strictEqual(startResult.started, true);
    assert.strictEqual(startResult.catchupTriggered, true);
    assert.strictEqual(backupRunCount, 1);
    assert.strictEqual(runReason, 'power_off_catchup');

    // 验证更新了 lastScheduledBackupAt
    assert.ok(scheduler.lastRunAt > fortyEightHoursAgo);

    scheduler.stop();
  });

  await t.test('8. Router 端点测试: GET /backup/export, POST /backup/import, GET /storage/health 与 507 错误格式', async () => {
    const drService = new DisasterRecoveryService({ dbClient, snapshotStore, auditService });
    const localDriver = new LocalPathStorageDriver({ basePath: path.join(tempBase, 'health_test'), enabled: true });
    const storageMirror = new StorageMirrorService({ localDriver });
    const sync = new SyncService(dbClient, adapters, snapshotStore, authService, configService, 10, storageMirror);
    sync.dataRoot = tempBase;

    const router = createPluginRouter({
      syncService: sync,
      authService,
      adapters,
      configService,
      disasterRecoveryService: drService,
      storageMirrorService: storageMirror,
    });

    // 1) 导出备份 GET /backup/export
    const reqMock = {
      method: 'GET',
      url: '/backup/export',
      headers: {},
      authContext: { handle: 'test_disk_user', role: 'admin' },
    };
    let resHeaders = {};
    let resBody = null;
    let resStatus = 200;
    const resMock = {
      setHeader: (k, v) => { resHeaders[k] = v; },
      status: (code) => { resStatus = code; return resMock; },
      send: (data) => { resBody = data; },
      json: (data) => { resBody = data; },
    };

    // 匹配路由处理
    const exportRoute = router.stack.find(s => s.route?.path === '/backup/export');
    assert.ok(exportRoute);
    await new Promise((resolve, reject) => {
      resMock.send = (data) => { resBody = data; resolve(); };
      exportRoute.route.stack[0].handle(reqMock, resMock, reject);
    });

    assert.strictEqual(resHeaders['Content-Type'], 'application/zip');
    assert.ok(Buffer.isBuffer(resBody));

    // 2) 导入备份 POST /backup/import
    const importRoute = router.stack.find(s => s.route?.path === '/backup/import');
    assert.ok(importRoute);
    const reqImportMock = {
      method: 'POST',
      url: '/backup/import',
      headers: {},
      authContext: { handle: 'test_disk_user', role: 'admin' },
      body: resBody,
    };
    let importResBody = null;
    const resImportMock = {
      status: (c) => { resStatus = c; return resImportMock; },
      json: (data) => { importResBody = data; },
    };
    const importHandler = importRoute.route.stack[importRoute.route.stack.length - 1].handle;
    await new Promise((resolve, reject) => {
      resImportMock.json = (data) => { importResBody = data; resolve(); };
      importHandler(reqImportMock, resImportMock, reject);
    });
    assert.strictEqual(importResBody.success, true);

    // 3) 健康检查 GET /storage/health
    const healthRoute = router.stack.find(s => s.route?.path === '/storage/health');
    assert.ok(healthRoute);
    let healthBody = null;
    await new Promise((resolve, reject) => {
      healthRoute.route.stack[0].handle({}, { json: (d) => { healthBody = d; resolve(); } }, reject);
    });
    assert.strictEqual(healthBody.local.enabled, true);
    assert.strictEqual(healthBody.local.healthy, true);

    // 4) 507 错误格式校验 (N-9, #24)
    const errMock = new InsufficientStorageError('Disk full', 1024, 4096);
    let errorStatus = null;
    let errorJson = null;
    const errorHandler = router.stack.find(s => s.handle?.length === 4);
    assert.ok(errorHandler);
    errorHandler.handle(errMock, {}, {
      status: (c) => { errorStatus = c; return { json: (j) => { errorJson = j; } }; },
    }, () => {});

    assert.strictEqual(errorStatus, 507);
    assert.strictEqual(errorJson.error, 'InsufficientStorageError');
    assert.strictEqual(errorJson.code, 'INSUFFICIENT_STORAGE');
    assert.strictEqual(errorJson.availableBytes, 1024);
    assert.strictEqual(errorJson.requiredBytes, 4096);
  });

  await t.test('9. BUG-P6-01: POST /backup/import 原始二进制流通道与异常容错', async () => {
    const drService = new DisasterRecoveryService({ dbClient, snapshotStore, auditService });
    const localDriver = new LocalPathStorageDriver({ basePath: path.join(tempBase, 'health_test_2'), enabled: true });
    const storageMirror = new StorageMirrorService({ localDriver });
    const sync = new SyncService(dbClient, adapters, snapshotStore, authService, configService, 10, storageMirror);
    sync.dataRoot = tempBase;

    const router = createPluginRouter({
      syncService: sync,
      authService,
      adapters,
      configService,
      disasterRecoveryService: drService,
      storageMirrorService: storageMirror,
    });

    const exportRes = await drService.exportBackup('test_disk_user');
    const importRoute = router.stack.find(s => s.route?.path === '/backup/import');
    assert.ok(importRoute);
    const handler = importRoute.route.stack[importRoute.route.stack.length - 1].handle;

    // 1) 原始 Buffer 直接传入
    const reqDirect = {
      method: 'POST',
      url: '/backup/import',
      headers: { 'content-type': 'application/octet-stream' },
      authContext: { handle: 'test_disk_user', role: 'admin' },
      body: exportRes.buffer,
    };
    let jsonResult = null;
    await new Promise((resolve, reject) => {
      handler(reqDirect, { json: (d) => { jsonResult = d; resolve(); }, status: () => ({ json: resolve }) }, reject);
    });
    assert.strictEqual(jsonResult.success, true);

    // 2) 模拟可读流 (Stream chunks)
    const stream = Readable.from([exportRes.buffer.subarray(0, 100), exportRes.buffer.subarray(100)]);
    const reqStream = {
      method: 'POST',
      url: '/backup/import',
      headers: { 'content-type': 'application/zip' },
      authContext: { handle: 'test_disk_user', role: 'admin' },
      readable: true,
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    };
    let jsonStreamResult = null;
    await new Promise((resolve, reject) => {
      handler(reqStream, { json: (d) => { jsonStreamResult = d; resolve(); }, status: () => ({ json: resolve }) }, reject);
    });
    assert.strictEqual(jsonStreamResult.success, true);

    // 3) 空数据拦截
    let errorStatus = 200;
    let errorJson = null;
    const reqEmpty = {
      method: 'POST',
      url: '/backup/import',
      headers: {},
      authContext: { handle: 'test_disk_user', role: 'admin' },
      body: Buffer.alloc(0),
    };
    await new Promise((resolve, reject) => {
      handler(reqEmpty, {
        status: (c) => { errorStatus = c; return { json: (j) => { errorJson = j; resolve(); } }; },
        json: (j) => { errorJson = j; resolve(); },
      }, reject);
    });
    assert.strictEqual(errorStatus, 400);
    assert.match(errorJson.message, /ZIP body is required/);
  });

  await t.test('10. BUG-P6-04: LocalPathStorageDriver checkHealth 超时防护 (<= 3s) 与非阻塞降级', async () => {
    const driver = new LocalPathStorageDriver({ basePath: path.join(tempBase, 'timeout_test'), enabled: true });

    // 模拟挂起/超时的文件系统调用 (如挂起的写操作)
    const origWriteFile = fsSync.promises.writeFile;
    try {
      fsSync.promises.writeFile = () => new Promise(resolve => setTimeout(resolve, 500));
      const start = Date.now();
      const health = await driver.checkHealth(50); // 设置 50ms 超时
      const duration = Date.now() - start;

      assert.strictEqual(health.healthy, false);
      assert.strictEqual(health.code, 'TIMEOUT');
      assert.ok(duration < 450, `Health check should return quickly on timeout, took ${duration}ms`);
    } finally {
      fsSync.promises.writeFile = origWriteFile;
    }
  });

  await t.test('11. BUG-P6-03: LocalPathStorageDriver 容器环境检测与绝对路径解析', async () => {
    const testPath = './some_relative_path';
    const driver = new LocalPathStorageDriver({ basePath: testPath, enabled: true });

    // 无论输入相对还是绝对路径，resolvedPath 始终为标准化绝对路径
    assert.ok(path.isAbsolute(driver.resolvedPath));

    // 测试容器环境判断
    const isContainer = driver.isContainerEnvironment();
    assert.strictEqual(typeof isContainer, 'boolean');

    // 模拟容器环境下健康检查
    const origDetect = driver.isContainerEnvironment;
    try {
      driver.isContainerEnvironment = () => true;
      const health = await driver.checkHealth(1000);
      assert.strictEqual(health.isContainer, true);
      assert.ok(health.containerWarning);
      assert.match(health.containerWarning, /Docker/);
    } finally {
      driver.isContainerEnvironment = origDetect;
    }
  });

  await t.test('12. P6-R2: MigrationService .migrated_to 标记文件写入与二次启动 Fast-Path 跳过', async () => {
    const mTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_marker_test_'));
    try {
      const pluginDir = path.join(mTestDir, 'plugin');
      const oldDataDir = path.join(pluginDir, 'data');
      await fs.mkdir(oldDataDir, { recursive: true });

      // 创建测试旧库
      const oldDbPath = path.join(oldDataDir, 'cfgsync.sqlite');
      const oldDb = new DatabaseClient(oldDbPath);
      oldDb.prepare("CREATE TABLE IF NOT EXISTS config_records (id INTEGER PRIMARY KEY);").run();
      oldDb.close();

      const targetDataRoot = path.join(mTestDir, 'st_data', 'cfgsync');

      // 第一次运行迁移
      const res1 = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.migrated, true);

      // 验证生成了 .migrated_to 标记文件
      const markerPath = path.join(oldDataDir, '.migrated_to');
      assert.ok(fsSync.existsSync(markerPath), '.migrated_to marker file must exist after migration');
      const markerContent = fsSync.readFileSync(markerPath, 'utf8');
      const marker = JSON.parse(markerContent);
      assert.strictEqual(path.resolve(marker.migratedTo), path.resolve(targetDataRoot));

      // 第二次运行迁移：命中快速跳过
      const res2 = await MigrationService.migrateIfNeeded({
        pluginDir,
        targetDataRoot,
      });
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.skipped, true);
      assert.strictEqual(res2.reason, 'already_migrated_marker');
    } finally {
      await fs.rm(mTestDir, { recursive: true, force: true });
    }
  });

  await t.test('13. P6-R4: 重复导入备份时 importedVersions 精确计数 (已存在版本不虚增)', async () => {
    const drService = new DisasterRecoveryService({ dbClient, snapshotStore, auditService });
    const exportResult = await drService.exportBackup('test_disk_user');

    // 第一次导入：有新记录和新版本入库
    const res1 = await drService.importBackup(exportResult.buffer, 'test_disk_user');
    assert.strictEqual(res1.success, true);

    // 第二次原样导入：因无新版本写入，importedVersions 必须精确为 0
    const res2 = await drService.importBackup(exportResult.buffer, 'test_disk_user');
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.importedVersions, 0, '已存在的历史版本再次导入时，importedVersions 计数必须为 0');
  });
});
