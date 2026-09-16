import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudConfigPanel } from '../../src/client/ui/panel.js';

test('Step 3: Character / Theme UI & Sequential One-Click Backup', async (t) => {
  await t.test('CloudConfigPanel initializes thumbnailCache and supports character/theme mapping', () => {
    const panel = new CloudConfigPanel({
      api: {},
      syncManager: {},
      storage: {},
      accountHandle: 'alice',
    });

    assert.ok(panel.thumbnailCache instanceof Map, 'thumbnailCache must be a Map');
    panel.thumbnailCache.set('uid1', 'blob:http://localhost/123');
    assert.equal(panel.thumbnailCache.get('uid1'), 'blob:http://localhost/123');
  });

  await t.test('runBackupAll: alerts when no bindings are enabled', async () => {
    let alertMsg = '';
    globalThis.alert = (msg) => { alertMsg = msg; };

    const mockStorage = {
      getBindingsByAccount: async () => [
        { enabled: false, display_name: 'Disabled 1' },
      ],
    };

    const panel = new CloudConfigPanel({
      api: {},
      syncManager: {},
      storage: mockStorage,
      accountHandle: 'alice',
    });

    const result = await panel.runBackupAll();
    assert.equal(result.total, 0);
    assert.ok(alertMsg.includes('没有已开启云同步的配置项'));

    delete globalThis.alert;
  });

  await t.test('runBackupAll: strictly serial, fault-tolerant, calculates size estimation', async () => {
    const pushCalls = [];
    let alertSummary = '';

    globalThis.confirm = () => true;
    globalThis.alert = (msg) => { alertSummary = msg; };

    const mockStorage = {
      getBindingsByAccount: async () => [
        { enabled: true, item_uid: 'item1', content_type: 'character', display_name: 'Seraphina' },
        { enabled: true, item_uid: 'item2', content_type: 'openai_preset', display_name: 'Failing Preset' },
        { enabled: true, item_uid: 'item3', content_type: 'theme', display_name: 'Dark Theme' },
      ],
    };

    const mockSyncManager = {
      pushLocal: async (binding) => {
        pushCalls.push(binding.item_uid);
        if (binding.item_uid === 'item2') {
          throw new Error('Network timeout during preset upload');
        }
        return { success: true, size_bytes: 10240 };
      },
    };

    const panel = new CloudConfigPanel({
      api: {},
      syncManager: mockSyncManager,
      storage: mockStorage,
      accountHandle: 'alice',
    });
    // mock refresh to avoid network calls
    panel.refresh = async () => {};

    const res = await panel.runBackupAll();

    // 1. 严格断言执行顺序：严格串行按序调用
    assert.deepEqual(pushCalls, ['item1', 'item2', 'item3']);

    // 2. 严格断言容错性：单个失败不阻断后续项
    assert.equal(res.total, 3);
    assert.equal(res.successCount, 2);
    assert.equal(res.failCount, 1);
    assert.equal(res.totalBytes, 20480);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].name, 'Failing Preset');

    // 3. 提示弹窗包含大小与失败详情
    assert.ok(alertSummary.includes('成功备份: 2 项'));
    assert.ok(alertSummary.includes('失败: 1 项'));
    assert.ok(alertSummary.includes('Network timeout during preset upload'));

    delete globalThis.confirm;
    delete globalThis.alert;
  });
});
