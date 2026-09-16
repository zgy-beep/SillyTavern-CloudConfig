import { SyncState, SyncMode, ReloadStrategy } from '../../common/constants.js';
import { showConflictDialog } from './conflictDialog.js';
import { showClaimDialog, showShareDialog } from './shareDialog.js';
import { showPushDialog } from './pushDialog.js';
import { showSettingsDialog } from './settingsDialog.js';
import { showDeleteDialog } from './deleteDialog.js';
import { showSnapshotHistoryDialog } from './snapshotHistoryDialog.js';
import { showAdminDashboardDialog } from './adminDialog.js';

/**
 * 渲染云同步配置主面板
 */
export class CloudConfigPanel {
  /**
   * @param {object} context
   * @param {import('../api.js').CloudConfigApi} context.api
   * @param {import('../syncManager.js').ClientSyncManager} context.syncManager
   * @param {import('../db/idb.js').IdbStorage} context.storage
   * @param {string} context.accountHandle
   * @param {(newHandle: string) => void} [context.onAccountChange]
   */
  constructor({ api, syncManager, storage, accountHandle, onAccountChange }) {
    this.api = api;
    this.syncManager = syncManager;
    this.storage = storage;
    this.accountHandle = accountHandle;
    this.onAccountChange = onAccountChange;
    this.container = null;
    this._refreshing = false;
    this.thumbnailCache = new Map();
  }

  render(targetEl) {
    this.container = targetEl;
    this.ensureShell();
    this.refresh();
  }

  /**
   * 仅在容器未就绪时初始化外层骨架，绝不重复清空已有 DOM
   */
  ensureShell() {
    if (!this.container || this.container.querySelector('.cfgsync-panel-container')) {
      return;
    }

    this.container.innerHTML = `
      <div class="cfgsync-panel-container" style="padding: 4px 2px; font-family: sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:6px; border-bottom: 1px solid rgba(255,255,255,0.08); gap:8px;">
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <span style="font-size:12px; font-weight:600; opacity:0.9;">云端配置</span>
            <button id="cfgsync-toggle-all-btn" type="button" title="切换全部展开/折叠" style="display:inline-flex; align-items:center; gap:3px; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:22px; padding:0 8px; margin:0; border-radius:4px; font-size:11px; font-weight:500; color:#69c0ff; background:rgba(24,144,255,0.12); border:1px solid rgba(24,144,255,0.3); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-angles-down" style="font-size:10px;"></i>
              <span class="cfgsync-toggle-all-text">全部展开</span>
            </button>
            <button id="cfgsync-refresh-btn" type="button" title="刷新配置状态" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; margin:0; border-radius:4px; font-size:10px; color:#69c0ff; background:rgba(24,144,255,0.12); border:1px solid rgba(24,144,255,0.3); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-rotate"></i>
            </button>
            <button id="cfgsync-backup-all-btn" type="button" title="一键备份所有已开启同步的本地配置到云端" style="display:inline-flex; align-items:center; gap:3px; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:22px; padding:0 8px; margin:0; border-radius:4px; font-size:11px; font-weight:500; color:#13c2c2; background:rgba(19,194,194,0.12); border:1px solid rgba(19,194,194,0.3); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-cloud-arrow-up" style="font-size:10px;"></i>
              <span class="cfgsync-backup-all-text">一键备份</span>
            </button>
            <button id="cfgsync-claim-btn" type="button" title="认领好友分享给你的配置邀请码" style="display:inline-flex; align-items:center; gap:3px; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:22px; padding:0 8px; margin:0; border-radius:4px; font-size:11px; font-weight:500; color:#52c41a; background:rgba(82,196,26,0.12); border:1px solid rgba(82,196,26,0.3); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-key" style="font-size:10px;"></i>
              <span>认领</span>
            </button>
            <button id="cfgsync-settings-btn" type="button" title="云同步设置" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; margin:0; border-radius:4px; font-size:10.5px; color:#c9d1d9; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.18); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-gear"></i>
            </button>
            <button id="cfgsync-dashboard-btn" type="button" title="存储看板与清理工具" style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; margin:0; border-radius:4px; font-size:10.5px; color:#58a6ff; background:rgba(88,166,255,0.12); border:1px solid rgba(88,166,255,0.3); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-chart-pie"></i>
            </button>
          </div>
          <span style="font-size:11.5px; opacity:0.75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">账号: <strong class="cfgsync-account-label" style="color:#69c0ff;">${this.accountHandle}</strong></span>
        </div>
        <div id="cfgsync-items-loading" style="text-align:center; padding:16px; font-size:12px; opacity:0.7;">正在加载配置...</div>
        <div id="cfgsync-items-tree"></div>
      </div>
    `;

    this.bindToggleAll();
    this.bindRefresh();
    this.bindBackupAll();
    this.bindClaim();
    this.bindSettings();
    this.bindDashboard();
  }

  bindDashboard() {
    const dashBtn = this.container.querySelector('#cfgsync-dashboard-btn');
    if (!dashBtn || dashBtn.dataset.bound) return;
    dashBtn.dataset.bound = 'true';

    dashBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAdminDashboardDialog({
        api: this.api,
        isAdmin: this._isAdmin,
        onClose: () => this.refresh(),
      });
    };
  }

  bindSettings() {
    const settingsBtn = this.container.querySelector('#cfgsync-settings-btn');
    if (!settingsBtn || settingsBtn.dataset.bound) return;
    settingsBtn.dataset.bound = 'true';

    settingsBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSettingsDialog({
        api: this.api,
        onUpdated: () => this.refresh(),
      });
    };
  }

  bindClaim() {
    const claimBtn = this.container.querySelector('#cfgsync-claim-btn');
    if (!claimBtn || claimBtn.dataset.bound) return;
    claimBtn.dataset.bound = 'true';

    claimBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showClaimDialog({
        api: this.api,
        onClaimed: () => this.refresh(),
      });
    };
  }

  bindRefresh() {
    const refreshBtn = this.container.querySelector('#cfgsync-refresh-btn');
    if (!refreshBtn || refreshBtn.dataset.bound) return;
    refreshBtn.dataset.bound = 'true';

    refreshBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('fa-spin');
      try {
        await this.refresh();
      } finally {
        if (icon) icon.classList.remove('fa-spin');
      }
    };
  }

  bindBackupAll() {
    const backupBtn = this.container.querySelector('#cfgsync-backup-all-btn');
    if (!backupBtn || backupBtn.dataset.bound) return;
    backupBtn.dataset.bound = 'true';

    backupBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.runBackupAll();
    };
  }

  /**
   * 严格串行执行一键备份已同步项 (P5-8, Step 3)
   * 包含进度展示、单项容错、总大小预估
   * @returns {Promise<{ total: number, successCount: number, failCount: number, totalBytes?: number, cancelled?: boolean }>}
   */
  async runBackupAll() {
    const backupBtn = this.container?.querySelector?.('#cfgsync-backup-all-btn');
    const textSpan = backupBtn?.querySelector?.('.cfgsync-backup-all-text');
    const iconI = backupBtn?.querySelector?.('i');

    const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
    const enabledBindings = (bindings || []).filter(b => b.enabled);

    if (enabledBindings.length === 0) {
      alert('当前没有已开启云同步的配置项。\n请先勾选需要同步的项目复选框，再执行一键备份。');
      return { total: 0, successCount: 0, failCount: 0 };
    }

    const confirmMsg = `已发现 ${enabledBindings.length} 个已开启云同步的配置项。\n将依次备份到云端（严格串行执行保证安全性）。\n\n是否立即开始？`;
    if (typeof confirm === 'function' && !confirm(confirmMsg)) {
      return { total: enabledBindings.length, successCount: 0, failCount: 0, cancelled: true };
    }

    if (backupBtn) {
      backupBtn.disabled = true;
      if (iconI) iconI.className = 'fa-solid fa-spinner fa-spin';
    }

    let successCount = 0;
    let totalBytes = 0;
    const failures = [];

    try {
      for (let i = 0; i < enabledBindings.length; i++) {
        const binding = enabledBindings[i];
        const progressText = `正在备份 (${i + 1}/${enabledBindings.length})...`;
        if (textSpan) textSpan.textContent = progressText;

        try {
          let localPayload = null;
          if (binding.content_type === 'settings' && typeof window !== 'undefined') {
            try {
              const s = window.settings || window.SillyTavern?.getContext?.()?.settings;
              if (s && typeof s === 'object' && Object.keys(s).length > 0) {
                localPayload = JSON.parse(JSON.stringify(s));
              }
            } catch {}
          }

          const res = await this.syncManager.pushLocal(binding, localPayload, {
            force: true,
            versionTitle: `一键批量备份 (${new Date().toLocaleTimeString()})`,
          });

          if (res?.success !== false) {
            successCount++;
            if (res.size_bytes) {
              totalBytes += Number(res.size_bytes);
            }
          } else {
            failures.push({ name: binding.display_name, error: res.error || '上传未成功' });
          }
        } catch (err) {
          console.error(`[cfgsync] 一键备份项【${binding.display_name}】失败:`, err);
          failures.push({ name: binding.display_name, error: err.message || String(err) });
        }
      }

      await this.refresh();

      const sizeDesc = totalBytes > 0 ? ` (总计上传约 ${(totalBytes / 1024).toFixed(1)} KB)` : '';
      let summaryMsg = `【一键备份完成】\n\n成功备份: ${successCount} 项${sizeDesc}\n失败: ${failures.length} 项`;
      if (failures.length > 0) {
        summaryMsg += `\n\n失败详情:\n` + failures.map(f => `• ${f.name}: ${f.error}`).join('\n');
      }
      alert(summaryMsg);

      return { total: enabledBindings.length, successCount, failCount: failures.length, totalBytes, failures };
    } finally {
      if (backupBtn) {
        backupBtn.disabled = false;
        if (textSpan) textSpan.textContent = '一键备份';
        if (iconI) iconI.className = 'fa-solid fa-cloud-arrow-up';
      }
    }
  }

  bindToggleAll() {
    const toggleAllBtn = this.container.querySelector('#cfgsync-toggle-all-btn');
    if (!toggleAllBtn || toggleAllBtn.dataset.bound) return;
    toggleAllBtn.dataset.bound = 'true';

    let allExpanded = false;
    toggleAllBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      allExpanded = !allExpanded;
      const textSpan = toggleAllBtn.querySelector('.cfgsync-toggle-all-text');
      const iconI = toggleAllBtn.querySelector('i');
      if (textSpan) textSpan.textContent = allExpanded ? '全部折叠' : '全部展开';
      if (iconI) {
        iconI.className = allExpanded ? 'fa-solid fa-angles-up' : 'fa-solid fa-angles-down';
      }
      const treeEl = this.container.querySelector('#cfgsync-items-tree');
      if (!treeEl) return;
      const groupDrawers = treeEl.querySelectorAll('.cfgsync-group-drawer');
      groupDrawers.forEach(drawer => {
        const content = drawer.querySelector('.cfgsync-drawer-content');
        const icon = drawer.querySelector('.inline-drawer-icon');
        if (content) {
          content.style.display = allExpanded ? 'block' : 'none';
        }
        if (icon) {
          if (allExpanded) {
            icon.classList.remove('down');
            icon.classList.add('up');
          } else {
            icon.classList.remove('up');
            icon.classList.add('down');
          }
        }
      });
    };
  }

  /**
   * 静默增量刷新：同时获取本地与云端备份，支持跨账号拉取
   */
  async refresh() {
    if (!this.container) return;
    if (this._refreshing) return;
    this._refreshing = true;
    this.ensureShell();

    const treeEl = this.container.querySelector('#cfgsync-items-tree');
    const loadingEl = this.container.querySelector('#cfgsync-items-loading');

    if (treeEl && treeEl.children.length === 0 && loadingEl) {
      loadingEl.style.display = 'block';
    }

    try {
      const typeRes = await this.api.getContentTypes();
      if (typeRes.current_user && this.accountHandle !== typeRes.current_user) {
        this.accountHandle = typeRes.current_user;
        const labelEl = this.container.querySelector('.cfgsync-account-label');
        if (labelEl) labelEl.textContent = this.accountHandle;
        if (typeof this.onAccountChange === 'function') {
          this.onAccountChange(this.accountHandle);
        }
      }
      this._isAdmin = Boolean(typeRes.is_admin);

      // 支持所有已注册并启用的配置类型（核心类型 + P1 纯 JSON 预设）
      const allActiveTypes = typeRes.activeTypes || (typeRes.groups?.P0 || ['settings', 'openai_preset', 'world']);
      const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
      const bindingMap = new Map(bindings.map(b => [`${b.content_type}:${b.item_uid}`, b]));

      const ctNameMap = {
        'settings': '通用设置',
        'character': '角色卡',
        'theme': '主题风格',
        'openai_preset': 'OpenAI 预设',
        'textgen_preset': 'TextGen 预设',
        'novel_preset': 'NovelAI 预设',
        'kobold_preset': 'KoboldAI 预设',
        'world': '世界设定 / 规则书',
        'instruct': 'Instruct / 格式预设',
        'context': 'Context / 上下文预设',
        'sysprompt': '系统提示词预设',
        'quick_replies': '快捷回复',
      };

      for (const ct of allActiveTypes) {
        // 1. 获取本地配置项
        const localRes = await this.api.getItems(ct, this.accountHandle, 'local').catch(() => ({ items: [] }));
        const localItems = localRes.items || [];

        // 2. 获取云端全量备份（跨所有账号）
        const cloudRes = await this.api.getItems(ct, '', 'cloud', true).catch(() => ({ items: [] }));
        const cloudItems = cloudRes.items || [];

        // 核心三类常驻；其余扩展类型若本地与云端均为空，则不展示空抽屉
        const isCoreType = ct === 'settings' || ct === 'openai_preset' || ct === 'world';
        if (!isCoreType && localItems.length === 0 && cloudItems.length === 0) {
          const oldDrawer = treeEl.querySelector(`.cfgsync-group-drawer[data-content-type="${ct}"]`);
          if (oldDrawer) oldDrawer.remove();
          continue;
        }

        // 3. 智能合并：既能在本地看到未同步项，也能在其它账号下看到已有云端备份
        const itemMap = new Map();
        for (const loc of localItems) {
          itemMap.set(loc.itemUid, {
            itemUid: loc.itemUid,
            displayName: loc.displayName,
            sourceRef: loc.sourceRef,
            existsLocally: true,
            cloudItem: null,
          });
        }

        for (const cld of cloudItems) {
          if (itemMap.has(cld.item_uid)) {
            const existing = itemMap.get(cld.item_uid);
            existing.cloudItem = cld;
          } else {
            // 仅存在于云端（例如由其它账号如 default-user 备份），本地尚未下载
            itemMap.set(cld.item_uid, {
              itemUid: cld.item_uid,
              displayName: cld.display_name,
              sourceRef: `来自云端 (${cld.owner_handle})`,
              existsLocally: false,
              cloudItem: cld,
            });
          }
        }

        const items = Array.from(itemMap.values());
        // 智能排序：云端有数据的排在前面，未同步的排在后面；同组内部按中文拼音稳定字典序排序
        items.sort((a, b) => {
          const aHasCloud = Boolean(a.cloudItem);
          const bHasCloud = Boolean(b.cloudItem);
          if (aHasCloud !== bHasCloud) {
            return aHasCloud ? -1 : 1;
          }
          return (a.displayName || '').localeCompare(b.displayName || '', 'zh-CN');
        });
        const displayTypeName = ctNameMap[ct] || ct;

        let groupDrawer = treeEl.querySelector(`.cfgsync-group-drawer[data-content-type="${ct}"]`);
        if (!groupDrawer) {
          groupDrawer = this.createGroupDrawer(ct, displayTypeName);
          treeEl.appendChild(groupDrawer);
        }

        this.updateGroupDrawer(groupDrawer, ct, items, bindingMap);
      }

      if (loadingEl) loadingEl.style.display = 'none';
    } catch (err) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (err.status === 404 || err.message?.includes('404')) {
        this.renderServerErrorNotice();
      } else {
        console.warn('[cfgsync] Refresh error:', err.message);
      }
    } finally {
      this._refreshing = false;
    }
  }

  /**
   * 后台轮询事件回调：直接原地更新对应项，零刷新、零抖动
   */
  async handlePollerUpdate(events) {
    if (!this.container || !Array.isArray(events) || events.length === 0) return;

    let hasMissingItem = false;
    for (const evt of events) {
      const row = this.container.querySelector(
        `.cfgsync-item-row[data-content-type="${evt.content_type}"][data-item-uid="${evt.item_uid}"]`
      );
      if (row) {
        const sourceOwner = evt.owner_handle || this.accountHandle;
        const bindingUid = this.storage.makeBindingUid(this.accountHandle, sourceOwner, evt.content_type, evt.item_uid);
        const binding = await this.storage.getBinding(bindingUid);
        this.updateRowState(row, binding, {
          owner_handle: evt.owner_handle,
          current_version: evt.version,
          item_uid: evt.item_uid,
        }, row._existsLocally);
      } else {
        hasMissingItem = true;
      }
    }

    if (hasMissingItem) {
      await this.refresh();
    }
  }

  createGroupDrawer(ct, displayTypeName) {
    const groupDrawer = document.createElement('div');
    groupDrawer.className = 'cfgsync-group-drawer';
    groupDrawer.dataset.contentType = ct;
    groupDrawer.style.cssText = 'margin-bottom: 7px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; overflow: hidden; background: rgba(0, 0, 0, 0.12);';

    groupDrawer.innerHTML = `
      <div class="inline-drawer-header cfgsync-drawer-toggle" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; background: rgba(255, 255, 255, 0.03); user-select: none; transition: background 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 7px;">
          <b style="font-size: 12.5px; color: #40a9ff;">${displayTypeName}</b>
          <span class="cfgsync-count-badge" style="font-size: 10.5px; padding: 0 6px; height: 17px; line-height: 17px; border-radius: 9px; background: rgba(255, 255, 255, 0.08); opacity: 0.6; font-weight: 500;">0</span>
        </div>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" style="transition: transform 0.15s ease-in-out; font-size: 13px; opacity: 0.7;"></div>
      </div>
      <div class="cfgsync-drawer-content" style="display: none; padding: 5px 6px;">
        <div class="cfgsync-group-items"></div>
      </div>
    `;

    const toggleBtn = groupDrawer.querySelector('.cfgsync-drawer-toggle');
    const contentEl = groupDrawer.querySelector('.cfgsync-drawer-content');
    const iconEl = groupDrawer.querySelector('.inline-drawer-icon');

    toggleBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = contentEl.style.display === 'none';
      contentEl.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        iconEl.classList.remove('down');
        iconEl.classList.add('up');
      } else {
        iconEl.classList.remove('up');
        iconEl.classList.add('down');
      }
    };

    toggleBtn.onmouseenter = () => { toggleBtn.style.background = 'rgba(255, 255, 255, 0.06)'; };
    toggleBtn.onmouseleave = () => { toggleBtn.style.background = 'rgba(255, 255, 255, 0.03)'; };

    return groupDrawer;
  }

  updateGroupDrawer(groupDrawer, ct, items, bindingMap) {
    const badgeEl = groupDrawer.querySelector('.cfgsync-count-badge');
    const cloudCount = items.filter(i => Boolean(i.cloudItem && !i.cloudItem.is_deleted)).length;
    const totalCount = items.length;

    if (badgeEl) {
      if (totalCount > 0) {
        badgeEl.textContent = cloudCount > 0 ? `${cloudCount}/${totalCount}` : `${totalCount}`;
        badgeEl.title = `共 ${totalCount} 项配置：${cloudCount} 项云端有数据，${totalCount - cloudCount} 项未同步`;
        badgeEl.style.background = cloudCount > 0 ? 'rgba(24, 144, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
        badgeEl.style.color = cloudCount > 0 ? '#69c0ff' : '#8c8c8c';
        badgeEl.style.opacity = '1';
      } else {
        badgeEl.textContent = '0';
        badgeEl.style.background = 'rgba(255, 255, 255, 0.08)';
        badgeEl.style.color = '';
        badgeEl.style.opacity = '0.5';
      }
    }

    const itemsContainer = groupDrawer.querySelector('.cfgsync-group-items');
    if (!itemsContainer) return;

    if (items.length === 0) {
      itemsContainer.innerHTML = `<div class="cfgsync-empty-notice" style="font-size:12px; opacity:0.6; padding: 6px 4px;">（暂无可用配置）</div>`;
      return;
    }

    const emptyNotice = itemsContainer.querySelector('.cfgsync-empty-notice');
    if (emptyNotice) {
      emptyNotice.remove();
    }

    const currentItemUids = new Set(items.map(i => i.itemUid));

    // 移除已删除的项
    itemsContainer.querySelectorAll('.cfgsync-item-row').forEach(row => {
      if (!currentItemUids.has(row.dataset.itemUid)) {
        row.remove();
      }
    });

    // 移除旧的子分隔线
    const oldDivider = itemsContainer.querySelector('.cfgsync-section-divider');
    if (oldDivider) oldDivider.remove();

    // 动态判断是否需要渲染“本地未同步”子分隔栏（云端有数据与未同步两类并存时）
    const hasBoth = cloudCount > 0 && (totalCount - cloudCount) > 0;
    let dividerInserted = false;

    // 依序排列/创建配置项
    for (const item of items) {
      const binding = bindingMap.get(`${ct}:${item.itemUid}`);
      const isUnsynced = !item.cloudItem || item.cloudItem.is_deleted;

      if (hasBoth && isUnsynced && !dividerInserted) {
        const divider = document.createElement('div');
        divider.className = 'cfgsync-section-divider';
        divider.style.cssText = `
          font-size: 11px; color: #8b949e; margin: 9px 4px 6px 4px;
          padding-top: 6px; border-top: 1px dashed rgba(255, 255, 255, 0.1);
          display: flex; align-items: center; justify-content: space-between;
          user-select: none;
        `;
        divider.innerHTML = `
          <span style="display:inline-flex; align-items:center; gap:5px;">
            <i class="fa-solid fa-hard-drive" style="font-size:10px; color:#6e7681;"></i>
            <span>本地未同步 (${totalCount - cloudCount})</span>
          </span>
          <span style="font-size:10px; opacity:0.6;">点击右侧上传直接备份</span>
        `;
        itemsContainer.appendChild(divider);
        dividerInserted = true;
      }

      let existingRow = itemsContainer.querySelector(`.cfgsync-item-row[data-item-uid="${item.itemUid}"]`);
      if (existingRow) {
        this.updateRowState(existingRow, binding, item.cloudItem, item.existsLocally);
        itemsContainer.appendChild(existingRow); // 确保与排序后的 items 顺序一致
      } else {
        const newRow = this.createItemRow(ct, item, binding);
        itemsContainer.appendChild(newRow);
      }
    }
  }

  /**
   * 获取同步状态的颜色与文字描述
   */
  getStateInfo(state, version, cloudItem = null, binding = null) {
    if (binding && binding.enabled && state === SyncState.SYNCED) {
      if (cloudItem && cloudItem.current_version > (binding.last_synced_version || 0)) {
        return { color: '#faad14', label: '☁️ 有更新' };
      }
      const fromText = (binding.source_owner_handle && binding.source_owner_handle !== this.accountHandle) ? ` @${binding.source_owner_handle}` : '';
      return { color: '#52c41a', label: `已同步${fromText}` };
    }
    if (state === SyncState.CONFLICT) {
      return { color: '#f5222d', label: '⚠️ 冲突' };
    }
    if (state === SyncState.BACKUP_CREATED) {
      return { color: '#1890ff', label: '冷备份' };
    }
    if (cloudItem) {
      const isCross = cloudItem.owner_handle && cloudItem.owner_handle !== this.accountHandle;
      const ownerText = isCross ? ` @${cloudItem.owner_handle}` : '';
      return { color: '#1890ff', label: `已备份${ownerText}` };
    }
    return { color: '#8c8c8c', label: '未同步' };
  }

  /**
   * 将毫秒时间戳格式化为相对时间（如 "2分钟前"、"昨天"）
   */
  formatRelativeTime(timestampMs) {
    const now = Date.now();
    const diff = now - timestampMs;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days === 1) return '昨天';
    if (days < 30) return `${days}天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}个月前`;
    return `${Math.floor(months / 12)}年前`;
  }

  /**
   * 为指定行渲染版本选择器的初始 HTML（方案 A：极简紧凑胶囊风）
   * @returns {string} select 或 badge 的 HTML
   */
  renderVersionSelectorHtml(state, version, cloudItem = null, binding = null) {
    // 云端没有任何版本时，显示精致虚线小胶囊徽章
    if (!cloudItem) {
      return `<span class="cfgsync-state-badge cfgsync-badge-unsynced" title="当前配置仅保存在本地，尚未备份到云端" style="display:inline-flex; align-items:center; justify-content:center; font-size:10.5px; height:22px; line-height:20px; box-sizing:border-box; padding:0 8px; border-radius:11px; background:transparent; border:1px dashed rgba(255,255,255,0.18); color:#8b949e; white-space:nowrap; user-select:none; letter-spacing:0.3px;"><i class="fa-solid fa-cloud-slash" style="font-size:9.5px; margin-right:4px; opacity:0.6;"></i>未同步</span>`;
    }

    // 有云端版本时，显示方案 A 极简胶囊快照历史按钮（高对比云端蓝，无截断无白底白字）
    const isCross = cloudItem.owner_handle && cloudItem.owner_handle !== this.accountHandle;
    const badgeLabel = isCross ? `@${cloudItem.owner_handle} ▾` : '历史快照 ▾';

    return `<button class="cfgsync-history-badge-btn menu_button" type="button" title="点击查看与管理云端历史快照" style="display:inline-flex !important; align-items:center !important; gap:4px !important; font-size:10.5px !important; font-weight:600 !important; height:22px !important; line-height:20px !important; box-sizing:border-box !important; padding:0 8px !important; border-radius:11px !important; border:1px solid rgba(88,166,255,0.45) !important; background:rgba(31,111,235,0.18) !important; color:#58a6ff !important; cursor:pointer !important; outline:none !important; white-space:nowrap !important; transition:all 0.15s ease !important;">
      <i class="fa-solid fa-cloud" style="font-size:10px;"></i>
      <span>${badgeLabel}</span>
    </button>`;
  }

  /**
   * 还原云端指定快照或最新快照到本地
   */
  async restoreSnapshot(row, contentType, item, targetVersion = null) {
    if (!row._binding || !row._binding.enabled) {
      const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
      row._binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
    }
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    const origHtml = pullBtn ? pullBtn.innerHTML : '';
    if (pullBtn) {
      pullBtn.disabled = true;
      pullBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    try {
      const res = await this.syncManager.pullCloud(row._binding, null, targetVersion);
      row._existsLocally = true;
      this.updateRowState(row, row._binding, row._cloudItem, true);

      if (contentType === 'settings' && typeof window !== 'undefined' && res.content) {
        try {
          if (window.settings && typeof window.settings === 'object') {
            Object.assign(window.settings, res.content);
          }
          if (window.SillyTavern?.getContext?.()?.settings) {
            Object.assign(window.SillyTavern.getContext().settings, res.content);
          }
        } catch {}
      }

      const versionDesc = targetVersion ? `指定快照 (v${targetVersion})` : '最新快照';
      const strategy = res?.reload_strategy || this.getDefaultReloadStrategy(contentType);
      await this.handleReloadStrategy(strategy, item, versionDesc, this.accountHandle, res);
    } catch (e) {
      if (e.status === 423 || e.data?.code === 'LOCKED') {
        alert('【拉取已被防替换锁定保护拦截】\n\n当前配置已开启防替换锁定保护，阻止来自云端的覆盖！\n如需覆盖更新本地，请先点击行内的金色 🔒 图标解除锁定，然后再执行拉取。');
      } else {
        alert(`拉取失败: ${e.message}`);
      }
    } finally {
      if (pullBtn) {
        pullBtn.disabled = !row._cloudItem;
        pullBtn.innerHTML = origHtml;
        pullBtn.style.opacity = row._cloudItem ? '0.9' : '0.35';
      }
    }
  }

  /**
   * 获取某类配置的默认 reload_strategy 降级
   */
  getDefaultReloadStrategy(contentType) {
    if (contentType === 'character') return ReloadStrategy.CHARACTER_LIST;
    if (contentType === 'settings') return ReloadStrategy.SETTINGS;
    if (contentType === 'world') return ReloadStrategy.WORLD_INFO;
    if (contentType && contentType.endsWith('_preset')) return ReloadStrategy.PRESET_LIST;
    return ReloadStrategy.NONE;
  }

  /**
   * 根据服务端下发的 reload_strategy 执行前端刷新或提示重启 (P5-3)
   * @param {string} reloadStrategy
   * @param {object} item
   * @param {string} versionDesc
   * @param {string} accountHandle
   * @param {object} [res]
   * @returns {Promise<{ strategy: string, refreshedInUi: boolean, message: string }>}
   */
  async handleReloadStrategy(reloadStrategy, item, versionDesc, accountHandle, res = null) {
    const name = item.displayName || item.itemUid || '配置';
    let refreshedInUi = false;
    let reloadMsg = '';

    switch (reloadStrategy) {
      case ReloadStrategy.CHARACTER_LIST: {
        // 优先尝试触发前端刷新钩子
        try {
          if (typeof window !== 'undefined') {
            if (typeof window.getCharacters === 'function') {
              await window.getCharacters();
              refreshedInUi = true;
            } else if (window.SillyTavern?.getContext?.()?.getCharacters) {
              await window.SillyTavern.getContext().getCharacters();
              refreshedInUi = true;
            } else if (typeof window.jQuery === 'function' && window.jQuery('#character_refresh_button').length > 0) {
              window.jQuery('#character_refresh_button').trigger('click');
              refreshedInUi = true;
            }
          }
        } catch (err) {
          console.warn('[cfgsync] 触发角色列表前端刷新钩子异常:', err);
        }

        reloadMsg = `拉取成功！已将角色卡【${name}】的 ${versionDesc} 同步到本地。\n\n提示：SillyTavern 存在服务端内存缓存，若角色列表中未立即刷新显示该角色，请重启 SillyTavern 服务端完全生效。\n\n是否立即刷新页面？`;
        break;
      }

      case ReloadStrategy.SETTINGS: {
        reloadMsg = `拉取成功！已自动将【${name}】的 ${versionDesc} 同步并安全合并到当前账号（${accountHandle}）的本地配置中（已自动生成备份保护）。\n\n提示：酒馆服务在启动时会缓存全局配置与 API 密钥，若包含密钥更新，建议重启 SillyTavern 服务端以完全生效。\n\n是否立即刷新前端页面？`;
        break;
      }

      case ReloadStrategy.PRESET_LIST: {
        try {
          if (typeof window !== 'undefined') {
            if (typeof window.loadPresets === 'function') {
              await window.loadPresets();
              refreshedInUi = true;
            } else if (window.SillyTavern?.getContext?.()?.loadPresets) {
              await window.SillyTavern.getContext().loadPresets();
              refreshedInUi = true;
            }
          }
        } catch (err) {
          console.warn('[cfgsync] 触发预设列表前端刷新钩子异常:', err);
        }
        reloadMsg = `拉取成功！已将预设【${name}】的 ${versionDesc} 同步到本地。\n\n是否立即刷新页面以应用新预设？`;
        break;
      }

      case ReloadStrategy.WORLD_INFO: {
        try {
          if (typeof window !== 'undefined') {
            if (typeof window.loadWorldInfo === 'function') {
              await window.loadWorldInfo();
              refreshedInUi = true;
            } else if (window.SillyTavern?.getContext?.()?.loadWorldInfo) {
              await window.SillyTavern.getContext().loadWorldInfo();
              refreshedInUi = true;
            }
          }
        } catch (err) {
          console.warn('[cfgsync] 触发世界书前端刷新钩子异常:', err);
        }
        reloadMsg = `拉取成功！已将世界书【${name}】的 ${versionDesc} 同步到本地。\n\n是否立即刷新页面以应用？`;
        break;
      }

      case ReloadStrategy.BACKGROUND_CACHE: {
        reloadMsg = `拉取成功！已将背景【${name}】的 ${versionDesc} 同步到本地。\n\n是否立即刷新页面以更新背景缓存？`;
        break;
      }

      default: {
        reloadMsg = `拉取成功！已将【${name}】的 ${versionDesc} 同步并保存到当前账号（${accountHandle}）的本地目录中。\n\n是否立即刷新页面让酒馆完整应用新配置？`;
        break;
      }
    }

    const shouldReload = (typeof confirm === 'function') ? confirm(reloadMsg) : false;
    if (shouldReload && typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
    }

    return { strategy: reloadStrategy, refreshedInUi, message: reloadMsg };
  }

  updateRowState(row, binding, cloudItem = null, existsLocally = true) {
    row._binding = binding;
    if (cloudItem !== undefined) row._cloudItem = cloudItem;
    row._existsLocally = existsLocally;
    const cItem = row._cloudItem || null;
    const hasCloud = Boolean(cItem && !cItem.is_deleted);

    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || (hasCloud ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = binding?.last_synced_version || cItem?.current_version;
    const info = this.getStateInfo(state, version, hasCloud ? cItem : null, binding);

    // 1. 行样式差异化呈现
    if (hasCloud) {
      row._defaultBg = 'rgba(255, 255, 255, 0.05)';
      row._hoverBg = 'rgba(255, 255, 255, 0.08)';
      row.style.background = row._defaultBg;
      row.style.border = '1px solid rgba(255, 255, 255, 0.08)';
      row.style.borderLeft = '3px solid #1890ff';
    } else {
      row._defaultBg = 'rgba(255, 255, 255, 0.02)';
      row._hoverBg = 'rgba(255, 255, 255, 0.04)';
      row.style.background = row._defaultBg;
      row.style.border = '1px dashed rgba(255, 255, 255, 0.12)';
      row.style.borderLeft = '3px solid rgba(255, 255, 255, 0.2)';
    }

    // 1.5 动态更新左侧图标与文件名状态
    const rowIcon = row.querySelector('.cfgsync-row-icon');
    if (rowIcon) {
      rowIcon.className = `cfgsync-row-icon ${hasCloud ? 'fa-solid fa-cloud' : 'fa-regular fa-file'}`;
      rowIcon.style.color = hasCloud ? '#58a6ff' : 'rgba(255,255,255,0.3)';
    }
    const rowName = row.querySelector('.cfgsync-row-name');
    if (rowName && rowName.parentElement) {
      rowName.parentElement.style.fontWeight = hasCloud ? '600' : '400';
      rowName.parentElement.style.color = hasCloud ? '#f0f6fc' : '#c9d1d9';
    }
    const rowRef = row.querySelector('.cfgsync-row-ref');
    if (rowRef) {
      const baseRef = rowRef.dataset.sourceRef || rowRef.title || '';
      rowRef.textContent = `${baseRef}${!hasCloud ? ' · 仅本地' : ''}`;
      rowRef.style.color = hasCloud ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.3)';
    }

    // 2. 状态徽章与历史浮层
    const badgeContainer = row.querySelector('.cfgsync-state-badge-container');
    if (badgeContainer) {
      badgeContainer.innerHTML = this.renderVersionSelectorHtml(state, version, hasCloud ? cItem : null, binding);
      if (hasCloud) {
        const historyBtn = badgeContainer.querySelector('.cfgsync-history-badge-btn');
        if (historyBtn) {
          historyBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const owner = cItem?.owner_handle || this.accountHandle;
            const displayName = row._itemDisplayName || row.querySelector('.cfgsync-row-name')?.textContent || '配置项';
            showSnapshotHistoryDialog({
              displayName,
              contentType: row.dataset.contentType,
              itemUid: row.dataset.itemUid,
              owner,
              isCrossAccount: Boolean(owner && owner !== this.accountHandle),
              api: this.api,
              onRestore: async (targetVer) => {
                await this.restoreSnapshot(row, row.dataset.contentType, { displayName, itemUid: row.dataset.itemUid }, targetVer);
              },
              onDeleteVersion: async () => {
                await this.refresh();
              },
            });
          };
        }
      }
    }

    // 3. 按钮状态与视觉区分
    const pushBtn = row.querySelector('.cfgsync-push-btn');
    if (pushBtn) {
      pushBtn.disabled = !existsLocally;
      if (!existsLocally) {
        pushBtn.style.opacity = '0.25';
        pushBtn.style.pointerEvents = 'none';
        pushBtn.title = '本地不存在此文件';
      } else if (!hasCloud) {
        // 未同步项：强调“推送到云端”为首要行动点 (CTA)
        pushBtn.style.opacity = '1';
        pushBtn.style.pointerEvents = 'auto';
        pushBtn.style.background = 'rgba(31, 111, 235, 0.22) !important';
        pushBtn.style.border = '1px solid rgba(88, 166, 255, 0.5) !important';
        pushBtn.style.color = '#58a6ff !important';
        pushBtn.title = '未同步：立即推送到云端生成首个快照';
      } else {
        pushBtn.style.opacity = '0.9';
        pushBtn.style.pointerEvents = 'auto';
        pushBtn.style.background = '';
        pushBtn.style.border = '';
        pushBtn.style.color = '';
        pushBtn.title = '推送到云端 (上传新快照覆盖云端)';
      }
    }


    const shareBtn = row.querySelector('.cfgsync-share-btn');
    if (shareBtn) {
      shareBtn.disabled = !hasCloud;
      if (!hasCloud) {
        shareBtn.style.opacity = '0.15';
        shareBtn.style.pointerEvents = 'none';
        shareBtn.style.cursor = 'not-allowed';
        shareBtn.title = '尚未推送到云端，无法分享';
      } else {
        shareBtn.style.opacity = '0.9';
        shareBtn.style.pointerEvents = 'auto';
        shareBtn.style.cursor = 'pointer';
        shareBtn.title = '分享配置 (生成邀请码 / 设为公开)';
      }
    }

    const toggle = row.querySelector('.cfgsync-toggle');
    if (toggle && toggle.checked !== isEnabled) {
      toggle.checked = isEnabled;
    }
  }

  createItemRow(contentType, item, initialBinding) {
    const row = document.createElement('div');
    row.className = 'cfgsync-item-row';
    row.dataset.itemUid = item.itemUid;
    row.dataset.contentType = contentType;

    const cItem = item.cloudItem || null;
    const hasCloud = Boolean(cItem && !cItem.is_deleted);

    row._defaultBg = hasCloud ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)';
    row._hoverBg = hasCloud ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.04)';

    row.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; margin-bottom: 4px; border-radius: 6px;
      background: ${row._defaultBg};
      border: ${hasCloud ? '1px solid rgba(255, 255, 255, 0.08)' : '1px dashed rgba(255, 255, 255, 0.12)'};
      border-left: ${hasCloud ? '3px solid #1890ff' : '3px solid rgba(255, 255, 255, 0.2)'};
      gap: 8px;
      transition: background 0.15s ease;
    `;
    row.onmouseenter = () => { row.style.background = row._hoverBg; };
    row.onmouseleave = () => { row.style.background = row._defaultBg; };

    row._binding = initialBinding;
    row._cloudItem = cItem;
    row._existsLocally = item.existsLocally !== false;

    const isEnabled = Boolean(initialBinding?.enabled);
    const state = initialBinding?.state || (hasCloud ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = initialBinding?.last_synced_version || cItem?.current_version;

    const isLocked = Boolean(cItem?.is_locked !== undefined ? cItem.is_locked : item.is_locked);
    row._isLocked = isLocked;

    const lockOwnerTip = (cItem?.owner_handle && cItem.owner_handle !== this.accountHandle) ? `来自 @${cItem.owner_handle} 的配置` : '此配置';

    let iconOrAvatarHtml = '';
    if (contentType === 'character') {
      const avatarSrc = `/characters/${encodeURIComponent(item.sourceRef || item.displayName + '.png')}`;
      iconOrAvatarHtml = `
        <div style="width:20px; height:20px; flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; overflow:hidden; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);">
          <img class="cfgsync-char-avatar" src="${avatarSrc}" alt="" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='inline-flex';" />
          <i class="cfgsync-char-fallback fa-solid fa-user-ninja" style="display:none; font-size:11px; color:#58a6ff;"></i>
        </div>
      `;
    } else if (contentType === 'theme') {
      iconOrAvatarHtml = `<i class="fa-solid fa-palette" style="font-size:12px; color:#d48806; flex-shrink:0;"></i>`;
    } else if (contentType === 'settings') {
      iconOrAvatarHtml = `<i class="fa-solid fa-sliders" style="font-size:11px; color:#79c0ff; flex-shrink:0;"></i>`;
    } else if (contentType === 'world') {
      iconOrAvatarHtml = `<i class="fa-solid fa-book-atlas" style="font-size:11px; color:#7ee787; flex-shrink:0;"></i>`;
    } else {
      iconOrAvatarHtml = `<i class="cfgsync-row-icon ${hasCloud ? 'fa-solid fa-cloud' : 'fa-regular fa-file'}" style="font-size:11px; color:${hasCloud ? '#58a6ff' : 'rgba(255,255,255,0.3)'}; flex-shrink:0;"></i>`;
    }

    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1;">
        <input type="checkbox" class="cfgsync-toggle" ${isEnabled ? 'checked' : ''} title="${isEnabled ? '已开启云同步 (取消勾选停用)' : (hasCloud ? '勾选开启自动同步' : '未同步：勾选后可在推送时自动关联同步')}" style="cursor:pointer; flex-shrink:0; width:15px; height:15px; margin:0; accent-color:#1890ff;" />
        <div style="min-width:0; flex:1; overflow:hidden; display:flex; flex-direction:column; gap:1px;">
          <div title="${item.displayName}" style="font-size:12.5px; font-weight:${hasCloud ? '600' : '400'}; color:${hasCloud ? '#f0f6fc' : '#c9d1d9'}; line-height:1.3; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; display:flex; align-items:center; gap:6px;">
            ${iconOrAvatarHtml}
            <span class="cfgsync-row-name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.displayName}</span>
          </div>
          <div class="cfgsync-row-ref" data-source-ref="${item.sourceRef}" title="${item.sourceRef}" style="font-size:10.5px; line-height:1.2; color:${hasCloud ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.3)'}; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; padding-left: 26px;">${item.sourceRef}${!hasCloud ? ' · 仅本地' : ''}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:5px; flex-shrink:0;">
        <div class="cfgsync-state-badge-container" style="display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">
          ${this.renderVersionSelectorHtml(state, version, hasCloud ? cItem : null, initialBinding)}
        </div>
        <button class="cfgsync-push-btn menu_button" title="${hasCloud ? '推送到云端 (上传新快照覆盖云端)' : '未同步：立即推送到云端生成首个快照'}" style="white-space:nowrap !important; width:26px !important; min-width:26px !important; max-width:26px !important; height:24px !important; padding:0 !important; font-size:11px !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; cursor:pointer !important; border-radius:4px !important; ${!row._existsLocally ? 'opacity:0.25 !important; pointer-events:none;' : (!hasCloud ? 'opacity:1 !important; background:rgba(31,111,235,0.22) !important; border:1px solid rgba(88,166,255,0.5) !important; color:#58a6ff !important;' : 'opacity:0.9;')}">
          <i class="fa-solid fa-cloud-arrow-up"></i>
        </button>
        ${contentType !== 'settings' ? `
        <button class="cfgsync-share-btn menu_button" title="${hasCloud ? '分享配置 (生成邀请码 / 设为公开)' : '尚未推送到云端，无法分享'}" style="white-space:nowrap !important; width:26px !important; min-width:26px !important; max-width:26px !important; height:24px !important; padding:0 !important; font-size:11px !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; border-radius:4px !important; ${!hasCloud ? 'opacity:0.15 !important; pointer-events:none !important; cursor:not-allowed !important;' : 'opacity:0.9; cursor:pointer !important;'}">
          <i class="fa-solid fa-share-nodes"></i>
        </button>
        <button class="cfgsync-delete-btn menu_button" title="删除配置 (云端备份 / 本地文件)" style="white-space:nowrap !important; width:24px !important; min-width:24px !important; max-width:24px !important; height:24px !important; padding:0 !important; font-size:11px !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; cursor:pointer !important; border-radius:4px !important; background:transparent; border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.4); transition:all 0.15s ease;">
          <i class="fa-regular fa-trash-can"></i>
        </button>
        ` : ''}
      </div>
    `;

    row._itemDisplayName = item.displayName;

    if (contentType === 'character') {
      const avatarImg = row.querySelector('.cfgsync-char-avatar');
      if (avatarImg) {
        if (this.thumbnailCache.has(item.itemUid)) {
          avatarImg.src = this.thumbnailCache.get(item.itemUid);
        } else {
          avatarImg.onload = () => {
            this.thumbnailCache.set(item.itemUid, avatarImg.src);
          };
        }
      }
    }

    // 绑定快照历史弹窗事件
    const historyBtn = row.querySelector('.cfgsync-history-badge-btn');
    if (historyBtn) {
      historyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const owner = row._cloudItem?.owner_handle || this.accountHandle;
        showSnapshotHistoryDialog({
          displayName: item.displayName,
          contentType,
          itemUid: item.itemUid,
          owner,
          isCrossAccount: Boolean(owner && owner !== this.accountHandle),
          api: this.api,
          onRestore: async (targetVer) => {
            await this.restoreSnapshot(row, contentType, item, targetVer);
          },
          onDeleteVersion: async () => {
            await this.refresh();
          },
        });
      };
    }

    // 勾选切换开关
    const toggle = row.querySelector('.cfgsync-toggle');
    toggle.onchange = async () => {
      toggle.disabled = true;
      try {
        if (toggle.checked) {
          const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
          const binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
          this.updateRowState(row, binding, row._cloudItem, row._existsLocally);
        } else {
          const sourceOwner = row._binding?.source_owner_handle || row._cloudItem?.owner_handle || this.accountHandle;
          const bindingUid = this.storage.makeBindingUid(this.accountHandle, sourceOwner, contentType, item.itemUid);
          const binding = await this.syncManager.disableSync(bindingUid, false);
          this.updateRowState(row, binding, row._cloudItem, row._existsLocally);
        }
      } catch (err) {
        console.error('[cfgsync] toggle error:', err);
        toggle.checked = !toggle.checked;
        alert(`切换状态失败: ${err.message}`);
      } finally {
        toggle.disabled = false;
      }
    };

    // 手动推送到云端（支持时间快照、自定义备注、缓存精简与网盘式直传）
    const pushBtn = row.querySelector('.cfgsync-push-btn');
    pushBtn.onclick = () => {
      showPushDialog({
        displayName: item.displayName,
        contentType,
        onConfirm: async (versionTitle, pushOptions = {}) => {
          if (!row._binding || !row._binding.enabled) {
            const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
            row._binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
          }
          pushBtn.disabled = true;
          const origHtml = pushBtn.innerHTML;
          pushBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            let localPayload = null;
            if (contentType === 'settings' && typeof window !== 'undefined') {
              try {
                const s = window.settings || window.SillyTavern?.getContext?.()?.settings;
                if (s && typeof s === 'object' && Object.keys(s).length > 0) {
                  localPayload = JSON.parse(JSON.stringify(s));
                }
              } catch {}
            }

            const res = await this.syncManager.pushLocal(row._binding, localPayload, {
              versionTitle,
              force: true, // 网盘式快照直传
              excludeHeavy: pushOptions?.excludeHeavy,
            });
            if (res.conflict) {
              showConflictDialog({
                displayName: item.displayName,
                serverVersion: res.serverVersion,
                onResolve: async (choice) => {
                  await this.syncManager.resolveConflict(row._binding, choice, localPayload);
                  row._versionsLoaded = false;
                  await this.refresh();
                },
              });
            } else {
              row._existsLocally = true;
              await this.refresh();
              const toastMsg = `已成功推送到云端 (${res.versionTitle || '最新快照'})`;
              if (typeof toastr !== 'undefined' && toastr?.success) {
                toastr.success(toastMsg);
              }
            }
          } catch (e) {
            alert(`推送失败: ${e.message}`);
          } finally {
            pushBtn.disabled = !row._existsLocally;
            pushBtn.innerHTML = origHtml;
            pushBtn.style.opacity = row._existsLocally ? '0.9' : '0.35';
          }
        },
      });
    };


    // 分享配置（专属邀请码 / 全服公开）
    const shareBtn = row.querySelector('.cfgsync-share-btn');
    if (shareBtn) {
      shareBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showShareDialog({
          api: this.api,
          contentType,
          itemUid: item.itemUid,
          displayName: item.displayName,
          onUpdated: () => this.refresh(),
        });
      };
    }

    // 安全删除配置（云端备份 / 本地文件）
    const deleteBtn = row.querySelector('.cfgsync-delete-btn');
    if (deleteBtn) {
      deleteBtn.onmouseenter = () => {
        deleteBtn.style.color = '#f85149';
        deleteBtn.style.borderColor = 'rgba(248,81,73,0.4)';
        deleteBtn.style.background = 'rgba(248,81,73,0.1)';
      };
      deleteBtn.onmouseleave = () => {
        deleteBtn.style.color = 'rgba(255,255,255,0.4)';
        deleteBtn.style.borderColor = 'rgba(255,255,255,0.12)';
        deleteBtn.style.background = 'transparent';
      };
      deleteBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showDeleteDialog({
          displayName: item.displayName,
          contentType,
          itemUid: item.itemUid,
          existsLocally: row._existsLocally,
          onConfirm: async ({ deleteCloud, deleteLocal }) => {
            const res = await this.api.deleteItem({
              contentType,
              itemUid: item.itemUid,
              deleteCloud,
              deleteLocal,
            });
            const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
            const bindingUid = this.storage.makeBindingUid(this.accountHandle, sourceOwner, contentType, item.itemUid);
            await this.storage.deleteBinding(bindingUid).catch(() => {});
            await this.refresh();

            if (deleteLocal && res?.deleted_local === false && res?.local_reason === 'local_file_not_found') {
              alert('【删除提示】\n\n本地未找到该配置文件，已仅删除云端备份记录。');
            }
          },
        });
      };
    }

    return row;
  }

  updateLockBtnState(btn, isLocked, owner = '') {
    if (!btn) return;
    const ownerTip = owner && owner !== this.accountHandle ? `来自 @${owner} 的配置` : '此配置';
    btn.title = isLocked
      ? `防替换保护：已锁定${ownerTip}，阻止任何云端快照覆盖本地 (点击解锁)`
      : `防替换保护：未锁定${ownerTip} (点击开启防替换锁定)`;
    btn.style.background = isLocked ? 'rgba(250, 173, 20, 0.18)' : 'transparent';
    btn.style.borderColor = isLocked ? 'rgba(250, 173, 20, 0.45)' : 'rgba(255, 255, 255, 0.12)';
    btn.style.color = isLocked ? '#faad14' : 'rgba(255, 255, 255, 0.4)';
    btn.innerHTML = `<i class="fa-solid ${isLocked ? 'fa-lock' : 'fa-lock-open'}"></i>`;
  }

  renderServerErrorNotice() {
    this.container.innerHTML = `
      <div style="box-sizing: border-box; width: 100%; background: #1c181a; border: 1px solid rgba(255, 77, 79, 0.4); border-left: 4px solid #ff4d4f; border-radius: 6px; padding: 12px; margin: 4px 0; color: #f5f5f5;">
        <div style="color: #ff4d4f; font-weight: 600; font-size: 13px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          <span>⚠️</span> 服务端插件未就绪
        </div>
        <div style="font-size: 12px; line-height: 1.6; margin-bottom: 8px; color: #d0d0d0;">
          当前仅加载了前端扩展，SillyTavern 后端尚未激活插件路由。请按以下步骤启用：
        </div>
        <ol style="font-size: 12px; line-height: 1.8; margin: 0 0 10px 18px; padding: 0; color: #c5c5c5;">
          <li>将本仓库移动或软链接到 <code>SillyTavern/plugins/cfgsync</code>；</li>
          <li>在 <code>config.yaml</code> 中确认 <code>enableServerPlugins: true</code>；</li>
          <li>重启 SillyTavern 服务端。</li>
        </ol>
        <button class="menu_button cfgsync-retry-btn" style="width: 100%; padding: 6px; font-size: 12px; cursor: pointer;">
          🔄 重新检测服务状态
        </button>
      </div>
    `;
    const retryBtn = this.container.querySelector('.cfgsync-retry-btn');
    if (retryBtn) {
      retryBtn.onclick = () => {
        this.container.innerHTML = '';
        this.refresh();
      };
    }
  }
}
