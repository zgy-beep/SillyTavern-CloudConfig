import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseClient } from '../../src/server/db/database.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { ShareService } from '../../src/server/services/ShareService.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Cross-Account Sharing System (Phase 2)', async (t) => {
  // 1. 初始化独立测试数据库与环境
  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient);
  const changeBus = new ChangeEventBus(dbClient);
  const auditService = new AuditService(dbClient);
  const shareService = new ShareService(dbClient, auditService, {
    serverSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService);

  // 2. 构造支持动态 Mock 账号的 Express Server
  const app = express();
  app.use(express.json());

  let mockUser = {
    handle: 'alice',
    directories: { userDir: 'test_alice' },
  };

  app.use((req, res, next) => {
    req.user = {
      profile: { handle: mockUser.handle },
      directories: mockUser.directories,
    };
    next();
  });

  const pluginRouter = createPluginRouter({
    syncService,
    changeBus,
    authService,
    adapters,
    shareService,
    auditService,
  });
  app.use('/', pluginRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const presetUid = makeItemUid('openai_preset', 'story_preset.json');
  const worldbookUid = makeItemUid('world', 'fantasy_lore.json');
  const settingsUid = makeItemUid('settings', 'global_settings.json');

  // 初始化测试数据：alice 拥有 story_preset 与 fantasy_lore
  mockUser = { handle: 'alice', directories: { userDir: 'alice_dir' } };
  await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'openai_preset',
      item_uid: presetUid,
      display_name: 'Story Preset',
      base_version: 0,
      payload: { temperature: 0.7, model: 'gpt-4' },
      client_id: 'alice_client',
    }),
  });

  await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'world',
      item_uid: worldbookUid,
      display_name: 'Fantasy Lore',
      base_version: 0,
      payload: { entries: { 1: { key: 'dragon' } } },
      client_id: 'alice_client',
    }),
  });

  await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'settings',
      item_uid: settingsUid,
      display_name: 'Alice Secret Settings',
      base_version: 0,
      payload: { apiKey: 'secret_123' },
      client_id: 'alice_client',
    }),
  });

  // --- 用例 A: 验证 P0-1 漏洞防复活（安全迁移 + 重启保护） ---
  await t.test('Case A (P0-1): Pending code remains is_public=0 after DB re-init / restart', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.ok(createData.share_code);

    // 检查数据库中新创建的邀请码：必须是 is_public = 0, status = 'pending'
    const codeHash = shareService.hashShareCode(createData.share_code);
    const rowBefore = dbClient.prepare('SELECT is_public, status, grantee_handle FROM share_grants WHERE share_code_hash = :h').get({ ':h': codeHash });
    assert.equal(rowBefore.is_public, 0, 'New pending code must have is_public=0');
    assert.equal(rowBefore.status, 'pending');
    assert.equal(rowBefore.grantee_handle, null);

    // 模拟容器或数据库重连初始化 (PRAGMA user_version 已经为 2)
    dbClient.init();

    // 验证：重启后 is_public 绝不能被误改置为 1
    const rowAfter = dbClient.prepare('SELECT is_public, status FROM share_grants WHERE share_code_hash = :h').get({ ':h': codeHash });
    assert.equal(rowAfter.is_public, 0, 'P0-1 Fix: is_public MUST remain 0 after server restart!');
    assert.equal(rowAfter.status, 'pending');

    // 切换到第三方 bob 视角：拉取严格 403，/owners 不含 alice，/items?all_owners=true 不含该项
    mockUser = { handle: 'bob' };
    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullRes.status, 403, 'Unclaimed pending code must NOT grant public read access');

    const ownersRes = await fetch(`${baseUrl}/owners?content_type=openai_preset`);
    const ownersData = await ownersRes.json();
    assert.ok(!ownersData.owners.includes('alice'), 'Alice must not appear in Bob /owners while code is pending');

    const itemsRes = await fetch(`${baseUrl}/items?content_type=openai_preset&all_owners=true`);
    const itemsData = await itemsRes.json();
    assert.ok(!itemsData.items.some(i => i.item_uid === presetUid && i.owner_handle === 'alice'));
  });

  // --- 用例 B: 验证 P0-2 multi_use 模板模型与多人认领 ---
  await t.test('Case B (P0-2): multi_use code can be claimed by B, C, and D with usage cap', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'world',
        item_uid: worldbookUid,
        code_usage: 'multi_use',
        max_uses: 2, // 最多允许 2 人认领
      }),
    });
    assert.equal(createRes.status, 200);
    const { share_code: multiCode } = await createRes.json();

    // 1. Bob 认领
    mockUser = { handle: 'bob' };
    const claimBobRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: multiCode }),
    });
    assert.equal(claimBobRes.status, 200);
    const claimBobData = await claimBobRes.json();
    assert.equal(claimBobData.success, true);
    assert.equal(claimBobData.already_claimed, false);

    // Bob 应该能拉取配置
    const pullBob = await fetch(`${baseUrl}/pull?content_type=world&item_uid=${worldbookUid}&owner=alice`);
    assert.equal(pullBob.status, 200);

    // 2. Charlie 认领 (multi_use 应该允许第 2 个人成功)
    mockUser = { handle: 'charlie' };
    const claimCharlieRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: multiCode }),
    });
    assert.equal(claimCharlieRes.status, 200);
    const claimCharlieData = await claimCharlieRes.json();
    assert.equal(claimCharlieData.success, true);

    // Charlie 也能拉取
    const pullCharlie = await fetch(`${baseUrl}/pull?content_type=world&item_uid=${worldbookUid}&owner=alice`);
    assert.equal(pullCharlie.status, 200);

    // 3. Dave 尝试第 3 次认领（超过 max_uses = 2 上限）
    mockUser = { handle: 'dave' };
    const claimDaveRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: multiCode }),
    });
    assert.equal(claimDaveRes.status, 400);
    const daveErr = await claimDaveRes.json();
    assert.match(daveErr.message, /maximum uses/);

    // Dave 拉取应为 403
    const pullDave = await fetch(`${baseUrl}/pull?content_type=world&item_uid=${worldbookUid}&owner=alice`);
    assert.equal(pullDave.status, 403);
  });

  // --- 用例 C: 验证 P0-3 账号限速隔离 (A 被锁不影响 B) ---
  await t.test('Case C (P0-3): Account rate limiting locks user A without affecting user B', async () => {
    mockUser = { handle: 'attacker_a' };

    // 连续 4 次错误码
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${baseUrl}/shares/claim-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_code: `WRONG00${i}` }),
      });
      assert.equal(res.status, 400);
    }

    // 第 5 次错误码：触发锁定
    const fifthRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: 'WRONG005' }),
    });
    // 第 5 次记录后，下一次调用必须 429
    const sixthRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: 'WRONG006' }),
    });
    assert.equal(sixthRes.status, 429, 'Account A must be locked with 429');

    // 切换到无辜用户 innocent_b：认领仍然正常，不受 A 的锁定影响
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { share_code: validCode } = await createRes.json();

    mockUser = { handle: 'innocent_b' };
    const innocentClaimRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: validCode }),
    });
    assert.equal(innocentClaimRes.status, 200, 'Innocent B must NOT be affected by Attacker A lock');
  });

  // --- 用例 D: 取消公开分享与定向授权解耦 ---
  await t.test('Case D: Disabling public share revokes public read while preserving claimed grants', async () => {
    // 1. Alice 将 story_preset 设为全服公开
    mockUser = { handle: 'alice' };
    const pubRes = await fetch(`${baseUrl}/shares/quick-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        enabled: true,
      }),
    });
    assert.equal(pubRes.status, 200);

    // 2. 匿名或未认领用户 user_public 可以读取
    mockUser = { handle: 'user_public' };
    const pullPub = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullPub.status, 200);

    // 3. Alice 取消公开分享
    mockUser = { handle: 'alice' };
    const unpubRes = await fetch(`${baseUrl}/shares/quick-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        enabled: false,
      }),
    });
    assert.equal(unpubRes.status, 200);

    // 4. user_public 再次读取立即 403
    mockUser = { handle: 'user_public' };
    const pullAfterUnpub = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullAfterUnpub.status, 403, 'After public share is disabled, public users must get 403');

    // 5. 但之前在 Case C 已经认领过定向授权的 innocent_b 依然能正常读取
    mockUser = { handle: 'innocent_b' };
    const pullInnocent = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullInnocent.status, 200, 'Claimed grant must NOT be affected by public share toggle');
  });

  // --- 用例 E: /audit 端点严格自作用域 ---
  await t.test('Case E: /audit endpoint strictly returns only self-related logs and includes denied events', async () => {
    mockUser = { handle: 'alice' };
    const auditAliceRes = await fetch(`${baseUrl}/audit`);
    assert.equal(auditAliceRes.status, 200);
    const { logs: aliceLogs } = await auditAliceRes.json();
    assert.ok(aliceLogs.length > 0);
    // 所有记录要么 actor 是 alice，要么 target 是 alice
    for (const entry of aliceLogs) {
      assert.ok(entry.actor_handle === 'alice' || entry.target_handle === 'alice');
    }

    mockUser = { handle: 'attacker_a' };
    const auditAttackerRes = await fetch(`${baseUrl}/audit`);
    assert.equal(auditAttackerRes.status, 200);
    const { logs: attackerLogs } = await auditAttackerRes.json();
    // 包含 denied 拦截记录
    assert.ok(attackerLogs.some(l => l.result === 'denied'));
    // 绝不能包含与 attacker_a 无关的 alice 或 bob 操作
    for (const entry of attackerLogs) {
      assert.ok(entry.actor_handle === 'attacker_a' || entry.target_handle === 'attacker_a');
    }
  });

  // --- 用例 1: 幂等性认领测试 ---
  await t.test('Case 1: Re-claiming the same code by same user is idempotent', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { share_code: code } = await createRes.json();

    mockUser = { handle: 'user_idempotent' };
    const firstClaim = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });
    assert.equal(firstClaim.status, 200);
    const firstData = await firstClaim.json();
    assert.equal(firstData.already_claimed, false);

    // 重复提交同一码
    const secondClaim = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });
    assert.equal(secondClaim.status, 200);
    const secondData = await secondClaim.json();
    assert.equal(secondData.already_claimed, true, 'Second claim by same user must return already_claimed: true without 409');
  });

  // --- 用例 2: settings 类别绝对禁止分享与公开 ---
  await t.test('Case 2: settings category strictly rejects code creation and public sharing (400)', async () => {
    mockUser = { handle: 'alice' };
    const createCodeRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
      }),
    });
    assert.equal(createCodeRes.status, 400);

    const publicRes = await fetch(`${baseUrl}/shares/quick-public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
        enabled: true,
      }),
    });
    assert.equal(publicRes.status, 400);
  });

  // --- 用例 3: 撤销分享即时阻断 ---
  await t.test('Case 3: Revoking grant immediately terminates reader access', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { share_code: code, grant_id: grantId } = await createRes.json();

    mockUser = { handle: 'user_revoke_test' };
    await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });

    // 认领后可以读
    const pullBefore = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullBefore.status, 200);

    // Alice 撤销该授权
    mockUser = { handle: 'alice' };
    const revokeRes = await fetch(`${baseUrl}/shares/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_id: grantId }),
    });
    assert.equal(revokeRes.status, 200);

    // user_revoke_test 立即被阻断
    mockUser = { handle: 'user_revoke_test' };
    const pullAfter = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice`);
    assert.equal(pullAfter.status, 403);
  });

  // --- 用例 4: single_use 已被认领后他人认领报 409 ---
  await t.test('Case 4: single_use code claimed by one user returns 409 to another user', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { share_code: code } = await createRes.json();

    mockUser = { handle: 'winner_user' };
    const winClaim = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });
    assert.equal(winClaim.status, 200);

    mockUser = { handle: 'loser_user' };
    const loseClaim = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });
    assert.equal(loseClaim.status, 409);
  });

  // --- 用例 5: outgoing 与 incoming 列表安全性与无哈希泄漏 ---
  await t.test('Case 5: /shares/outgoing and /shares/incoming never leak share_code_hash', async () => {
    mockUser = { handle: 'alice' };
    const outRes = await fetch(`${baseUrl}/shares/outgoing`);
    assert.equal(outRes.status, 200);
    const outData = await outRes.json();
    assert.ok(Array.isArray(outData.shares));
    assert.ok(outData.shares.length > 0);
    for (const s of outData.shares) {
      assert.equal(s.share_code_hash, undefined, 'share_code_hash must NEVER be exposed in outgoing shares');
    }

    mockUser = { handle: 'winner_user' };
    const inRes = await fetch(`${baseUrl}/shares/incoming`);
    assert.equal(inRes.status, 200);
    const inData = await inRes.json();
    assert.ok(Array.isArray(inData.shares));
    assert.ok(inData.shares.some(s => s.owner_handle === 'alice'));
    for (const s of inData.shares) {
      assert.equal(s.share_code_hash, undefined, 'share_code_hash must NEVER be exposed in incoming shares');
    }
  });

  // --- 用例 6: 非所有者为他人对象发码严格 403 ---
  await t.test('Case 6: Non-owner creating share code for another user config returns 403', async () => {
    mockUser = { handle: 'unauthorized_stranger' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    assert.equal(createRes.status, 403);
  });

  // --- 用例 7: 非所有者撤销他人分享严格 404/403 ---
  await t.test('Case 7: Non-owner revoking another user grant returns 404', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { grant_id: grantId } = await createRes.json();

    mockUser = { handle: 'bob' };
    const revokeRes = await fetch(`${baseUrl}/shares/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_id: grantId }),
    });
    assert.equal(revokeRes.status, 404);
  });

  // --- 用例 8: 创建者不能认领自己的邀请码 ---
  await t.test('Case 8: Creator claiming own share code is rejected (400)', async () => {
    mockUser = { handle: 'alice' };
    const createRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        code_usage: 'single_use',
      }),
    });
    const { share_code: code } = await createRes.json();

    const claimSelf = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code }),
    });
    assert.equal(claimSelf.status, 400);
    const data = await claimSelf.json();
    assert.match(data.message, /Cannot claim your own share code/);
  });

  // 关闭服务
  server.close();
  dbClient.close();
});
