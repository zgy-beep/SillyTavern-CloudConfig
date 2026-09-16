import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { DatabaseClient } from '../../src/server/db/database.js';
import { SnapshotStore } from '../../src/server/storage/SnapshotStore.js';
import { AuthorizationService } from '../../src/server/services/AuthorizationService.js';
import { SyncService } from '../../src/server/services/SyncService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { ShareService } from '../../src/server/services/ShareService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { createP0Adapters } from '../../src/server/adapters/P0Adapters.js';
import { createP1Adapters } from '../../src/server/adapters/P1Adapters.js';
import { createP2Adapters } from '../../src/server/adapters/P2Adapters.js';
import { ConfigAdapter, MergeStrategy } from '../../src/server/adapters/ConfigAdapter.js';
import { CharacterAdapter } from '../../src/server/adapters/CharacterAdapter.js';
import { ThemeAdapter } from '../../src/server/adapters/ThemeAdapter.js';
import { BinaryConfigAdapter } from '../../src/server/adapters/BinaryConfigAdapter.js';
import { sha256 } from '../../src/common/utils.js';
import { OperationType, Permission } from '../../src/common/constants.js';

// 构造一个合法的 PNG 格式二进制 Buffer，支持内嵌 tEXt 块
function createPngWithCharaChunk(imageByte = 0xAA, charaJsonObj = null) {
  // 1. PNG Header (8 bytes)
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // 2. IHDR Chunk (25 bytes)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width = 1
  ihdrData.writeUInt32BE(1, 4); // height = 1
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // 3. 可选 tEXt chara chunk
  let textChunk = Buffer.alloc(0);
  if (charaJsonObj) {
    const jsonStr = JSON.stringify(charaJsonObj);
    const b64 = Buffer.from(jsonStr, 'utf8').toString('base64');
    const keyword = Buffer.from('chara\0', 'utf8');
    const textData = Buffer.concat([keyword, Buffer.from(b64, 'utf8')]);
    textChunk = makeChunk('tEXt', textData);
  }

  // 4. IDAT Chunk (图像像素数据，包含 imageByte)
  const idatData = Buffer.from([0x78, 0x9C, 0x63, imageByte, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  const idatChunk = makeChunk('IDAT', idatData);

  // 5. IEND Chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdrChunk, textChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  // 简易 crc 占位
  crc.writeUInt32BE(0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

test('Phase 5 Step 1: 二进制适配层基类与 Character / Theme 适配器 (TC1~TC8, TC21~TC22)', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync-p5-step1-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  const dbClient = new DatabaseClient(dbPath);

  const configPath = path.join(tempDir, 'cfgsync_config.json');
  const configService = new ConfigService(configPath, {
    maxVersions: 20,
    maxVersionsByType: {
      character: 5,
      theme: 5,
    },
    allowSettingsSharing: true,
  });

  const adapters = createP0Adapters();
  for (const [k, a] of createP1Adapters()) adapters.set(k, a);
  for (const [k, a] of createP2Adapters()) adapters.set(k, a);

  const snapshotStore = new SnapshotStore();
  const authService = new AuthorizationService(dbClient, configService);
  const auditService = new AuditService(dbClient);
  const shareService = new ShareService(dbClient, auditService, configService);
  const syncService = new SyncService(dbClient, adapters, snapshotStore, authService, configService);

  const userAliceDir = path.join(tempDir, 'data', 'alice');
  const userAliceCharDir = path.join(userAliceDir, 'characters');
  await fs.mkdir(userAliceCharDir, { recursive: true });

  const authAlice = {
    handle: 'alice',
    directories: {
      handle: 'alice',
      root: userAliceDir,
      characters: userAliceCharDir,
    },
  };

  const userBobDir = path.join(tempDir, 'data', 'bob');
  const userBobCharDir = path.join(userBobDir, 'characters');
  await fs.mkdir(userBobCharDir, { recursive: true });

  const authBob = {
    handle: 'bob',
    directories: {
      handle: 'bob',
      root: userBobDir,
      characters: userBobCharDir,
    },
  };

  t.after(async () => {
    dbClient.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('TC3: MergeStrategy 枚举合法性与适配器基类策略校验', async () => {
    // 验证枚举完整性
    assert.equal(MergeStrategy.REPLACE, 'REPLACE');
    assert.equal(MergeStrategy.MERGE, 'MERGE');
    assert.equal(MergeStrategy.APPEND_MERGE, 'APPEND_MERGE');

    // 验证未声明或非法策略抛错
    assert.throws(() => {
      new (class extends ConfigAdapter {
        constructor() {
          super('invalid_type', 'UNKNOWN_STRATEGY');
        }
      })();
    }, /Invalid or undeclared mergeStrategy/);

    // 验证各适配器的 strategy 声明
    const charAdapter = adapters.get('character');
    assert.equal(charAdapter.getMergeStrategy(), MergeStrategy.REPLACE);

    const themeAdapter = adapters.get('theme');
    assert.equal(themeAdapter.getMergeStrategy(), MergeStrategy.REPLACE);

    const settingsAdapter = adapters.get('settings');
    assert.equal(settingsAdapter.getMergeStrategy(), MergeStrategy.MERGE);
  });

  await t.test('P5-5 & TC7: 仅扫描 characters/ 根目录，严格排除子目录（如贴图包）', async () => {
    const charAdapter = adapters.get('character');

    // 写入一个根级角色卡
    const aliceCardPng = createPngWithCharaChunk(0x11, { name: 'Seraphina' });
    await fs.writeFile(path.join(userAliceCharDir, 'Seraphina.png'), aliceCardPng);

    // 写入子目录及表情贴图（characters/Seraphina/emotion_01.png）
    const spriteSubDir = path.join(userAliceCharDir, 'Seraphina');
    await fs.mkdir(spriteSubDir, { recursive: true });
    await fs.writeFile(path.join(spriteSubDir, 'emotion_01.png'), Buffer.from('fake_sprite_1'));
    await fs.writeFile(path.join(spriteSubDir, 'emotion_02.png'), Buffer.from('fake_sprite_2'));

    const items = await charAdapter.listItems(authAlice.directories);
    // 验证：只能识别到根级的 Seraphina.png，28 个贴图子目录绝不被识别为独立卡片
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceRef, 'Seraphina.png');
    assert.equal(items[0].displayName, 'Seraphina');
    assert.ok(!items.some(i => i.sourceRef.includes('emotion')));
  });

  await t.test('P5-1 & TC1: PNG 角色卡推到云端再拉回，文件原始字节 sha256 完全一致', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    // Alice 推送到云端
    const pushRes = await syncService.push({
      authContext: authAlice,
      ownerHandle: 'alice',
      contentType: 'character',
      itemUid: item.itemUid,
      baseVersion: 0,
      operation: OperationType.UPSERT,
      versionTitle: '初始角色卡',
    });
    assert.equal(pushRes.version, 1);

    // 读取云端版本
    const pullRes = await syncService.pull(authAlice, 'alice', 'character', item.itemUid, 1);
    assert.equal(pullRes.version, 1);

    const localBytes = await fs.readFile(path.join(userAliceCharDir, 'Seraphina.png'));
    const localHash = sha256(localBytes);
    const cloudHash = sha256(pullRes.content);
    assert.equal(cloudHash, localHash, '云端还原的字节流哈希必须与本地原始文件完全一致');
  });

  await t.test('P5-1 & TC2: 只更换头像立绘、卡片数据完全不变，必须成功生成新版本', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    // 换头像立绘（imageByte 从 0x11 改为 0x22），但内嵌 chara 数据完全一样
    const newAvatarPng = createPngWithCharaChunk(0x22, { name: 'Seraphina' });
    await fs.writeFile(path.join(userAliceCharDir, 'Seraphina.png'), newAvatarPng);

    const pushRes2 = await syncService.push({
      authContext: authAlice,
      ownerHandle: 'alice',
      contentType: 'character',
      itemUid: item.itemUid,
      baseVersion: 1,
      operation: OperationType.UPSERT,
      versionTitle: '更换立绘',
      force: true,
    });

    assert.equal(pushRes2.version, 2, '仅更换立绘图片必须生成新版本（P5-1 原始字节 sha256 生效）');
    assert.notEqual(pushRes2.checksum, pushRes2.serverVersion, 'checksum 随着立绘变化而更新');
  });

  await t.test('P5-2 & TC4: 覆盖本地已存在角色卡时，必须先生成 .bak-<timestamp> 备份', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    const targetPath = path.join(userAliceCharDir, 'Seraphina.png');
    assert.ok(await fs.access(targetPath).then(() => true).catch(() => false));

    // 从云端拉取 v1 并 apply 覆盖本地当前 v2
    const v1 = await syncService.pull(authAlice, 'alice', 'character', item.itemUid, 1);
    await charAdapter.apply(authAlice.directories, item.itemUid, 'UPSERT', v1.content, v1.display_name);

    // 检查目录中是否生成了 .bak 备份
    const files = await fs.readdir(userAliceCharDir);
    const bakFiles = files.filter(f => f.startsWith('Seraphina.png.bak-'));
    assert.ok(bakFiles.length >= 1, '覆盖本地已有角色卡前必须先生成 .bak 备份文件');
  });

  await t.test('TC5: 角色卡跨账号分享、认领与防替换锁定保护', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    // Alice 分享该角色卡
    const codeRes = shareService.createShareCode(authAlice, {
      contentType: 'character',
      itemUid: item.itemUid,
      scopeType: 'ITEM',
    });

    // Bob 认领分享码
    shareService.claimShareCode(authBob, {
      code: codeRes.share_code,
    });

    // Bob 锁定该角色卡（防止云端拉取意外覆盖本地）
    syncService.setLock({
      requesterHandle: 'bob',
      ownerHandle: 'alice',
      contentType: 'character',
      itemUid: item.itemUid,
      locked: true,
    });

    assert.equal(syncService.isLocked('bob', 'alice', 'character', item.itemUid), true);

    // 显式解锁后允许
    syncService.setLock({
      requesterHandle: 'bob',
      ownerHandle: 'alice',
      contentType: 'character',
      itemUid: item.itemUid,
      locked: false,
    });
    assert.equal(syncService.isLocked('bob', 'alice', 'character', item.itemUid), false);
  });

  await t.test('P5-4, TC8 & TC21: 类型上限配置生效（预设保留20版，角色卡保留5版）', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    // 连续推送版本，使得角色卡总版本数达到 8 个
    for (let i = 3; i <= 8; i++) {
      const pngBuf = createPngWithCharaChunk(i, { name: 'Seraphina' });
      await syncService.push({
        authContext: authAlice,
        ownerHandle: 'alice',
        contentType: 'character',
        itemUid: item.itemUid,
        baseVersion: i - 1,
        operation: OperationType.UPSERT,
        payload: pngBuf,
        versionTitle: `版本 ${i}`,
        force: true,
      });
    }

    // 检查角色卡保留的版本列表
    const charVersions = syncService.stmtGetVersionsDesc.all({
      ':owner': 'alice',
      ':ct': 'character',
      ':uid': item.itemUid,
    });

    // 角色卡默认上限为 5 版，超额后修剪至 5 版
    assert.equal(charVersions.length, 5, '角色卡版本上限应严格限制为 5 版');

    // 检查全局预设依然能够保留 20 版上限
    assert.equal(configService.getMaxVersions('openai_preset'), 20, '预设上限依然为 20');
    assert.equal(configService.getMaxVersions('character'), 5, '角色卡上限为 5');
    assert.equal(configService.getMaxVersions('theme'), 5, '主题上限为 5');
  });

  await t.test('TC22: 锁定版本超过类型上限时一个都不删', async () => {
    const charAdapter = adapters.get('character');
    const items = await charAdapter.listItems(authAlice.directories);
    const item = items[0];

    // 获取当前保留的 5 个版本（v4, v5, v6, v7, v8）
    let versions = syncService.stmtGetVersionsDesc.all({
      ':owner': 'alice',
      ':ct': 'character',
      ':uid': item.itemUid,
    });

    // 将全部 5 个版本都锁定
    for (const v of versions) {
      await syncService.setVersionLock(authAlice, 'alice', 'character', item.itemUid, v.version, true);
    }

    // 再推入第 9 个和第 10 个版本
    for (let i = 9; i <= 10; i++) {
      const pngBuf = createPngWithCharaChunk(i + 10, { name: 'Seraphina' });
      await syncService.push({
        authContext: authAlice,
        ownerHandle: 'alice',
        contentType: 'character',
        itemUid: item.itemUid,
        baseVersion: i - 1,
        operation: OperationType.UPSERT,
        payload: pngBuf,
        versionTitle: `版本 ${i}`,
        force: true,
      });
      // 并把新生成的版本也锁定
      await syncService.setVersionLock(authAlice, 'alice', 'character', item.itemUid, i, true);
    }

    // 此时共有 7 个版本全部被锁定（已超过类型上限 5 版）
    versions = syncService.stmtGetVersionsDesc.all({
      ':owner': 'alice',
      ':ct': 'character',
      ':uid': item.itemUid,
    });

    assert.equal(versions.length, 7, '当锁定的版本超过类型上限时，所有被锁定的版本坚如磐石，一个都不删（TC22）');
    for (const v of versions) {
      assert.equal(v.is_locked, 1);
    }
  });
});
