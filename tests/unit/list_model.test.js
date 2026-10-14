import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItemList, isOwnBinding } from '../../src/client/listModel.js';
import { ClientSyncManager } from '../../src/client/syncManager.js';

test('Same UID owned by two users produces separate own and shared rows', () => {
  const rows = buildItemList([{ itemUid: 'same', displayName: 'local', sourceRef: 'same.json' }],
    [{ item_uid: 'same', owner_handle: 'alice', display_name: 'own' }, { item_uid: 'same', owner_handle: 'bob', display_name: 'shared' }], 'alice');
  assert.equal(rows.length,2); assert.deepEqual(rows.map(r => r.sourceOwner).sort(),['alice','bob']);
});

test('Legacy subscriptions without sync_mode remain read-only', () => {
  assert.equal(isOwnBinding({ source_owner_handle: 'bob' }, 'alice'),false);
  assert.equal(isOwnBinding({ source_owner_handle: 'alice' }, 'alice'),true);
});

test('Shared bindings cannot upload even when their legacy mode is absent', async () => {
  const manager = new ClientSyncManager({ push: () => assert.fail('must not call API') }, {});
  await assert.rejects(manager.pushLocal({ account_handle:'alice',source_owner_handle:'bob' },{}), /只读/);
});

test('Enabling sync captures local content and restores it before disabling', async () => {
  let binding, backup, restored;
  const storage = { makeBindingUid:()=> 'binding',getBinding:async()=>binding,saveBinding:async b=> {binding=b;},
    saveBackup:async(uid,account,content)=> {backup={snapshot_content:content};},getBackup:async()=>backup };
  const manager = new ClientSyncManager({ readLocal:async()=>({content:{original:true}}), restoreLocal:async(type,uid,content)=> {restored=content;} },storage);
  await manager.enableSync('alice','settings','settings','Settings');
  await manager.disableSync('binding',true);
  assert.deepEqual(restored,{original:true}); assert.equal(binding.enabled,false);
});
