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
import { ShareService } from '../../src/server/services/ShareService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { createP1Adapters } from '../../src/server/adapters/P1Adapters.js';
import { createP2Adapters } from '../../src/server/adapters/P2Adapters.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { computeMessageKey, mergeMessageLists, parseChatJsonl, formatChatJsonl } from '../../src/server/adapters/ChatAdapter.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Phase 5.2 历史记录增量同步 (TC13 ~ TC20, TC23, TC24)', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_p52_test_'));
  const aliceDev1 = path.join(tempDir, 'alice_device1');
  const aliceDev2 = path.join(tempDir, 'alice_device2');
  const bobDir = path.join(tempDir, 'bob_device');

  await fs.mkdir(path.join(aliceDev1, 'chats'), { recursive: true });
  await fs.mkdir(path.join(aliceDev2, 'chats'), { recursive: true });
  await fs.mkdir(path.join(bobDir, 'chats'), { recursive: true });

  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  for (const [k, v] of createP1Adapters()) adapters.set(k, v);
  for (const [k, v] of createP2Adapters()) adapters.set(k, v);

  const snapshotStore = new SnapshotStore({ baseDir: path.join(tempDir, 'blobs') });
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const auditService = new AuditService(dbClient);
  const configService = new ConfigService(null, { maxVersionsByType: { chat: 5, character: 5 } });
  const shareService = new ShareService(dbClient, auditService, configService);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService, configService);

  const app = express();
  app.use(express.json());

  let currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };

  // 模拟 ST 鉴权中间件注入 req.user
  app.use((req, res, next) => {
    req.user = {
      profile: {
        handle: currentRequestUser.handle,
        admin: currentRequestUser.isAdmin,
      },
      directories: {
        user: currentRequestUser.dir,
        chats: path.join(currentRequestUser.dir, 'chats'),
        root: currentRequestUser.dir,
      },
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
    shares: shareService,
  });
  app.use('/api/plugins/cfgsync', pluginRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/plugins/cfgsync`;

  t.after(async () => {
    server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const chatRef = 'Seraphina/2026-09-16 @12h 00m 00s.jsonl';
  const chatUid = makeItemUid('chat', chatRef);

  await t.test('1. TC16: 严格排除 backups/ 与 vectors/ 目录扫描', async () => {
    // 创建正常会话文件
    const normalChatDir = path.join(aliceDev1, 'chats', 'Seraphina');
    await fs.mkdir(normalChatDir, { recursive: true });
    await fs.writeFile(path.join(normalChatDir, '2026-09-16 @12h 00m 00s.jsonl'), '{"user_name":"Alice","character_name":"Seraphina"}\n');

    // 创建应当被严格排除的目录与文件
    const backupsDir = path.join(aliceDev1, 'chats', 'backups');
    const vectorsDir = path.join(aliceDev1, 'chats', 'vectors');
    const charBackupsDir = path.join(normalChatDir, 'backups');
    const charVectorsDir = path.join(normalChatDir, 'vectors');

    await fs.mkdir(backupsDir, { recursive: true });
    await fs.mkdir(vectorsDir, { recursive: true });
    await fs.mkdir(charBackupsDir, { recursive: true });
    await fs.mkdir(charVectorsDir, { recursive: true });

    await fs.writeFile(path.join(backupsDir, 'stray_backup.jsonl'), '{"should":"exclude"}\n');
    await fs.writeFile(path.join(vectorsDir, 'vector_cache.jsonl'), '{"should":"exclude"}\n');
    await fs.writeFile(path.join(charBackupsDir, 'auto_bak.jsonl'), '{"should":"exclude"}\n');
    await fs.writeFile(path.join(charVectorsDir, 'embedded.jsonl'), '{"should":"exclude"}\n');

    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const listRes = await fetch(`${baseUrl}/items?content_type=chat&scope=local`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();

    // 只能扫描出 Seraphina/2026-09-16 @12h 00m 00s.jsonl
    assert.equal(listData.items.length, 1);
    assert.equal(listData.items[0].itemUid, chatUid);
    assert.equal(listData.items[0].sourceRef, chatRef);
  });

  await t.test('2. TC14: 设备追加消息并推送到云端生成完整快照', async () => {
    // 写入完整的初始两轮对话
    const initialJsonl = [
      JSON.stringify({ user_name: 'Alice', character_name: 'Seraphina', chat_metadata: { topic: 'intro' } }),
      JSON.stringify({ name: 'Seraphina', is_user: false, send_date: 1000, mes: 'Hello Alice!', mid: 1 }),
      JSON.stringify({ name: 'Alice', is_user: true, send_date: 2000, mes: 'Hi Seraphina!', mid: 2 }),
    ].join('\n') + '\n';

    const localFilePath = path.join(aliceDev1, 'chats', 'Seraphina', '2026-09-16 @12h 00m 00s.jsonl');
    await fs.writeFile(localFilePath, initialJsonl, 'utf8');

    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        display_name: 'Seraphina / 2026-09-16 @12h 00m 00s',
        base_version: 0,
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushData = await pushRes.json();
    assert.equal(pushData.version, 1);

    // 验证服务端快照为完整的 JSONL 文本快照 (N-4)
    const pullRes = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${chatUid}`);
    assert.equal(pullRes.status, 200);
    const pullData = await pullRes.json();
    assert.equal(pullData.version, 1);
    assert.equal(pullData.content.messages.length, 2);
    assert.equal(pullData.content.metadata.chat_metadata.topic, 'intro');
  });

  await t.test('3. TC13: 两台设备分别对话后同步，按主键并集去重排序，绝不产生副本', async () => {
    // 设备 2 初始拉取云端版本 1
    currentRequestUser = { handle: 'alice', dir: aliceDev2, isAdmin: false };
    const pullApplyRes = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${chatUid}&apply=true`);
    assert.equal(pullApplyRes.status, 200);

    const dev2FilePath = path.join(aliceDev2, 'chats', 'Seraphina', '2026-09-16 @12h 00m 00s.jsonl');
    const dev2Raw = await fs.readFile(dev2FilePath, 'utf8');
    const dev2Parsed = parseChatJsonl(dev2Raw);
    assert.equal(dev2Parsed.messages.length, 2);

    // 场景模拟：
    // 设备 1 追加了一条消息 (send_date: 2500, mid: 3)
    // 设备 2 追加了一条消息 (send_date: 3000, mid: 4)
    const dev1Msg = { name: 'Alice', is_user: true, send_date: 2500, mes: 'Device 1 says hello', mid: 3 };
    const dev2Msg = { name: 'Seraphina', is_user: false, send_date: 3000, mes: 'Device 2 responds', mid: 4 };

    // 设备 1 追加并上传为版本 2
    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const dev1FilePath = path.join(aliceDev1, 'chats', 'Seraphina', '2026-09-16 @12h 00m 00s.jsonl');
    const dev1Current = parseChatJsonl(await fs.readFile(dev1FilePath, 'utf8'));
    dev1Current.messages.push(dev1Msg);
    await fs.writeFile(dev1FilePath, formatChatJsonl(dev1Current.metadata, dev1Current.messages), 'utf8');

    const pushDev1 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        base_version: 1,
      }),
    });
    assert.equal(pushDev1.status, 200);

    // 设备 2 本地也已追加 dev2Msg
    dev2Parsed.messages.push(dev2Msg);
    await fs.writeFile(dev2FilePath, formatChatJsonl(dev2Parsed.metadata, dev2Parsed.messages), 'utf8');

    // 设备 2 从云端拉取版本 2 并应用合并 (apply=true)
    currentRequestUser = { handle: 'alice', dir: aliceDev2, isAdmin: false };
    const pullDev2 = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${chatUid}&apply=true`);
    assert.equal(pullDev2.status, 200);

    // 检查设备 2 的本地合并结果：4 条消息 (1, 2, 3, 4)，按 send_date 升序严格排列
    const dev2Merged = parseChatJsonl(await fs.readFile(dev2FilePath, 'utf8'));
    assert.equal(dev2Merged.messages.length, 4);
    assert.deepEqual(
      dev2Merged.messages.map(m => m.mid),
      [1, 2, 3, 4],
      '消息必须按主键并集去重，且按 send_date 严格排序'
    );

    // 检查目录下只有一个会话文件，绝不产生 (1).jsonl 或 conflict 副本文件 (TC13)
    const filesInDev2 = await fs.readdir(path.join(aliceDev2, 'chats', 'Seraphina'));
    const jsonlFiles = filesInDev2.filter(f => f.endsWith('.jsonl'));
    assert.equal(jsonlFiles.length, 1);
    assert.equal(jsonlFiles[0], '2026-09-16 @12h 00m 00s.jsonl');

    // 检查覆盖前是否正确生成了 .bak 备份
    const bakFiles = filesInDev2.filter(f => f.includes('.bak-'));
    assert.ok(bakFiles.length >= 1, '覆盖本地聊天记录时必须生成 .bak 备份保护');
  });

  await t.test('4. TC15: 同一 mid 在两端各新增 swipe，swipes 数组完整合并', async () => {
    // 在 mid: 2 的消息上，两端各自新增不同的 swipe 分支
    const localMsgs = [
      {
        mid: 2,
        name: 'Seraphina',
        send_date: 2000,
        mes: 'Swipe branch A',
        swipe_id: 1,
        swipes: ['Original message', 'Swipe branch A'],
      },
    ];

    const incomingMsgs = [
      {
        mid: 2,
        name: 'Seraphina',
        send_date: 2000,
        mes: 'Swipe branch B',
        swipe_id: 1,
        swipes: ['Original message', 'Swipe branch B'],
      },
    ];

    const merged = mergeMessageLists(localMsgs, incomingMsgs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].mid, 2);
    // 验证 swipes 数组合并了两个分支全部内容
    assert.deepEqual(merged[0].swipes, ['Original message', 'Swipe branch A', 'Swipe branch B']);
  });

  await t.test('5. TC18: 本地删除单条消息后同步，遵循方案 A 只增不减并准确复原', async () => {
    // 设备 1 目前本地有 3 条消息 (mid: 1, 2, 3)
    // 用户本地删除了 mid: 2，本地此时只剩下 [1, 3]
    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const dev1FilePath = path.join(aliceDev1, 'chats', 'Seraphina', '2026-09-16 @12h 00m 00s.jsonl');
    const dev1Parsed = parseChatJsonl(await fs.readFile(dev1FilePath, 'utf8'));
    dev1Parsed.messages = dev1Parsed.messages.filter(m => m.mid !== 2);
    assert.equal(dev1Parsed.messages.length, 2);
    await fs.writeFile(dev1FilePath, formatChatJsonl(dev1Parsed.metadata, dev1Parsed.messages), 'utf8');

    // 设备 1 从云端同步拉取 (云端含有 mid: 1, 2, 3)
    const pullRes = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${chatUid}&apply=true`);
    assert.equal(pullRes.status, 200);

    // 验证方案 A（只增不减）：本地删除被云端补齐，条数准确回到 3 条，不多不少
    const restored = parseChatJsonl(await fs.readFile(dev1FilePath, 'utf8'));
    assert.equal(restored.messages.length, 3);
    assert.deepEqual(restored.messages.map(m => m.mid), [1, 2, 3]);
  });

  await t.test('6. TC23: 含无 mid 老消息的会话同步 (N-10 合成键与多重集序列号保真)', async () => {
    const legacyFile = 'OldCharacter/legacy_chat.jsonl';
    const legacyUid = makeItemUid('chat', legacyFile);

    const legacyChatDir = path.join(aliceDev1, 'chats', 'OldCharacter');
    await fs.mkdir(legacyChatDir, { recursive: true });

    // 构造无 mid 的老格式会话（含连续相同内容的真实酒馆场景）
    const legacyContent = [
      JSON.stringify({ user_name: 'Alice', character_name: 'OldCharacter' }),
      JSON.stringify({ name: 'OldCharacter', is_user: false, send_date: 5000, mes: 'Legacy greeting' }), // 无 mid
      JSON.stringify({ name: 'Alice', is_user: true, send_date: 6000, mes: 'Same repeat message' }),     // 无 mid
      JSON.stringify({ name: 'Alice', is_user: true, send_date: 6000, mes: 'Same repeat message' }),     // 相同内容与时间的连续消息
    ].join('\n') + '\n';

    await fs.writeFile(path.join(legacyChatDir, 'legacy_chat.jsonl'), legacyContent, 'utf8');

    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const pushLegacy = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: legacyUid,
        base_version: 0,
      }),
    });
    assert.equal(pushLegacy.status, 200);

    // 设备 2 初始同步该老会话
    currentRequestUser = { handle: 'alice', dir: aliceDev2, isAdmin: false };
    const pullLegacy = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${legacyUid}&apply=true`);
    assert.equal(pullLegacy.status, 200);

    const dev2LegacyPath = path.join(aliceDev2, 'chats', 'OldCharacter', 'legacy_chat.jsonl');
    const dev2Legacy = parseChatJsonl(await fs.readFile(dev2LegacyPath, 'utf8'));

    // 验证老消息不丢失、连续同名同内容消息保留 2 条（多重集保真 #1, #2）
    assert.equal(dev2Legacy.messages.length, 3);
    assert.equal(dev2Legacy.messages[0].mes, 'Legacy greeting');
    assert.equal(dev2Legacy.messages[1].mes, 'Same repeat message');
    assert.equal(dev2Legacy.messages[2].mes, 'Same repeat message');

    // 验证合成键独立稳定性
    const occur = new Map();
    const k1 = computeMessageKey(dev2Legacy.messages[1], occur);
    const k2 = computeMessageKey(dev2Legacy.messages[2], occur);
    assert.ok(k1.startsWith('legacy:'));
    assert.ok(k2.startsWith('legacy:'));
    assert.ok(k1.endsWith('#1'));
    assert.ok(k2.endsWith('#2'));
  });

  await t.test('7. TC17: 聊天记录跨账号分享默认返回 400 硬拒 (NON_SHAREABLE_CONTENT_TYPES)', async () => {
    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const shareRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
      }),
    });
    // 聊天记录属于高度隐私资产，跨账号分享必须被拦截
    assert.equal(shareRes.status, 400);
    const errData = await shareRes.json();
    assert.ok(errData.message?.includes('not shareable'));
  });

  await t.test('8. TC19: 聊天会话锁定保护 (pull?apply=true 坚决返回 423 Locked)', async () => {
    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    // 锁定会话
    const lockRes = await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        locked: true,
      }),
    });
    assert.equal(lockRes.status, 200);

    // 拉取并尝试写入本地，必须被 423 Locked 拦截
    const pullLocked = await fetch(`${baseUrl}/pull?content_type=chat&item_uid=${chatUid}&apply=true`);
    assert.equal(pullLocked.status, 423);

    // 解除锁定
    await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        locked: false,
      }),
    });
  });

  await t.test('9. TC20: 角色卡与聊天会话配额与锁定完全独立', async () => {
    const charUid = makeItemUid('character', 'Seraphina.png');

    // 锁定角色卡
    await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'character',
        item_uid: charUid,
        locked: true,
      }),
    });

    // 验证角色卡锁定状态不影响会话锁定状态
    const isChatLocked = syncService.isLocked('alice', 'alice', 'chat', chatUid);
    const isCharLocked = syncService.isLocked('alice', 'alice', 'character', charUid);
    assert.equal(isChatLocked, false);
    assert.equal(isCharLocked, true);
  });

  await t.test('10. TC24: 两台设备同时基于旧版本上传同一会话，CAS 串行化保护 (409 Conflict)', async () => {
    // 当前云端版本为版本 2
    currentRequestUser = { handle: 'alice', dir: aliceDev1, isAdmin: false };
    const pushDev1 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        base_version: 2,
      }),
    });
    assert.equal(pushDev1.status, 200);
    const d1Data = await pushDev1.json();
    assert.equal(d1Data.version, 3);

    // 设备 2 在不知情情况下也基于 base_version: 2 尝试推送，必须被 409 拦截
    currentRequestUser = { handle: 'alice', dir: aliceDev2, isAdmin: false };
    const pushDev2 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'chat',
        item_uid: chatUid,
        base_version: 2,
      }),
    });
    assert.equal(pushDev2.status, 409);
    const errData = await pushDev2.json();
    assert.equal(errData.error, 'Conflict');
    assert.equal(errData.server_version, 3);
  });
});
