import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudConfigPanel } from '../../src/client/ui/panel.js';
import { ReloadStrategy } from '../../src/common/constants.js';

test('TC6: P5-3 Client consumption of reload_strategy', async (t) => {
  const panel = new CloudConfigPanel({
    api: {},
    syncManager: {},
    storage: {},
    accountHandle: 'test-user',
  });

  await t.test('getDefaultReloadStrategy returns appropriate strategy per contentType', () => {
    assert.equal(panel.getDefaultReloadStrategy('character'), ReloadStrategy.CHARACTER_LIST);
    assert.equal(panel.getDefaultReloadStrategy('settings'), ReloadStrategy.SETTINGS);
    assert.equal(panel.getDefaultReloadStrategy('world'), ReloadStrategy.WORLD_INFO);
    assert.equal(panel.getDefaultReloadStrategy('openai_preset'), ReloadStrategy.PRESET_LIST);
    assert.equal(panel.getDefaultReloadStrategy('unknown_type'), ReloadStrategy.NONE);
  });

  await t.test('character reload_strategy triggers window.getCharacters hook if present and prompts server restart', async () => {
    let hookCalled = false;
    let confirmPrompt = '';

    // 模拟全局 window 与 getCharacters 钩子
    globalThis.window = {
      getCharacters: async () => {
        hookCalled = true;
      },
      location: {
        reload: () => {},
      },
    };
    globalThis.confirm = (msg) => {
      confirmPrompt = msg;
      return false; // 不触发实际页面刷新
    };

    try {
      const res = await panel.handleReloadStrategy(
        ReloadStrategy.CHARACTER_LIST,
        { displayName: 'Seraphina', itemUid: 'char_1' },
        '最新快照',
        'test-user'
      );

      assert.equal(res.strategy, ReloadStrategy.CHARACTER_LIST);
      assert.equal(res.refreshedInUi, true, 'Front-end hook should be called');
      assert.equal(hookCalled, true);
      assert.ok(
        confirmPrompt.includes('SillyTavern 存在服务端内存缓存，若角色列表中未立即刷新显示该角色，请重启 SillyTavern 服务端完全生效'),
        'Must prompt about SillyTavern server-side memory cache'
      );
    } finally {
      delete globalThis.window;
      delete globalThis.confirm;
    }
  });

  await t.test('character reload_strategy gracefully handles missing hook and still prompts restart notice', async () => {
    let confirmPrompt = '';
    globalThis.confirm = (msg) => {
      confirmPrompt = msg;
      return false;
    };

    try {
      const res = await panel.handleReloadStrategy(
        ReloadStrategy.CHARACTER_LIST,
        { displayName: 'Hero', itemUid: 'char_2' },
        '快照 (v2)',
        'test-user'
      );

      assert.equal(res.strategy, ReloadStrategy.CHARACTER_LIST);
      assert.equal(res.refreshedInUi, false, 'No hook exists, so refreshedInUi is false');
      assert.ok(confirmPrompt.includes('Hero'));
      assert.ok(confirmPrompt.includes('服务端完全生效'));
    } finally {
      delete globalThis.confirm;
    }
  });

  await t.test('settings reload_strategy prompts about API keys & server restart', async () => {
    let confirmPrompt = '';
    globalThis.confirm = (msg) => {
      confirmPrompt = msg;
      return false;
    };

    try {
      const res = await panel.handleReloadStrategy(
        ReloadStrategy.SETTINGS,
        { displayName: '全局设置', itemUid: 'settings' },
        '最新快照',
        'alice'
      );

      assert.equal(res.strategy, ReloadStrategy.SETTINGS);
      assert.ok(confirmPrompt.includes('缓存全局配置与 API 密钥'));
      assert.ok(confirmPrompt.includes('建议重启 SillyTavern 服务端以完全生效'));
    } finally {
      delete globalThis.confirm;
    }
  });

  await t.test('preset reload_strategy triggers window.loadPresets hook if present', async () => {
    let hookCalled = false;
    globalThis.window = {
      loadPresets: async () => {
        hookCalled = true;
      },
    };
    globalThis.confirm = () => false;

    try {
      const res = await panel.handleReloadStrategy(
        ReloadStrategy.PRESET_LIST,
        { displayName: 'Claude 3.5 Sonnet', itemUid: 'preset_1' },
        '最新快照',
        'alice'
      );

      assert.equal(res.refreshedInUi, true);
      assert.equal(hookCalled, true);
    } finally {
      delete globalThis.window;
      delete globalThis.confirm;
    }
  });
});
