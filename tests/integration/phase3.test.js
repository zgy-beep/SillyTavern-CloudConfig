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
import { AuditService } from '../../src/server/services/AuditService.js';
import { ShareService } from '../../src/server/services/ShareService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { createP0Adapters, deepMergeSettings, autoBackupLocalFile, injectSecrets } from '../../src/server/adapters/P0Adapters.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { AuthContext } from '../../src/server/auth/AuthContext.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Phase 3 Home Settings Sharing & Direct Snapshot Upload (26 Cases)', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_p3_test_'));
  const aliceDir = path.join(tempDir, 'user_alice');
  const bobDir = path.join(tempDir, 'user_bob');
  await fs.mkdir(aliceDir, { recursive: true });
  await fs.mkdir(bobDir, { recursive: true });

  const configPath = path.join(tempDir, 'cfgsync_config.json');
  const configService = new ConfigService(configPath, {
    allowSettingsSharing: false,
    forcePush: true,
    maxVersions: 3, // 设置较小的上限用于快速测试版本轮转裁剪
    excludeHeavyExtensions: true,
  });

  const dbClient = new DatabaseClient(':memory:');
  const adapters = createP0Adapters();
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient, configService);
  const changeBus = new ChangeEventBus(dbClient, configService);
  const auditService = new AuditService(dbClient);
  const shareService = new ShareService(dbClient, auditService, configService, {
    serverSecret: 'p3_test_secret',
  });
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService, configService);

  const aliceAuth = new AuthContext('alice', { user: aliceDir, root: tempDir, handle: 'alice' });
  const bobAuth = new AuthContext('bob', { user: bobDir, root: tempDir, handle: 'bob' });

  let currentUser = 'alice';
  let currentUserDir = aliceDir;
  let currentUserAdmin = false;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      profile: { handle: currentUser, admin: currentUserAdmin },
      directories: { user: currentUserDir, root: tempDir, handle: currentUser },
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
    configService,
  });
  app.use('/api/plugins/cfgsync', pluginRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/plugins/cfgsync`;

  t.after(async () => {
    server.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const settingsUid = makeItemUid('settings', 'settings.json');
  const presetUid = makeItemUid('openai_preset', 'Model_A.json');

  // TC01: Push creates snapshot with custom title and calculated size_bytes
  await t.test('TC01: Push creates snapshot with custom title and calculated size_bytes', async () => {
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: presetUid,
      displayName: 'Model_A',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { model: 'gpt-4o', temp: 0.7 },
      clientId: 'device_1',
      versionTitle: '初始版本 备份',
      force: true,
    });
    assert.equal(res.version, 1);
    assert.equal(res.version_title, '初始版本 备份');

    const vRows = dbClient.prepare('SELECT version_title, size_bytes FROM config_versions WHERE item_uid = ?').all(presetUid);
    assert.equal(vRows.length, 1);
    assert.equal(vRows[0].version_title, '初始版本 备份');
    assert.ok(vRows[0].size_bytes > 0);
  });

  // TC02: Direct push (force: true) increments version without 409 error
  await t.test('TC02: Direct push (force: true) increments version without 409 error', async () => {
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: presetUid,
      displayName: 'Model_A',
      baseVersion: 999, // 故意传入不一致的 baseVersion
      operation: 'UPSERT',
      payload: { model: 'gpt-4o', temp: 0.8 },
      clientId: 'device_2',
      versionTitle: '直接覆盖快照',
      force: true,
    });
    assert.equal(res.version, 2);
    assert.equal(res.version_title, '直接覆盖快照');
  });

  // TC03: Push with title > 64 chars is trimmed to 64 chars; multiline titles have newlines stripped
  await t.test('TC03: Push with title > 64 chars is trimmed to 64 chars; multiline titles have newlines stripped', async () => {
    const longMultiline = '这是一个很长很长的快照备注名称\n包含换行符与多余空格  ' + 'A'.repeat(100);
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: presetUid,
      displayName: 'Model_A',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { model: 'gpt-4o', temp: 0.85 },
      clientId: 'device_1',
      versionTitle: longMultiline,
      force: true,
    });
    assert.equal(res.version, 3);
    assert.ok(res.version_title.length <= 64);
    assert.ok(!res.version_title.includes('\n'));
    assert.ok(!res.version_title.includes('\r'));
  });

  // TC04: Default title defaults to seconds-level timestamp when title is omitted or empty
  await t.test('TC04: Default title defaults to seconds-level timestamp when title is omitted or empty', async () => {
    const itemB = makeItemUid('openai_preset', 'Model_B.json');
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: itemB,
      displayName: 'Model_B',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { model: 'claude-3-5' },
      clientId: 'device_1',
      versionTitle: '',
      force: true,
    });
    assert.ok(res.version_title);
    assert.match(res.version_title, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 备份/);
  });

  // TC05: Direct push on a previously soft-deleted item resurrects the tombstone (is_deleted = 0)
  await t.test('TC05: Direct push on a previously soft-deleted item resurrects the tombstone (is_deleted = 0)', async () => {
    const delUid = makeItemUid('openai_preset', 'DeleteMe.json');
    await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: delUid,
      displayName: 'DeleteMe',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { a: 1 },
      clientId: 'dev',
      force: true,
    });
    // 软删除
    await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: delUid,
      displayName: 'DeleteMe',
      baseVersion: 1,
      operation: 'DELETE',
      payload: null,
      clientId: 'dev',
    });
    const delRecord = dbClient.prepare('SELECT is_deleted, current_version FROM config_records WHERE item_uid = ?').get(delUid);
    assert.equal(delRecord.is_deleted, 1);

    // 网盘直传重新推送：复活墓碑
    const res = await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'openai_preset',
      itemUid: delUid,
      displayName: 'DeleteMe',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { a: 2, resurrected: true },
      clientId: 'dev',
      versionTitle: '复活快照',
      force: true,
    });
    assert.equal(res.version, 3);
    const revivedRecord = dbClient.prepare('SELECT is_deleted, current_version FROM config_records WHERE item_uid = ?').get(delUid);
    assert.equal(revivedRecord.is_deleted, 0);
    assert.equal(revivedRecord.current_version, 3);
  });

  // TC06 & TC07: Exceeding maxVersions (set to 3) automatically prunes oldest versions & cleans blob
  await t.test('TC06 & TC07: Exceeding maxVersions (set to 3) automatically prunes oldest versions', async () => {
    const pruneUid = makeItemUid('openai_preset', 'PruneTest.json');
    for (let v = 1; v <= 5; v++) {
      await syncService.push({
        authContext: aliceAuth,
        ownerHandle: 'alice',
        contentType: 'openai_preset',
        itemUid: pruneUid,
        displayName: 'PruneTest',
        baseVersion: 0,
        operation: 'UPSERT',
        payload: { step: v },
        clientId: 'dev',
        versionTitle: `Snapshot v${v}`,
        force: true,
      });
    }

    const versions = dbClient.prepare('SELECT version FROM config_versions WHERE item_uid = ? ORDER BY version ASC').all(pruneUid);
    // maxVersions 设置为 3，因此仅保留最新的 3 个版本：v3, v4, v5
    assert.equal(versions.length, 3);
    assert.deepEqual(versions.map(r => r.version), [3, 4, 5]);

    const record = dbClient.prepare('SELECT current_version FROM config_records WHERE item_uid = ?').get(pruneUid);
    assert.equal(record.current_version, 5);
  });

  // TC08: Settings adapter excludes oai_settings.extensions.tavern_helper by default
  await t.test('TC08: Settings adapter excludes oai_settings.extensions.tavern_helper by default', async () => {
    const settingsAdapter = adapters.get('settings');
    const localSettings = {
      api_server: 'http://localhost:5000',
      oai_settings: {
        model: 'gpt-4',
        extensions: {
          tavern_helper: { bigData: 'X'.repeat(5000) },
          other_plugin: { enabled: true },
        },
      },
    };
    await fs.writeFile(path.join(aliceDir, 'settings.json'), JSON.stringify(localSettings), 'utf-8');

    const readBack = await settingsAdapter.read(aliceAuth.directories, settingsUid);
    assert.equal(readBack.api_server, 'http://localhost:5000');
    assert.equal(readBack.oai_settings.extensions.other_plugin.enabled, true);
    // tavern_helper 必须已被排除
    assert.equal(readBack.oai_settings.extensions.tavern_helper, undefined);
  });

  // TC09: deepMergeSettings preserves local-only top-level keys
  await t.test('TC09: deepMergeSettings preserves local-only top-level keys', () => {
    const local = {
      api_server: 'http://127.0.0.1:5000',
      preset_settings: 'Default',
      common_key: 'local_val',
    };
    const incoming = {
      common_key: 'cloud_val',
      new_cloud_key: 'added',
    };
    const merged = deepMergeSettings(local, incoming);
    assert.equal(merged.api_server, 'http://127.0.0.1:5000');
    assert.equal(merged.preset_settings, 'Default');
    assert.equal(merged.common_key, 'cloud_val');
    assert.equal(merged.new_cloud_key, 'added');
  });

  // TC10: deepMergeSettings preserves local-only nested keys in oai_settings
  await t.test('TC10: deepMergeSettings preserves local-only nested keys in oai_settings', () => {
    const local = {
      oai_settings: {
        local_custom_param: 123,
        temperature: 0.7,
      },
    };
    const incoming = {
      oai_settings: {
        temperature: 0.9,
        max_tokens: 4096,
      },
    };
    const merged = deepMergeSettings(local, incoming);
    assert.equal(merged.oai_settings.local_custom_param, 123);
    assert.equal(merged.oai_settings.temperature, 0.9);
    assert.equal(merged.oai_settings.max_tokens, 4096);
  });

  // TC11: deepMergeSettings preserves local oai_settings.extensions.tavern_helper
  await t.test('TC11: deepMergeSettings preserves local tavern_helper when incoming lacks it', () => {
    const local = {
      oai_settings: {
        extensions: {
          tavern_helper: { cached_characters: ['char1', 'char2'] },
        },
      },
    };
    const incoming = {
      oai_settings: {
        extensions: {
          other_ext: { active: true },
        },
      },
    };
    const merged = deepMergeSettings(local, incoming);
    assert.deepEqual(merged.oai_settings.extensions.tavern_helper, { cached_characters: ['char1', 'char2'] });
    assert.equal(merged.oai_settings.extensions.other_ext.active, true);
  });

  // TC12: deepMergeSettings merges arrays by id / identifier
  await t.test('TC12: deepMergeSettings merges arrays by id / identifier', () => {
    const local = {
      custom_sources: [
        { id: 'source_1', name: 'Source 1 (Old Local)' },
        { id: 'source_local_only', name: 'Local Only' },
      ],
    };
    const incoming = {
      custom_sources: [
        { id: 'source_2', name: 'Cloud Source 2' },
        { id: 'source_1', name: 'Source 1 (Cloud Updated)' },
      ],
    };
    const merged = deepMergeSettings(local, incoming);
    assert.equal(merged.custom_sources.length, 3);
    // 云端顺序优先
    assert.equal(merged.custom_sources[0].id, 'source_2');
    assert.equal(merged.custom_sources[1].id, 'source_1');
    assert.equal(merged.custom_sources[1].name, 'Source 1 (Cloud Updated)');
    // 本地独有追加到末尾
    assert.equal(merged.custom_sources[2].id, 'source_local_only');
  });

  // TC13 & TC14: Local settings.json is automatically backed up as settings.json.bak-<timestamp>, keeping max 3
  await t.test('TC13 & TC14: Local settings.json is backed up (never ending in .json) keeping max 3', async () => {
    const testSettingsPath = path.join(aliceDir, 'test_backup_settings.json');
    await fs.writeFile(testSettingsPath, JSON.stringify({ v: 1 }), 'utf-8');

    // 连续触发 4 次备份
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 20)); // 保证时间戳不同
      await autoBackupLocalFile(testSettingsPath);
    }

    const files = await fs.readdir(aliceDir);
    const backups = files.filter(f => f.startsWith('test_backup_settings.json.bak-'));
    assert.equal(backups.length, 3, '最多保留 3 份历史备份');
    for (const b of backups) {
      assert.ok(!b.endsWith('.json'), '备份文件名绝不能以 .json 结尾');
    }
  });

  // TC15: Corrupted local JSON guard: invalid syntax refuses to overwrite and throws error
  await t.test('TC15: Corrupted local JSON guard: invalid syntax in local settings.json throws error', async () => {
    const corruptedSettingsPath = path.join(bobDir, 'settings.json');
    await fs.writeFile(corruptedSettingsPath, '{ invalid json syntax ... ', 'utf-8');

    const settingsAdapter = adapters.get('settings');
    await assert.rejects(
      async () => {
        await settingsAdapter.apply(bobAuth.directories, settingsUid, 'UPSERT', { api_server: 'valid' });
      },
      /corrupted and cannot be parsed/i
    );

    // 确保损坏的本地文件内容没有被强行覆盖抹除
    const rawContent = await fs.readFile(corruptedSettingsPath, 'utf-8');
    assert.equal(rawContent, '{ invalid json syntax ... ');

    // 清理损坏的测试文件，保证后续测试干净
    await fs.rm(corruptedSettingsPath, { force: true });
  });

  // TC16: When allowSettingsSharing = false, /shares/create-code for settings returns 400
  await t.test('TC16: When allowSettingsSharing = false, /shares/create-code for settings returns 400', async () => {
    configService.set('allowSettingsSharing', false);
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const res = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.message, /not shareable/i);
  });

  // TC17: When allowSettingsSharing = true, /shares/create-code for settings succeeds
  let settingsShareCode = '';
  await t.test('TC17: When allowSettingsSharing = true, /shares/create-code for settings succeeds', async () => {
    configService.set('allowSettingsSharing', true);
    // 先让 alice 推送一份 settings 到云端
    await syncService.push({
      authContext: aliceAuth,
      ownerHandle: 'alice',
      contentType: 'settings',
      itemUid: settingsUid,
      displayName: '通用设置',
      baseVersion: 0,
      operation: 'UPSERT',
      payload: { api_server: 'http://family-nas:5000', oai_settings: { model: 'claude-3-7' } },
      clientId: 'alice_dev',
      versionTitle: '家庭主配置',
      force: true,
    });

    const res = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
        inject_secrets: true,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.share_code);
    settingsShareCode = data.share_code;
  });

  // TC18 & TC19 & TC20 & TC21: Secret injection merges api_key_custom by id, preserves member keys, logs audit
  await t.test('TC18-TC21: Secret injection into secrets.json via server-side derivation', async () => {
    // 准备 Alice 的 secrets.json
    await fs.writeFile(path.join(aliceDir, 'secrets.json'), JSON.stringify({
      api_key_custom: [
        { id: 'openai_main', key: 'sk-alice-openai-secret' },
        { id: 'anthropic_main', key: 'sk-alice-claude-secret' },
      ],
    }), 'utf-8');

    // 准备 Bob 的初始 secrets.json（包含 Bob 自己的独有密钥）
    await fs.writeFile(path.join(bobDir, 'secrets.json'), JSON.stringify({
      api_key_custom: [
        { id: 'anthropic_main', key: 'sk-bob-old-claude' },
        { id: 'bob_private_key', key: 'sk-bob-private-only' },
      ],
    }), 'utf-8');

    // Bob 认领 Alice 的邀请码
    currentUser = 'bob';
    currentUserDir = bobDir;

    const claimRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        share_code: settingsShareCode,
      }),
    });
    assert.equal(claimRes.status, 200);

    // Bob 调用 GET /pull?apply=true 包含 settings
    // 必须通过服务端派生，客户端不传递也不接受 sourceOwner
    const pullRes = await fetch(`${baseUrl}/pull?content_type=settings&item_uid=${settingsUid}&owner=alice&apply=true`);
    assert.equal(pullRes.status, 200);

    // 验证 Bob 本地的 secrets.json 是否正确注入与合并
    const bobSecretsRaw = await fs.readFile(path.join(bobDir, 'secrets.json'), 'utf-8');
    const bobSecrets = JSON.parse(bobSecretsRaw);

    const keyMap = new Map(bobSecrets.api_key_custom.map(k => [k.id, k.key]));
    // 覆盖/合并了 Alice 的 key
    assert.equal(keyMap.get('openai_main'), 'sk-alice-openai-secret');
    assert.equal(keyMap.get('anthropic_main'), 'sk-alice-claude-secret');
    // Bob 独有的 key 严格保留
    assert.equal(keyMap.get('bob_private_key'), 'sk-bob-private-only');

    // 验证审计日志：包含 sensitive 标记且绝无明文 API Key 泄漏
    const auditLogs = dbClient.prepare("SELECT * FROM audit_logs WHERE action = 'inject_secrets'").all();
    assert.ok(auditLogs.length >= 1);
    for (const log of auditLogs) {
      assert.ok(!log.details?.includes('sk-alice'));
      assert.ok(!log.details?.includes('sk-bob'));
    }
  });

  // TC22: When allowSettingsSharing = true, /owners and /items include settings
  await t.test('TC22: When allowSettingsSharing = true, /owners and /items include settings', async () => {
    currentUser = 'bob';
    currentUserDir = bobDir;

    const ownersRes = await fetch(`${baseUrl}/owners?content_type=settings`);
    assert.equal(ownersRes.status, 200);
    const ownersData = await ownersRes.json();
    assert.ok(ownersData.owners.includes('alice'));

    const itemsRes = await fetch(`${baseUrl}/items?content_type=settings&scope=cloud&all_owners=true`);
    assert.equal(itemsRes.status, 200);
    const itemsData = await itemsRes.json();
    assert.ok(itemsData.items.some(i => i.owner_handle === 'alice' && i.item_uid === settingsUid));
  });

  // TC23: GET /versions returns version_title and size_bytes
  await t.test('TC23: GET /versions returns version_title and size_bytes', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;
    const vRes = await fetch(`${baseUrl}/versions?content_type=settings&item_uid=${settingsUid}&owner=alice`);
    assert.equal(vRes.status, 200);
    const vData = await vRes.json();
    assert.ok(vData.versions.length >= 1);
    assert.equal(vData.versions[0].version_title, '家庭主配置');
    assert.ok(vData.versions[0].size_bytes > 0);
  });

  // TC24: GET /config returns current config; POST /config requires admin (403 for non-admin, 200 for admin)
  await t.test('TC24: GET /config returns current config; POST /config requires admin', async () => {
    const getRes = await fetch(`${baseUrl}/config`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.config.allowSettingsSharing, true);

    // 非管理员尝试更新配置，必须返回 403 Forbidden
    currentUserAdmin = false;
    const forbiddenRes = await fetch(`${baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxVersions: 50 }),
    });
    assert.equal(forbiddenRes.status, 403);
    const forbiddenData = await forbiddenRes.json();
    assert.match(forbiddenData.message, /Administrator privileges required/i);

    // 管理员更新配置，成功返回 200 并动态生效
    currentUserAdmin = true;
    const postRes = await fetch(`${baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxVersions: 50,
      }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.config.maxVersions, 50);
    assert.equal(configService.get('maxVersions'), 50);
    currentUserAdmin = false;
  });

  // TC25: ChangeEventBus filters out settings when allowSettingsSharing = false, and allows when true
  await t.test('TC25: ChangeEventBus filters out settings when allowSettingsSharing = false, and allows when true', () => {
    configService.set('allowSettingsSharing', false);
    changeBus.recordEvent('alice', 'settings', settingsUid, 1, 'UPSERT');
    let res = changeBus.getChanges('bob', 0);
    assert.equal(res.events.filter(e => e.content_type === 'settings').length, 0);

    configService.set('allowSettingsSharing', true);
    changeBus.recordEvent('alice', 'settings', settingsUid, 2, 'UPSERT');
    res = changeBus.getChanges('bob', 0);
    assert.equal(res.events.filter(e => e.content_type === 'settings').length, 1);
  });

  // TC26: SillyTavern multi-user mode: directories.user = <accountRoot>/user, secrets.json written to <accountRoot>/secrets.json & stray cleaned
  await t.test('TC26: Multi-user mode writes secrets.json to account root and cleans stray user/secrets.json', async () => {
    // 准备 Charlie 用户目录（模拟 ST 多用户目录结构：root = data/charlie, user = data/charlie/user）
    const charlieRoot = path.join(tempDir, 'charlie');
    const charlieUserDir = path.join(charlieRoot, 'user');
    await fs.mkdir(charlieUserDir, { recursive: true });

    // 故意在 charlieUserDir 中遗留一份 stray secrets.json（模拟旧版本 bug 产生的残留文件）
    const straySecretsPath = path.join(charlieUserDir, 'secrets.json');
    await fs.writeFile(straySecretsPath, JSON.stringify({ stray: true }), 'utf-8');

    const charlieDirs = {
      root: charlieRoot,
      user: charlieUserDir,
      handle: 'charlie',
    };

    const settingsAdapter = adapters.get('settings');
    const primarySettings = settingsAdapter.getUserPrimaryPath(charlieDirs);
    assert.equal(primarySettings, path.join(charlieRoot, 'settings.json'), 'Settings 主路径应为 accountRoot/settings.json');

    // 触发密钥注入：将 Alice 的密钥注入给 Charlie
    await injectSecrets('alice', charlieDirs, auditService);

    // 验证正确的账号根目录 secrets.json 是否生成并注入
    const charlieSecretsPath = path.join(charlieRoot, 'secrets.json');
    const charlieSecretsExists = await fs.access(charlieSecretsPath).then(() => true).catch(() => false);
    assert.ok(charlieSecretsExists, 'secrets.json 必须写入到账号根目录下');

    const charlieSecrets = JSON.parse(await fs.readFile(charlieSecretsPath, 'utf-8'));
    assert.ok(charlieSecrets.api_key_custom.some(k => k.id === 'openai_main'));

    // 验证 stray secrets.json 是否被防御性清理
    const strayStillExists = await fs.access(straySecretsPath).then(() => true).catch(() => false);
    assert.equal(strayStillExists, false, '误写在 user/ 目录下的残留 secrets.json 必须被自动清理');
  });
});
