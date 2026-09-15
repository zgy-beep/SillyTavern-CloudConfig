import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { SyncService, ConflictError } from '../../src/server/services/SyncService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { AuthContext } from '../../src/server/auth/AuthContext.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Full CAS Lifecycle & Concurrency Control', async (t) => {
  // 1. 创建测试环境
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_test_'));
  const userDir = path.join(tempDir, 'user_alice');
  await fs.mkdir(userDir, { recursive: true });

  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService);

  const aliceAuth = new AuthContext('alice', { user: userDir, root: tempDir });
  const bobAuth = new AuthContext('bob', { user: tempDir, root: tempDir });

  const contentType = 'openai_preset';
  const itemUid = makeItemUid(contentType, 'Creative.json');

  // 测试 1: 首次推送创建（base_version = 0）
  await t.test('1. First push creates item at version 1', async () => {
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType,
      itemUid,
      displayName: 'Creative',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { temperature: 0.8, top_p: 0.9 },
      clientId: 'device_A',
    });

    assert.equal(res.version, 1);
    assert.ok(res.checksum);

    // 验证 pull
    const pulled = await syncService.pull(aliceAuth, 'alice', contentType, itemUid);
    assert.equal(pulled.version, 1);
    assert.equal(pulled.content.temperature, 0.8);
    assert.equal(pulled.content.top_p, 0.9);
  });

  // 测试 2: 两台设备同时首次创建同一对象，后到者必定收到 409
  await t.test('2. Simultaneous first push collision results in 409', async () => {
    const dupUid = makeItemUid(contentType, 'Duplicate.json');

    // 模拟设备 A 成功创建
    await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType,
      itemUid: dupUid,
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { value: 'from_A' },
      clientId: 'device_A',
    });

    // 模拟设备 B 以为还不存在，同样以 base_version = 0 提交
    await assert.rejects(
      async () => {
        await syncService.push({
          authContext: aliceAuth,
          ownerHandle: 'alice',
          contentType,
          itemUid: dupUid,
          baseVersion: 0,
          operation: 'UPSERT',
          payload: { value: 'from_B' },
          clientId: 'device_B',
        });
      },
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.status, 409);
        assert.equal(err.serverVersion, 1);
        return true;
      }
    );
  });

  // 测试 3: 并发修改已存在对象，后到者收到 409
  await t.test('3. Concurrent update collision results in 409', async () => {
    // 设备 A 将版本 1 推进到版本 2
    const resA = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType,
      itemUid,
      baseVersion: 1,
      operation: 'UPSERT',
      payload: { temperature: 0.85, top_p: 0.9 },
      clientId: 'device_A',
    });
    assert.equal(resA.version, 2);

    // 设备 B 依然拿旧的 base_version = 1 提交
    await assert.rejects(
      async () => {
        await syncService.push({
          authContext: aliceAuth,
          ownerHandle: 'alice',
          contentType,
          itemUid,
          baseVersion: 1,
          operation: 'UPSERT',
          payload: { temperature: 0.95, top_p: 0.95 },
          clientId: 'device_B',
        });
      },
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.serverVersion, 2);
        return true;
      }
    );
  });

  // 测试 4: 软删除（Tombstone）与防复活
  await t.test('4. Soft delete creates tombstone and prevents resurrection', async () => {
    // 设备 A 执行删除（base_version = 2 -> 3）
    const resDel = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType,
      itemUid,
      baseVersion: 2,
      operation: 'DELETE',
      clientId: 'device_A',
    });
    assert.equal(resDel.version, 3);

    // 删除后 pull 最新版本应返回 404
    await assert.rejects(
      async () => {
        await syncService.pull(aliceAuth, 'alice', contentType, itemUid);
      },
      /deleted|not found/
    );

    // 长期离线设备试图拿版本 1 更新，直接 409 拒绝
    await assert.rejects(
      async () => {
        await syncService.push({
          authContext: aliceAuth,
          ownerHandle: 'alice',
          contentType,
          itemUid,
          baseVersion: 1,
          operation: 'UPSERT',
          payload: { temperature: 1.0 },
          clientId: 'device_offline',
        });
      },
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.serverVersion, 3);
        assert.equal(err.isDeleted, true);
        return true;
      }
    );
  });

  // 测试 5: 回滚至历史版本
  await t.test('5. Rollback restores content via CAS', async () => {
    // 将已删除的对象回滚至版本 2（当前服务器处于版本 3）
    const resRollback = await syncService.rollback({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType,
      itemUid,
      targetVersion: 2,
      baseVersion: 3,
      clientId: 'device_A',
    });
    assert.equal(resRollback.version, 4);

    // 再次 pull，内容应恢复为版本 2 的内容
    const pulled = await syncService.pull(aliceAuth, 'alice', contentType, itemUid);
    assert.equal(pulled.version, 4);
    assert.equal(pulled.content.temperature, 0.85);
  });

  // 测试 6: ChangeEventBus 轮询过滤与去重
  await t.test('6. ChangeEventBus filters by requester and dedups to latest version', () => {
    // Alice 查询自身事件
    const aliceChanges = changeBus.getChanges('alice', 0);
    assert.ok(aliceChanges.events.length > 0);
    // 对 itemUid 只返回最新版本 4
    const itemEvt = aliceChanges.events.find(e => e.item_uid === itemUid);
    assert.ok(itemEvt);
    assert.equal(itemEvt.version, 4);

    // Bob 此时未获授权，查询应为空
    const bobChanges = changeBus.getChanges('bob', 0);
    assert.equal(bobChanges.events.length, 0);
  });

  // 测试 7: 越权写校验（Bob 试图修改 Alice 配置）
  await t.test('7. Unauthorized write is rejected with 403', async () => {
    await assert.rejects(
      async () => {
        await syncService.push({
          authContext: bobAuth,
          ownerHandle: 'alice',
          contentType,
          itemUid,
          baseVersion: 4,
          operation: 'UPSERT',
          payload: { hacker: true },
          clientId: 'device_hacker',
        });
      },
      /ForbiddenError|no write permission/
    );
  });

  // 清理临时目录与数据库
  dbClient.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});
