import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 确定性字节稳定 ZIP 打包与解压工具类 (P6-2)
 * 遵循四条核心规约：
 * 1. 目录内文件严格按相对路径字典序（Alphanumeric Sort）排列入包
 * 2. ZIP 条目时间戳强制固定为 MS-DOS 规范 Epoch 零点（1980-01-01 00:00:00）
 * 3. 统一采用固定 Deflate Level 6 压缩
 * 4. 连续两次打包相同内容 sha256 必须字节级 100% 相同
 */
export class DeterministicZip {
  /**
   * 将内存中文件列表打包为确定性 ZIP Buffer
   * @param {Array<{ name: string, data: Buffer }>} entries
   * @returns {Buffer}
   */
  static pack(entries) {
    // 1. 规范化文件名路径并按相对路径字典序严格排序 (Alphanumeric Sort)
    const sorted = [...entries].map(e => ({
      name: e.name.replace(/\\/g, '/').replace(/^\/+/, ''),
      data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || ''),
    })).sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const localHeaders = [];
    const cdHeaders = [];
    let offset = 0;

    for (const entry of sorted) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const data = entry.data;
      const crc = zlib.crc32(data);
      // 空数据直接存储，非空采用 Deflate Level 6 压缩
      const isCompressed = data.length > 0;
      const compressed = isCompressed ? zlib.deflateRawSync(data, { level: 6 }) : data;
      const method = isCompressed ? 8 : 0;

      // Local file header (30 bytes + nameBuf.length)
      const lh = Buffer.alloc(30 + nameBuf.length);
      lh.writeUInt32LE(0x04034b50, 0); // Local header signature
      lh.writeUInt16LE(20, 4);         // Version needed: 2.0
      lh.writeUInt16LE(0x0800, 6);     // General purpose bit flag: UTF-8 filename (Bit 11)
      lh.writeUInt16LE(method, 8);     // Compression method (8 = deflate, 0 = store)
      lh.writeUInt16LE(0, 10);         // Last mod file time: 00:00:00
      lh.writeUInt16LE(0x0021, 12);     // Last mod file date: 1980-01-01 (DOS: Y=0, M=1, D=1)
      lh.writeUInt32LE(crc, 14);       // CRC-32
      lh.writeUInt32LE(compressed.length, 18); // Compressed size
      lh.writeUInt32LE(data.length, 22);       // Uncompressed size
      lh.writeUInt16LE(nameBuf.length, 26);    // File name length
      lh.writeUInt16LE(0, 28);                 // Extra field length
      nameBuf.copy(lh, 30);

      const localOffset = offset;
      offset += lh.length + compressed.length;
      localHeaders.push(lh, compressed);

      // Central directory header (46 bytes + nameBuf.length)
      const cdh = Buffer.alloc(46 + nameBuf.length);
      cdh.writeUInt32LE(0x02014b50, 0); // Central directory signature
      cdh.writeUInt16LE(20, 4);         // Version made by
      cdh.writeUInt16LE(20, 6);         // Version needed
      cdh.writeUInt16LE(0x0800, 8);     // Flags: UTF-8
      cdh.writeUInt16LE(method, 10);    // Compression method
      cdh.writeUInt16LE(0, 12);         // Mod time: 00:00:00
      cdh.writeUInt16LE(0x0021, 14);    // Mod date: 1980-01-01
      cdh.writeUInt32LE(crc, 16);       // CRC-32
      cdh.writeUInt32LE(compressed.length, 20); // Compressed size
      cdh.writeUInt32LE(data.length, 24);       // Uncompressed size
      cdh.writeUInt16LE(nameBuf.length, 28);    // File name length
      cdh.writeUInt16LE(0, 30);                 // Extra field length
      cdh.writeUInt16LE(0, 32);                 // Comment length
      cdh.writeUInt16LE(0, 34);                 // Disk number start
      cdh.writeUInt16LE(0, 36);                 // Internal attributes
      cdh.writeUInt32LE(0, 38);                 // External attributes
      cdh.writeUInt32LE(localOffset, 42);       // Relative offset of local header
      nameBuf.copy(cdh, 46);
      cdHeaders.push(cdh);
    }

    const cdBuf = Buffer.concat(cdHeaders);
    const cdOffset = offset;
    const cdSize = cdBuf.length;

    // End of central directory record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);       // EOCD signature
    eocd.writeUInt16LE(0, 4);                // Number of this disk
    eocd.writeUInt16LE(0, 6);                // Disk where CD starts
    eocd.writeUInt16LE(sorted.length, 8);    // Number of CD records on this disk
    eocd.writeUInt16LE(sorted.length, 10);   // Total number of CD records
    eocd.writeUInt32LE(cdSize, 12);          // Size of CD
    eocd.writeUInt32LE(cdOffset, 16);        // Offset of CD start
    eocd.writeUInt16LE(0, 20);               // Comment length

    return Buffer.concat([...localHeaders, cdBuf, eocd]);
  }

  /**
   * 将本地目录递归打包为确定性 ZIP Buffer
   * @param {string} dirPath
   * @returns {Promise<Buffer>}
   */
  static async packDirectory(dirPath) {
    const entries = [];

    async function walk(currentDir, relativePrefix = '') {
      let items;
      try {
        items = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }

      for (const item of items) {
        // 忽略备份文件与临时文件
        if (item.name.includes('.bak-') || item.name.endsWith('.tmp')) {
          continue;
        }

        const fullPath = path.join(currentDir, item.name);
        const relPath = relativePrefix ? `${relativePrefix}/${item.name}` : item.name;

        if (item.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (item.isFile()) {
          const data = await fs.readFile(fullPath);
          entries.push({ name: relPath, data });
        }
      }
    }

    await walk(dirPath);
    return this.pack(entries);
  }

  /**
   * 解析 ZIP Buffer 提取所有条目
   * @param {Buffer} zipBuffer
   * @returns {Array<{ name: string, data: Buffer }>}
   */
  static unpack(zipBuffer) {
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
      throw new Error('Invalid or corrupted ZIP buffer: too short');
    }

    // 1. 逆向查找 End of Central Directory Record (EOCD: 0x06054b50)
    let eocdOffset = -1;
    const maxSearch = Math.min(zipBuffer.length - 22, 65535 + 22);
    for (let i = zipBuffer.length - 22; i >= zipBuffer.length - 22 - maxSearch; i--) {
      if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error('Corrupted ZIP buffer: End of Central Directory not found');
    }

    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    const results = [];
    let curCd = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
      if (curCd + 46 > zipBuffer.length) {
        throw new Error('Corrupted ZIP buffer: truncated Central Directory');
      }

      const sig = zipBuffer.readUInt32LE(curCd);
      if (sig !== 0x02014b50) {
        throw new Error(`Corrupted ZIP buffer: invalid CD signature 0x${sig.toString(16)} at ${curCd}`);
      }

      const method = zipBuffer.readUInt16LE(curCd + 10);
      const expectedCrc = zipBuffer.readUInt32LE(curCd + 16);
      const compSize = zipBuffer.readUInt32LE(curCd + 20);
      const uncompSize = zipBuffer.readUInt32LE(curCd + 24);
      const nameLen = zipBuffer.readUInt16LE(curCd + 28);
      const extraLen = zipBuffer.readUInt16LE(curCd + 30);
      const commentLen = zipBuffer.readUInt16LE(curCd + 32);
      const localOffset = zipBuffer.readUInt32LE(curCd + 42);

      const nameStart = curCd + 46;
      const fileName = zipBuffer.subarray(nameStart, nameStart + nameLen).toString('utf8');

      // 安全防目录穿越检查
      const normalizedName = fileName.replace(/\\/g, '/');
      if (normalizedName.startsWith('/') || normalizedName.includes('../') || normalizedName === '..') {
        throw new Error(`Path traversal attempt in ZIP entry: ${fileName}`);
      }

      // 读取 Local Header
      if (localOffset + 30 > zipBuffer.length) {
        throw new Error(`Corrupted ZIP buffer: truncated local header for ${fileName}`);
      }
      const lhSig = zipBuffer.readUInt32LE(localOffset);
      if (lhSig !== 0x04034b50) {
        throw new Error(`Corrupted ZIP buffer: invalid local header signature for ${fileName}`);
      }
      const lhNameLen = zipBuffer.readUInt16LE(localOffset + 26);
      const lhExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + lhNameLen + lhExtraLen;

      if (dataOffset + compSize > zipBuffer.length) {
        throw new Error(`Corrupted ZIP buffer: compressed data out of bounds for ${fileName}`);
      }

      const rawData = zipBuffer.subarray(dataOffset, dataOffset + compSize);
      let uncompressedData;

      if (method === 0) {
        uncompressedData = rawData;
      } else if (method === 8) {
        uncompressedData = zlib.inflateRawSync(rawData);
      } else {
        throw new Error(`Unsupported compression method ${method} for ${fileName}`);
      }

      // 校验 CRC32
      const actualCrc = zlib.crc32(uncompressedData);
      if (actualCrc !== expectedCrc) {
        throw new Error(`CRC-32 mismatch for ${fileName}: expected ${expectedCrc}, got ${actualCrc}`);
      }

      results.push({
        name: normalizedName,
        data: uncompressedData,
      });

      curCd += 46 + nameLen + extraLen + commentLen;
    }

    return results;
  }

  /**
   * 解压 ZIP 到指定目录（安全写入，不删未在 ZIP 中的本地文件，加法还原）
   * @param {Buffer} zipBuffer
   * @param {string} targetDir
   */
  static async unpackToDirectory(zipBuffer, targetDir) {
    const entries = this.unpack(zipBuffer);
    await fs.mkdir(targetDir, { recursive: true });

    for (const entry of entries) {
      const outPath = path.join(targetDir, entry.name);
      // 安全二次核验防止路径穿越
      const resolved = path.resolve(outPath);
      const resolvedTarget = path.resolve(targetDir);
      if (!resolved.startsWith(resolvedTarget)) {
        throw new Error(`Path traversal attempt to write outside targetDir: ${entry.name}`);
      }

      await fs.mkdir(path.dirname(outPath), { recursive: true });
      const tmpPath = `${outPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, entry.data);
      await fs.rename(tmpPath, outPath);
    }

    return entries;
  }
}
