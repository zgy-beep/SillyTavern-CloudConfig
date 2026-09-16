import { SyncState, SyncMode } from '../../common/constants.js';
import { showConflictDialog } from './conflictDialog.js';

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
      <div class="cfgsync-panel-container" style="padding: 6px 2px; font-family: sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:6px; border-bottom: 1px solid rgba(255,255,255,0.08); gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
            <span style="font-size:12px; font-weight:600; opacity:0.9;">云端配置项</span>
            <button id="cfgsync-toggle-all-btn" type="button" style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:24px; padding:0 10px; margin:0; border-radius:4px; font-size:11px; font-weight:500; color:#69c0ff; background:rgba(24,144,255,0.15); border:1px solid rgba(24,144,255,0.35); cursor:pointer; user-select:none;">
              <i class="fa-solid fa-angles-down" style="font-size:10px;"></i>
              <span class="cfgsync-toggle-all-text">全部展开</span>
            </button>
          </div>
          <span style="font-size:12px; opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">当前账号: <strong class="cfgsync-account-label" style="color:#69c0ff;">${this.accountHandle}</strong></span>
        </div>
        <div id="cfgsync-items-loading" style="text-align:center; padding:16px; font-size:12px; opacity:0.7;">正在加载配置...</div>
        <div id="cfgsync-items-tree"></div>
      </div>
    `;

    this.bindToggleAll();
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

      const p0Types = typeRes.groups?.P0 || [];
      const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
      const bindingMap = new Map(bindings.map(b => [`${b.content_type}:${b.item_uid}`, b]));

      const ctNameMap = {
        'settings': '通用设置 (Settings)',
        'openai_preset': 'OpenAI 预设 (Presets)',
        'textgen_preset': 'TextGen 预设 (Presets)',
        'novel_preset': 'NovelAI 预设 (Presets)',
        'kobold_preset': 'KoboldAI 预设 (Presets)',
        'world': '世界设定 / 规则书 (World Info)',
      };

      for (const ct of p0Types) {
        // 1. 获取本地配置项
        const localRes = await this.api.getItems(ct, this.accountHandle, 'local').catch(() => ({ items: [] }));
        const localItems = localRes.items || [];

        // 2. 获取云端全量备份（跨所有账号）
        const cloudRes = await this.api.getItems(ct, '', 'cloud', true).catch(() => ({ items: [] }));
        const cloudItems = cloudRes.items || [];

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
    groupDrawer.style.cssText = 'margin-bottom: 8px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; overflow: hidden; background: rgba(0, 0, 0, 0.1);';

    groupDrawer.innerHTML = `
      <div class="inline-drawer-header cfgsync-drawer-toggle" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: rgba(255, 255, 255, 0.03); user-select: none; transition: background 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <b style="font-size: 13px; color: #1890ff;">${displayTypeName}</b>
          <span class="cfgsync-count-badge" style="font-size: 11px; padding: 1px 7px; border-radius: 10px; background: rgba(255, 255, 255, 0.08); opacity: 0.5; font-weight: normal;">0</span>
        </div>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" style="transition: transform 0.15s ease-in-out; font-size: 14px;"></div>
      </div>
      <div class="cfgsync-drawer-content" style="display: none; padding: 6px 8px;">
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
    if (badgeEl) {
      badgeEl.textContent = String(items.length);
      if (items.length > 0) {
        badgeEl.style.background = 'rgba(24, 144, 255, 0.2)';
        badgeEl.style.color = '#69c0ff';
        badgeEl.style.opacity = '1';
      } else {
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

    // 原地更新已有项，或创建新项
    for (const item of items) {
      const binding = bindingMap.get(`${ct}:${item.itemUid}`);
      let existingRow = itemsContainer.querySelector(`.cfgsync-item-row[data-item-uid="${item.itemUid}"]`);
      if (existingRow) {
        this.updateRowState(existingRow, binding, item.cloudItem, item.existsLocally);
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
        return { color: '#faad14', label: `☁️ 云端新版 v${cloudItem.current_version}` };
      }
      const vText = version ? `v${version}` : '本地版';
      const fromText = (binding.source_owner_handle && binding.source_owner_handle !== this.accountHandle) ? ` · ${binding.source_owner_handle}` : '';
      return { color: '#52c41a', label: `已同步 (${vText}${fromText})` };
    }
    if (state === SyncState.CONFLICT) {
      return { color: '#f5222d', label: '⚠️ 冲突' };
    }
    if (state === SyncState.BACKUP_CREATED) {
      return { color: '#1890ff', label: '冷备份就绪' };
    }
    if (cloudItem) {
      return { color: '#722ed1', label: `云端就绪 (v${cloudItem.current_version} · ${cloudItem.owner_handle})` };
    }
    return { color: '#555', label: '未同步' };
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
   * 为指定行渲染版本选择器的初始 HTML
   * @returns {string} select 或 badge 的 HTML
   */
  renderVersionSelectorHtml(state, version, cloudItem = null, binding = null) {
    const info = this.getStateInfo(state, version, cloudItem, binding);

    // 云端没有任何版本时，显示静态徽章
    if (!cloudItem) {
      return `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:${info.color}; color:#fff; white-space:nowrap;">${info.label}</span>`;
    }

    // 有云端版本时，显示下拉选择器（初始仅显示当前版本，懒加载完整列表）
    const ownerText = cloudItem.owner_handle || '';
    const currentV = cloudItem.current_version || 1;
    return `<select class="cfgsync-version-select" style="font-size:11px; padding:2px 4px; border-radius:3px; border:2px solid ${info.color}; background:rgba(0,0,0,0.3); color:#fff; cursor:pointer; max-width:180px; outline:none; appearance:auto; -webkit-appearance:menulist;">
      <option value="${currentV}" selected>v${currentV} · 最新 · ${ownerText}</option>
    </select>`;
  }

  /**
   * 懒加载版本历史到下拉选择器
   */
  async loadVersionOptions(row) {
    if (row._versionsLoaded) return;
    const cloudItem = row._cloudItem;
    if (!cloudItem) return;

    const contentType = row.dataset.contentType;
    const itemUid = row.dataset.itemUid;
    const owner = cloudItem.owner_handle || this.accountHandle;

    try {
      const res = await this.api.getVersions(contentType, itemUid, owner);
      const versions = res.versions || [];
      if (versions.length === 0) return;

      const select = row.querySelector('.cfgsync-version-select');
      if (!select) return;

      const currentSelected = select.value;

      select.innerHTML = '';
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        if (v.operation === 'DELETE') continue;
        const isLatest = i === 0;
        const timeText = v.created_at ? this.formatRelativeTime(v.created_at) : '';
        const label = isLatest
          ? `v${v.version} · 最新 · ${owner} · ${timeText}`
          : `v${v.version} · ${owner} · ${timeText}`;
        const opt = document.createElement('option');
        opt.value = String(v.version);
        opt.textContent = label;
        if (String(v.version) === currentSelected) opt.selected = true;
        select.appendChild(opt);
      }

      // 如果之前选中的版本已不存在，默认选中最新
      if (!select.querySelector(`option[value="${currentSelected}"]`)) {
        select.selectedIndex = 0;
      }

      row._versionsLoaded = true;
    } catch (err) {
      console.warn('[cfgsync] Failed to load version history:', err.message);
    }
  }

  updateRowState(row, binding, cloudItem = null, existsLocally = true) {
    row._binding = binding;
    if (cloudItem !== undefined) row._cloudItem = cloudItem;
    row._existsLocally = existsLocally;
    const cItem = row._cloudItem || null;

    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || (cItem ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = binding?.last_synced_version || cItem?.current_version;
    const info = this.getStateInfo(state, version, cItem, binding);

    const badgeContainer = row.querySelector('.cfgsync-state-badge-container');
    if (badgeContainer) {
      const select = badgeContainer.querySelector('.cfgsync-version-select');
      if (select) {
        // 有版本选择器时，仅更新边框颜色
        select.style.borderColor = info.color;
      } else if (cItem) {
        // 云端有数据但选择器还没创建（可能状态变化后出现了 cloudItem），用选择器替换 badge
        badgeContainer.innerHTML = this.renderVersionSelectorHtml(state, version, cItem, binding);
        const newSelect = badgeContainer.querySelector('.cfgsync-version-select');
        if (newSelect) {
          newSelect.addEventListener('focus', () => this.loadVersionOptions(row), { once: true });
          newSelect.addEventListener('mousedown', () => this.loadVersionOptions(row), { once: true });
        }
      } else {
        // 没有云端数据，显示静态 badge
        badgeContainer.innerHTML = `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:${info.color}; color:#fff; white-space:nowrap;">${info.label}</span>`;
      }
    }

    const pushBtn = row.querySelector('.cfgsync-push-btn');
    if (pushBtn) {
      pushBtn.disabled = !existsLocally || !isEnabled;
    }

    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    if (pullBtn) {
      pullBtn.disabled = !cItem && !isEnabled;
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
    row.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; margin-bottom: 6px; border-radius: 4px;
      background: rgba(255, 255, 255, 0.05); gap: 8px;
    `;

    row._binding = initialBinding;
    row._cloudItem = item.cloudItem || null;
    row._existsLocally = item.existsLocally !== false;

    const isEnabled = Boolean(initialBinding?.enabled);
    const state = initialBinding?.state || (item.cloudItem ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = initialBinding?.last_synced_version || item.cloudItem?.current_version;

    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
        <input type="checkbox" class="cfgsync-toggle" ${isEnabled ? 'checked' : ''} style="cursor:pointer; flex-shrink:0;" />
        <div style="min-width:0; overflow:hidden;">
          <div style="font-size:13px; font-weight:500; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${item.displayName}</div>
          <div style="font-size:11px; opacity:0.6; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${item.sourceRef}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <div class="cfgsync-state-badge-container" style="display:inline-flex; align-items:center;">
          ${this.renderVersionSelectorHtml(state, version, item.cloudItem, initialBinding)}
        </div>
        <button class="cfgsync-push-btn menu_button" style="white-space:nowrap !important; width:auto !important; min-width:unset !important; padding:4px 8px !important; font-size:11px !important; line-height:1.2 !important; cursor:pointer;" ${(!row._existsLocally || !isEnabled) ? 'disabled' : ''}>推云端</button>
        <button class="cfgsync-pull-btn menu_button" style="white-space:nowrap !important; width:auto !important; min-width:unset !important; padding:4px 8px !important; font-size:11px !important; line-height:1.2 !important; cursor:pointer;" ${(!item.cloudItem && !isEnabled) ? 'disabled' : ''}>拉云端</button>
      </div>
    `;

    // 为版本选择器绑定懒加载事件
    const versionSelect = row.querySelector('.cfgsync-version-select');
    if (versionSelect) {
      versionSelect.addEventListener('focus', () => this.loadVersionOptions(row), { once: true });
      versionSelect.addEventListener('mousedown', () => this.loadVersionOptions(row), { once: true });
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
          const confirmRestore = confirm(`是否在关闭同步时恢复为开启同步前的本地原始配置？\n点击【确定】恢复备份，点击【取消】保留当前配置。`);
          const sourceOwner = row._binding?.source_owner_handle || row._cloudItem?.owner_handle || this.accountHandle;
          const bindingUid = this.storage.makeBindingUid(this.accountHandle, sourceOwner, contentType, item.itemUid);
          const binding = await this.syncManager.disableSync(bindingUid, confirmRestore);
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

    // 手动推送到云端
    const pushBtn = row.querySelector('.cfgsync-push-btn');
    pushBtn.onclick = async () => {
      if (!row._binding) {
        const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
        row._binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
      }
      pushBtn.disabled = true;
      const origText = pushBtn.textContent;
      pushBtn.textContent = '推送中...';
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

        const res = await this.syncManager.pushLocal(row._binding, localPayload);
        if (res.conflict) {
          showConflictDialog({
            displayName: item.displayName,
            serverVersion: res.serverVersion,
            onResolve: async (choice) => {
              await this.syncManager.resolveConflict(row._binding, choice, localPayload);
              row._versionsLoaded = false; // 推送后刷新版本列表
              this.updateRowState(row, row._binding, row._cloudItem, true);
            },
          });
        } else {
          row._existsLocally = true;
          row._versionsLoaded = false; // 推送后刷新版本列表
          this.updateRowState(row, row._binding, row._cloudItem, true);
        }
      } catch (e) {
        alert(`推送失败: ${e.message}`);
      } finally {
        pushBtn.disabled = !row._binding?.enabled;
        pushBtn.textContent = origText;
      }
    };

    // 手动从云端拉取（支持跨账号从任意云端备份拉取并写入本地，支持选择历史版本）
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    pullBtn.onclick = async () => {
      if (!row._binding) {
        const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
        row._binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
      }
      pullBtn.disabled = true;
      const origText = pullBtn.textContent;
      pullBtn.textContent = '拉取中...';
      try {
        // 从版本下拉选择器读取用户选中的目标版本
        const versionSelect = row.querySelector('.cfgsync-version-select');
        const selectedVersion = versionSelect ? Number(versionSelect.value) : null;
        const versionLabel = selectedVersion ? `v${selectedVersion}` : '最新版';

        const res = await this.syncManager.pullCloud(row._binding, null, selectedVersion);
        row._existsLocally = true;
        this.updateRowState(row, row._binding, row._cloudItem, true);

        // 如果拉取的是设置，同步更新前端内存中的 settings 状态
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

        const shouldReload = confirm(
          `拉取成功！已将【${item.displayName}】的 ${versionLabel} 同步并保存到当前账号（${this.accountHandle}）的本地目录中。\n\n是否立即刷新页面让酒馆完整应用新配置？`
        );
        if (shouldReload) {
          window.location.reload();
        }
      } catch (e) {
        alert(`拉取失败: ${e.message}`);
      } finally {
        pullBtn.disabled = false;
        pullBtn.textContent = origText;
      }
    };

    return row;
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
