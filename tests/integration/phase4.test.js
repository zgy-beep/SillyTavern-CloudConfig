import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import express from 'express';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { ShareService } from '../../src/server/services/ShareService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { createP1Adapters } from '../../src/server/adapters/P1Adapters.js';
import { createPluginRouter } from '../../src/server/routes/router.js';
import { AuthContext } from '../../src/server/auth/AuthContext.js';
import { makeItemUid } from '../../src/common/utils.js';

test('Integration: Phase 4 Visuals, Pruning, Delete & Server-Side Lock Protection (16 Cases)', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_p4_test_'));
  const aliceDir = path.join(tempDir, 'user_alice');
  const bobDir = path.join(tempDir, 'user_bob');
  const alicePresetsDir = path.join(aliceDir, 'OpenAI Settings');
  const bobPresetsDir = path.join(bobDir, 'OpenAI Settings');
  const aliceInstructDir = path.join(aliceDir, 'instruct');
  await fs.mkdir(alicePresetsDir, { recursive: true });
  await fs.mkdir(bobPresetsDir, { recursive: true });
  await fs.mkdir(aliceInstructDir, { recursive: true });

  const configPath = path.join(tempDir, 'cfgsync_config.json');
  const configService = new ConfigService(configPath, {
    allowSettingsSharing: true,
    forcePush: true,
    maxVersions: 10,
    excludeHeavyExtensions: true,
  });

  const dbClient = new DatabaseClient(':memory:');
  const p0Adapters = createP0Adapters();
  const p1Adapters = createP1Adapters();
  const adapters = new Map([...p0Adapters, ...p1Adapters]);
  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient, configService);
  const changeBus = new ChangeEventBus(dbClient, configService);
  const auditService = new AuditService(dbClient);
  const shareService = new ShareService(dbClient, auditService, configService, {
    serverSecret: 'p4_test_secret',
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

  const presetUid = makeItemUid('openai_preset', 'Custom_Preset.json');
  const presetLocalPath = path.join(alicePresetsDir, 'Custom_Preset.json');
  await fs.writeFile(presetLocalPath, JSON.stringify({ temp: 0.7, local_note: 'v1-local' }), 'utf8');

  // Push version 1 from Alice
  await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_type: 'openai_preset',
      item_uid: presetUid,
      display_name: 'Custom_Preset',
      version_title: 'v1 snapshot',
      force: true,
      payload: { temp: 0.7, cloud_tag: 'from-cloud-v1' },
    }),
  });

  // TC01: Lock own item -> pull?apply=true returns 423 Locked, local file unchanged
  await t.test('TC01: Lock own item -> pull?apply=true returns 423 Locked, local file unchanged', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    // Set lock
    const lockRes = await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        locked: true,
      }),
    });
    assert.equal(lockRes.status, 200);
    const lockData = await lockRes.json();
    assert.equal(lockData.is_locked, 1);

    // Try pull with apply=true
    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&apply=true`);
    assert.equal(pullRes.status, 423);
    const pullData = await pullRes.json();
    assert.equal(pullData.error, 'LockedError');
    assert.equal(pullData.code, 'LOCKED');

    // Verify local file untouched
    const localContent = JSON.parse(await fs.readFile(presetLocalPath, 'utf8'));
    assert.equal(localContent.local_note, 'v1-local');
  });

  // TC02: New session (same user) -> pull?apply=true still returns 423 Locked
  await t.test('TC02: New session (same user) -> pull?apply=true still returns 423 Locked', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&apply=true`, {
      headers: { 'User-Agent': 'New-Device-Browser/1.0' },
    });
    assert.equal(pullRes.status, 423);
    const pullData = await pullRes.json();
    assert.equal(pullData.code, 'LOCKED');
  });

  // TC03: Shared item from Alice to Bob -> Bob locks it -> Bob pull?apply=true returns 423 Locked
  await t.test('TC03: Member role locks shared item -> pull?apply=true returns 423 Locked', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    // Alice shares Custom_Preset with Bob
    const codeRes = await fetch(`${baseUrl}/shares/create-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        scope_type: 'ITEM',
        code_usage: 'single_use',
      }),
    });
    assert.equal(codeRes.status, 200);
    const { share_code: shareCode } = await codeRes.json();

    // Bob claims code
    currentUser = 'bob';
    currentUserDir = bobDir;
    const claimRes = await fetch(`${baseUrl}/shares/claim-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: shareCode }),
    });
    assert.equal(claimRes.status, 200);

    // Bob locks Alice's shared item on Bob's end
    const lockBobRes = await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        owner: 'alice',
        locked: true,
      }),
    });
    assert.equal(lockBobRes.status, 200);
    const lockBobData = await lockBobRes.json();
    assert.equal(lockBobData.is_locked, 1);

    // Bob tries to pull Alice's item with apply=true -> 423 Locked
    const bobPullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&owner=alice&apply=true`);
    assert.equal(bobPullRes.status, 423);
    const bobPullData = await bobPullRes.json();
    assert.equal(bobPullData.code, 'LOCKED');
  });

  // TC04: pull?apply=true&force_unlock=true -> still 423 (N-5 backdoor verification)
  await t.test('TC04: pull?apply=true&force_unlock=true -> still 423 (N-5 backdoor strictly blocked)', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&apply=true&force_unlock=true`);
    assert.equal(pullRes.status, 423);
    const pullData = await pullRes.json();
    assert.equal(pullData.code, 'LOCKED');
  });

  // TC05: Two-step workflow: POST /lock {locked: false} -> pull?apply=true succeeds (200)
  await t.test('TC05: Explicit unlock via POST /lock {locked: false} -> pull succeeds (200)', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    // Step 1: Explicit unlock
    const unlockRes = await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        locked: false,
      }),
    });
    assert.equal(unlockRes.status, 200);
    const unlockData = await unlockRes.json();
    assert.equal(unlockData.is_locked, 0);

    // Step 2: Pull with apply
    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}&apply=true`);
    assert.equal(pullRes.status, 200);
    const pullData = await pullRes.json();
    assert.equal(pullData.content.cloud_tag, 'from-cloud-v1');

    // Local file was updated
    const localContent = JSON.parse(await fs.readFile(presetLocalPath, 'utf8'));
    assert.equal(localContent.cloud_tag, 'from-cloud-v1');
  });

  // TC06: Read-only preview GET /pull (without apply) on locked item returns 200 OK
  await t.test('TC06: Read-only preview GET /pull without apply on locked item returns 200 OK', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    // Relock
    await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'openai_preset', item_uid: presetUid, locked: true }),
    });

    // Preview without apply
    const previewRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${presetUid}`);
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.content.cloud_tag, 'from-cloud-v1');
  });

  // TC07: Push on locked item -> returns 200 OK (lock only prevents apply)
  await t.test('TC07: Push on locked item -> returns 200 OK (lock only prevents apply)', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        display_name: 'Custom_Preset',
        version_title: 'v2 snapshot while locked',
        force: true,
        payload: { temp: 0.8, cloud_tag: 'from-cloud-v2' },
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushData = await pushRes.json();
    assert.equal(pushData.version, 2);
  });

  // TC08: Setting lock on another user unshared item returns 403 Forbidden
  await t.test('TC08: Non-owner without grant cannot set lock for other owner (403)', async () => {
    currentUser = 'bob';
    currentUserDir = bobDir;

    const fakeUid = makeItemUid('openai_preset', 'Unshared_Preset.json');
    const lockRes = await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: fakeUid,
        owner: 'alice',
        locked: true,
      }),
    });
    assert.equal(lockRes.status, 403);
  });

  // TC09: audit_logs records lock and unlock events
  await t.test('TC09: audit_logs records lock and unlock actions', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const auditRes = await fetch(`${baseUrl}/audit`);
    assert.equal(auditRes.status, 200);
    const { logs } = await auditRes.json();
    const actions = logs.map(l => l.action);
    assert.ok(actions.includes('lock'));
    assert.ok(actions.includes('unlock'));
  });

  // TC10: DELETE /items (delete_cloud=true, delete_local=false) -> tombstone + local file intact
  await t.test('TC10: DELETE /items cloud-only creates tombstone and preserves local file', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const deleteRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        delete_cloud: true,
        delete_local: false,
      }),
    });
    assert.equal(deleteRes.status, 200);
    const delData = await deleteRes.json();
    assert.equal(delData.deleted_cloud, true);
    assert.equal(delData.deleted_local, false);

    // Local file is intact
    const fileExists = fsSync.existsSync(presetLocalPath);
    assert.ok(fileExists);

    // Pushing again resurrects the tombstone
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        display_name: 'Custom_Preset',
        force: true,
        payload: { temp: 0.9, resurrected: true },
      }),
    });
    assert.equal(pushRes.status, 200);
    const pushData = await pushRes.json();
    assert.equal(pushData.version, 4); // 1, 2, 3(delete tombstone), 4(resurrected)
  });

  // TC11: DELETE /items + delete_local=true (non-settings) -> creates .bak, removes file, cleans locks
  await t.test('TC11: DELETE /items delete_local=true on preset creates .bak and cleans locks', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    // Ensure preset file exists
    await fs.writeFile(presetLocalPath, JSON.stringify({ temp: 0.9, content: 'to-be-deleted' }), 'utf8');

    // Ensure lock exists
    await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'openai_preset', item_uid: presetUid, locked: true }),
    });

    const deleteRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: presetUid,
        delete_cloud: true,
        delete_local: true,
      }),
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.success, true);
    assert.equal(deleteData.deleted_cloud, true);
    assert.equal(deleteData.deleted_local, true);
    assert.equal(deleteData.local_reason, null);

    // Local original file is deleted
    assert.ok(!fsSync.existsSync(presetLocalPath));

    // A .bak file was created
    const files = await fs.readdir(alicePresetsDir);
    const bakFiles = files.filter(f => f.startsWith('Custom_Preset.json.bak-'));
    assert.ok(bakFiles.length >= 1);

    // Lock was cleaned up
    assert.equal(syncService.isLocked('alice', 'alice', 'openai_preset', presetUid), false);
  });

  // TC12: DELETE /items + delete_local=true on settings -> 400 Bad Request, local settings.json intact
  await t.test('TC12: DELETE /items delete_local=true on settings returns 400 Bad Request', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const settingsPath = path.join(tempDir, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark', safe_guard: true }), 'utf8');

    const settingsUid = makeItemUid('settings', 'settings.json');
    const deleteRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
        delete_cloud: true,
        delete_local: true,
      }),
    });
    assert.equal(deleteRes.status, 400);
    const errData = await deleteRes.json();
    assert.equal(errData.error, 'BadRequest');
    assert.ok(errData.message.includes('Local settings.json cannot be deleted'));

    // settings.json remains intact
    const stillExists = fsSync.existsSync(settingsPath);
    assert.ok(stillExists);
    const content = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(content.safe_guard, true);
  });

  // TC13: DELETE /items removes associated locks from binding_locks
  await t.test('TC13: DELETE /items cleans up orphaned binding_locks records', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const tempUid = makeItemUid('instruct', 'temp_inst.json');
    syncService.setLock({ requesterHandle: 'alice', ownerHandle: 'alice', contentType: 'instruct', itemUid: tempUid, locked: true });
    assert.equal(syncService.isLocked('alice', 'alice', 'instruct', tempUid), true);

    const deleteRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'instruct',
        item_uid: tempUid,
        delete_cloud: true,
        delete_local: false,
      }),
    });
    assert.equal(deleteRes.status, 200);

    assert.equal(syncService.isLocked('alice', 'alice', 'instruct', tempUid), false);
  });

  // TC14: GET /items returns is_locked: 0 | 1 for both local and cloud scope
  await t.test('TC14: GET /items returns is_locked for local and cloud items', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const lockInstUid = makeItemUid('instruct', 'Locked_Inst.json');
    const instFilePath = path.join(aliceInstructDir, 'Locked_Inst.json');
    await fs.writeFile(instFilePath, JSON.stringify({ format: 'chatml' }), 'utf8');

    // Lock it
    await fetch(`${baseUrl}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'instruct', item_uid: lockInstUid, locked: true }),
    });

    // Push it
    await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'instruct',
        item_uid: lockInstUid,
        display_name: 'Locked_Inst',
        force: true,
        payload: { format: 'chatml' },
      }),
    });

    // Test cloud scope
    const cloudRes = await fetch(`${baseUrl}/items?content_type=instruct&scope=cloud`);
    assert.equal(cloudRes.status, 200);
    const cloudData = await cloudRes.json();
    const cloudItem = cloudData.items.find(i => i.item_uid === lockInstUid);
    assert.ok(cloudItem);
    assert.equal(cloudItem.is_locked, 1);

    // Test local scope
    const localRes = await fetch(`${baseUrl}/items?content_type=instruct&scope=local`);
    assert.equal(localRes.status, 200);
    const localData = await localRes.json();
    const localItem = localData.items.find(i => i.itemUid === lockInstUid);
    assert.ok(localItem);
    assert.equal(localItem.is_locked, 1);
  });

  // TC15: exclude_heavy priority verification: per-push > ConfigService > default true
  await t.test('TC15: exclude_heavy priority: per-push param overrides ConfigService', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const settingsPath = path.join(tempDir, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: 'dark',
      oai_settings: {
        extensions: {
          tavern_helper: { cache_data: 'huge-data-here' },
        },
      },
    }), 'utf8');

    const settingsUid = makeItemUid('settings', 'settings.json');

    // Case 1: per-push exclude_heavy = false (keep tavern_helper even if global default is true)
    const push1Res = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
        display_name: 'Settings',
        force: true,
        exclude_heavy: false,
      }),
    });
    assert.equal(push1Res.status, 200);

    const v1Pull = await syncService.pull(aliceAuth, 'alice', 'settings', settingsUid, 1);
    assert.ok(v1Pull.content?.oai_settings?.extensions?.tavern_helper, 'tavern_helper should be retained when exclude_heavy=false');

    // Case 2: per-push exclude_heavy = true (exclude tavern_helper)
    const push2Res = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'settings',
        item_uid: settingsUid,
        display_name: 'Settings',
        force: true,
        exclude_heavy: true,
      }),
    });
    assert.equal(push2Res.status, 200);

    const v2Pull = await syncService.pull(aliceAuth, 'alice', 'settings', settingsUid, 2);
    assert.equal(v2Pull.content?.oai_settings?.extensions?.tavern_helper, undefined, 'tavern_helper should be excluded when exclude_heavy=true');
  });

  // TC16: Admin permissions: non-admin POST /config -> 403, admin -> 200; /content-types returns is_admin
  await t.test('TC16: Non-admin calling POST /config returns 403, admin succeeds; /content-types has is_admin', async () => {
    currentUser = 'bob';
    currentUserDir = bobDir;
    currentUserAdmin = false;

    // Bob (non-admin) checks /content-types
    const ctRes = await fetch(`${baseUrl}/content-types`);
    assert.equal(ctRes.status, 200);
    const ctData = await ctRes.json();
    assert.equal(ctData.is_admin, false);

    // Bob tries to update config
    const bobConfigRes = await fetch(`${baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxVersions: 50 }),
    });
    assert.equal(bobConfigRes.status, 403);

    // Admin user updates config
    currentUser = 'alice';
    currentUserDir = aliceDir;
    currentUserAdmin = true;

    const adminCtRes = await fetch(`${baseUrl}/content-types`);
    const adminCtData = await adminCtRes.json();
    assert.equal(adminCtData.is_admin, true);

    const adminConfigRes = await fetch(`${baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxVersions: 50 }),
    });
    assert.equal(adminConfigRes.status, 200);
    const adminConfigData = await adminConfigRes.json();
    assert.equal(adminConfigData.config.maxVersions, 50);

    // GET /config returns is_admin
    const adminGetRes = await fetch(`${baseUrl}/config`);
    assert.equal(adminGetRes.status, 200);
    const adminGetData = await adminGetRes.json();
    assert.equal(adminGetData.is_admin, true);
  });

  // TC17 (BUG-P4-01): When local file does not exist, DELETE /items returns deleted_local: false and local_reason: 'local_file_not_found'
  await t.test('TC17: DELETE /items when local file does not exist returns deleted_local: false and local_reason: local_file_not_found', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const ghostUid = makeItemUid('openai_preset', 'Ghost_Preset_Never_Existed.json');

    // First push to cloud so cloud has it
    const pushRes = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: ghostUid,
        payload: { temp: 0.5, name: 'Ghost_Preset' },
        force: true,
      }),
    });
    assert.equal(pushRes.status, 200);

    // Verify local file does NOT exist
    const ghostLocalPath = path.join(alicePresetsDir, 'Ghost_Preset_Never_Existed.json');
    assert.ok(!fsSync.existsSync(ghostLocalPath));

    // Call DELETE with delete_local = true
    const deleteRes = await fetch(`${baseUrl}/items`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: ghostUid,
        delete_cloud: true,
        delete_local: true,
      }),
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();

    assert.equal(deleteData.success, true);
    assert.equal(deleteData.deleted_cloud, true);
    assert.equal(deleteData.deleted_local, false, 'deleted_local must be false when local file is missing');
    assert.equal(deleteData.local_reason, 'local_file_not_found');

    // Cloud record is indeed deleted (tombstone)
    const pullRes = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${ghostUid}`);
    assert.equal(pullRes.status, 404);
  });

  // TC18: DELETE /versions deletes specific historical version and manages records
  await t.test('TC18: DELETE /versions deletes specific version and updates current_version', async () => {
    currentUser = 'alice';
    currentUserDir = aliceDir;

    const snapUid = makeItemUid('openai_preset', 'Snapshot_Test_Preset.json');

    // Push version 1
    const p1 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: snapUid,
        payload: { ver: 1 },
        version_title: 'First Snapshot',
        force: true,
      }),
    });
    assert.equal(p1.status, 200);

    // Push version 2
    const p2 = await fetch(`${baseUrl}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: snapUid,
        payload: { ver: 2 },
        version_title: 'Second Snapshot',
        force: true,
      }),
    });
    assert.equal(p2.status, 200);

    // Check GET /versions returns 2 versions
    let vRes = await fetch(`${baseUrl}/versions?content_type=openai_preset&item_uid=${snapUid}`);
    let vData = await vRes.json();
    assert.equal(vData.versions.length, 2);

    // Bob tries to delete Alice's version 2 -> 403 Forbidden
    currentUser = 'bob';
    currentUserDir = bobDir;
    const forbidRes = await fetch(`${baseUrl}/versions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: snapUid,
        version: 2,
        owner: 'alice',
      }),
    });
    assert.equal(forbidRes.status, 403);

    // Alice deletes version 2
    currentUser = 'alice';
    currentUserDir = aliceDir;
    const delV2Res = await fetch(`${baseUrl}/versions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: snapUid,
        version: 2,
      }),
    });
    assert.equal(delV2Res.status, 200);
    const delV2Data = await delV2Res.json();
    assert.equal(delV2Data.success, true);

    // GET /versions now has only 1 version
    vRes = await fetch(`${baseUrl}/versions?content_type=openai_preset&item_uid=${snapUid}`);
    vData = await vRes.json();
    assert.equal(vData.versions.length, 1);
    assert.equal(vData.versions[0].version, 1);

    // Pull now yields version 1
    const pullV1 = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${snapUid}`);
    assert.equal(pullV1.status, 200);
    const pullData = await pullV1.json();
    assert.equal(pullData.content.ver, 1);

    // Alice deletes version 1 (the last version)
    const delV1Res = await fetch(`${baseUrl}/versions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_type: 'openai_preset',
        item_uid: snapUid,
        version: 1,
      }),
    });
    assert.equal(delV1Res.status, 200);

    // Now pull returns 404 (item marked as deleted tombstone)
    const pullEmpty = await fetch(`${baseUrl}/pull?content_type=openai_preset&item_uid=${snapUid}`);
    assert.equal(pullEmpty.status, 404);
  });
});
