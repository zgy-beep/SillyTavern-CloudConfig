import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSyncManager } from '../../src/client/syncManager.js';
import { SyncState } from '../../src/common/constants.js';

test('ClientSyncManager: pushLocal handles 409 conflict correctly without silent auto-retry', async () => {
  let pushCallCount = 0;
  const mockApi = {
    push: async () => {
      pushCallCount++;
      const err = new Error('Conflict');
      err.status = 409;
      err.data = { server_version: 5, current_checksum: 'abc123' };
      throw err;
    },
  };

  const savedBindings = [];
  const mockStorage = {
    saveBinding: async (b) => {
      savedBindings.push({ ...b });
    },
  };

  const manager = new ClientSyncManager(mockApi, mockStorage);
  const binding = {
    content_type: 'settings',
    item_uid: 'uid_test_1',
    display_name: 'Test Settings',
    last_synced_version: 2,
    state: SyncState.SYNCED,
  };

  const res = await manager.pushLocal(binding, { theme: 'dark' });

  // 1. 严格断言：push 只调用一次，绝无自动自增重试覆盖
  assert.equal(pushCallCount, 1, 'push should be called exactly once without retry');

  // 2. 状态与返回断言
  assert.equal(res.success, false);
  assert.equal(res.conflict, true);
  assert.equal(res.serverVersion, 5);

  // 3. binding 状态断言
  assert.equal(binding.state, SyncState.CONFLICT);
  assert.equal(binding.last_notified_version, 5);
  assert.equal(savedBindings.length, 1);
});
