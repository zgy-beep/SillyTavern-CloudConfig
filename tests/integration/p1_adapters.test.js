import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createP1Adapters } from '../../src/server/adapters/P1Adapters.js';
import { isShareableContentType, P1ContentTypes } from '../../src/common/constants.js';

test('Integration: P1 Pure JSON Adapters', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync-p1-test-'));

  const aliceDir = path.join(tmpDir, 'data', 'alice');
  const bobDir = path.join(tmpDir, 'data', 'bob');

  const aliceDirs = {
    handle: 'alice',
    user: aliceDir,
    root: aliceDir,
    instruct: path.join(aliceDir, 'instruct'),
    context: path.join(aliceDir, 'context'),
    sysprompt: path.join(aliceDir, 'sysprompt'),
    quickReplies: path.join(aliceDir, 'QuickReplies'),
  };

  const bobDirs = {
    handle: 'bob',
    user: bobDir,
    root: bobDir,
    instruct: path.join(bobDir, 'instruct'),
    context: path.join(bobDir, 'context'),
    sysprompt: path.join(bobDir, 'sysprompt'),
    quickReplies: path.join(bobDir, 'QuickReplies'),
  };

  await fs.mkdir(aliceDirs.instruct, { recursive: true });
  await fs.mkdir(aliceDirs.context, { recursive: true });
  await fs.mkdir(aliceDirs.sysprompt, { recursive: true });
  await fs.mkdir(aliceDirs.quickReplies, { recursive: true });

  await fs.mkdir(bobDirs.instruct, { recursive: true });
  await fs.mkdir(bobDirs.context, { recursive: true });
  await fs.mkdir(bobDirs.sysprompt, { recursive: true });
  await fs.mkdir(bobDirs.quickReplies, { recursive: true });

  const adapters = createP1Adapters();

  // 1. 验证 4 个类别均包含且均为 shareable
  await t.test('1. All P1 categories are registered and shareable', () => {
    for (const ct of P1ContentTypes) {
      assert.ok(adapters.has(ct), `Adapter must exist for ${ct}`);
      assert.equal(isShareableContentType(ct), true, `${ct} must be shareable`);
    }
  });

  // 2. 验证 InstructAdapter 的读写与隔离
  await t.test('2. InstructAdapter: read, write, and account isolation', async () => {
    const adapter = adapters.get('instruct');
    assert.ok(adapter);

    // Alice 写入一个 instruct
    const sampleInstruct = { name: 'ChatGLM-Instruct', system_prompt: 'You are an AI assistant' };
    await fs.writeFile(
      path.join(aliceDirs.instruct, 'ChatGLM-Instruct.json'),
      JSON.stringify(sampleInstruct, null, 2),
      'utf8'
    );

    const aliceItems = await adapter.listItems(aliceDirs);
    assert.equal(aliceItems.length, 1);
    assert.equal(aliceItems[0].displayName, 'ChatGLM-Instruct');

    // Bob 目录下应该为空（严格隔离）
    const bobItems = await adapter.listItems(bobDirs);
    assert.equal(bobItems.length, 0);

    // 读取 Alice 的内容
    const content = await adapter.read(aliceDirs, aliceItems[0].itemUid);
    assert.deepEqual(content, sampleInstruct);

    // Bob apply 到自己本地
    await adapter.apply(bobDirs, aliceItems[0].itemUid, 'UPSERT', content, 'ChatGLM-Instruct');
    const bobAfterApply = await adapter.listItems(bobDirs);
    assert.equal(bobAfterApply.length, 1);
    assert.equal(bobAfterApply[0].displayName, 'ChatGLM-Instruct');
  });

  // 3. 验证 ContextAdapter
  await t.test('3. ContextAdapter: list and apply', async () => {
    const adapter = adapters.get('context');
    assert.ok(adapter);

    const sampleContext = { name: 'StoryContext', story_string: 'Once upon a time...' };
    await fs.writeFile(
      path.join(aliceDirs.context, 'StoryContext.json'),
      JSON.stringify(sampleContext, null, 2),
      'utf8'
    );

    const items = await adapter.listItems(aliceDirs);
    assert.equal(items.length, 1);
    const readBack = await adapter.read(aliceDirs, items[0].itemUid);
    assert.deepEqual(readBack, sampleContext);
  });

  // 4. 验证 SyspromptAdapter
  await t.test('4. SyspromptAdapter: list and apply', async () => {
    const adapter = adapters.get('sysprompt');
    assert.ok(adapter);

    const samplePrompt = { name: 'RoleplayPrompt', content: 'Act as a fantasy narrator.' };
    await fs.writeFile(
      path.join(aliceDirs.sysprompt, 'RoleplayPrompt.json'),
      JSON.stringify(samplePrompt, null, 2),
      'utf8'
    );

    const items = await adapter.listItems(aliceDirs);
    assert.equal(items.length, 1);
    const readBack = await adapter.read(aliceDirs, items[0].itemUid);
    assert.deepEqual(readBack, samplePrompt);
  });

  // 5. 验证 QuickRepliesAdapter
  await t.test('5. QuickRepliesAdapter: list, read, and delete', async () => {
    const adapter = adapters.get('quick_replies');
    assert.ok(adapter);

    const sampleQR = { name: 'CombatQR', setList: [{ label: 'Attack', value: 'I attack!' }] };
    await fs.writeFile(
      path.join(aliceDirs.quickReplies, 'CombatQR.json'),
      JSON.stringify(sampleQR, null, 2),
      'utf8'
    );

    const items = await adapter.listItems(aliceDirs);
    assert.equal(items.length, 1);
    const readBack = await adapter.read(aliceDirs, items[0].itemUid);
    assert.deepEqual(readBack, sampleQR);

    // 删除验证
    await adapter.apply(aliceDirs, items[0].itemUid, 'DELETE', null);
    const afterDelete = await adapter.listItems(aliceDirs);
    assert.equal(afterDelete.length, 0);
  });

  // 清理临时目录
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
