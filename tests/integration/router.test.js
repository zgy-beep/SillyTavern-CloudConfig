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

  await t.test('8. POST /push with null payload reads local file directly', async () => {
    // 写入本地新配置
    await fs.writeFile(path.join(tempDir, 'settings.json'), JSON.stringify({ theme: 'nordic', fontSize: 16 }), 'utf-8');
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: itemUid,
        base_version: 1,
        operation: 'UPSERT',
        payload: null,
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushData = await pushRes.json();
    assert.equal(pushData.version, 2);

    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${itemUid}`);
    const pullData = await pullRes.json();
    assert.equal(pullData.version, 2);
    assert.equal(pullData.content.theme, 'nordic');
    assert.equal(pullData.content.fontSize, 16);
  });

  await t.test('9. GET /pull?apply=true writes content to local disk', async () => {
    // 显式拉取 version 1 并应用到本地
    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${itemUid}&version=1&apply=true`);
    assert.equal(pullRes.status, 200);

    // 检查本地文件是否被更新为 version 1 的内容
    const diskContent = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf-8'));
    assert.equal(diskContent.theme, 'dark');
    assert.equal(diskContent.fontSize, 14);
  });

  await t.test('10. GET /items?scope=cloud&all_owners=true returns items across owners', async () => {
    const res = await fetch(`${baseUrl}/items?content_type=settings&scope=cloud&all_owners=true`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.items.length >= 1);
    assert.equal(data.items[0].owner_handle, 'alice');
    assert.equal(data.items[0].item_uid, itemUid);
  });

  await t.test('11. GET /pull with unauthorized owner is rejected with 403 Forbidden', async () => {
    // 请求者 alice 尝试未授权读取 bob 的设置，必须严格返回 403 Forbidden
    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${itemUid}&owner=bob`);
    assert.equal(pullRes.status, 403);
    const data = await pullRes.json();
    assert.equal(data.error, 'ForbiddenError');
  });

  await t.test('12. GET /owners supports content_type filtering', async () => {
    // 已创建 settings 对象，应包含 alice
    const resSettings = await fetch(`${baseUrl}/owners?content_type=settings`);
    assert.equal(resSettings.status, 200);
    const dataSettings = await resSettings.json();
    assert.deepEqual(dataSettings.owners, ['alice']);

    // 未创建 world 对象且无授权，不应包含 alice
    const resWorld = await fetch(`${baseUrl}/owners?content_type=world`);
    assert.equal(resWorld.status, 200);
    const dataWorld = await resWorld.json();
    assert.deepEqual(dataWorld.owners, []);
  });

  await t.test('13. NEW-04: Non-shareable categories (settings) are never listed in /owners or items?all_owners even with active grants', async () => {
    const bobSettingsUid = makeItemUid('settings', 'bob_settings.json');
    const now = Date.now();

    // 1. bob 拥有一个 settings 云记录
    dbClient.prepare(`
      INSERT INTO config_records (owner_handle, content_type, item_uid, display_name, current_version, current_checksum, updated_at, is_deleted)
      VALUES ('bob', 'settings', :uid, 'Bob Settings', 1, 'dummy_hash', :now, 0)
    `).run({ ':uid': bobSettingsUid, ':now': now });

    // 2. 插入 bob 的 settings 公开/私有 share_grant (模拟异常或历史遗留授权)
    dbClient.prepare(`
      INSERT INTO share_grants (owner_handle, grantee_handle, content_type, scope_type, grant_method, status, created_at)
      VALUES ('bob', NULL, 'settings', 'CONTENT_TYPE', 'DIRECT', 'active', :now)
    `).run({ ':now': now });

    // 3. alice 视角验证：
    // (a) 拉取必须 403 Forbidden
    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${bobSettingsUid}&owner=bob`);
    assert.equal(pullRes.status, 403);

    // (b) items?all_owners=true 不得泄露 bob 的 settings
    const itemsRes = await fetch(`${baseUrl}/items?content_type=settings&scope=cloud&all_owners=true`);
    assert.equal(itemsRes.status, 200);
    const itemsData = await itemsRes.json();
    const itemOwners = itemsData.items.map(i => i.owner_handle);
    assert.ok(itemOwners.includes('alice'));
    assert.ok(!itemOwners.includes('bob'), 'items?all_owners must NOT include bob settings');

    // (c) /owners?content_type=settings 不得列出 bob
    const ownersSettingsRes = await fetch(`${baseUrl}/owners?content_type=settings`);
    assert.equal(ownersSettingsRes.status, 200);
    const ownersSettingsData = await ownersSettingsRes.json();
    assert.deepEqual(ownersSettingsData.owners, ['alice']);

    // (d) /owners (无参数) 因 bob 仅有 settings 授权，也不应将 bob 列为有效共享源
    const ownersAllRes = await fetch(`${baseUrl}/owners`);
    assert.equal(ownersAllRes.status, 200);
    const ownersAllData = await ownersAllRes.json();
    assert.ok(!ownersAllData.owners.includes('bob'), '/owners must not list bob when only settings grant exists');

    // 4. 当 bob 授权了合法可共享类别 (如 openai_preset)
    dbClient.prepare(`
      INSERT INTO share_grants (owner_handle, grantee_handle, content_type, scope_type, grant_method, status, created_at)
      VALUES ('bob', NULL, 'openai_preset', 'CONTENT_TYPE', 'DIRECT', 'active', :now)
    `).run({ ':now': now });

    // /owners (无参数) 现在应当列出 bob
    const ownersAfterPresetRes = await fetch(`${baseUrl}/owners`);
    const ownersAfterPresetData = await ownersAfterPresetRes.json();
    assert.ok(ownersAfterPresetData.owners.includes('bob'));

    // 但 /owners?content_type=settings 依然严格不包含 bob
    const ownersSettingsStillRes = await fetch(`${baseUrl}/owners?content_type=settings`);
    const ownersSettingsStillData = await ownersSettingsStillRes.json();
    assert.deepEqual(ownersSettingsStillData.owners, ['alice']);
  });

  // 关闭服务
  server.close();
  dbClient.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});
