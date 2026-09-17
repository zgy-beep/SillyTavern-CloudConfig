import { SyncState, SyncMode } from '../common/constants.js';

/**
 * 客户端无感自动同步引擎 (AutoSyncEngine, M4, P6-4, #12)
 * 核心机制：
 * 1. 默认关闭 (Disabled by default) + 开启前二次风险确认
 * 2. 空闲与防打扰判定 (Active Typing / Generation Guard)：用户正在输入或 AI 正在生成时绝对不写盘、不拉取、自动避让
 * 3. CAS 服务端锚点兜底：遇到 409 冲突绝不盲目重试或静默覆盖，优雅降级为用户提示并保留本地草稿
 * 4. 周期调度轮询与手动即时触发
 */
export class AutoSyncEngine {
  /**
   * @param {object} options
   * @param {import('./api.js').CloudConfigApi} options.api
   * @param {import('./syncManager.js').ClientSyncManager} options.syncManager
   * @param {import('./db/idb.js').IdbStorage} options.storage
   * @param {string} [options.accountHandle]
   * @param {boolean} [options.enabled=false] 严格默认关闭
   * @param {number} [options.intervalMs=600000] 默认 10 分钟 (600,000ms)
   * @param {(status: string, message?: string) => void} [options.onStatusChange]
   * @param {(msg: string) => void} [options.notifyFn]
   */
  constructor(options = {}) {
    this.api = options.api;
    this.syncManager = options.syncManager;
    this.storage = options.storage;
    this.accountHandle = options.accountHandle || 'default-user';
    this.enabled = Boolean(options.enabled ?? false);
    this.intervalMs = Number(options.intervalMs) || 10 * 60 * 1000;
    this.timer = null;
    this.isSyncing = false;
    this.lastSyncAt = 0;
    this.lastStatus = 'idle';
    this.onStatusChange = options.onStatusChange || null;
    this.notifyFn = options.notifyFn || ((msg) => {
      if (typeof window !== 'undefined' && window.toastr?.warning) {
        window.toastr.warning(msg, '云配置自动同步');
      } else {
        console.log('[cfgsync:autosync]', msg);
      }
    });

    this.lastTypingTimestamp = 0;
    this.mockGenerating = null; // 测试用
    this.mockTyping = null; // 测试用

    // 监听键盘按键，感知用户活跃打字状态
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', () => {
        this.lastTypingTimestamp = Date.now();
      }, { passive: true });
    }
  }

  setAccountHandle(handle) {
    if (handle) this.accountHandle = handle;
  }

  setStatus(status, message = '') {
    this.lastStatus = status;
    if (typeof this.onStatusChange === 'function') {
      try {
        this.onStatusChange(status, message);
      } catch (err) {
        console.warn('[cfgsync:autosync] onStatusChange error:', err);
      }
    }
  }

  /**
   * 二次确认开启保护 (默认关闭铁律，P6-4)
   * @param {(promptText: string) => Promise<boolean>} confirmFn
   */
  async requestEnable(confirmFn) {
    if (this.enabled) return true;

    const promptText = '开启自动同步前请确认：\n\n自动同步将在后台空闲时定期备份配置与资产至云端。系统检测到用户正在输入或 AI 正在生成回复时将自动避让。若遇到云端版本冲突将安全暂停并提示人工处理。\n\n是否确认开启？';
    let confirmed = false;
    if (typeof confirmFn === 'function') {
      confirmed = await confirmFn(promptText);
    } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      confirmed = window.confirm(promptText);
    } else {
      confirmed = true;
    }

    if (confirmed) {
      this.enabled = true;
      this.start();
      return true;
    }
    return false;
  }

  disable() {
    this.enabled = false;
    this.stop();
    this.setStatus('disabled', '自动同步已关闭');
  }

  /**
   * 空闲与防打扰判定 (Active Typing / Generation Guard, #12)
   * 正在生成或编辑中的会话绝对不写盘、不拉取
   * @returns {{ busy: boolean, reason?: 'generating' | 'typing', message?: string }}
   */
  isUserActiveOrGenerating() {
    // 单元测试注入模拟
    if (this.mockGenerating) {
      return { busy: true, reason: 'generating', message: 'AI 正在生成回复中，自动同步避让' };
    }
    if (this.mockTyping) {
      return { busy: true, reason: 'typing', message: '用户正在输入框编辑中，自动同步避让' };
    }

    if (typeof window === 'undefined') return { busy: false };

    // 1. 检测 AI 是否正在生成回复
    if (window.is_generating === true) {
      return { busy: true, reason: 'generating', message: 'AI 正在生成回复中，自动同步避让' };
    }
    if (typeof window.SillyTavern?.getContext === 'function') {
      const ctx = window.SillyTavern.getContext();
      if (ctx?.isGenerating === true) {
        return { busy: true, reason: 'generating', message: 'AI 正在生成回复中，自动同步避让' };
      }
    }
    const sendBtn = typeof document !== 'undefined' ? document.querySelector('#send_button') : null;
    if (sendBtn && (sendBtn.classList?.contains('generating') || (sendBtn.style?.display === 'none' && document.querySelector('#stop_button')?.style?.display !== 'none'))) {
      return { busy: true, reason: 'generating', message: '发送按钮处于生成态，自动同步避让' };
    }
    const loadingMes = typeof document !== 'undefined' ? document.querySelector('#loading_mes') : null;
    if (loadingMes && loadingMes.style?.display !== 'none' && loadingMes.offsetParent !== null) {
      return { busy: true, reason: 'generating', message: '正在加载消息，自动同步避让' };
    }

    // 2. 检测用户是否正在编辑/打字输入
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeEl) {
      const tagName = activeEl.tagName?.toLowerCase();
      if (tagName === 'textarea' || tagName === 'input') {
        return { busy: true, reason: 'typing', message: '用户正在输入框编辑中，自动同步避让' };
      }
      if (activeEl.isContentEditable) {
        return { busy: true, reason: 'typing', message: '用户正在编辑内容，自动同步避让' };
      }
    }

    // 用户在最近 5 秒内有键盘击键活动
    if (Date.now() - this.lastTypingTimestamp < 5000) {
      return { busy: true, reason: 'typing', message: '检测到近期用户输入活跃，自动同步避让' };
    }

    return { busy: false };
  }

  start() {
    this.stop();
    if (!this.enabled) return;

    this.timer = setInterval(() => {
      if (this.enabled && !this.isSyncing) {
        this.runAutoSync(this.accountHandle).catch(err => {
          console.warn('[cfgsync:autosync] Scheduled run warning:', err.message);
        });
      }
    }, this.intervalMs);

    this.setStatus('idle', '空闲待命');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 执行一次安全的自动同步循环
   * @param {string} [accountHandle]
   * @returns {Promise<{ success?: boolean, skipped?: boolean, reason?: string, pushed?: number, conflicts?: number }>}
   */
  async runAutoSync(accountHandle = null) {
    if (!this.enabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (this.isSyncing) {
      return { skipped: true, reason: 'already_syncing' };
    }

    const handle = accountHandle || this.accountHandle;

    // #12 静默同步防打扰检测
    const busyCheck = this.isUserActiveOrGenerating();
    if (busyCheck.busy) {
      this.setStatus(`suppressed_${busyCheck.reason}`, busyCheck.message);
      return { skipped: true, reason: busyCheck.reason, message: busyCheck.message };
    }

    this.isSyncing = true;
    this.setStatus('syncing', '正在后台自动同步...');

    let pushed = 0;
    let conflicts = 0;

    try {
      const bindings = await this.storage.getBindingsByAccount(handle);
      const activeBindings = (bindings || []).filter(b => b.enabled);

      for (const binding of activeBindings) {
        // 每项同步前复查防打扰（防止执行过程中用户突然打字或收到AI响应）
        const midCheck = this.isUserActiveOrGenerating();
        if (midCheck.busy) {
          console.log(`[cfgsync:autosync] 自动同步被用户操作中断: ${midCheck.message}`);
          this.setStatus(`suppressed_${midCheck.reason}`, midCheck.message);
          break;
        }

        // 仅对当前所有者资产执行推送 (OWN 模式)
        if (binding.sync_mode === SyncMode.OWN || !binding.sync_mode) {
          // 若之前已处于冲突状态，不重复推送，等待用户处理
          if (binding.state === SyncState.CONFLICT) {
            conflicts++;
            continue;
          }

          try {
            // CAS 安全推送，force: false 确保服务端校验 baseVersion
            const pushRes = await this.syncManager.pushLocal(binding, null, {
              versionTitle: '自动同步安全快照',
              force: false,
            });

            if (pushRes?.conflict) {
              conflicts++;
              this.notifyFn(`资产「${binding.display_name}」检测到云端更新，自动同步已暂停并标记冲突，请在面板中确认。`);
            } else if (pushRes?.success) {
              pushed++;
            }
          } catch (err) {
            if (err.status === 409 || err.name === 'ConflictError') {
              conflicts++;
              this.notifyFn(`资产「${binding.display_name}」发生版本冲突，已保留本地草稿并暂停同步。`);
            } else {
              console.warn(`[cfgsync:autosync] Push failed on ${binding.display_name}:`, err.message);
            }
          }
        }
      }

      this.lastSyncAt = Date.now();
      if (conflicts > 0) {
        this.setStatus('conflict_paused', `检测到 ${conflicts} 处版本冲突，已暂停并保留本地草稿`);
      } else {
        this.setStatus('idle', pushed > 0 ? `自动同步完成，成功推送 ${pushed} 项` : '全部资产已是最新');
      }

      return { success: true, pushed, conflicts };
    } catch (err) {
      this.setStatus('error', err.message);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }
}
