/**
 * 定时备份调度器与断电自愈引擎 (#11)
 * 核心特性：
 * 1. 定期触发快照与容灾镜像备份
 * 2. 容器/服务重启后自动探测停机期间错过的任务并【自动补跑一次】(Catch-up Execution)
 * 3. 记录完整的调度与补跑审计日志
 */
export class SchedulerService {
  /**
   * @param {object} options
   * @param {import('../config/ConfigService.js').ConfigService} options.configService
   * @param {import('./AuditService.js').AuditService} [options.auditService]
   * @param {() => Promise<any>} [options.backupFn] 备份执行回调函数
   */
  constructor({ configService, auditService = null, backupFn = null }) {
    this.configService = configService;
    this.audit = auditService;
    this.backupFn = backupFn;
    this.timer = null;
    this._running = false;
  }

  get enabled() {
    return Boolean(this.configService?.get('schedulerEnabled'));
  }

  get intervalMs() {
    return Number(this.configService?.get('schedulerIntervalMs')) || 24 * 60 * 60 * 1000; // 默认 24 小时
  }

  get lastRunAt() {
    return Number(this.configService?.get('lastScheduledBackupAt')) || 0;
  }

  setLastRunAt(timestamp) {
    this.configService?.set('lastScheduledBackupAt', timestamp);
  }

  /**
   * 启动调度器并执行停机检测（自愈补跑）
   */
  async start() {
    this.stop();
    if (!this.enabled) return { started: false, reason: 'disabled' };

    const now = Date.now();
    const last = this.lastRunAt;
    const interval = this.intervalMs;

    let catchupTriggered = false;

    // #11 核心特性：检测离线期间是否错过了定时执行
    if (last > 0 && now - last >= interval) {
      console.log(`[cfgsync:scheduler] 检测到服务停机期间错过了计划备份 (上次执行: ${new Date(last).toISOString()})，启动自动补跑一次...`);
      catchupTriggered = true;
      try {
        await this.runJob('power_off_catchup');
      } catch (err) {
        console.warn('[cfgsync:scheduler] Catchup job warning:', err.message);
      }
    }

    // 启动周期轮询定时器
    this.timer = setInterval(async () => {
      if (!this.enabled || this._running) return;
      const currentNow = Date.now();
      if (currentNow - this.lastRunAt >= this.intervalMs) {
        await this.runJob('scheduled_interval');
      }
    }, Math.min(this.intervalMs, 60 * 1000)); // 每分钟或 intervalMs 检查一次

    return { started: true, catchupTriggered };
  }

  /**
   * 执行单次备份任务
   * @param {'power_off_catchup' | 'scheduled_interval' | 'manual'} reason
   */
  async runJob(reason = 'manual') {
    if (this._running) {
      return { skipped: true, reason: 'already_running' };
    }

    this._running = true;
    const startedAt = Date.now();
    try {
      let result = null;
      if (typeof this.backupFn === 'function') {
        result = await this.backupFn(reason);
      }

      this.setLastRunAt(startedAt);

      if (this.audit) {
        this.audit.log({
          actor: 'SYSTEM',
          action: 'scheduler_backup',
          result: 'success',
          details: { reason, durationMs: Date.now() - startedAt, result },
        });
      }

      return { success: true, reason, startedAt, durationMs: Date.now() - startedAt, result };
    } catch (err) {
      console.error(`[cfgsync:scheduler] Backup run (${reason}) failed:`, err);
      if (this.audit) {
        this.audit.log({
          actor: 'SYSTEM',
          action: 'scheduler_backup',
          result: 'failure',
          details: { reason, error: err.message },
        });
      }
      return { success: false, reason, error: err.message };
    } finally {
      this._running = false;
    }
  }

  /**
   * 停止调度器
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
