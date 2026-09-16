import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { SseService } from '../../src/server/services/SseService.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';

function createMockResponse() {
  const chunks = [];
  const headers = {};
  let statusCode = 200;
  let finished = false;

  return {
    chunks,
    headers,
    statusCode,
    writeHead: (code, h) => {
      statusCode = code;
      Object.assign(headers, h);
    },
    write: (chunk) => {
      chunks.push(chunk.toString());
      return true;
    },
    flush: () => {},
    flushHeaders: () => {},
    end: () => {
      finished = true;
    },
    isFinished: () => finished,
    getAllOutput: () => chunks.join(''),
  };
}

test('Step 4 & TC11: SSE 实时事件流与反代加固 (P5-7, N-7, N-12)', async (t) => {
  const db = new DatabaseClient(':memory:');
  const configService = new ConfigService();
  const authService = new AuthorizationService(db, configService);
  const changeBus = new ChangeEventBus(db, configService);
  const adapters = createP0Adapters();
  const mockStore = {
    saveBlob: async () => 'blobs/test.bin',
    getBlobStream: async () => null,
    deleteBlob: async () => {},
    commitBlob: async () => {},
  };
  const syncService = new SyncService(db, adapters, mockStore, authService, configService);

  const sseService = new SseService({
    changeBus,
    authService,
    configService,
    heartbeatIntervalMs: 0, // disable auto timer for manual test control
  });

  const pluginRouter = createPluginRouter({
    syncService,
    changeBus,
    authService,
    adapters,
    configService,
    sseService,
  });

  t.after(() => {
    sseService.close();
    db.close();
  });

  await t.test('N-7 / N-12 & TC11: GET /events 下发防缓冲头与即时握手包 (:ok\\n\\n)', async () => {
    const res = createMockResponse();
    const req = {
      headers: {},
      query: {},
      authContext: { handle: 'alice', isAdmin: false },
      on: () => {},
    };

    // 触发 GET /events
    const layer = pluginRouter.stack.find(s => s.route && s.route.path === '/events');
    assert.ok(layer, 'Route /events must exist');

    layer.route.stack[0].handle(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
    assert.equal(res.headers['Connection'], 'keep-alive');
    assert.equal(res.headers['X-Accel-Buffering'], 'no');

    // 首字节确认包
    assert.ok(res.getAllOutput().includes(':ok\n\n'), 'Must flush :ok\\n\\n immediately on connect');
  });

  await t.test('25s 心跳广播 (:heartbeat\\n\\n)', async () => {
    const resAlice = createMockResponse();
    sseService.addClient(resAlice, { handle: 'alice' });

    resAlice.chunks.length = 0; // 清空握手包
    sseService.sendHeartbeat();

    assert.equal(resAlice.getAllOutput(), ':heartbeat\n\n');
  });

  await t.test('TC11 权限隔离：A 的 settings 变动绝不广播给 B；已授权项广播给 B', async () => {
    const resAlice = createMockResponse();
    const resBob = createMockResponse();

    const clientAlice = sseService.addClient(resAlice, { handle: 'alice' });
    const clientBob = sseService.addClient(resBob, { handle: 'bob' });

    resAlice.chunks.length = 0;
    resBob.chunks.length = 0;

    // 1. Alice 推送 settings（黑名单且未开启共享）
    sseService.broadcastEvent({
      seq: 101,
      owner_handle: 'alice',
      content_type: 'settings',
      item_uid: 'global_settings',
      version: 1,
      operation: 'UPSERT',
    });

    // Alice 收到自身变更
    assert.ok(resAlice.getAllOutput().includes('id: 101'), 'Alice must receive own settings event');
    assert.ok(resAlice.getAllOutput().includes('global_settings'));

    // Bob 绝不应收到 Alice 的 settings 事件
    assert.equal(resBob.getAllOutput(), '', 'Bob must NOT receive Alice settings event (strictly isolated)');

    // 2. Alice 推送未授权给 Bob 的 preset
    resAlice.chunks.length = 0;
    resBob.chunks.length = 0;

    sseService.broadcastEvent({
      seq: 102,
      owner_handle: 'alice',
      content_type: 'openai_preset',
      item_uid: 'private_preset',
      version: 1,
      operation: 'UPSERT',
    });

    assert.ok(resAlice.getAllOutput().includes('id: 102'));
    assert.equal(resBob.getAllOutput(), '', 'Bob must NOT receive ungranted preset event');

    // 3. Alice 授权给 Bob 后推送 preset
    db.prepare(`
      INSERT INTO share_grants (
        owner_handle, grantee_handle, scope_type, content_type, item_uid,
        permission, grant_method, status, created_at
      ) VALUES (
        'alice', 'bob', 'ITEM', 'openai_preset', 'shared_preset',
        'read', 'direct', 'active', 1000
      )
    `).run();

    resAlice.chunks.length = 0;
    resBob.chunks.length = 0;

    sseService.broadcastEvent({
      seq: 103,
      owner_handle: 'alice',
      content_type: 'openai_preset',
      item_uid: 'shared_preset',
      version: 2,
      operation: 'UPSERT',
    });

    assert.ok(resAlice.getAllOutput().includes('id: 103'));
    assert.ok(resBob.getAllOutput().includes('id: 103'), 'Bob must receive granted preset event');
    assert.ok(resBob.getAllOutput().includes('shared_preset'));

    sseService.removeClient(clientAlice);
    sseService.removeClient(clientBob);
  });

  await t.test('Last-Event-ID 断线自动补发历史事件', async () => {
    // 写入数据库中的历史变更事件
    changeBus.recordEvent('alice', 'openai_preset', 'preset_hist_1', 1, 'UPSERT');
    const seq2 = changeBus.recordEvent('alice', 'openai_preset', 'preset_hist_2', 2, 'UPSERT');

    const resReconnect = createMockResponse();
    // 客户端带着 Last-Event-ID 重连 (比 seq2 小 1)
    sseService.addClient(resReconnect, { handle: 'alice' }, seq2 - 1);

    const output = resReconnect.getAllOutput();
    assert.ok(output.includes(':ok\n\n'), 'Initial ok packet');
    assert.ok(output.includes(`id: ${seq2}`), 'Must replay missed event with seq2');
    assert.ok(output.includes('preset_hist_2'), 'Must contain missed preset content');
  });
});
