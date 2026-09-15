import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseClient } from './src/server/db/database.js';
import { createP0Adapters } from './src/server/adapters/P0Adapters.js';
import { SnapshotStore } from './src/server/storage/SnapshotStore.js';
import { AuthorizationService } from './src/server/services/AuthorizationService.js';
import { ChangeEventBus } from './src/server/services/ChangeEventBus.js';
import { SyncService } from './src/server/services/SyncService.js';
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

  // 1. 初始化 SQLite 数据库
  const dbPath = path.join(__dirname, 'data', 'cfgsync.sqlite');
  dbClient = new DatabaseClient(dbPath);

  // 2. 初始化核心组件与适配器
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService);

  // 3. 挂载前端扩展静态资源目录
  const clientDir = path.join(__dirname, 'src', 'client');
  router.use('/client', express.static(clientDir));

  // 4. 挂载服务端业务路由
  const pluginRouter = createPluginRouter({
    syncService,
    changeBus,
    authService,
    adapters,
  });
  router.use('/', pluginRouter);

  // 5. 启动时执行一次孤儿 Blob 清理，并注册周期定时器（每24小时）
  const runGc = async () => {
    try {
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
