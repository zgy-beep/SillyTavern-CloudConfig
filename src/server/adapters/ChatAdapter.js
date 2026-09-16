import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { ConfigAdapter, MergeStrategy } from './ConfigAdapter.js';
import { autoBackupLocalFile } from './P0Adapters.js';
import { makeItemUid, sha256 } from '../../common/utils.js';
import { ReloadStrategy } from '../../common/constants.js';

/**
 * 提取/计算单条消息的唯一稳定键 (N-10 复合键算法)
 * - 包含 mid 的消息：直接使用 'mid:' + mid
 * - 无 mid 的老消息 (真实数据约 14.6%)：
 *   基于 send_date | (is_user ? '1' : (is_system ? 's' : '0')) | name | mes 计算 sha256
 *   绝不包含易变字段 (gen_started, gen_finished, swipe_id, extra 等)
 * - 连续多重集保真：追加当前数组内的出现频次序列号 #1, #2...
 * @param {object} msg 消息对象
 * @param {Map<string, number>} occurrenceMap 键频次跟踪 Map
 * @returns {string} 唯一稳定键
 */
export function computeMessageKey(msg, occurrenceMap) {
  if (!msg || typeof msg !== 'object') {
    return 'invalid_msg#0';
  }

  let baseKey = '';
  if (msg.mid !== undefined && msg.mid !== null && msg.mid !== '') {
    baseKey = `mid:${msg.mid}`;
  } else {
    const isUserStr = msg.is_user ? '1' : (msg.is_system ? 's' : '0');
    const sendDateStr = String(msg.send_date ?? '');
    const nameStr = String(msg.name ?? '');
    const mesStr = String(msg.mes ?? '');
    const rawSig = `${sendDateStr}|${isUserStr}|${nameStr}|${mesStr}`;
    baseKey = `legacy:${sha256(rawSig)}`;
  }

  const count = (occurrenceMap.get(baseKey) || 0) + 1;
  occurrenceMap.set(baseKey, count);
  return `${baseKey}#${count}`;
}

/**
 * 合并两份会话的元数据（第 0 行）(N-1 字段级合并，冲突本地优先)
 */
export function mergeChatMetadata(localMeta = {}, incomingMeta = {}) {
  const result = { ...(incomingMeta || {}), ...(localMeta || {}) };

  // 针对嵌套的 chat_metadata 对象执行子字段级合并，本地优先
  if (
    localMeta?.chat_metadata && typeof localMeta.chat_metadata === 'object' &&
    incomingMeta?.chat_metadata && typeof incomingMeta.chat_metadata === 'object'
  ) {
    result.chat_metadata = {
      ...incomingMeta.chat_metadata,
      ...localMeta.chat_metadata,
    };
  }

  return result;
}

/**
 * 合并两条相同 key 的消息 (TC15: swipes 数组保序并集，双方分支全部保留，本地字段优先)
 */
export function mergeSingleMessage(localMsg, incomingMsg) {
  // 1. 合并 swipes 数组
  const localSwipes = Array.isArray(localMsg.swipes)
    ? localMsg.swipes
    : (localMsg.mes ? [localMsg.mes] : []);
  const incomingSwipes = Array.isArray(incomingMsg.swipes)
    ? incomingMsg.swipes
    : (incomingMsg.mes ? [incomingMsg.mes] : []);

  const mergedSwipes = [...localSwipes];
  for (const s of incomingSwipes) {
    if (!mergedSwipes.includes(s)) {
      mergedSwipes.push(s);
    }
  }

  // 2. 字段合并（N-1 本地优先）
  return {
    ...incomingMsg,
    ...localMsg,
    swipes: mergedSwipes,
  };
}

/**
 * 历史消息列表全量合并算法 (N-3 只增不减并集，时间升序)
 * @param {Array<object>} localMsgs
 * @param {Array<object>} incomingMsgs
 * @returns {Array<object>}
 */
export function mergeMessageLists(localMsgs = [], incomingMsgs = []) {
  const localMap = new Map();
  const localOccur = new Map();
  for (const msg of (localMsgs || [])) {
    const key = computeMessageKey(msg, localOccur);
    localMap.set(key, msg);
  }

  const incomingMap = new Map();
  const incomingOccur = new Map();
  for (const msg of (incomingMsgs || [])) {
    const key = computeMessageKey(msg, incomingOccur);
    incomingMap.set(key, msg);
  }

  const mergedMap = new Map();

  // 1. 处理所有 local 消息
  for (const [key, lMsg] of localMap) {
    if (incomingMap.has(key)) {
      mergedMap.set(key, mergeSingleMessage(lMsg, incomingMap.get(key)));
    } else {
      mergedMap.set(key, lMsg);
    }
  }

  // 2. 追加云端独有消息（N-3 只增不减并集）
  for (const [key, inMsg] of incomingMap) {
    if (!mergedMap.has(key)) {
      mergedMap.set(key, inMsg);
    }
  }

  // 3. 按 send_date 升序排列，保持自然对话时序
  const result = Array.from(mergedMap.values());
  result.sort((a, b) => {
    const tA = Number(a.send_date) || 0;
    const tB = Number(b.send_date) || 0;
    return tA - tB;
  });

  return result;
}

/**
 * 解析 JSONL 文本为 { metadata, messages }
 */
export function parseChatJsonl(text) {
  if (!text || typeof text !== 'string') {
    return { metadata: {}, messages: [] };
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return { metadata: {}, messages: [] };
  }

  let metadata = {};
  try {
    metadata = JSON.parse(lines[0]);
  } catch {
    metadata = {};
  }

  const messages = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      messages.push(JSON.parse(lines[i]));
    } catch {
      // 容错跳过损毁行
    }
  }

  return { metadata, messages };
}

/**
 * 序列化 { metadata, messages } 为规范 JSONL 文本
 */
export function formatChatJsonl(metadata, messages) {
  const metaLine = JSON.stringify(metadata || {});
  const msgLines = (messages || []).map(m => JSON.stringify(m));
  return [metaLine, ...msgLines].join('\n') + '\n';
}

/**
 * SillyTavern 历史记录（聊天会话）增量同步适配器
 * 落实 Phase 5.2 全量技术规格 (N-1 ~ N-4, N-10, N-11, TC13 ~ TC20, TC23, TC24)
 */
export class ChatAdapter extends ConfigAdapter {
  constructor() {
    super('chat', MergeStrategy.APPEND_MERGE, ReloadStrategy.CHAT);
  }

  resolveChatDirs(directories) {
    const userHandle = directories?.handle || 'default-user';
    const primary = directories?.chats
      || (directories?.root ? path.join(directories.root, 'chats') : null)
      || (directories?.user ? path.join(directories.user, 'chats') : null)
      || path.join(process.cwd(), 'data', userHandle, 'chats')
      || path.join(process.cwd(), 'public', 'chats');

    const candidates = Array.from(new Set([
      primary,
      directories?.chats,
      directories?.user ? path.join(directories.user, 'chats') : null,
      directories?.root ? path.join(directories.root, 'chats') : null,
      path.join(process.cwd(), 'data', userHandle, 'chats'),
      path.join(process.cwd(), 'public', 'chats'),
    ].filter(Boolean)));

    return { primary, candidates };
  }

  async getPrimaryDir(directories) {
    const { primary } = this.resolveChatDirs(directories);
    await fs.mkdir(primary, { recursive: true });
    return primary;
  }

  getCandidateDirs(directories) {
    return this.resolveChatDirs(directories).candidates;
  }

  /**
   * 扫描发现本地聊天会话文件 (.jsonl)
   * 严格排除 backups/ 与 vectors/ 目录 (TC16)
   */
  async listItems(directories) {
    const { candidates } = this.resolveChatDirs(directories);
    const seenFiles = new Set();
    const items = [];

    for (const baseDir of candidates) {
      if (!baseDir) continue;
      let entries = [];
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        // TC16 严格排除 backups/ 与 vectors/ 目录
        if (entry.name === 'backups' || entry.name === 'vectors') {
          continue;
        }

        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const sourceRef = entry.name;
          if (!seenFiles.has(sourceRef)) {
            seenFiles.add(sourceRef);
            const chatName = path.basename(entry.name, '.jsonl');
            items.push({
              itemUid: makeItemUid(this.contentType, sourceRef),
              displayName: chatName,
              chatName,
              sourceRef,
              actualDir: baseDir,
            });
          }
        } else if (entry.isDirectory()) {
          // 角色/群组子目录：检查内部 .jsonl 会话文件
          const subDirPath = path.join(baseDir, entry.name);
          let subEntries = [];
          try {
            subEntries = await fs.readdir(subDirPath, { withFileTypes: true });
          } catch {
            continue;
          }

          for (const subEntry of subEntries) {
            // 子目录下也坚决排除 backups/ 与 vectors/ (TC16)
            if (subEntry.name === 'backups' || subEntry.name === 'vectors') {
              continue;
            }
            if (subEntry.isFile() && subEntry.name.endsWith('.jsonl')) {
              const sourceRef = `${entry.name}/${subEntry.name}`.replace(/\\/g, '/');
              if (!seenFiles.has(sourceRef)) {
                seenFiles.add(sourceRef);
                const chatName = path.basename(subEntry.name, '.jsonl');
                items.push({
                  itemUid: makeItemUid(this.contentType, sourceRef),
                  displayName: `${entry.name} / ${chatName}`,
                  characterName: entry.name,
                  chatName,
                  sourceRef,
                  actualDir: baseDir,
                });
              }
            }
          }
        }
      }
    }

    return items;
  }

  resolveFilePath(directories, itemUid, items) {
    const item = items.find(i => i.itemUid === itemUid);
    if (item && item.actualDir) {
      return path.join(item.actualDir, item.sourceRef);
    }
    const { primary } = this.resolveChatDirs(directories);
    if (item) {
      return path.join(primary, item.sourceRef);
    }
    return null;
  }

  async read(directories, itemUid) {
    const items = await this.listItems(directories);
    const filePath = this.resolveFilePath(directories, itemUid, items);
    if (!filePath) {
      throw new Error(`Chat item ${itemUid} not found`);
    }
    const raw = await fs.readFile(filePath, 'utf8');
    return parseChatJsonl(raw);
  }

  async getFilePath(directories, itemUid) {
    const items = await this.listItems(directories);
    return this.resolveFilePath(directories, itemUid, items);
  }

  /**
   * 安全原子写入二进制文件（先写 tmp 再 rename）
   */
  async safeWriteFile(filePath, buffer) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);
  }

  async safeDeleteFile(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * 写入本地会话文件 (APPEND_MERGE 策略，覆盖前自动生成 .bak 备份)
   */
  async apply(directories, itemUid, operation, content, displayName = null) {
    const { primary } = this.resolveChatDirs(directories);
    const items = await this.listItems(directories);
    const existingInPrimary = items.find(i => i.itemUid === itemUid && i.actualDir === primary);
    const existingAny = items.find(i => i.itemUid === itemUid);

    // 1. 解析传入的 incoming 内容
    let incomingParsed = null;
    if (typeof content === 'string') {
      incomingParsed = parseChatJsonl(content);
    } else if (Buffer.isBuffer(content)) {
      incomingParsed = parseChatJsonl(content.toString('utf8'));
    } else if (content && Buffer.isBuffer(content.buffer)) {
      incomingParsed = parseChatJsonl(content.buffer.toString('utf8'));
    } else if (content && (content.metadata !== undefined || content.messages !== undefined)) {
      incomingParsed = {
        metadata: content.metadata || {},
        messages: Array.isArray(content.messages) ? content.messages : [],
      };
    } else {
      incomingParsed = { metadata: {}, messages: [] };
    }

    let targetRelPath = (existingInPrimary || existingAny) ? (existingInPrimary || existingAny).sourceRef : null;
    if (!targetRelPath) {
      let charFolder = incomingParsed.metadata?.character_name || null;
      let chatBaseName = null;

      if (displayName && displayName.includes(' / ')) {
        const parts = displayName.split(' / ');
        if (!charFolder) charFolder = parts[0].trim();
        chatBaseName = parts.slice(1).join('_').trim();
      } else if (displayName) {
        chatBaseName = displayName.trim();
      } else {
        chatBaseName = `chat_${itemUid.slice(0, 8)}`;
      }

      if (!chatBaseName.endsWith('.jsonl')) {
        chatBaseName += '.jsonl';
      }

      if (charFolder) {
        targetRelPath = path.join(charFolder.replace(/[\\/:*?"<>|]/g, '_'), chatBaseName);
      } else {
        targetRelPath = chatBaseName;
      }
    }

    const targetDir = (existingInPrimary || existingAny)?.actualDir || primary;
    const filePath = path.join(targetDir, targetRelPath);

    if (operation === 'UPSERT') {
      // 2. 检查本地文件是否存在
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      let finalJsonlStr = '';

      if (exists) {
        // 自动生成 .bak 备份保护 (TC4)
        await autoBackupLocalFile(filePath);

        const localRaw = await fs.readFile(filePath, 'utf8');
        const localParsed = parseChatJsonl(localRaw);

        // APPEND_MERGE: N-1 元数据合并 + N-3/N-10/TC15 消息并集
        const mergedMeta = mergeChatMetadata(localParsed.metadata, incomingParsed.metadata);
        const mergedMsgs = mergeMessageLists(localParsed.messages, incomingParsed.messages);
        finalJsonlStr = formatChatJsonl(mergedMeta, mergedMsgs);
      } else {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        finalJsonlStr = formatChatJsonl(incomingParsed.metadata, incomingParsed.messages);
      }

      // 3. 原子落盘
      await this.safeWriteFile(filePath, Buffer.from(finalJsonlStr, 'utf8'));
    } else if (operation === 'DELETE') {
      await this.safeDeleteFile(filePath);
    }
  }

  /**
   * 序列化为存储 Blob (完整的 JSONL 文本快照，N-4)
   */
  serialize(content) {
    if (Buffer.isBuffer(content)) {
      return { buffer: content, mimeType: 'application/x-ndjson', ext: 'jsonl' };
    }
    if (content && Buffer.isBuffer(content.buffer)) {
      return { buffer: content.buffer, mimeType: content.mimeType || 'application/x-ndjson', ext: content.ext || 'jsonl' };
    }
    if (typeof content === 'string') {
      return { buffer: Buffer.from(content, 'utf8'), mimeType: 'application/x-ndjson', ext: 'jsonl' };
    }
    if (content && (content.metadata !== undefined || content.messages !== undefined)) {
      const jsonlStr = formatChatJsonl(content.metadata, content.messages);
      return { buffer: Buffer.from(jsonlStr, 'utf8'), mimeType: 'application/x-ndjson', ext: 'jsonl' };
    }
    return { buffer: Buffer.from('{}\n', 'utf8'), mimeType: 'application/x-ndjson', ext: 'jsonl' };
  }

  deserialize(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer || '');
    }
    return parseChatJsonl(buffer.toString('utf8'));
  }

  /**
   * 规范化计算 Checksum：按 send_date 稳定排序后序列化 (P5-1, N-2)
   */
  canonicalize(content) {
    let parsed = null;
    if (typeof content === 'string') {
      parsed = parseChatJsonl(content);
    } else if (Buffer.isBuffer(content)) {
      parsed = parseChatJsonl(content.toString('utf8'));
    } else if (content && Buffer.isBuffer(content.buffer)) {
      parsed = parseChatJsonl(content.buffer.toString('utf8'));
    } else if (content && (content.metadata !== undefined || content.messages !== undefined)) {
      parsed = {
        metadata: content.metadata || {},
        messages: Array.isArray(content.messages) ? content.messages : [],
      };
    } else {
      parsed = { metadata: {}, messages: [] };
    }

    const sortedMsgs = [...(parsed.messages || [])];
    sortedMsgs.sort((a, b) => {
      const tA = Number(a.send_date) || 0;
      const tB = Number(b.send_date) || 0;
      return tA - tB;
    });

    const canonicalStr = formatChatJsonl(parsed.metadata, sortedMsgs);
    return Buffer.from(canonicalStr, 'utf8');
  }
}
