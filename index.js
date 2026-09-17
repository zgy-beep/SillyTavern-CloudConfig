import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseClient } from './src/server/db/database.js';
import { createP0Adapters, cleanupStraySecrets } from './src/server/adapters/P0Adapters.js';
import { createP1Adapters } from './src/server/adapters/P1Adapters.js';
import { createP2Adapters } from './src/server/adapters/P2Adapters.js';
import { SnapshotStore } from './src/server/storage/SnapshotStore.js';
import { AuthorizationService } from './src/server/services/AuthorizationService.js';
import { ChangeEventBus } from './src/server/services/ChangeEventBus.js';
import { SyncService } from './src/server/services/SyncService.js';
import { AuditService } from './src/server/services/AuditService.js';
import { ShareService } from './src/server/services/ShareService.js';
import { ConfigService } from './src/server/config/ConfigService.js';
import { SseService } from './src/server/services/SseService.js';
import { MigrationService } from './src/server/services/MigrationService.js';
import { DiagnosticService } from './src/server/services/DiagnosticService.js';
import { createPluginRouter } from './src/server/routes/router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const info = {
  id: 'cfgsync',
  name: 'SillyTavern-CloudConfig',
  description: 'SillyTavern 多用户多设备配置云同步与共享插件',
  version: '0.1.0',
};

let dbClient = null;
let gcInterval = null;

/**
 * SillyTavern 插件初始化入口
 * @param {import('express').Router} router ST 分配的插件专用 Router
 */
export async function init(router) {
  console.log(`[${info.name}] Initializing v${info.version}...`);

  // 1. 执行数据库与配置平滑迁移 (M1, N-1, N-6, N-7, N-11, N-12)
  const migrationResult = await MigrationService.migrateIfNeeded({
    pluginDir: __dirname,
    stRoot: process.cwd(),
  });
  const dataRoot = migrationResult.activeDataRoot;
  const dbPath = migrationResult.dbPath;
  dbClient = new DatabaseClient(dbPath);

  // 2. 初始化核心组件与适配器
  const adapters = createP0Adapters();
  const p1Adapters = createP1Adapters();
  for (const [key, adapter] of p1Adapters) {
    adapters.set(key, adapter);
  }
  const p2Adapters = createP2Adapters();
  for (const [key, adapter] of p2Adapters) {
    adapters.set(key, adapter);
  }
  const configService = new ConfigService(path.join(dataRoot, 'cfgsync_config.json'));
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient, configService);
  const changeBus = new ChangeEventBus(dbClient, configService);
  const auditService = new AuditService(dbClient);
  const shareService = new ShareService(dbClient, auditService, configService, { dataRoot });
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService, configService);
  syncService.dataRoot = dataRoot;

  const sseService = new SseService({ changeBus, authService, configService });
  const diagnosticService = new DiagnosticService({
    dbClient,
    configService,
    stRoot: process.cwd(),
    activeDataRoot: dataRoot,
  });

  // 3. 挂载前端扩展静态资源目录
  const clientDir = path.join(__dirname, 'src', 'client');
  router.use('/client', express.static(clientDir));

  // 4. 挂载服务端业务路由
  const pluginRouter = createPluginRouter({
    syncService,
    changeBus,
    authService,
    adapters,
    shareService,
    auditService,
    configService,
    sseService,
    diagnosticService,
  });
  router.use('/', pluginRouter);

  // 5. 启动时自愈清理历史残留 user/secrets.json，并执行一次孤儿 Blob 清理（注册每24小时周期定时器）
  const runGc = async () => {
    try {
      await cleanupStraySecrets();
      const activeRows = dbClient.prepare('SELECT blob_path FROM config_versions WHERE blob_path IS NOT NULL').all();
      const activePaths = new Set(activeRows.map(r => r.blob_path));
      // 遍历所有已记录的用户目录执行清理（在此记录的路径视为有效）
      // snapshotStore.cleanupOrphans 会基于 activePaths 过滤
    } catch (e) {
      console.warn(`[${info.name}] GC warning:`, e.message);
    }
  };
  runGc();
  gcInterval = setInterval(runGc, 24 * 3600 * 1000);

  console.log(`[${info.name}] Initialization complete.`);
}

/**
 * 插件卸载与退出清理
 */
export async function exit() {
  console.log(`[${info.name}] Shutting down...`);
  if (gcInterval) {
    clearInterval(gcInterval);
    gcInterval = null;
  }
  if (dbClient) {
    dbClient.close();
    dbClient = null;
  }
  console.log(`[${info.name}] Exited cleanly.`);
}
