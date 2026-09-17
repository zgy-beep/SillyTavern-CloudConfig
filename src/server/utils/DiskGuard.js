import fs from 'node:fs';

export class InsufficientStorageError extends Error {
  constructor(message, availableBytes, requiredBytes) {
    super(message);
    this.name = 'InsufficientStorageError';
    this.status = 507;
    this.code = 'INSUFFICIENT_STORAGE';
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
  }
}

/**
 * 动态磁盘余量守卫 (N-9, #10, #24)
 * 阈值计算公式：Threshold = max(50MB, 本次待写体积 * 3)
 */
export class DiskGuard {
  static MIN_FREE_BYTES = 50 * 1024 * 1024; // 50MB 绝对安全底线

  /**
   * 检查指定路径的磁盘可用空间
   * @param {string} targetDir 检查目标路径
   * @param {number} payloadSizeBytes 本次待写数据字节数
   * @param {number|null} [mockAvailableBytes] 仅供单元测试模拟余量
   * @returns {{ ok: boolean, availableBytes: number, requiredBytes: number }}
   * @throws {InsufficientStorageError} 当可用空间不足时抛出 507 异常
   */
  static checkSpace(targetDir, payloadSizeBytes = 0, mockAvailableBytes = null) {
    const size = Math.max(Number(payloadSizeBytes) || 0, 0);
    const requiredBytes = Math.max(DiskGuard.MIN_FREE_BYTES, size * 3);

    let availableBytes = null;
    if (mockAvailableBytes !== null && mockAvailableBytes !== undefined) {
      availableBytes = Number(mockAvailableBytes);
    } else {
      try {
        const stats = fs.statfsSync(targetDir || process.cwd());
        availableBytes = Number(stats.bavail) * Number(stats.bsize);
      } catch (err) {
        // 部分特殊虚拟文件系统不支持 statfs 时，不作阻断，允许安全通行
        return { ok: true, availableBytes: null, requiredBytes };
      }
    }

    if (availableBytes !== null && availableBytes < requiredBytes) {
      throw new InsufficientStorageError(
        `磁盘可用空间不足以安全写入：当前可用 ${(availableBytes / (1024 * 1024)).toFixed(2)} MB，本次写入安全要求至少 ${(requiredBytes / (1024 * 1024)).toFixed(2)} MB`,
        availableBytes,
        requiredBytes
      );
    }

    return { ok: true, availableBytes, requiredBytes };
  }
}
