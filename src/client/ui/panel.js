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
   */
  constructor({ api, syncManager, storage, accountHandle }) {
    this.api = api;
    this.syncManager = syncManager;
    this.storage = storage;
    this.accountHandle = accountHandle;
    this.container = null;
  }

  render(targetEl) {
    this.container = targetEl;
    this.refresh();
  }

  async refresh() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="cfgsync-panel-container" style="padding: 16px; font-family: sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h3 style="margin:0;">☁️ 配置云同步</h3>
          <span style="font-size:12px; opacity:0.8;">当前账号: <strong>${this.accountHandle}</strong></span>
        </div>
        <div id="cfgsync-items-loading" style="text-align:center; padding:20px;">正在加载同步配置...</div>
        <div id="cfgsync-items-tree"></div>
      </div>
    `;

    try {
      const typeRes = await this.api.getContentTypes();
      const p0Types = typeRes.groups?.P0 || [];
      const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
      const bindingMap = new Map(bindings.map(b => [`${b.content_type}:${b.item_uid}`, b]));

      const treeEl = this.container.querySelector('#cfgsync-items-tree');
      this.container.querySelector('#cfgsync-items-loading').style.display = 'none';

      for (const ct of p0Types) {
        const groupEl = document.createElement('div');
        groupEl.style.cssText = 'margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px;';
        groupEl.innerHTML = `<h4 style="margin:0 0 10px 0; text-transform: capitalize; color: #1890ff;">${ct}</h4>`;

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
          <div style="background: rgba(255, 77, 79, 0.1); border: 1px solid #ff4d4f; border-radius: 6px; padding: 16px; margin: 12px 0;">
            <h4 style="color:#ff4d4f; margin-top:0;">⚠️ 服务端插件未就绪</h4>
            <p style="font-size:13px; line-height:1.6; margin-bottom:8px;">
              当前仅加载了前端扩展，SillyTavern 后端尚未激活插件路由。请检查以下配置：
            </p>
            <ol style="font-size:12px; line-height:1.8; margin:0 0 10px 20px; padding:0;">
              <li>本仓库需放置或软链接到 SillyTavern 的 <code>plugins/cfgsync</code> 目录；</li>
              <li>在 <code>config.yaml</code> 中确认已开启 <code>enableServerPlugins: true</code>；</li>
              <li>重启 SillyTavern 服务端。</li>
            </ol>
          </div>
        `;
      } else {
        this.container.innerHTML = `<div style="color:#ff4d4f; padding:20px;">加载配置失败: ${err.message}</div>`;
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
