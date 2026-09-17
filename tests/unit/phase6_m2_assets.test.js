import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { BackgroundAdapter, resolveBackgroundDirs } from '../../src/server/adapters/BackgroundAdapter.js';
import { PersonaAdapter, resolvePersonaDirs } from '../../src/server/adapters/PersonaAdapter.js';
import { AvatarAdapter, resolveAvatarDirs } from '../../src/server/adapters/AvatarAdapter.js';
import { GroupAdapter, resolveGroupDirs } from '../../src/server/adapters/GroupAdapter.js';
import { GroupChatAdapter, resolveGroupChatDirs } from '../../src/server/adapters/GroupChatAdapter.js';
import { SpritesAdapter } from '../../src/server/adapters/SpritesAdapter.js';
import { DeterministicZip } from '../../src/server/utils/DeterministicZip.js';
import { DatabaseClient } from '../../src/server/db/database.js';
import { ShareService } from '../../src/server/services/ShareService.js';
import { ConfigService } from '../../src/server/config/ConfigService.js';
import { AuditService } from '../../src/server/services/AuditService.js';
import { NON_SHAREABLE_CONTENT_TYPES, SHAREABLE_CONTENT_TYPES, isShareableContentType } from '../../src/common/constants.js';
import { makeItemUid, sha256 } from '../../src/common/utils.js';

test('Phase 6 Milestone 2: 全资产生态闭环与海量管理 (M2 专项测试套件)', async (t) => {
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgsync_m2_'));

  t.after(async () => {
    try {
      await fs.rm(tempBase, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. BackgroundAdapter: 真实路径定位在 data/<user>/backgrounds/，严禁 public/，中文/空格文件名稳健性 (P6-1)', async () => {
    const userHandle = 'nuobao_test';
    const dirs = {
      handle: userHandle,
      user: path.join(tempBase, 'data', userHandle),
      backgrounds: path.join(tempBase, 'data', userHandle, 'backgrounds'),
    };

    const { primary, candidates } = resolveBackgroundDirs(dirs);
    assert.strictEqual(primary, dirs.backgrounds);
    // P6-1 铁律：候选路径中绝无 public/backgrounds
    for (const c of candidates) {
      assert.strictEqual(c.includes('public'), false, `Candidate must not contain public: ${c}`);
    }

    await fs.mkdir(dirs.backgrounds, { recursive: true });
    const bgName = '幻想 森林 01.png';
    const bgPath = path.join(dirs.backgrounds, bgName);
    const bgContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03]);
    await fs.writeFile(bgPath, bgContent);

    const adapter = new BackgroundAdapter();
    const items = await adapter.listItems(dirs);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].displayName, bgName);
    assert.strictEqual(items[0].sourceRef, bgName);
    assert.strictEqual(items[0].itemUid, makeItemUid('background', bgName));

    // 读取测试
    const readBuf = await adapter.read(dirs, items[0].itemUid);
    assert.deepStrictEqual(readBuf, bgContent);

    // 覆盖更新测试：触发 autoBackupLocalFile
    const updatedContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x99, 0x88]);
    await adapter.apply(dirs, items[0].itemUid, 'UPSERT', updatedContent, bgName);

    const reReadBuf = await adapter.read(dirs, items[0].itemUid);
    assert.deepStrictEqual(reReadBuf, updatedContent);

    // 验证 .bak 备份文件存在
    const allFiles = await fs.readdir(dirs.backgrounds);
    const backupFile = allFiles.find(f => f.startsWith(`${bgName}.bak-`));
    assert.ok(backupFile, 'Backup file should be created before overwrite');
  });

  await t.test('2. PersonaAdapter & AvatarAdapter: 用户人设与头像动态关联及容错 (P6-1)', async () => {
    const userHandle = 'nuobao_persona_test';
    const userDir = path.join(tempBase, 'data', userHandle);
    const personaDir = path.join(userDir, 'personas');
    const avatarDir = path.join(userDir, 'User Avatars');
    await fs.mkdir(personaDir, { recursive: true });
    await fs.mkdir(avatarDir, { recursive: true });

    const dirs = {
      handle: userHandle,
      user: userDir,
      personas: personaDir,
      'User Avatars': avatarDir,
    };

    // 1. Persona 测试
    const personaAdapter = new PersonaAdapter();
    const personaData = { name: '糯宝旅行家', description: '探索全宇宙的数字漫游者' };
    const personaFileName = '糯宝旅行家.json';
    await fs.writeFile(path.join(personaDir, personaFileName), JSON.stringify(personaData), 'utf8');

    const pItems = await personaAdapter.listItems(dirs);
    assert.strictEqual(pItems.length, 1);
    assert.strictEqual(pItems[0].displayName, '糯宝旅行家');
    const readPersona = await personaAdapter.read(dirs, pItems[0].itemUid);
    assert.deepStrictEqual(readPersona, personaData);

    // 2. Avatar 测试与大小写自适应
    const avatarAdapter = new AvatarAdapter();
    const avatarBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x11, 0x22]);
    const avatarFileName = '糯宝旅行家.png';
    await fs.writeFile(path.join(avatarDir, avatarFileName), avatarBuf);

    const aItems = await avatarAdapter.listItems(dirs);
    assert.strictEqual(aItems.length, 1);
    assert.strictEqual(aItems[0].displayName, avatarFileName);

    // 头像关联查询：存在时匹配成功
    const matchedAvatar = await avatarAdapter.findAvatarForPersona(dirs, '糯宝旅行家');
    assert.ok(matchedAvatar && matchedAvatar.endsWith(avatarFileName));

    // 头像改名或缺失时：优雅返回 null，绝对不抛异常
    const missingAvatar = await avatarAdapter.findAvatarForPersona(dirs, '不存在的人设');
    assert.strictEqual(missingAvatar, null);
  });

  await t.test('3. GroupAdapter: 群组设定 DirectoryJson 适配与跨账号共享标记', async () => {
    const userHandle = 'group_test_user';
    const groupDir = path.join(tempBase, 'data', userHandle, 'groups');
    await fs.mkdir(groupDir, { recursive: true });
    const dirs = { handle: userHandle, groups: groupDir };

    const adapter = new GroupAdapter();
    const groupData = { id: 'grp_001', name: '探索小分队', members: ['chara_1', 'chara_2'] };
    await fs.writeFile(path.join(groupDir, '探索小分队.json'), JSON.stringify(groupData), 'utf8');

    const items = await adapter.listItems(dirs);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].displayName, '探索小分队');

    const content = await adapter.read(dirs, items[0].itemUid);
    assert.deepStrictEqual(content, groupData);

    // 确认 group 处于可共享白名单
    assert.strictEqual(isShareableContentType('group'), true);
    assert.strictEqual(SHAREABLE_CONTENT_TYPES.includes('group'), true);
  });

  await t.test('4. GroupChatAdapter: data/<user>/group chats/ 路径与 APPEND_MERGE 继承 (P6-1)', async () => {
    const userHandle = 'group_chat_user';
    const groupChatDir = path.join(tempBase, 'data', userHandle, 'group chats');
    await fs.mkdir(groupChatDir, { recursive: true });
    const dirs = { handle: userHandle, 'group chats': groupChatDir };

    const { primary } = resolveGroupChatDirs(dirs);
    assert.strictEqual(primary, groupChatDir);

    const adapter = new GroupChatAdapter();
    const chatFileName = '冒险旅途会话.jsonl';
    const metaLine = JSON.stringify({ user_name: '糯宝', group_name: '探索小分队', chat_metadata: { note: '重要会话' } });
    const msg1Line = JSON.stringify({ mid: 101, send_date: 1700000000, name: '糯宝', mes: '大家好！', is_user: true });
    await fs.writeFile(path.join(groupChatDir, chatFileName), `${metaLine}\n${msg1Line}\n`, 'utf8');

    const items = await adapter.listItems(dirs);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].displayName, '冒险旅途会话');
    assert.strictEqual(items[0].itemUid, makeItemUid('group_chat', chatFileName));

    // 执行追加合并 apply
    const incomingData = {
      metadata: { group_name: '探索小分队', chat_metadata: { cloud_tag: 'synced' } },
      messages: [
        { mid: 101, send_date: 1700000000, name: '糯宝', mes: '大家好！', is_user: true },
        { mid: 102, send_date: 1700000010, name: '艾莉', mes: '收到！', is_user: false },
      ],
    };

    await adapter.apply(dirs, items[0].itemUid, 'UPSERT', incomingData, '冒险旅途会话');
    const merged = await adapter.read(dirs, items[0].itemUid);
    assert.strictEqual(merged.messages.length, 2);
    assert.strictEqual(merged.messages[0].mid, 101);
    assert.strictEqual(merged.messages[1].mid, 102);
    // 元数据本地优先 + 云端补充
    assert.strictEqual(merged.metadata.chat_metadata.note, '重要会话');
    assert.strictEqual(merged.metadata.chat_metadata.cloud_tag, 'synced');
  });

  await t.test('5. 🔴 GroupChat 跨账号分享坚决 400 硬拒铁律 (N-1, NON_SHAREABLE_CONTENT_TYPES)', async () => {
    // 确认 group_chat 严格列入不可共享黑名单
    assert.strictEqual(NON_SHAREABLE_CONTENT_TYPES.includes('group_chat'), true);
    assert.strictEqual(isShareableContentType('group_chat'), false);

    // 初始化测试数据库与 ShareService
    const dbPath = path.join(tempBase, 'test_share.sqlite');
    const dbClient = new DatabaseClient(dbPath);
    const auditService = new AuditService(dbClient);
    const configService = new ConfigService(path.join(tempBase, 'cfgsync_config.json'));
    const shareService = new ShareService(dbClient, auditService, configService, { dataRoot: tempBase });

    // 先插入一条 group_chat 记录
    dbClient.prepare(`
      INSERT INTO config_records (owner_handle, content_type, item_uid, display_name, current_version, is_deleted, updated_at)
      VALUES ('user_a', 'group_chat', 'grp_chat_uid_123', '小队聊天', 1, 0, ${Date.now()})
    `).run();

    const authContext = { handle: 'user_a' };

    // 1. 测试创建分享码：必须坚决抛出 400 异常
    assert.throws(() => {
      shareService.createShareCode(authContext, {
        contentType: 'group_chat',
        itemUid: 'grp_chat_uid_123',
      });
    }, (err) => {
      assert.strictEqual(err.status, 400);
      assert.ok(err.message.includes('not shareable'));
      return true;
    });

    // 2. 测试开启公开分享：必须坚决抛出 400 异常
    assert.throws(() => {
      shareService.setPublicShare(authContext, {
        contentType: 'group_chat',
        itemUid: 'grp_chat_uid_123',
        enabled: true,
      });
    }, (err) => {
      assert.strictEqual(err.status, 400);
      assert.ok(err.message.includes('not shareable'));
      return true;
    });
  });

  await t.test('6. 🔴 Sprites ZIP 确定性字节稳定规约与双重打包 sha256 绝对一致断言 (P6-2)', async () => {
    const spritesDir = path.join(tempBase, 'sprites_source');
    await fs.mkdir(spritesDir, { recursive: true });

    // 故意乱序写入贴图文件（测试文件名自然序排序）
    await fs.writeFile(path.join(spritesDir, 'smile.png'), Buffer.from('smile_sprite_bytes_001'));
    await fs.writeFile(path.join(spritesDir, 'angry.png'), Buffer.from('angry_sprite_bytes_002'));
    await fs.writeFile(path.join(spritesDir, 'crying.png'), Buffer.from('crying_sprite_bytes_003'));
    await fs.writeFile(path.join(spritesDir, 'neutral.png'), Buffer.from('neutral_sprite_bytes_004'));

    // P6-2 硬性断言：“同一目录连续打包两次，生成 ZIP 的 sha256 必须字节级 100% 相同”
    const zip1 = await DeterministicZip.packDirectory(spritesDir);
    const zip2 = await DeterministicZip.packDirectory(spritesDir);

    const hash1 = crypto.createHash('sha256').update(zip1).digest('hex');
    const hash2 = crypto.createHash('sha256').update(zip2).digest('hex');

    assert.strictEqual(hash1, hash2, 'Pack twice MUST yield identical sha256');
    assert.strictEqual(zip1.length, zip2.length);

    // 校验解压出的文件列表与排序
    const unpacked = DeterministicZip.unpack(zip1);
    assert.strictEqual(unpacked.length, 4);
    assert.strictEqual(unpacked[0].name, 'angry.png');
    assert.strictEqual(unpacked[1].name, 'crying.png');
    assert.strictEqual(unpacked[2].name, 'neutral.png');
    assert.strictEqual(unpacked[3].name, 'smile.png');
    assert.deepStrictEqual(unpacked[3].data, Buffer.from('smile_sprite_bytes_001'));
  });

  await t.test('7. SpritesAdapter: 本地表情包扫描、打包与非破坏性增量还原 (不删本地独有贴图)', async () => {
    const userHandle = 'sprites_user';
    const charDir = path.join(tempBase, 'data', userHandle, 'characters');
    const seraphinaDir = path.join(charDir, 'Seraphina');
    await fs.mkdir(seraphinaDir, { recursive: true });

    const dirs = { handle: userHandle, characters: charDir };

    // 写入 Seraphina 贴图
    await fs.writeFile(path.join(seraphinaDir, 'joy.png'), Buffer.from('joy_expression'));
    await fs.writeFile(path.join(seraphinaDir, 'sad.png'), Buffer.from('sad_expression'));

    const adapter = new SpritesAdapter();
    const items = await adapter.listItems(dirs);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].characterName, 'Seraphina');
    assert.strictEqual(items[0].displayName, 'Seraphina 表情贴图包');
    assert.strictEqual(items[0].spriteCount, 2);

    // 读取并打包
    const zipBuf = await adapter.read(dirs, items[0].itemUid);
    assert.ok(Buffer.isBuffer(zipBuf));

    // 模拟目标环境拥有本地独有贴图 local_custom.png
    await fs.writeFile(path.join(seraphinaDir, 'local_custom.png'), Buffer.from('my_custom_sprite'));

    // 执行还原
    await adapter.apply(dirs, items[0].itemUid, 'UPSERT', zipBuf, 'Seraphina 表情贴图包');

    // 验证还原后文件：ZIP 内的 joy.png、sad.png 正常还原，本地独有 local_custom.png 完好保留（加法还原）
    assert.ok(fsSync.existsSync(path.join(seraphinaDir, 'joy.png')));
    assert.ok(fsSync.existsSync(path.join(seraphinaDir, 'sad.png')));
    assert.ok(fsSync.existsSync(path.join(seraphinaDir, 'local_custom.png')), 'Local custom sprite must be preserved');

    // 验证备份目录生成
    const charEntries = await fs.readdir(charDir);
    const backupDir = charEntries.find(e => e.startsWith('Seraphina.bak-'));
    assert.ok(backupDir, 'Backup directory Seraphina.bak-<timestamp> should be created');
  });

  await t.test('8. DeterministicZip 安全防护：防范目录穿越漏洞 (Path Traversal Protection)', async () => {
    // 构造恶意的 ZIP 文件头（携带 ../malicious.txt）
    const maliciousEntries = [
      { name: '../outside.txt', data: Buffer.from('hacked') },
    ];

    assert.throws(() => {
      const badZip = DeterministicZip.pack(maliciousEntries);
      DeterministicZip.unpack(badZip);
    }, (err) => {
      assert.ok(err.message.includes('Path traversal'));
      return true;
    });
  });

  await t.test('9. ConfigService: 全资产类别版本上限默认值合规性检查 (M2 矩阵)', async () => {
    const cs = new ConfigService();
    assert.strictEqual(cs.getMaxVersions('character'), 5);
    assert.strictEqual(cs.getMaxVersions('theme'), 5);
    assert.strictEqual(cs.getMaxVersions('background'), 3);
    assert.strictEqual(cs.getMaxVersions('avatar'), 5);
    assert.strictEqual(cs.getMaxVersions('persona'), 20);
    assert.strictEqual(cs.getMaxVersions('group'), 20);
    assert.strictEqual(cs.getMaxVersions('group_chat'), 5);
    assert.strictEqual(cs.getMaxVersions('sprites'), 3);
    assert.strictEqual(cs.getMaxVersions('chat'), 5);
  });

  await t.test('10. CharacterAdapter 与 SpritesAdapter 互不干扰和谐共存 (P5-5 & P6-2 Harmony)', async () => {
    const userHandle = 'harmony_user';
    const charDir = path.join(tempBase, 'data', userHandle, 'characters');
    const seraphinaDir = path.join(charDir, 'Seraphina');
    await fs.mkdir(seraphinaDir, { recursive: true });

    // 写入一个角色卡普通文件和一个贴图子目录
    await fs.writeFile(path.join(charDir, 'Seraphina.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x11, 0x22]));
    await fs.writeFile(path.join(seraphinaDir, 'smile.png'), Buffer.from('smile_sprite'));

    const dirs = { handle: userHandle, characters: charDir };

    const charAdapter = new (await import('../../src/server/adapters/CharacterAdapter.js')).CharacterAdapter();
    const spriteAdapter = new SpritesAdapter();

    const charItems = await charAdapter.listItems(dirs);
    const spriteItems = await spriteAdapter.listItems(dirs);

    // 角色卡仅识别普通文件 Seraphina.png，坚决不把 Seraphina/ 目录当成角色卡
    assert.strictEqual(charItems.length, 1);
    assert.strictEqual(charItems[0].displayName, 'Seraphina');
    assert.strictEqual(charItems[0].sourceRef, 'Seraphina.png');

    // 贴图适配器仅识别 Seraphina/ 目录，不把 Seraphina.png 当成贴图目录
    assert.strictEqual(spriteItems.length, 1);
    assert.strictEqual(spriteItems[0].characterName, 'Seraphina');
    assert.strictEqual(spriteItems[0].sourceRef, 'Seraphina');
  });

  await t.test('11. Sprites 3 版本上限轮转与锁定快照不修剪铁律 (M2 验收矩阵 #5)', async () => {
    const dbPath = path.join(tempBase, 'test_prune.sqlite');
    const dbClient = new DatabaseClient(dbPath);
    const configService = new ConfigService(path.join(tempBase, 'cfgsync_config.json'));
    const { SyncService } = await import('../../src/server/services/SyncService.js');
    const { SnapshotStore } = await import('../../src/server/storage/SnapshotStore.js');
    const { AuthorizationService } = await import('../../src/server/services/AuthorizationService.js');

    const authService = new AuthorizationService(dbClient, configService);
    const snapshotStore = new SnapshotStore();
    const syncService = new SyncService(dbClient, new Map(), snapshotStore, authService, configService);

    const owner = 'alice';
    const ct = 'sprites';
    const uid = 'sprite_uid_test';

    // 插入初始记录
    dbClient.prepare(`
      INSERT INTO config_records (owner_handle, content_type, item_uid, display_name, current_version, is_deleted, updated_at)
      VALUES (:owner, :ct, :uid, '测试贴图包', 4, 0, ${Date.now()})
    `).run({ ':owner': owner, ':ct': ct, ':uid': uid });

    // 插入 4 个版本，其中版本 2 设置为锁定 (is_locked = 1)
    for (let v = 1; v <= 4; v++) {
      dbClient.prepare(`
        INSERT INTO config_versions (owner_handle, content_type, item_uid, version, operation, checksum, is_locked, created_at)
        VALUES (:owner, :ct, :uid, :version, 'UPSERT', :chk, :locked, ${Date.now() + v})
      `).run({
        ':owner': owner,
        ':ct': ct,
        ':uid': uid,
        ':version': v,
        ':chk': `chk_${v}`,
        ':locked': v === 2 ? 1 : 0,
      });
    }

    // 执行修剪（sprites 限额为 3）
    await syncService.pruneVersions(owner, ct, uid);

    const remaining = dbClient.prepare(`
      SELECT version, is_locked FROM config_versions
      WHERE owner_handle = :owner AND content_type = :ct AND item_uid = :uid
      ORDER BY version ASC
    `).all({ ':owner': owner, ':ct': ct, ':uid': uid });

    // 应该保留 3 个版本：版本 1（未锁定旧版）被修剪；版本 2（已锁定）被保护保留；版本 3、4 保留
    assert.strictEqual(remaining.length, 3);
    const versions = remaining.map(r => r.version);
    assert.deepStrictEqual(versions, [2, 3, 4]);
    assert.strictEqual(remaining.find(r => r.version === 2).is_locked, 1);
  });

  await t.test('12. Panel UI: 搜索与分类下拉筛选支持 (DOM 纯净模拟)', async () => {
    const { CloudConfigPanel } = await import('../../src/client/ui/panel.js');

    // 简单模拟 DOM 容器
    const eventListeners = new Map();
    const mockContainer = {
      innerHTML: '',
      querySelector: (selector) => {
        if (selector === '#cfgsync-search-input') {
          return {
            value: '',
            dataset: {},
            addEventListener: (evt, fn) => eventListeners.set(`search:${evt}`, fn),
          };
        }
        if (selector === '#cfgsync-category-filter') {
          return {
            value: '',
            dataset: {},
            children: [],
            appendChild: () => {},
            addEventListener: (evt, fn) => eventListeners.set(`cat:${evt}`, fn),
          };
        }
        return null;
      },
      querySelectorAll: () => [],
    };

    const panel = new CloudConfigPanel({
      api: { getContentTypes: async () => ({ activeTypes: ['character', 'background', 'sprites'] }) },
      syncManager: {},
      storage: { getBindingsByAccount: async () => [] },
      accountHandle: 'alice',
    });

    panel.container = mockContainer;
    panel.bindSearchFilter();

    // 验证搜索监听器与分类监听器成功挂载
    assert.ok(eventListeners.has('search:input'));
    assert.ok(eventListeners.has('cat:change'));
  });
});

