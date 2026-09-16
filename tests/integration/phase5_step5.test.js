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
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Step 5 Admin Dashboard and Deduplicated Orphan Cleanup (TC9, TC10, N-8)', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_step5_test_'));
  const aliceDir = path.join(tempDir, 'user_alice');
  const bobDir = path.join(tempDir, 'user_bob');
  const adminDir = path.join(tempDir, 'user_admin');
  await fs.mkdir(aliceDir, { recursive: true });
  await fs.mkdir(bobDir, { recursive: true });
  await fs.mkdir(adminDir, { recursive: true });

  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore({ baseDir: path.join(tempDir, 'blobs') });
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const auditService = new AuditService(dbClient);
  const configService = new ConfigService(dbClient);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService, configService);

  const app = express();
  app.use(express.json());

  let currentRequestUser = { handle: 'alice', isAdmin: false, dir: aliceDir };

  // 模拟 ST 鉴权中间件注入 req.user
  app.use((req, res, next) => {
    req.user = {
      profile: {
        handle: currentRequestUser.handle,
        admin: currentRequestUser.isAdmin,
      },
      directories: { user: currentRequestUser.dir, root: tempDir },
    };
    next();
  });

  const pluginRouter = createPluginRouter({
    syncService,
    changeBus,
    authService,
    adapters,
    configService,
    audit: auditService,
  });
  app.use('/api/plugins/cfgsync', pluginRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/plugins/cfgsync`;

  t.after(async () => {
    server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const sharedContent = { theme: 'dark', fontSize: 14, commonKey: 'same_data_for_dedup' };
  const uid1 = makeItemUid('openai_preset', 'preset1.json');
  const uid2 = makeItemUid('openai_preset', 'preset2.json');

  await t.test('1. Setup initial versions and verify CAS deduplication in storage', async () => {
    // Alice pushes preset1 v1
    currentRequestUser = { handle: 'alice', isAdmin: false, dir: aliceDir };
    const push1 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid1,
        title: 'Alice Preset 1',
        base_version: 0,
        payload: sharedContent,
      }),
    });
    assert.equal(push1.status, 200);

    // Alice pushes preset2 v1 with identical content (should reuse blob in CAS)
    const push2 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid2,
        title: 'Alice Preset 2',
        base_version: 0,
        payload: sharedContent,
      }),
    });
    assert.equal(push2.status, 200);

    // Alice pushes preset2 v2 with different content
    const push3 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid2,
        title: 'Alice Preset 2 v2',
        base_version: 1,
        payload: { theme: 'light', fontSize: 16 },
      }),
    });
    assert.equal(push3.status, 200);

    // Bob pushes preset1 with same sharedContent
    currentRequestUser = { handle: 'bob', isAdmin: false, dir: bobDir };
    const push4 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid1,
        title: 'Bob Preset 1',
        base_version: 0,
        payload: sharedContent,
      }),
    });
    assert.equal(push4.status, 200);
  });

  await t.test('2. TC9: GET /stats permission isolation and N-8 deduplication calculation', async () => {
    // Alice (普通用户) 请求 GET /stats
    currentRequestUser = { handle: 'alice', isAdmin: false, dir: aliceDir };
    const resAlice = await fetch(`${baseUrl}/stats`);
    assert.equal(resAlice.status, 200);
    const dataAlice = await resAlice.json();

    assert.equal(dataAlice.is_admin, false);
    assert.equal(dataAlice.global, null, '普通用户绝不能看到 global 全局看板数据');
    assert.equal(dataAlice.user.handle, 'alice');
    assert.equal(dataAlice.user.total_versions, 3); // preset1 v1, preset2 v1, preset2 v2
    assert.equal(dataAlice.user.active_items, 2);
    assert.equal(dataAlice.user.unique_blobs, 3);
    assert.ok(dataAlice.user.total_logical_bytes > 0);
    assert.ok(dataAlice.user.unique_bytes > 0);

    // Admin 请求 GET /stats
    currentRequestUser = { handle: 'admin', isAdmin: true, dir: adminDir };
    const resAdmin = await fetch(`${baseUrl}/stats`);
    assert.equal(resAdmin.status, 200);
    const dataAdmin = await resAdmin.json();

    assert.equal(dataAdmin.is_admin, true);
    assert.ok(dataAdmin.global !== null, '管理员应当能获取全局存储与看板统计');
    assert.equal(dataAdmin.global.total_users, 2); // alice & bob
    assert.equal(dataAdmin.global.total_versions, 4); // alice 3 + bob 1
    assert.equal(dataAdmin.global.deduplicated_blobs, 4);
    assert.ok(dataAdmin.global.deduplicated_disk_bytes > 0);
    assert.ok(dataAdmin.global.total_logical_bytes > 0);
  });

  await t.test('3. TC10: Two-stage orphan snapshot cleanup (dry_run vs execute & lock preservation)', async () => {
    currentRequestUser = { handle: 'alice', isAdmin: false, dir: aliceDir };

    // 锁定 Alice 的 preset2 v1 (通过 POST /versions/lock)
    const lockRes = await fetch(`${baseUrl}/versions/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid2,
        version: 1,
        locked: true,
      }),
    });
    assert.equal(lockRes.status, 200);

    // 软删除 Alice 的 preset2 (墓碑记录 is_deleted = 1)
    const delRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid2,
        delete_cloud: true,
        delete_local: false,
      }),
    });
    assert.equal(delRes.status, 200);

    // 软删除 Alice 的 preset1
    const delRes2 = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: uid1,
        delete_cloud: true,
        delete_local: false,
      }),
    });
    assert.equal(delRes2.status, 200);

    // Stage 1: dry_run = true (仅分析，不删除任何数据)
    const dryRunRes = await fetch(`${baseUrl}/clean-orphans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    assert.equal(dryRunRes.status, 200);
    const dryRunData = await dryRunRes.json();

    assert.equal(dryRunData.success, true);
    assert.equal(dryRunData.dry_run, true);
    // 候选待清理项中：
    // preset1 v1 (UPSERT, 未锁定) -> 候选
    // preset1 v2 (DELETE 墓碑, 未锁定) -> 候选
    // preset2 v2 (UPSERT, 未锁定) -> 候选
    // preset2 v3 (DELETE 墓碑, 未锁定) -> 候选
    // preset2 v1 (UPSERT, 已锁定 is_locked = 1) -> 必须被严格排除！绝不允许清理！
    assert.equal(dryRunData.candidate_count, 4);
    assert.equal(dryRunData.unique_blobs_count, 2);
    const lockedCandidate = dryRunData.candidates.find(c => c.item_uid === uid2 && c.version === 1);
    assert.equal(lockedCandidate, undefined, '已锁定的版本绝不能出现在清理候选名单中');

    // 验证 DB 依然完整 (Alice 此时有 5 条版本记录：preset1 2条 + preset2 3条)
    const countBefore = dbClient.prepare("SELECT COUNT(*) as c FROM config_versions WHERE owner_handle = 'alice'").get().c;
    assert.equal(countBefore, 5);

    // Stage 2: dry_run = false (正式执行清理)
    const execRes = await fetch(`${baseUrl}/clean-orphans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    });
    assert.equal(execRes.status, 200);
    const execData = await execRes.json();

    assert.equal(execData.success, true);
    assert.equal(execData.dry_run, false);
    assert.equal(execData.deleted_count, 4);

    // 验证数据库：
    // preset2 v1 (已锁定) 依然完好存在！
    const remainingVersions = dbClient.prepare("SELECT version, is_locked FROM config_versions WHERE owner_handle = 'alice' AND item_uid = ?").all(uid2);
    assert.equal(remainingVersions.length, 1);
    assert.equal(remainingVersions[0].version, 1);
    assert.equal(remainingVersions[0].is_locked, 1);

    // 验证 sharedContent 的 blob 仍然被 Bob 和 Alice preset2 v1 引用，绝不能被误删
    currentRequestUser = { handle: 'bob', isAdmin: false, dir: bobDir };
    const bobPull = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${uid1}&owner=bob`);
    assert.equal(bobPull.status, 200);
    const bobData = await bobPull.json();
    assert.deepEqual(bobData.content, sharedContent);

    // 验证 audit_logs 记录了 clean_orphans 审计日志
    const auditRow = dbClient.prepare("SELECT * FROM audit_logs WHERE action = 'clean_orphans' ORDER BY created_at DESC LIMIT 1").get();
    assert.ok(auditRow, '必须产生 clean_orphans 审计记录');
    assert.equal(auditRow.actor_handle, 'alice');
    assert.equal(auditRow.result, 'success');
  });
});
