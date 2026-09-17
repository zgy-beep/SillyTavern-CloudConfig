import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 关键表列表（用于行数对比与数据一致性验证）
 */
export const CRITICAL_TABLES = [
  'config_records',
  'config_versions',
  'share_grants',
  'audit_logs',
  'binding_locks',
];

export class MigrationService {
  /**
   * 解析默认数据根目录
   * @param {string} [stRoot] SillyTavern 根目录，默认 process.cwd()
   * @param {string} [customDataRoot] 用户自定义路径，优先自环境变量 CFGSYNC_DATA_ROOT
   * @returns {string}
   */
  static resolveDataRoot(stRoot = process.cwd(), customDataRoot = process.env.CFGSYNC_DATA_ROOT) {
    if (customDataRoot && typeof customDataRoot === 'string' && customDataRoot.trim()) {
      return path.resolve(customDataRoot.trim());
    }
    return path.join(stRoot, 'data', 'cfgsync');
  }

  /**
   * 清理老目录残留杂散物 (P6-R3)
   * 1. 宿主机或第三方启动脚本在老目录误建的 0 字节空库 (cfgsync.sqlite / -wal / -shm)
   * 2. 误建在老目录下的杂散 cfgsync/ 子目录 (<pluginDir>/data/cfgsync/)
   * 保证安全：只有当目标外置库已存在且有效 (size > 0) 时，才清理老目录下的 0 字节空库
   * @param {string} oldDataDir
   * @param {string} activeTargetRoot
   */
  static cleanStrayLegacyArtifacts(oldDataDir, activeTargetRoot) {
    if (!oldDataDir || !activeTargetRoot) return;
    try {
      if (!fs.existsSync(oldDataDir)) return;
      const targetDbPath = path.join(activeTargetRoot, 'cfgsync.sqlite');
      if (!fs.existsSync(targetDbPath)) return;

      // 确认目标库是有效的非空文件
      const targetStats = fs.statSync(targetDbPath);
      if (targetStats.size <= 0) return;

      // 1. 清理 0 字节老库及关联文件 (宿主机/第三方脚本误建)
      const oldDbPath = path.join(oldDataDir, 'cfgsync.sqlite');
      if (fs.existsSync(oldDbPath)) {
        try {
          const stats = fs.statSync(oldDbPath);
          if (stats.size === 0) {
            fs.unlinkSync(oldDbPath);
            console.log('[cfgsync:migration] 已自动清理老目录残留的 0 字节空库:', oldDbPath);
          }
        } catch {}
      }
      for (const suffix of ['-wal', '-shm']) {
        const strayFile = `${oldDbPath}${suffix}`;
        if (fs.existsSync(strayFile)) {
          try {
            const stats = fs.statSync(strayFile);
            if (stats.size === 0) {
              fs.unlinkSync(strayFile);
            }
          } catch {}
        }
      }

      // 2. 清理老目录下的杂散 cfgsync/ 子目录 (如 <ST>/plugins/cfgsync/data/cfgsync/)
      const straySubDir = path.join(oldDataDir, 'cfgsync');
      if (fs.existsSync(straySubDir)) {
        // 安全防误删：检查 straySubDir 是否就是目标 activeTargetRoot
        if (path.resolve(straySubDir) !== path.resolve(activeTargetRoot)) {
          try {
            fs.rmSync(straySubDir, { recursive: true, force: true });
            console.log('[cfgsync:migration] 已自动清理老目录残留的杂散子目录:', straySubDir);
          } catch (e) {
            console.warn('[cfgsync:migration] 清理杂散子目录警告:', e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[cfgsync:migration] cleanStrayLegacyArtifacts 异常捕获:', e.message);
    }
  }

  /**
   * 执行数据库与密钥由老路径至新全局数据根的平滑迁移 (M1, N-6 ~ N-8, N-11 ~ N-13)
   * 必须在任何业务 DatabaseClient 实例创建之前调用
   * 
   * @param {object} options
   * @param {string} options.pluginDir 插件根目录 (__dirname)
   * @param {string} [options.stRoot] SillyTavern 根目录 (process.cwd())
   * @param {string} [options.targetDataRoot] 目标全局数据根目录
   * @returns {Promise<{
   *   success: boolean,
   *   activeDataRoot: string,
   *   dbPath: string,
   *   migrated: boolean,
   *   dualDbResolved?: boolean,
   *   chosenSource?: string,
   *   warning?: string
   * }>}
   */
  static async migrateIfNeeded({ pluginDir, stRoot = process.cwd(), targetDataRoot = null }) {
    const activeTargetRoot = targetDataRoot || this.resolveDataRoot(stRoot);
    const oldDataDir = path.join(pluginDir, 'data');
    const oldDbPath = path.join(oldDataDir, 'cfgsync.sqlite');
    const oldSecretPath = path.join(oldDataDir, '.server_secret');
    const oldConfigPath = path.join(oldDataDir, 'cfgsync_config.json');

    const targetDbPath = path.join(activeTargetRoot, 'cfgsync.sqlite');
    const targetSecretPath = path.join(activeTargetRoot, '.server_secret');
    const targetConfigPath = path.join(activeTargetRoot, 'cfgsync_config.json');
    const oldMarkerPath = path.join(oldDataDir, '.migrated_to');

    // 0. P6-R3: 在任何 Fast-Path 或仲裁判定前，先清理老目录残留杂散物 (0 字节库与杂散 cfgsync/ 子目录)
    this.cleanStrayLegacyArtifacts(oldDataDir, activeTargetRoot);

    // 0.1 P6-R2: 快速通道——若老目录已存在迁移成功标记且目标库就绪，立即放行，永不重复仲裁
    if (fs.existsSync(oldMarkerPath) && fs.existsSync(targetDbPath)) {
      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: false,
        skipped: true,
        reason: 'already_migrated_marker',
      };
    }

    // 1. 若目标目录与老目录完全一致，直接放行
    if (path.resolve(oldDataDir) === path.resolve(activeTargetRoot)) {
      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: false,
      };
    }


    // 2. 确保目标目录存在
    try {
      await fsPromises.mkdir(activeTargetRoot, { recursive: true });
    } catch (err) {
      console.error('[cfgsync:migration] 无法创建目标数据目录，降级回退使用旧路径:', err.message);
      return {
        success: false,
        activeDataRoot: oldDataDir,
        dbPath: oldDbPath,
        migrated: false,
        warning: `目标路径不可写 (${err.message})，已降级使用旧路径`,
      };
    }

    const oldDbExists = fs.existsSync(oldDbPath);
    const targetDbExists = fs.existsSync(targetDbPath);

    // 3. 情况 A：新老库均不存在（崭新安装），无需迁移
    if (!oldDbExists && !targetDbExists) {
      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: false,
      };
    }

    // 4. 情况 B：老库不存在，新库已存在（已完成过迁移或全新部署在目标路径）
    if (!oldDbExists && targetDbExists) {
      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: false,
      };
    }

    // 5. 并发锁保护 (N-8)
    const lockPath = path.join(activeTargetRoot, 'migration.lock');
    if (fs.existsSync(lockPath)) {
      try {
        const lockStats = await fsPromises.stat(lockPath);
        // 若锁文件存活超过 60 秒，视为陈旧锁清除
        if (Date.now() - lockStats.mtimeMs < 60000) {
          console.warn('[cfgsync:migration] 检测到并发迁移锁 migration.lock，跳过本次迁移');
          return {
            success: true,
            activeDataRoot: targetDbExists ? activeTargetRoot : oldDataDir,
            dbPath: targetDbExists ? targetDbPath : oldDbPath,
            migrated: false,
            warning: '检测到其他并发迁移进程正在执行',
          };
        }
      } catch {}
    }

    try {
      await fsPromises.writeFile(lockPath, `${process.pid}:${Date.now()}`, 'utf8');
    } catch (err) {
      console.warn('[cfgsync:migration] 无法写入迁移锁:', err.message);
    }

    try {
      // 6. 情况 C：双库同时存在冲突仲裁 (N-12)
      if (oldDbExists && targetDbExists) {
        console.log('[cfgsync:migration] 检测到双库并存，启动深度仲裁...');
        const resolution = await this.resolveDualDbConflict({
          oldDbPath,
          targetDbPath,
          oldDataDir,
          activeTargetRoot,
        });
        return resolution;
      }

      // 7. 情况 D：单老库正常平滑迁移至新路径 (N-6, N-7, N-11)
      console.log(`[cfgsync:migration] 开始老部署迁移: ${oldDbPath} -> ${targetDbPath}`);

      // 7.1 执行 WAL Checkpoint (TRUNCATE) 并校验返回值与 0-byte WAL (N-6, N-11)
      await this.checkpointWalCleanly(oldDbPath);

      // 7.2 获取旧库基准指纹 (N-7)
      const oldFingerprint = this.extractDatabaseFingerprint(oldDbPath);

      // 7.3 生成老库时间戳备份 (N-7)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const oldBakPath = `${oldDbPath}.bak-${timestamp}`;
      try {
        await fsPromises.copyFile(oldDbPath, oldBakPath);
      } catch (err) {
        console.warn('[cfgsync:migration] 备份老库失败:', err.message);
      }

      // 7.4 清扫目标位置可能存在的脏 `-wal` / `-shm` 残留 (N-11)
      this.cleanupWalShm(targetDbPath);

      // 7.5 单文件复制至目标临时文件
      const tmpTargetDbPath = `${targetDbPath}.tmp-${Date.now()}`;
      await fsPromises.copyFile(oldDbPath, tmpTargetDbPath);

      // 7.6 六重严格校验 (N-7)
      const targetFingerprint = this.extractDatabaseFingerprint(tmpTargetDbPath);
      this.validateFingerprints(oldFingerprint, targetFingerprint);

      // 7.7 原子重命名切换指针 (N-8)
      await fsPromises.rename(tmpTargetDbPath, targetDbPath);

      // 7.8 迁移 .server_secret 并保持 0o600 权限 (N-13)
      if (fs.existsSync(oldSecretPath)) {
        const secretContent = await fsPromises.readFile(oldSecretPath, 'utf8');
        try {
          await fsPromises.writeFile(targetSecretPath, secretContent, { encoding: 'utf8', mode: 0o600 });
        } catch {
          await fsPromises.writeFile(targetSecretPath, secretContent, 'utf8');
        }
        // 验证 secret 哈希
        const oldSecretHash = crypto.createHash('sha256').update(secretContent.trim()).digest('hex');
        const targetSecretHash = crypto.createHash('sha256').update((await fsPromises.readFile(targetSecretPath, 'utf8')).trim()).digest('hex');
        if (oldSecretHash !== targetSecretHash) {
          throw new Error('Secret 哈希校验不匹配');
        }
      }

      // 7.9 迁移 cfgsync_config.json (N-7)
      if (fs.existsSync(oldConfigPath)) {
        const configContent = await fsPromises.readFile(oldConfigPath, 'utf8');
        await fsPromises.writeFile(targetConfigPath, configContent, 'utf8');
      }

      // 7.10 写入迁移成功审计日志 (N-8)
      try {
        const db = new DatabaseSync(targetDbPath);
        db.prepare(`
          INSERT INTO audit_logs (actor_handle, action, target_handle, content_type, item_uid, result, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'system',
          'MIGRATION_SUCCESS',
          'system',
          'system',
          'global_database',
          'success',
          JSON.stringify({ from: oldDbPath, to: targetDbPath, user_version: targetFingerprint.userVersion }),
          Date.now()
        );
        db.close();
      } catch (err) {
        console.warn('[cfgsync:migration] 写入迁移审计失败:', err.message);
      }

      // 7.11 标记老路径已完成迁移并冷备老库，清理残留 (P6-R2, P6-R3)
      try {
        await fsPromises.writeFile(oldMarkerPath, JSON.stringify({
          migratedTo: activeTargetRoot,
          migratedAt: Date.now(),
        }, null, 2), 'utf8');

        // 将原旧库重命名为冷备文件，避免原文件名残留触发后续启动误判
        const oldBakRename = `${oldDbPath}.bak-migrated-${timestamp}`;
        await fsPromises.rename(oldDbPath, oldBakRename).catch(() => {});

        // 统一清理老目录下残留杂散物 (P6-R3)
        this.cleanStrayLegacyArtifacts(oldDataDir, activeTargetRoot);
      } catch (e) {
        console.warn('[cfgsync:migration] 写入迁移标记警告:', e.message);
      }

      console.log(`[cfgsync:migration] 迁移成功完成！新数据根: ${activeTargetRoot}`);
      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: true,
      };


    } catch (err) {
      console.error('[cfgsync:migration] 迁移校验失败，安全回退使用旧路径:', err.message);
      // 清理临时文件
      try {
        const tmpFiles = await fsPromises.readdir(activeTargetRoot);
        for (const f of tmpFiles) {
          if (f.startsWith('cfgsync.sqlite.tmp-')) {
            await fsPromises.rm(path.join(activeTargetRoot, f), { force: true });
          }
        }
      } catch {}

      return {
        success: false,
        activeDataRoot: oldDataDir,
        dbPath: oldDbPath,
        migrated: false,
        warning: `迁移校验未通过 (${err.message})，已安全回退继续使用旧路径。旧数据完整保留未被删除。`,
      };
    } finally {
      // 释放迁移文件锁
      try {
        await fsPromises.rm(lockPath, { force: true });
      } catch {}
    }
  }

  /**
   * 执行 WAL Checkpoint (TRUNCATE)，带重试与 0 字节断言 (N-6, N-11)
   */
  static async checkpointWalCleanly(dbPath) {
    const walPath = `${dbPath}-wal`;
    if (!fs.existsSync(walPath)) {
      return;
    }

    let attempts = 0;
    let checkpointOk = false;

    while (attempts < 4 && !checkpointOk) {
      attempts++;
      let tempDb = null;
      try {
        tempDb = new DatabaseSync(dbPath);
        // PRAGMA wal_checkpoint(TRUNCATE) 返回一行: { busy: 0, log: 0, checkpointed: 0 }
        const res = tempDb.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
        tempDb.close();
        tempDb = null;

        if (res && res.busy === 0) {
          checkpointOk = true;
          break;
        }
        console.warn(`[cfgsync:migration] wal_checkpoint 遇到 busy (${JSON.stringify(res)})，尝试重试 ${attempts}...`);
      } catch (err) {
        if (tempDb) {
          try { tempDb.close(); } catch {}
        }
        console.warn(`[cfgsync:migration] checkpoint 异常重试 ${attempts}:`, err.message);
      }

      await new Promise(r => setTimeout(r, attempts * 150));
    }

    // 检查 WAL 文件大小
    if (fs.existsSync(walPath)) {
      const walStat = fs.statSync(walPath);
      if (walStat.size > 0 && !checkpointOk) {
        throw new Error(`无法清空 WAL 文件 (剩余 ${walStat.size} 字节未合并事务)`);
      }
    }
  }

  /**
   * 提取 SQLite 数据库六重关键指纹 (N-7)
   */
  static extractDatabaseFingerprint(dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
      // 1. integrity_check
      const integrityRow = db.prepare('PRAGMA integrity_check;').get();
      const integrity = integrityRow?.integrity_check || 'fail';

      // 2. user_version
      const versionRow = db.prepare('PRAGMA user_version;').get();
      const userVersion = versionRow ? versionRow.user_version : 0;

      // 3. 关键表行数
      const tableCounts = {};
      for (const table of CRITICAL_TABLES) {
        try {
          const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${table};`).get();
          tableCounts[table] = countRow ? countRow.count : 0;
        } catch {
          tableCounts[table] = -1; // 表不存在
        }
      }

      // 4. 最新版本时间戳
      let maxCreatedAt = 0;
      try {
        const maxRow = db.prepare('SELECT MAX(created_at) as max_time FROM config_versions;').get();
        maxCreatedAt = maxRow?.max_time || 0;
      } catch {}

      return {
        integrity,
        userVersion,
        tableCounts,
        maxCreatedAt,
      };
    } finally {
      db.close();
    }
  }

  /**
   * 校验新旧数据库指纹是否完全一致 (N-7)
   */
  static validateFingerprints(oldFp, targetFp) {
    if (targetFp.integrity !== 'ok') {
      throw new Error(`完整性检查失败: ${targetFp.integrity}`);
    }

    if (targetFp.userVersion !== oldFp.userVersion) {
      throw new Error(`user_version 不一致: 旧库=${oldFp.userVersion}, 新库=${targetFp.userVersion}`);
    }

    for (const table of CRITICAL_TABLES) {
      if (oldFp.tableCounts[table] >= 0) {
        if (targetFp.tableCounts[table] !== oldFp.tableCounts[table]) {
          throw new Error(`表 ${table} 行数不匹配: 旧库=${oldFp.tableCounts[table]}, 新库=${targetFp.tableCounts[table]}`);
        }
      }
    }
  }

  /**
   * 双库冲突安全仲裁 (N-12)
   */
  static async resolveDualDbConflict({ oldDbPath, targetDbPath, oldDataDir, activeTargetRoot }) {
    await this.checkpointWalCleanly(oldDbPath);
    await this.checkpointWalCleanly(targetDbPath);

    const oldFp = this.extractDatabaseFingerprint(oldDbPath);
    const targetFp = this.extractDatabaseFingerprint(targetDbPath);

    let chooseTarget = false;

    // 1. 优先比对 user_version
    if (targetFp.userVersion > oldFp.userVersion) {
      chooseTarget = true;
    } else if (targetFp.userVersion < oldFp.userVersion) {
      chooseTarget = false;
    } else {
      // 2. 比对关键表总行数
      const sumRows = (fp) => Object.values(fp.tableCounts).reduce((a, b) => a + Math.max(0, b), 0);
      const oldTotal = sumRows(oldFp);
      const targetTotal = sumRows(targetFp);

      if (targetTotal > oldTotal) {
        chooseTarget = true;
      } else if (targetTotal < oldTotal) {
        chooseTarget = false;
      } else {
        // 3. 比对最新版本时间戳
        chooseTarget = (targetFp.maxCreatedAt >= oldFp.maxCreatedAt);
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (chooseTarget) {
      // 目标位置更全/更新，保留目标库，将老库冷备
      const oldBakPath = `${oldDbPath}.bak-dual-db-${timestamp}`;
      try {
        await fsPromises.rename(oldDbPath, oldBakPath);
      } catch (err) {
        console.warn('[cfgsync:migration] 重命名老库冷备失败:', err.message);
      }

      // 写入迁移完成标记，后续启动快速跳过仲裁 (P6-R2)
      try {
        const oldMarkerPath = path.join(oldDataDir, '.migrated_to');
        await fsPromises.writeFile(oldMarkerPath, JSON.stringify({
          migratedTo: activeTargetRoot,
          arbitratedAt: Date.now(),
          winner: 'target',
        }, null, 2), 'utf8');

        // 统一清理老目录下残留杂散物 (P6-R3)
        this.cleanStrayLegacyArtifacts(oldDataDir, activeTargetRoot);
      } catch {}

      console.log(`[cfgsync:migration] 仲裁结果: 目标位置数据库更全，启用 ${targetDbPath}，老库已冷备为 ${oldBakPath}`);

      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: false,
        dualDbResolved: true,
        chosenSource: 'target',
      };
    } else {
      // 老库更全，将目标库冷备后，把老库迁移到目标位置
      const targetBakPath = `${targetDbPath}.bak-dual-db-${timestamp}`;
      try {
        await fsPromises.rename(targetDbPath, targetBakPath);
      } catch (err) {
        console.warn('[cfgsync:migration] 重命名目标库冷备失败:', err.message);
      }

      // 将老库复制过去
      await fsPromises.copyFile(oldDbPath, targetDbPath);
      console.log(`[cfgsync:migration] 仲裁结果: 老库数据更全，已将目标库冷备为 ${targetBakPath}，启用老库数据`);

      return {
        success: true,
        activeDataRoot: activeTargetRoot,
        dbPath: targetDbPath,
        migrated: true,
        dualDbResolved: true,
        chosenSource: 'old',
      };
    }
  }

  /**
   * 清理孤立的 `-wal` / `-shm` 文件
   */
  static cleanupWalShm(dbPath) {
    try {
      if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
      if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
    } catch {}
  }
}
