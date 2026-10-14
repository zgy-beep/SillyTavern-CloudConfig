import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { ChangeEventBus } from '../../src/server/services/ChangeEventBus.js';
import { DisasterRecoveryService } from '../../src/server/services/DisasterRecoveryService.js';
import { DeterministicZip } from '../../src/server/utils/DeterministicZip.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { AuthContext } from '../../src/server/auth/AuthContext.js';
import { makeItemUid, calcJsonChecksum } from '../../src/common/utils.js';
import { createPluginRouter } from '../../src/server/routes/router.js';

async function fixture(t, store = new SnapshotStore()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_reliability_'));
  const db = new DatabaseClient(':memory:');
  const config = new ConfigService(null, { forcePush: false, maxVersions: 50 });
  const adapters = createP0Adapters();
  const auth = new AuthContext('alice', { root });
  const sync = new SyncService(db, adapters, store, new AuthorizationService(db, config), config);
  sync.mockAvailableBytes = 1e9;
  const uid = makeItemUid('world', 'regression.json');
  const push = (payload, baseVersion, extra = {}) => sync.push({ authContext: auth, ownerHandle: 'alice', contentType: 'world', itemUid: uid, payload, baseVersion, ...extra });
  const pull = version => sync.pull(auth, 'alice', 'world', uid, version);
  t.after(async () => { await sync.waitForMirrors(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, db, config, store, auth, sync, uid, push, pull };
}

test('A failed file publication leaves the record, version and event tables untouched', async t => {
  const store = new SnapshotStore();
  store.commitBlob = async () => { throw new Error('simulated rename failure'); };
  const f = await fixture(t, store);
  await assert.rejects(f.push({ value: 1 }, 0), /simulated rename failure/);
  for (const table of ['config_records','config_versions','change_events']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

test('Concurrent forced uploads allocate separate versions and preserve both immutable files', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.push({ value: 'A' }, 0, { force: true }), f.push({ value: 'B' }, 0, { force: true })]);
  assert.deepEqual(results.map(r => r.version).sort(), [1,2]);
  const values = await Promise.all([f.pull(1), f.pull(2)]);
  assert.deepEqual(values.map(r => r.content.value).sort(), ['A','B']);
  const paths = f.db.prepare('SELECT blob_path FROM config_versions').all().map(r => r.blob_path);
  assert.equal(new Set(paths).size, 2);
});

test('Concurrent CAS uploads publish exactly one winner and discard the losing file', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.push({ value: 'A' }, 0), f.push({ value: 'B' }, 0)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await fs.readdir(f.store.getItemDir(f.auth.directories, 'world', f.uid))).length, 1);
});

test('Unchanged automatic backups preserve history without creating new events', async t => {
  const f = await fixture(t);
  await f.push({ a: 1, b: 2 }, 0);
  const result = await f.push({ b: 2, a: 1 }, 1, { skipUnchanged: true });
  assert.equal(result.unchanged, true); assert.equal(result.version, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM change_events').get().n, 1);
});

test('Snapshot paths reject traversal, drive names and separators before creating files', async t => {
  const f = await fixture(t);
  for (const uid of ['../bob', '..', 'a/b', 'a\\b', 'C:evil', 'NUL']) {
    assert.throws(() => f.store.getItemDir(f.auth.directories, 'world', uid), /Invalid item_uid/);
  }
  await assert.rejects(f.store.prepareTempBlob(f.auth.directories, 'world', f.uid, 1, '../../json', Buffer.from('{}')), /Invalid file extension/);
});

test('Disaster recovery preserves old bytes, publishes a complete new head and is idempotent', async t => {
  const f = await fixture(t);
  await f.push({ value: 'archive' }, 0);
  const dr = new DisasterRecoveryService({ dbClient: f.db, snapshotStore: f.store });
  const backup = await dr.exportBackup('alice');
  await f.push({ value: 'local' }, 1);
  const result = await dr.importBackup(backup.buffer, 'alice', f.auth.directories);
  assert.equal(result.conflictCount, 1); assert.equal(result.importedVersions, 1);
  assert.equal((await f.pull(1)).content.value, 'archive');
  assert.equal((await f.pull(2)).content.value, 'local');
  assert.equal((await f.pull()).version, 3); assert.equal((await f.pull()).content.value, 'archive');
  assert.equal((await dr.importBackup(backup.buffer, 'alice', f.auth.directories)).importedVersions, 0);
  assert.equal((await f.pull()).version, 3);
});

test('A corrupt archive checksum is rejected without changing the live record', async t => {
  const f = await fixture(t); await f.push({ value: 'original' }, 0);
  const dr = new DisasterRecoveryService({ dbClient: f.db, snapshotStore: f.store });
  const entries = DeterministicZip.unpack((await dr.exportBackup('alice')).buffer);
  entries.find(e => e.name.startsWith('blobs/')).data = Buffer.from('{"value":"tampered"}');
  await assert.rejects(dr.importBackup(DeterministicZip.pack(entries), 'alice', f.auth.directories), /checksum mismatch/);
  assert.equal((await f.pull()).content.value, 'original');
});

test('An imported version colliding with a different local version is idempotent after remapping', async t => {
  const f = await fixture(t); await f.push({ value: 'original' }, 0);
  const dr = new DisasterRecoveryService({ dbClient: f.db, snapshotStore: f.store });
  const entries = DeterministicZip.unpack((await dr.exportBackup('alice')).buffer);
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data);
  const imported = { value: 'external' };
  manifest.records[0].current_checksum = calcJsonChecksum(imported);
  manifest.versions[0].checksum = calcJsonChecksum(imported);
  entries.find(e => e.name.startsWith('blobs/')).data = Buffer.from(JSON.stringify(imported));
  manifestEntry.data = Buffer.from(JSON.stringify(manifest));
  const archive = DeterministicZip.pack(entries);
  await dr.importBackup(archive, 'alice', f.auth.directories);
  assert.equal((await f.pull(1)).content.value, 'original');
  assert.equal((await f.pull(2)).content.value, 'external');
  assert.equal((await dr.importBackup(archive, 'alice', f.auth.directories)).importedVersions, 0);
  assert.equal((await f.pull()).version, 2);
});

test('A later invalid archive object rolls back files staged for earlier objects', async t => {
  const f = await fixture(t); await f.push({ value: 'original' }, 0);
  const dr = new DisasterRecoveryService({ dbClient: f.db, snapshotStore: f.store });
  const entries = DeterministicZip.unpack((await dr.exportBackup('alice')).buffer);
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data);
  const rec = { ...manifest.records[0], item_uid: 'second-item' };
  const ver = { ...manifest.versions[0], item_uid: 'second-item' };
  manifest.records.unshift(rec); manifest.versions.push(ver);
  manifest.records[1].item_uid = '../outside';
  manifestEntry.data = Buffer.from(JSON.stringify(manifest));
  await assert.rejects(dr.importBackup(DeterministicZip.pack(entries), 'alice', f.auth.directories), /Invalid item_uid/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM config_records').get().n, 1);
  assert.deepEqual(await fs.readdir(f.store.getItemDir(f.auth.directories,'world','second-item')), []);
});

test('Deleting the latest snapshot never reuses its version number', async t => {
  const f = await fixture(t);
  await f.push({ value: 1 }, 0); await f.push({ value: 2 }, 1);
  await f.sync.deleteVersion(f.auth, 'alice', 'world', f.uid, 2);
  assert.equal((await f.push({ value: 3 }, 1)).version, 3);
});

test('Changes pagination delivers every object across multiple pages', () => {
  const db = new DatabaseClient(':memory:');
  try {
    const bus = new ChangeEventBus(db);
    for (let i=0;i<205;i++) bus.recordEvent('alice','world','uid'+i,1,'UPSERT');
    const first = bus.getChanges('alice',0,100);
    const second = bus.getChanges('alice',first.latest_seq,100);
    const third = bus.getChanges('alice',second.latest_seq,100);
    assert.equal(new Set([...first.events,...second.events,...third.events].map(e => e.item_uid)).size,205);
    assert.equal(first.has_more,true); assert.equal(third.has_more,false);
  } finally { db.close(); }
});

test('Both administrator and member configuration views redact credentials', () => {
  const config = new ConfigService(null, { webdavPassword: 'fake-secret', webdavUsername: 'admin', localPath: '/private' });
  for (const admin of [true,false]) {
    const publicConfig = config.getPublicConfig(admin);
    assert.equal(publicConfig.webdavPassword, undefined); assert.equal(publicConfig.webdavPasswordConfigured, true);
    if (!admin) { assert.equal(publicConfig.webdavUsername,undefined); assert.equal(publicConfig.localPath,undefined); }
  }
});

test('Invalid administrator configuration is rejected before changing runtime settings', () => {
  const config = new ConfigService();
  for (const partial of [{ maxVersions:-1 },{ schedulerIntervalMs:1 },{ webdavUrl:'file:///etc' },{ unknown:true },{ allowSettingsSharing:'true' }]) assert.throws(() => config.update(partial), /Invalid configuration/);
  assert.equal(config.get('allowSettingsSharing'),false);
});

test('Settings supplied by the browser follow the same snapshot exclusion policy as disk reads', async t => {
  const f = await fixture(t);
  const payload = { oai_settings:{ extensions:{ tavern_helper:{ cache:'heavy' },keep:'yes' } } };
  const id = makeItemUid('settings','settings.json');
  await f.sync.push({authContext:f.auth,ownerHandle:'alice',contentType:'settings',itemUid:id,baseVersion:0,payload,excludeHeavy:true});
  const snapshot = await f.sync.pull(f.auth,'alice','settings',id);
  assert.equal(snapshot.content.oai_settings.extensions.tavern_helper,undefined);
  assert.equal(snapshot.content.oai_settings.extensions.keep,'yes');
  assert.deepEqual(payload.oai_settings.extensions.tavern_helper,{cache:'heavy'});
});

test('Local backup endpoints read the full settings and restore exact content under the current account', async t => {
  const f = await fixture(t);
  const original = { original: true, oai_settings: { extensions: { tavern_helper: { cache: ['preserve'] } } } };
  const settingsPath = path.join(f.root,'settings.json');
  await fs.writeFile(settingsPath,JSON.stringify(original));
  f.config.set('webdavPassword','fake-password');
  const app = express(); app.use(express.json());
  app.use((req,res,next) => { req.user = { profile:{ handle:'alice', admin:false },directories:{ root:f.root } }; next(); });
  const router = createPluginRouter({ syncService:f.sync,authService:f.sync.auth,changeBus:new ChangeEventBus(f.db),adapters:f.sync.adapters,configService:f.config,shareService:{} });
  app.use(router);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => { router.sseService.close?.(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const uid = makeItemUid('settings','settings.json');
  const read = await fetch(`${base}/local-content?content_type=settings&item_uid=${uid}`);
  assert.equal(read.status,200); assert.deepEqual((await read.json()).content,original);
  await fs.writeFile(settingsPath,JSON.stringify({ ...original, addedLater:true }));
  const restore = await fetch(`${base}/restore-local`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content_type:'settings',item_uid:uid,content:original})});
  assert.equal(restore.status,200); assert.deepEqual(JSON.parse(await fs.readFile(settingsPath,'utf8')),original);
  const publicConfig = await (await fetch(`${base}/config`)).json();
  assert.equal(publicConfig.config.webdavPassword,undefined);
  const update = await fetch(`${base}/config`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowSettingsSharing:true})});
  assert.equal(update.status,403);
});
