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

    this.container.innerHTML = `
      <div class="cfgsync-panel-container" style="padding: 10px 4px; font-family: sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          <span style="font-size:12px; font-weight:600; opacity:0.9;">云端配置项</span>
          <span style="font-size:12px; opacity:0.8;">账号: <strong class="cfgsync-account-label">${this.accountHandle}</strong></span>
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

      for (const ct of p0Types) {
        const groupEl = document.createElement('div');
        groupEl.style.cssText = 'margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px;';
        const displayTypeName = ctNameMap[ct] || ct;
        groupEl.innerHTML = `<h4 style="margin:0 0 10px 0; font-size:13px; font-weight:600; color: #1890ff;">${displayTypeName}</h4>`;

        // 读取本地可同步对象
        const localRes = await this.api.getItems(ct, this.accountHandle, 'local').catch(() => ({ items: [] }));
        const items = localRes.items || [];

        if (items.length === 0) {
          groupEl.innerHTML += `<div style="font-size:12px; opacity:0.6; margin-left:12px;">（本地未找到此类型配置）</div>`;
        } else {
          for (const item of items) {
            const binding = bindingMap.get(`${ct}:${item.itemUid}`);
            const itemRow = this.createItemRow(ct, item, binding);
            groupEl.appendChild(itemRow);
          }
        }

        treeEl.appendChild(groupEl);
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

  createItemRow(contentType, item, binding) {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; margin-bottom: 6px; border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
    `;

    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || SyncState.DISABLED;
    const version = binding?.last_synced_version ? `v${binding.last_synced_version}` : '本地版';

    let stateBadge = `<span style="font-size:11px; padding:2px 6px; border-radius:3px; background:#555; color:#fff;">未同步</span>`;
    if (state === SyncState.SYNCED) {
      stateBadge = `<span style="font-size:11px; padding:2px 6px; border-radius:3px; background:#52c41a; color:#fff;">已同步 (${version})</span>`;
    } else if (state === SyncState.CONFLICT) {
      stateBadge = `<span style="font-size:11px; padding:2px 6px; border-radius:3px; background:#f5222d; color:#fff;">⚠️ 冲突</span>`;
    } else if (state === SyncState.BACKUP_CREATED) {
      stateBadge = `<span style="font-size:11px; padding:2px 6px; border-radius:3px; background:#1890ff; color:#fff;">冷备份就绪</span>`;
    }

    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <input type="checkbox" class="cfgsync-toggle" ${isEnabled ? 'checked' : ''} style="cursor:pointer;" />
        <div>
          <div style="font-size:14px; font-weight:500;">${item.displayName}</div>
          <div style="font-size:11px; opacity:0.6;">${item.sourceRef}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${stateBadge}
        <button class="cfgsync-push-btn menu_button" style="padding:4px 8px; font-size:12px; cursor:pointer;" ${!isEnabled ? 'disabled' : ''}>推云端</button>
        <button class="cfgsync-pull-btn menu_button" style="padding:4px 8px; font-size:12px; cursor:pointer;" ${!isEnabled ? 'disabled' : ''}>拉云端</button>
      </div>
    `;

    // 勾选切换开关
    const toggle = row.querySelector('.cfgsync-toggle');
    toggle.onchange = async () => {
      if (toggle.checked) {
        await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName);
        this.refresh();
      } else {
        const confirmRestore = confirm(`是否在关闭同步时恢复为开启同步前的本地原始配置？\n点击【确定】恢复备份，点击【取消】保留当前配置。`);
        const bindingUid = this.storage.makeBindingUid(this.accountHandle, this.accountHandle, contentType, item.itemUid);
        await this.syncManager.disableSync(bindingUid, confirmRestore);
        this.refresh();
      }
    };

    // 手动推送到云端
    const pushBtn = row.querySelector('.cfgsync-push-btn');
    pushBtn.onclick = async () => {
      pushBtn.disabled = true;
      try {
        const pullRes = await this.api.pull(contentType, item.itemUid, this.accountHandle).catch(() => null);
        const res = await this.syncManager.pushLocal(binding, pullRes?.content || {});
        if (res.conflict) {
          showConflictDialog({
            displayName: item.displayName,
            serverVersion: res.serverVersion,
            onResolve: async (choice) => {
              await this.syncManager.resolveConflict(binding, choice, pullRes?.content || {});
              this.refresh();
            },
          });
        } else {
          this.refresh();
        }
      } catch (e) {
        alert(`推送失败: ${e.message}`);
      } finally {
        pushBtn.disabled = false;
      }
    };

    // 手动从云端拉取
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    pullBtn.onclick = async () => {
      pullBtn.disabled = true;
      try {
        await this.syncManager.pullCloud(binding);
        this.refresh();
      } catch (e) {
        alert(`拉取失败: ${e.message}`);
      } finally {
        pullBtn.disabled = false;
      }
    };

    return row;
  }
}
