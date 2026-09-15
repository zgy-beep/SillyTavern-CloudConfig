import { SyncState } from '../../common/constants.js';
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
  }

  render(targetEl) {
    this.container = targetEl;
    this.refresh();
  }

  async refresh() {
    if (!this.container) return;

    // 记录已展开的分类，以便在刷新后保持用户的展开/折叠状态
    const expandedCategories = new Set();
    this.container.querySelectorAll('.cfgsync-group-drawer').forEach(drawer => {
      const ct = drawer.dataset.contentType;
      const content = drawer.querySelector('.cfgsync-drawer-content');
      if (ct && content && content.style.display === 'block') {
        expandedCategories.add(ct);
      }
    });

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
          <span style="font-size:12px; opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">账号: <strong class="cfgsync-account-label">${this.accountHandle}</strong></span>
        </div>
        <div id="cfgsync-items-loading" style="text-align:center; padding:16px; font-size:12px; opacity:0.7;">正在加载同步配置...</div>
        <div id="cfgsync-items-tree"></div>
      </div>
    `;

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

      const treeEl = this.container.querySelector('#cfgsync-items-tree');
      this.container.querySelector('#cfgsync-items-loading').style.display = 'none';

      const ctNameMap = {
        'settings': '通用设置 (Settings)',
        'openai_preset': 'OpenAI 预设 (Presets)',
        'textgen_preset': 'TextGen 预设 (Presets)',
        'novel_preset': 'NovelAI 预设 (Presets)',
        'kobold_preset': 'KoboldAI 预设 (Presets)',
        'world': '世界设定 / 规则书 (World Info)',
      };

      const toggleAllBtn = this.container.querySelector('#cfgsync-toggle-all-btn');
      let allExpanded = false;
      if (toggleAllBtn) {
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

      for (const ct of p0Types) {
        // 读取本地可同步对象
        const localRes = await this.api.getItems(ct, this.accountHandle, 'local').catch(() => ({ items: [] }));
        const items = localRes.items || [];
        const displayTypeName = ctNameMap[ct] || ct;

        // 如果用户之前已经手动展开过此分类，则保持展开；否则默认折叠
        const isExpanded = expandedCategories.has(ct);

        const groupDrawer = document.createElement('div');
        groupDrawer.className = 'cfgsync-group-drawer';
        groupDrawer.dataset.contentType = ct;
        groupDrawer.style.cssText = 'margin-bottom: 8px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; overflow: hidden; background: rgba(0, 0, 0, 0.1);';

        const countBadge = items.length > 0
          ? `<span style="font-size: 11px; padding: 1px 7px; border-radius: 10px; background: rgba(24, 144, 255, 0.2); color: #69c0ff; font-weight: normal;">${items.length}</span>`
          : `<span style="font-size: 11px; padding: 1px 7px; border-radius: 10px; background: rgba(255, 255, 255, 0.08); opacity: 0.5; font-weight: normal;">0</span>`;

        groupDrawer.innerHTML = `
          <div class="inline-drawer-header cfgsync-drawer-toggle" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: rgba(255, 255, 255, 0.03); user-select: none; transition: background 0.15s ease;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <b style="font-size: 13px; color: #1890ff;">${displayTypeName}</b>
              ${countBadge}
            </div>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down ${isExpanded ? 'up' : 'down'}" style="transition: transform 0.15s ease-in-out; font-size: 14px;"></div>
          </div>
          <div class="cfgsync-drawer-content" style="display: ${isExpanded ? 'block' : 'none'}; padding: 6px 8px;">
            <div class="cfgsync-group-items"></div>
          </div>
        `;

        const itemsContainer = groupDrawer.querySelector('.cfgsync-group-items');

        if (items.length === 0) {
          itemsContainer.innerHTML = `<div style="font-size:12px; opacity:0.6; padding: 6px 4px;">（本地未找到此类型配置）</div>`;
        } else {
          for (const item of items) {
            const binding = bindingMap.get(`${ct}:${item.itemUid}`);
            const itemRow = this.createItemRow(ct, item, binding);
            itemsContainer.appendChild(itemRow);
          }
        }

        // 高性能瞬时原生切换，杜绝 jQuery 逐帧高度计算导致的掉帧与高度截断异常
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

        treeEl.appendChild(groupDrawer);
      }
    } catch (err) {
      if (err.status === 404 || err.message?.includes('404')) {
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
          retryBtn.onclick = () => this.refresh();
        }
      } else {
        this.container.innerHTML = `<div style="color:#ff4d4f; padding:12px; font-size:12px;">加载配置失败: ${err.message}</div>`;
      }
    }
  }

  renderBadgeHtml(state, version) {
    if (state === SyncState.SYNCED) {
      const vText = version ? `v${version}` : '本地版';
      return `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:#52c41a; color:#fff; white-space:nowrap;">已同步 (${vText})</span>`;
    }
    if (state === SyncState.CONFLICT) {
      return `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:#f5222d; color:#fff; white-space:nowrap;">⚠️ 冲突</span>`;
    }
    if (state === SyncState.BACKUP_CREATED) {
      return `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:#1890ff; color:#fff; white-space:nowrap;">冷备份就绪</span>`;
    }
    return `<span class="cfgsync-state-badge" style="font-size:11px; padding:2px 6px; border-radius:3px; background:#555; color:#fff; white-space:nowrap;">未同步</span>`;
  }

  updateRowState(row, binding) {
    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || SyncState.DISABLED;
    const version = binding?.last_synced_version;

    const badgeContainer = row.querySelector('.cfgsync-state-badge-container');
    if (badgeContainer) {
      badgeContainer.innerHTML = this.renderBadgeHtml(state, version);
    }

    const pushBtn = row.querySelector('.cfgsync-push-btn');
    if (pushBtn) {
      pushBtn.disabled = !isEnabled;
    }

    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    if (pullBtn) {
      pullBtn.disabled = !isEnabled;
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

    let binding = initialBinding;
    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || SyncState.DISABLED;
    const version = binding?.last_synced_version;

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
          ${this.renderBadgeHtml(state, version)}
        </div>
        <button class="cfgsync-push-btn menu_button" style="white-space:nowrap !important; width:auto !important; min-width:unset !important; padding:4px 8px !important; font-size:11px !important; line-height:1.2 !important; cursor:pointer;" ${!isEnabled ? 'disabled' : ''}>推云端</button>
        <button class="cfgsync-pull-btn menu_button" style="white-space:nowrap !important; width:auto !important; min-width:unset !important; padding:4px 8px !important; font-size:11px !important; line-height:1.2 !important; cursor:pointer;" ${!isEnabled ? 'disabled' : ''}>拉云端</button>
      </div>
    `;

    // 勾选切换开关（原地更新，绝不全量重建，彻底杜绝抖动）
    const toggle = row.querySelector('.cfgsync-toggle');
    toggle.onchange = async () => {
      toggle.disabled = true;
      try {
        if (toggle.checked) {
          binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName);
          this.updateRowState(row, binding);
        } else {
          const confirmRestore = confirm(`是否在关闭同步时恢复为开启同步前的本地原始配置？\n点击【确定】恢复备份，点击【取消】保留当前配置。`);
          const bindingUid = this.storage.makeBindingUid(this.accountHandle, this.accountHandle, contentType, item.itemUid);
          binding = await this.syncManager.disableSync(bindingUid, confirmRestore);
          this.updateRowState(row, binding);
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

        const res = await this.syncManager.pushLocal(binding, localPayload);
        if (res.conflict) {
          showConflictDialog({
            displayName: item.displayName,
            serverVersion: res.serverVersion,
            onResolve: async (choice) => {
              await this.syncManager.resolveConflict(binding, choice, localPayload);
              this.updateRowState(row, binding);
            },
          });
        } else {
          this.updateRowState(row, binding);
        }
      } catch (e) {
        alert(`推送失败: ${e.message}`);
      } finally {
        pushBtn.disabled = !binding?.enabled;
        pushBtn.textContent = origText;
      }
    };

    // 手动从云端拉取
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    pullBtn.onclick = async () => {
      pullBtn.disabled = true;
      const origText = pullBtn.textContent;
      pullBtn.textContent = '拉取中...';
      try {
        await this.syncManager.pullCloud(binding);
        this.updateRowState(row, binding);
      } catch (e) {
        alert(`拉取失败: ${e.message}`);
      } finally {
        pullBtn.disabled = !binding?.enabled;
        pullBtn.textContent = origText;
      }
    };

    return row;
  }
}
