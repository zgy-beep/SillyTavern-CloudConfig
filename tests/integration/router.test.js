import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Express Router Endpoints', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_router_test_'));
  const userDir = path.join(tempDir, 'user_alice');
  await fs.mkdir(userDir, { recursive: true });

  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService);

  const app = express();
  app.use(express.json());

  // 模拟 ST 鉴权中间件注入 req.user
  app.use((req, res, next) => {
    if (req.headers['x-test-no-auth']) {
      return next();
    }
    req.user = {
      profile: { handle: 'alice' },
      directories: { user: userDir, root: tempDir },
    };
    next();
  });

  const pluginRouter = createPluginRouter({ syncService, changeBus, authService, adapters });
  app.use('/api/plugins/cfgsync', pluginRouter);

  // 启动临时 HTTP 服务
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/plugins/cfgsync`;

  const itemUid = makeItemUid('settings', 'settings.json');

  await t.test('1. GET /content-types returns groups, active types and current_user', async () => {
    const res = await fetch(`${baseUrl}/content-types`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.groups.P0.includes('settings'));
    assert.ok(data.activeTypes.includes('settings'));
    assert.equal(data.current_user, 'alice');
  });

  await t.test('2. 401 Unauthorized when auth session is missing', async () => {
    const res = await fetch(`${baseUrl}/content-types`, {
      headers: { 'x-test-no-auth': 'true' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('3. POST /push creates version 1 and GET /pull retrieves it', async () => {
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: itemUid,
        display_name: 'Main Settings',
        base_version: 0,
        operation: 'UPSERT',
        payload: { theme: 'dark', fontSize: 14 },
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushData = await pushRes.json();
    assert.equal(pushData.version, 1);

    // Pull
    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${itemUid}`);
    assert.equal(pullRes.status, 200);
    const pullData = await pullRes.json();
    assert.equal(pullData.version, 1);
    assert.equal(pullData.content.theme, 'dark');
  });

  await t.test('4. POST /push with stale base_version returns 409 Conflict', async () => {
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: itemUid,
        base_version: 0, // 应当冲突（当前已是版本 1）
        operation: 'UPSERT',
        payload: { theme: 'light' },
      }),
    });
    assert.equal(pushRes.status, 409);
    const errData = await pushRes.json();
    assert.equal(errData.error, 'Conflict');
    assert.equal(errData.server_version, 1);
  });

  await t.test('5. GET /changes returns event sequence', async () => {
    const res = await fetch(`${baseUrl}/changes?since=0`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.events.length >= 1);
    assert.equal(data.events[0].item_uid, itemUid);
  });

  await t.test('6. GET /versions returns version history', async () => {
    const res = await fetch(`${baseUrl}/versions?content_type=settings&item_uid=${itemUid}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.versions.length, 1);
    assert.equal(data.versions[0].version, 1);
  });

  await t.test('7. GET /items?scope=local discovers local items from directories', async () => {
    await fs.writeFile(path.join(tempDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf-8');
    const res = await fetch(`${baseUrl}/items?content_type=settings&scope=local`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items));
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].sourceRef, 'settings.json');
  });

  // 关闭服务
  server.close();
  dbClient.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});
