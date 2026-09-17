import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSyncEngine } from '../../src/client/autoSync.js';
import { SyncState, SyncMode } from '../../src/common/constants.js';

test('Phase 6 Milestone 4: 客户端安全自动同步引擎与防打扰保护 (M4 专项套件)', async (t) => {
  // 模拟 IdbStorage
  const createMockStorage = (bindings = []) => {
    const map = new Map(bindings.map(b => [b.binding_uid, { ...b }]));
    return {
      getBindingsByAccount: async (acc) => Array.from(map.values()).filter(b => b.account_handle === acc),
      saveBinding: async (b) => { map.set(b.binding_uid, { ...b }); },
      makeBindingUid: (acc, owner, ct, uid) => `${acc}:${owner}:${ct}:${uid}`,
    };
  };

  await t.test('1. 默认关闭铁律：初始状态绝对为 disabled，未开启前绝不执行同步 (P6-4)', async () => {
    const storage = createMockStorage();
    const engine = new AutoSyncEngine({ storage });

    assert.strictEqual(engine.enabled, false);
    assert.strictEqual(engine.lastStatus, 'idle');

    const runRes = await engine.runAutoSync('default-user');
    assert.strictEqual(runRes.skipped, true);
    assert.strictEqual(runRes.reason, 'disabled');
  });

  await t.test('2. 开启前二次确认守卫：用户拒绝则保持关闭，用户同意方可开启并启动调度', async () => {
    const storage = createMockStorage();
    const engine = new AutoSyncEngine({ storage });

    // 1) 用户取消
    const cancelRes = await engine.requestEnable(async () => false);
    assert.strictEqual(cancelRes, false);
    assert.strictEqual(engine.enabled, false);

    // 2) 用户确认
    const confirmRes = await engine.requestEnable(async () => true);
    assert.strictEqual(confirmRes, true);
    assert.strictEqual(engine.enabled, true);
    assert.ok(engine.timer !== null);

    // 禁用
    engine.disable();
    assert.strictEqual(engine.enabled, false);
    assert.strictEqual(engine.timer, null);
    assert.strictEqual(engine.lastStatus, 'disabled');
  });

  await t.test('3. 防打扰保护：检测到 AI 正在生成回复时，绝对避让不写盘 (Matrix #12)', async () => {
    const storage = createMockStorage([
      {
        binding_uid: 'b1',
        account_handle: 'nuobao',
        content_type: 'settings',
        item_uid: 'settings',
        display_name: '通用设置',
        enabled: true,
        sync_mode: SyncMode.OWN,
      },
    ]);

    let pushCount = 0;
    const mockSyncManager = {
      pushLocal: async () => { pushCount++; return { success: true }; },
    };

    const engine = new AutoSyncEngine({
      storage,
      syncManager: mockSyncManager,
      accountHandle: 'nuobao',
      enabled: true,
    });

    // 模拟 AI 正在生成回复
    engine.mockGenerating = true;

    const res = await engine.runAutoSync('nuobao');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'generating');
    assert.strictEqual(pushCount, 0, 'AI 生成中绝对严禁触发任何写盘或推送');
    assert.strictEqual(engine.lastStatus, 'suppressed_generating');
  });

  await t.test('4. 防打扰保护：检测到用户正在输入框编辑时，自动避让 (Matrix #12)', async () => {
    const storage = createMockStorage([
      {
        binding_uid: 'b1',
        account_handle: 'nuobao',
        content_type: 'chat',
        item_uid: 'chat-1',
        display_name: '测试会话',
        enabled: true,
        sync_mode: SyncMode.OWN,
      },
    ]);

    let pushCount = 0;
    const mockSyncManager = {
      pushLocal: async () => { pushCount++; return { success: true }; },
    };

    const engine = new AutoSyncEngine({
      storage,
      syncManager: mockSyncManager,
      accountHandle: 'nuobao',
      enabled: true,
    });

    // 模拟用户正在打字输入
    engine.mockTyping = true;

    const res = await engine.runAutoSync('nuobao');
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'typing');
    assert.strictEqual(pushCount, 0, '用户打字中绝对严禁触发推送');
    assert.strictEqual(engine.lastStatus, 'suppressed_typing');
  });

  await t.test('5. CAS 服务端锚点兜底：遇到 409 冲突绝不盲目重试或覆盖，优雅退化为提示 (P6-4)', async () => {
    const storage = createMockStorage([
      {
        binding_uid: 'b1',
        account_handle: 'nuobao',
        content_type: 'settings',
        item_uid: 'settings',
        display_name: '通用设置',
        enabled: true,
        sync_mode: SyncMode.OWN,
        state: SyncState.SYNCED,
      },
    ]);

    let notifyMessage = null;
    const mockSyncManager = {
      pushLocal: async () => {
        // 模拟 409 冲突响应
        return { success: false, conflict: true, serverVersion: 5 };
      },
    };

    const engine = new AutoSyncEngine({
      storage,
      syncManager: mockSyncManager,
      accountHandle: 'nuobao',
      enabled: true,
      notifyFn: (msg) => { notifyMessage = msg; },
    });

    const res = await engine.runAutoSync('nuobao');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.conflicts, 1);
    assert.strictEqual(res.pushed, 0);
    assert.ok(notifyMessage.includes('发生版本冲突') || notifyMessage.includes('标记冲突'));
    assert.strictEqual(engine.lastStatus, 'conflict_paused');
  });

  await t.test('6. 正常空闲流程：串行推送开启项，记录时间戳与状态', async () => {
    const storage = createMockStorage([
      {
        binding_uid: 'b1',
        account_handle: 'nuobao',
        content_type: 'character',
        item_uid: 'Seraphina',
        display_name: 'Seraphina',
        enabled: true,
        sync_mode: SyncMode.OWN,
      },
      {
        binding_uid: 'b2',
        account_handle: 'nuobao',
        content_type: 'theme',
        item_uid: 'dark-blue',
        display_name: '深蓝主题',
        enabled: false, // 未启用项不推
        sync_mode: SyncMode.OWN,
      },
    ]);

    let pushedItems = [];
    const mockSyncManager = {
      pushLocal: async (binding) => {
        pushedItems.push(binding.display_name);
        return { success: true, version: 1 };
      },
    };

    const engine = new AutoSyncEngine({
      storage,
      syncManager: mockSyncManager,
      accountHandle: 'nuobao',
      enabled: true,
    });

    const res = await engine.runAutoSync('nuobao');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.pushed, 1);
    assert.deepStrictEqual(pushedItems, ['Seraphina']);
    assert.ok(engine.lastSyncAt > 0);
    assert.strictEqual(engine.lastStatus, 'idle');
  });
});
