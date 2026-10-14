import { buildItemList, TYPE_LABELS, bindingKey, itemKey, isOwnBinding } from '../listModel.js';
import { ensureTheme, escapeHtml, notify, chooseDisable } from './dialog.js';
import { SyncState, SyncMode, ReloadStrategy } from '../../common/constants.js';
import { isSyncTypeEnabled } from '../../common/syncTypes.js';
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
  constructor({ api, syncManager, storage, accountHandle, onAccountChange, autoSyncEngine = null }) {
    this.api = api;
    this.syncManager = syncManager;
    this.storage = storage;
    this.accountHandle = accountHandle;
    this.onAccountChange = onAccountChange;
    this.autoSyncEngine = autoSyncEngine;
    this.entryContainer = null;
    this.modalBackdrop = null;
    this.container = null;
    this._refreshing = false;
    this._allowSettingsSharing = false;
    this.activeTab = 'world';
    this.thumbnailCache = new Map();
    this.drawerState = new Map();
  }

  render(targetEl) {
    ensureTheme();
    this.entryContainer = targetEl;
    this.renderEntryBar();

    if (typeof document !== 'undefined' && document.body) {
      let backdrop = document.getElementById('cfgsync-main-modal-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'cfgsync-main-modal-backdrop';
        backdrop.className = 'cfgsync-modal-overlay popup';
        backdrop.style.cssText = `
          position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
          background: rgba(0, 0, 0, 0.68); z-index: 99990;
          display: none; align-items: center; justify-content: center;
          backdrop-filter: blur(3px); padding: 12px; box-sizing: border-box;
        `;

        const dialog = document.createElement('div');
        dialog.id = 'cfgsync-modal-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', '配置云同步');
        dialog.style.cssText = `
          width: 680px; max-width: 96vw; max-height: 88vh;
          background: var(--cfgsync-bg); border: 1px solid color-mix(in srgb, var(--cfgsync-text) 14%, transparent);
          border-radius: 8px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
          display: flex; flex-direction: column; overflow: hidden;
          color: var(--cfgsync-text); font-family: inherit;
          box-sizing: border-box;
        `;

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        ['click', 'mousedown', 'mouseup', 'pointerdown', 'touchstart'].forEach((evt) => {
          backdrop.addEventListener(evt, (e) => e.stopPropagation());
        });

        backdrop.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.target === backdrop) {
            this.closeModal();
          }
        });
      }
      this.modalBackdrop = backdrop;
      this.container = backdrop.querySelector('#cfgsync-modal-dialog');
    } else {
      this.container = targetEl;
    }

    this.ensureShell();
    this.refresh();
  }

  /**
   * 在扩展设置侧边栏内渲染极简入口条（点击「打开面板」弹出独立窗口）
   */
  renderEntryBar() {
    if (!this.entryContainer) return;
    this.entryContainer.innerHTML = `
      <div class="cfgsync-entry-bar" style="background: var(--cfgsync-bg); border: 1px solid color-mix(in srgb, var(--cfgsync-text) 10%, transparent); border-radius: 6px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box;">
        <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
          <span style="font-size: 13px; font-weight: 600; color: var(--cfgsync-text); white-space: nowrap;">配置云同步</span>
          <span style="font-size: 12px; color: var(--cfgsync-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">账号: <strong class="cfgsync-entry-account-label" style="color: var(--cfgsync-text); font-weight: 500;">${escapeHtml(this.accountHandle)}</strong></span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <button id="cfgsync-open-modal-btn" type="button" style="height: 26px; padding: 0 11px; border-radius: 5px; font-size: 12px; font-weight: 600; color: var(--cfgsync-text); background: rgba(88,166,255,0.16); border: 1px solid rgba(88,166,255,0.42); cursor: pointer; white-space: nowrap !important; width: auto !important; min-width: unset !important; margin: 0;">
            打开面板
          </button>
          <button id="cfgsync-entry-backup-btn" type="button" style="height: 26px; padding: 0 10px; border-radius: 5px; font-size: 12px; font-weight: 500; color: var(--cfgsync-text); background: color-mix(in srgb, var(--cfgsync-text) 5%, transparent); border: 1px solid color-mix(in srgb, var(--cfgsync-text) 12%, transparent); cursor: pointer; white-space: nowrap !important; width: auto !important; min-width: unset !important; margin: 0;">
            <span class="cfgsync-entry-backup-text">一键备份</span>
          </button>
        </div>
      </div>
    `;

    const openBtn = this.entryContainer.querySelector('#cfgsync-open-modal-btn');
    if (openBtn) {
      openBtn.onmousedown = (e) => e.stopPropagation();
      openBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openModal();
      };
    }

    const entryBackupBtn = this.entryContainer.querySelector('#cfgsync-entry-backup-btn');
    if (entryBackupBtn) {
      entryBackupBtn.onmousedown = (e) => e.stopPropagation();
      entryBackupBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.runBackupAll();
      };
    }
  }

  openModal() {
    this.ensureShell();
    if (this.modalBackdrop) {
      this.modalBackdrop.style.display = 'flex';
    }
    this.refresh();
    const close = event => {
      if (document.querySelector('.cfgsync-modal-overlay:not(#cfgsync-main-modal-backdrop)')) return;
      if (event.key === 'Escape') this.closeModal();
      if (event.key === 'Tab') {
        const controls = [...this.container.querySelectorAll('button,input,select,summary')].filter(el => !el.disabled && el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    if (typeof window === 'undefined') return;
    this._modalKeydown = close; window.addEventListener('keydown', close);
    this.container.querySelector('#cfgsync-search-input')?.focus();
  }

  closeModal() {
    if (this._modalKeydown && typeof window !== 'undefined') window.removeEventListener('keydown', this._modalKeydown);
    if (this.modalBackdrop) {
      this.modalBackdrop.style.display = 'none';
    }
    this.entryContainer?.querySelector?.('#cfgsync-open-modal-btn')?.focus();
  }

  /**
   * 仅在容器未就绪时初始化外层骨架，绝不重复清空已有 DOM
   */
  ensureShell() {
    if (!this.container || this.container.querySelector('.cfgsync-panel-container')) {
      return;
    }

    const neutralBtnStyle = 'display:inline-flex; align-items:center; justify-content:center; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:28px; padding:0 11px; margin:0; border-radius:5px; font-size:12px; font-weight:500; color:var(--cfgsync-text); background:color-mix(in srgb, var(--cfgsync-text) 5%, transparent); border:1px solid color-mix(in srgb, var(--cfgsync-text) 12%, transparent); cursor:pointer; user-select:none;';
    const primaryBtnStyle = 'display:inline-flex; align-items:center; justify-content:center; white-space:nowrap !important; width:auto !important; min-width:unset !important; height:28px; padding:0 12px; margin:0; border-radius:5px; font-size:12px; font-weight:600; color:var(--cfgsync-text); background:rgba(88,166,255,0.16); border:1px solid rgba(88,166,255,0.42); cursor:pointer; user-select:none;';

    this.container.innerHTML = `
      <div class="cfgsync-panel-container">
        <header class="cfgsync-header">
          <div class="cfgsync-brand-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20 10a4 4 0 0 1-1 8"/><path d="M12 13v8m-3-5 3-3 3 3"/></svg></div>
          <div class="cfgsync-heading"><h2>配置云同步</h2><p>保存每次调整，在设备之间安心接续</p></div>
          <span class="cfgsync-account-pill" title="当前登录账号">@<strong class="cfgsync-account-label">${escapeHtml(this.accountHandle)}</strong></span>
          <button id="cfgsync-modal-close-btn" type="button" aria-label="关闭面板" style="border:0;background:transparent;color:var(--cfgsync-muted);font-size:24px;width:32px;height:32px;">&times;</button>
        </header>
        <div class="cfgsync-toolbar">
          <button id="cfgsync-backup-all-btn" class="cfgsync-primary" type="button"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i><span class="cfgsync-backup-all-text">一键备份</span></button>
          <button id="cfgsync-claim-btn" type="button"><span>认领分享</span></button>
          <button id="cfgsync-refresh-btn" type="button"><span class="cfgsync-refresh-text">刷新</span></button>
          <div class="cfgsync-toolbar-spacer"></div>
          <details class="cfgsync-overflow"><summary>更多工具 ▾</summary><div class="cfgsync-overflow-menu">
            <button id="cfgsync-export-backup-btn" type="button"><span class="cfgsync-export-backup-text">导出灾备包</span></button>
            <button id="cfgsync-import-backup-btn" type="button"><span class="cfgsync-import-backup-text">导入灾备包</span></button>
            <button id="cfgsync-dashboard-btn" type="button">存储看板</button>
            <button id="cfgsync-settings-btn" type="button">同步设置</button>
          </div></details>
          <input type="file" id="cfgsync-dr-file-input" accept=".zip,application/zip" hidden />
        </div>
        <div class="cfgsync-summary" aria-live="polite">
          <span><strong id="cfgsync-total-count">—</strong>项配置</span>
          <span><strong id="cfgsync-enabled-count">—</strong>项已开启</span>
          <span><strong id="cfgsync-cloud-count">—</strong>项有快照</span>
          <span class="cfgsync-sync-health" id="cfgsync-sync-health">自动备份未开启</span>
        </div>
        <div class="cfgsync-filter-bar">
          <div id="cfgsync-category-tabs" role="tablist" aria-label="配置分类"></div>
          <div class="cfgsync-search-row">
            <input id="cfgsync-search-input" type="search" aria-label="搜索配置" placeholder="搜索配置名称、文件名或分享账号…" />
            <label class="cfgsync-extra-types"><input id="cfgsync-extra-types" type="checkbox" />显示空分类</label>
            <select id="cfgsync-category-filter" hidden><option value="">全部分类</option></select>
          </div>
        </div>
        <div class="cfgsync-list-scroll">
          <div id="cfgsync-items-loading" role="status" style="text-align:center;padding:32px;color:var(--cfgsync-muted);">正在读取配置…</div>
          <div id="cfgsync-items-tree"></div>
          <div id="cfgsync-no-results" hidden style="text-align:center;padding:32px;color:var(--cfgsync-muted);font-size:12px;">没有匹配的配置，试试其他关键词。</div>
        </div>
        <footer class="cfgsync-footer"><span id="cfgsync-refresh-status" role="status">准备就绪</span><span id="cfgsync-storage-status">快照保存在当前酒馆服务器</span></footer>
      </div>
    `;
    this.container.querySelector('#cfgsync-extra-types').onchange = event => {
      this.showEmptyTypes = event.target.checked; this.refresh();
    };
    this.container.querySelectorAll('.cfgsync-overflow-menu button').forEach(button => {
      button.addEventListener('click', () => this.container.querySelector('.cfgsync-overflow').removeAttribute('open'));
    });
    const closeBtn = this.container.querySelector('#cfgsync-modal-close-btn');
    if (closeBtn) {
      closeBtn.onmousedown = (e) => e.stopPropagation();
      closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeModal();
      };
    }

    this.bindToggleAll();
    this.bindRefresh();
    this.bindBackupAll();
    this.bindClaim();
    this.bindSettings();
    this.bindDashboard();
    this.bindSearchFilter();
    this.bindDisasterRecovery();
  }

  /**
   * 切换当前激活的分类标签页
   */
  switchCategoryTab(contentType) {
    if (!contentType) return;
    this.activeTab = contentType;
    this.drawerState.set(contentType, true);

    if (!this.container) return;
    const tabsEl = this.container.querySelector('#cfgsync-category-tabs');
    if (tabsEl) {
      tabsEl.querySelectorAll('.cfgsync-cat-tab-btn').forEach((btn) => {
        const isActive = btn.dataset.tabType === contentType;
        btn.setAttribute('aria-selected', String(isActive));
        btn.setAttribute('role', 'tab');
        btn.style.fontWeight = isActive ? '600' : '400';
        btn.style.color = isActive ? 'var(--cfgsync-text)' : 'var(--cfgsync-muted)';
        btn.style.background = isActive ? 'color-mix(in srgb, var(--cfgsync-text) 10%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 2%, transparent)';
        btn.style.borderColor = isActive ? 'color-mix(in srgb, var(--cfgsync-text) 24%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 7%, transparent)';
        const badge = btn.querySelector('.cfgsync-tab-badge');
        if (badge) {
          badge.style.background = isActive ? 'color-mix(in srgb, var(--cfgsync-text) 15%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 5%, transparent)';
          badge.style.color = isActive ? 'var(--cfgsync-text)' : 'var(--cfgsync-muted)';
        }
      });
    }

    const treeEl = this.container.querySelector('#cfgsync-items-tree');
    if (treeEl) {
      treeEl.querySelectorAll('.cfgsync-group-drawer').forEach((drawer) => {
        const isMatch = drawer.dataset.contentType === contentType;
        drawer.style.display = isMatch ? 'block' : 'none';
        const contentEl = drawer.querySelector('.cfgsync-drawer-content');
        if (contentEl && isMatch) {
          contentEl.style.display = 'block';
        }
      });
    }
    this.container.querySelector('#cfgsync-search-input')?.dispatchEvent(new Event('input'));
  }

  bindSearchFilter() {
    const searchInput = this.container.querySelector('#cfgsync-search-input');
    const catSelect = this.container.querySelector('#cfgsync-category-filter');
    if (!searchInput || !catSelect) return;

    const applyFilter = () => {
      const q = (searchInput.value || '').trim().toLowerCase();
      const selectedCat = catSelect.value || this.activeTab;
      const treeEl = this.container.querySelector('#cfgsync-items-tree');
      if (!treeEl) return;

      const drawers = treeEl.querySelectorAll('.cfgsync-group-drawer');
      let matches = 0;
      drawers.forEach(drawer => {
        const ct = drawer.dataset.contentType;
        if (selectedCat && ct !== selectedCat) {
          drawer.style.display = 'none';
          return;
        }

        const rows = drawer.querySelectorAll('.cfgsync-item-row');
        let visibleCount = 0;
        rows.forEach(row => {
          const name = (row.dataset.displayName || row.querySelector('.cfgsync-row-name')?.textContent || '').toLowerCase();
          const ref = (row.querySelector('.cfgsync-row-ref')?.textContent || '').toLowerCase();
          const match = !q || name.includes(q) || ref.includes(q);
          row.style.display = match ? 'flex' : 'none';
          if (match) visibleCount++;
        });

        drawer.style.display = 'block';
        matches += visibleCount;
        const content = drawer.querySelector('.cfgsync-drawer-content');
        if (content) {
          content.style.display = 'block';
        }
      });
      const empty = this.container.querySelector('#cfgsync-no-results');
      if (empty) empty.hidden = !q || matches > 0;
    };

    if (!searchInput.dataset.bound) {
      searchInput.dataset.bound = 'true';
      searchInput.addEventListener('input', applyFilter);
      searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
      searchInput.addEventListener('click', (e) => e.stopPropagation());
    }
    if (!catSelect.dataset.bound) {
      catSelect.dataset.bound = 'true';
      catSelect.addEventListener('change', applyFilter);
      catSelect.addEventListener('mousedown', (e) => e.stopPropagation());
      catSelect.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  /**
   * 绑定灾备全量导出与安全导入 (BUG-P6-02)
   */
  bindDisasterRecovery() {
    const exportBtn = this.container.querySelector('#cfgsync-export-backup-btn');
    const importBtn = this.container.querySelector('#cfgsync-import-backup-btn');
    const fileInput = this.container.querySelector('#cfgsync-dr-file-input');

    if (exportBtn && !exportBtn.dataset.bound) {
      exportBtn.dataset.bound = 'true';
      exportBtn.onmousedown = (e) => e.stopPropagation();
      exportBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const confirmMsg = '即将导出当前账号与云端的全量灾备归档包 (ZIP)。\n包含全部数据库配置元数据、完整版本快照以及关联的二进制立绘/背景/表情包/头像。\n\n是否立即导出下载？';
        if (typeof confirm === 'function' && !confirm(confirmMsg)) {
          return;
        }

        const textSpan = exportBtn.querySelector('.cfgsync-export-backup-text');
        exportBtn.disabled = true;
        if (textSpan) textSpan.textContent = '导出中...';

        try {
          const { blob, fileName } = await this.api.exportBackup();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 1000);

          if (typeof toastr !== 'undefined' && toastr.success) {
            toastr.success(`灾备归档「${fileName}」导出成功`, '云配置');
          } else {
            notify(`【灾备包导出成功】\n\n已下载文件: ${fileName}\n体积: ${(blob.size / 1024).toFixed(1)} KB`);
          }
        } catch (err) {
          notify(`导出灾备包失败: ${escapeHtml(err.message)}`);
        } finally {
          exportBtn.disabled = false;
          if (textSpan) textSpan.textContent = '灾备导出';
        }
      };
    }

    if (importBtn && fileInput && !importBtn.dataset.bound) {
      importBtn.dataset.bound = 'true';
      importBtn.onmousedown = (e) => e.stopPropagation();
      importBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
      };

      fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        const confirmMsg = `确定导入灾备文件「${file.name}」(${sizeMB} MB)？\n\n【安全保障铁律】\n• 导入遵循零静默覆盖原则：冲突项将作为递增新版本安全入库；\n• 本地旧版本与历史快照 100% 完整保留，随时可通过「版本历史」回滚。\n\n是否立即开始导入？`;
        if (typeof confirm === 'function' && !confirm(confirmMsg)) {
          fileInput.value = '';
          return;
        }

        const textSpan = importBtn.querySelector('.cfgsync-import-backup-text');
        importBtn.disabled = true;
        if (textSpan) textSpan.textContent = '导入中...';

        try {
          const res = await this.api.importBackup(file);
          const receipt = `【灾备安全导入完成】\n\n• 新增/同步配置项: ${res.importedRecords || 0} 个\n• 导入历史快照版本: ${res.importedVersions || 0} 个\n• 冲突项安全保留为新版本: ${res.conflictCount || 0} 个\n\n全部数据已安全落盘并可追溯回滚。`;
          notify(receipt);
          await this.refresh();
        } catch (err) {
          notify(`导入灾备包失败: ${escapeHtml(err.message)}`);
        } finally {
          fileInput.value = '';
          importBtn.disabled = false;
          if (textSpan) textSpan.textContent = '灾备导入';
        }
      };
    }
  }


  bindDashboard() {
    const dashBtn = this.container.querySelector('#cfgsync-dashboard-btn');
    if (!dashBtn || dashBtn.dataset.bound) return;
    dashBtn.dataset.bound = 'true';

    dashBtn.onmousedown = (e) => e.stopPropagation();
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

    settingsBtn.onmousedown = (e) => e.stopPropagation();
    settingsBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSettingsDialog({
        api: this.api,
        autoSyncEngine: this.autoSyncEngine,
        onUpdated: () => this.refresh(),
      });
    };
  }


  bindClaim() {
    const claimBtn = this.container.querySelector('#cfgsync-claim-btn');
    if (!claimBtn || claimBtn.dataset.bound) return;
    claimBtn.dataset.bound = 'true';

    claimBtn.onmousedown = (e) => e.stopPropagation();
    claimBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showClaimDialog({
        api: this.api,
        onClaimed: async (claimResult) => {
          if (claimResult && claimResult.content_type) {
            this.activeTab = claimResult.content_type;
          }
          await this.refresh();
          if (claimResult && claimResult.content_type) {
            this.switchCategoryTab(claimResult.content_type);
            const drawer = this.container.querySelector(`.cfgsync-group-drawer[data-content-type="${claimResult.content_type}"]`);
            if (drawer) {
              const row = drawer.querySelector(`.cfgsync-item-row[data-item-uid="${claimResult.item_uid}"]`);
              if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                row.style.transition = 'background-color 0.5s ease';
                row.style.backgroundColor = 'rgba(88, 166, 255, 0.2)';
                setTimeout(() => {
                  row.style.backgroundColor = '';
                }, 2500);

                if (!row._existsLocally) {
                  const pullNow = confirm(`认领成功！配置「${claimResult.item_uid}」来自 @${claimResult.owner_handle}。\n本地尚未下载该文件，是否立即拉取并保存到本地？`);
                  if (pullNow) {
                    await this.restoreSnapshot(row, claimResult.content_type, {
                      displayName: claimResult.item_uid,
                      itemUid: claimResult.item_uid,
                    });
                  }
                }
              }
            }
          }
        },
      });
    };
  }

  bindRefresh() {
    const refreshBtn = this.container.querySelector('#cfgsync-refresh-btn');
    if (!refreshBtn || refreshBtn.dataset.bound) return;
    refreshBtn.dataset.bound = 'true';

    refreshBtn.onmousedown = (e) => e.stopPropagation();
    refreshBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const textSpan = refreshBtn.querySelector('.cfgsync-refresh-text');
      refreshBtn.disabled = true;
      if (textSpan) textSpan.textContent = '刷新中...';
      try {
        await this.refresh();
      } finally {
        refreshBtn.disabled = false;
        if (textSpan) textSpan.textContent = '刷新';
      }
    };
  }

  bindBackupAll() {
    const backupBtn = this.container.querySelector('#cfgsync-backup-all-btn');
    if (!backupBtn || backupBtn.dataset.bound) return;
    backupBtn.dataset.bound = 'true';

    backupBtn.onmousedown = (e) => e.stopPropagation();
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
    const entryBackupBtn = this.entryContainer?.querySelector?.('#cfgsync-entry-backup-btn');
    const entryTextSpan = entryBackupBtn?.querySelector?.('.cfgsync-entry-backup-text');

    const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
    const enabledBindings = (bindings || []).filter(b => b.enabled && isSyncTypeEnabled(b.content_type) && isOwnBinding(b, this.accountHandle));

    if (enabledBindings.length === 0) {
      notify('当前没有已开启云同步的配置项。\n请先勾选需要同步的项目复选框，再执行一键备份。');
      return { total: 0, successCount: 0, failCount: 0 };
    }

    const confirmMsg = `已发现 ${enabledBindings.length} 个已开启云同步的配置项。\n将依次备份到云端（严格串行执行保证安全性）。\n\n是否立即开始？`;
    if (typeof confirm === 'function' && !confirm(confirmMsg)) {
      return { total: enabledBindings.length, successCount: 0, failCount: 0, cancelled: true };
    }

    if (backupBtn) backupBtn.disabled = true;
    if (entryBackupBtn) entryBackupBtn.disabled = true;

    let successCount = 0;
    let totalBytes = 0;
    const failures = [];

    try {
      for (let i = 0; i < enabledBindings.length; i++) {
        const binding = enabledBindings[i];
        const progressText = `备份中 (${i + 1}/${enabledBindings.length})...`;
        if (textSpan) textSpan.textContent = progressText;
        if (entryTextSpan) entryTextSpan.textContent = progressText;

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
            force: false,
            versionTitle: `一键批量备份 (${new Date().toLocaleTimeString()})`,
          });

          if (res?.success !== false) {
            successCount++;
            if (res.size_bytes) {
              totalBytes += Number(res.size_bytes);
            }
          } else {
            failures.push({ name: binding.display_name, error: res.conflict ? '云端已有更新，请先处理冲突' : res.error || '上传未成功' });
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
      notify(summaryMsg);

      return { total: enabledBindings.length, successCount, failCount: failures.length, totalBytes, failures };
    } finally {
      if (backupBtn) {
        backupBtn.disabled = false;
        if (textSpan) textSpan.textContent = '一键备份';
      }
      if (entryBackupBtn) {
        entryBackupBtn.disabled = false;
        if (entryTextSpan) entryTextSpan.textContent = '一键备份';
      }
    }
  }

  bindToggleAll() {
    const toggleAllBtn = this.container?.querySelector?.('#cfgsync-toggle-all-btn');
    if (!toggleAllBtn || toggleAllBtn.dataset.bound) return;
    toggleAllBtn.dataset.bound = 'true';
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
        const entryLabelEl = this.entryContainer?.querySelector?.('.cfgsync-entry-account-label');
        if (entryLabelEl) entryLabelEl.textContent = this.accountHandle;
        if (typeof this.onAccountChange === 'function') {
          this.onAccountChange(this.accountHandle);
        }
      }
      this._isAdmin = Boolean(typeRes.is_admin);
      this._allowSettingsSharing = Boolean(typeRes.allow_settings_sharing);

      const allActiveTypes = typeRes.activeTypes || (typeRes.groups?.P0 || ['settings', 'openai_preset', 'world']);
      const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
    const bindingMap = new Map(bindings.map(b => [bindingKey(b.source_owner_handle || this.accountHandle, b.content_type, b.item_uid), b]));

      const ctNameMap = TYPE_LABELS;

      const preferredOrder = [
        'world',
        'openai_preset',
        'character',
        'settings',
        'persona',
        'avatar',
        'chat',
        'group',
        'group_chat',
        'theme',
        'background',
        'sprites',
        'quick_replies',
      ];

      const activeTypesToLoad = allActiveTypes.filter(isSyncTypeEnabled).sort((a, b) => {
        const idxA = preferredOrder.indexOf(a);
        const idxB = preferredOrder.indexOf(b);
        return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
      });

      const catSelect = this.container.querySelector('#cfgsync-category-filter');
      if (catSelect && catSelect.children.length <= 1) {
        for (const ct of activeTypesToLoad) {
          const opt = document.createElement('option');
          opt.value = ct;
          opt.textContent = ctNameMap[ct] || ct;
          catSelect.appendChild(opt);
        }
      }

      const typeDataList = await Promise.all(activeTypesToLoad.map(async (ct) => {
        const [localRes, cloudRes] = await Promise.all([
          this.api.getItems(ct, this.accountHandle, 'local'),
          this.api.getItems(ct, '', 'cloud', true).catch(() => ({ items: [] })),
        ]);
        return {
          ct,
          localItems: localRes.items || [],
          cloudItems: cloudRes.items || [],
        };
      }));

      const visibleCategories = [];

      for (const { ct, localItems, cloudItems } of typeDataList) {
        const isCoreType = ct === 'settings' || ct === 'openai_preset' || ct === 'world';
        if (!this.showEmptyTypes && !isCoreType && localItems.length === 0 && cloudItems.length === 0) {
          const oldDrawer = treeEl.querySelector(`.cfgsync-group-drawer[data-content-type="${ct}"]`);
          if (oldDrawer) oldDrawer.remove();
          continue;
        }

        const items = buildItemList(localItems, cloudItems, this.accountHandle);
        const displayTypeName = ctNameMap[ct] || ct;
        const cloudCount = items.filter(i => Boolean(i.cloudItem && !i.cloudItem.is_deleted)).length;
        const totalCount = items.length;
        visibleCategories.push({
          ct,
          displayTypeName,
          cloudCount,
          totalCount,
        });

        let groupDrawer = treeEl.querySelector(`.cfgsync-group-drawer[data-content-type="${ct}"]`);
        if (!groupDrawer) {
          groupDrawer = this.createGroupDrawer(ct, displayTypeName);
          treeEl.appendChild(groupDrawer);
        }

        this.updateGroupDrawer(groupDrawer, ct, items, bindingMap);
      }

      if (visibleCategories.length > 0 && !visibleCategories.some(c => c.ct === this.activeTab)) {
        this.activeTab = visibleCategories[0].ct;
      }

      this.renderCategoryTabs(visibleCategories);
      if (this.activeTab) {
        this.switchCategoryTab(this.activeTab);
      }

      if (loadingEl) loadingEl.style.display = 'none';
      this.updateSummary();
      this.container.querySelector('#cfgsync-search-input')?.dispatchEvent(new Event('input'));
      const status = this.container.querySelector('#cfgsync-refresh-status');
      if (status) { status.textContent = '已更新 · ' + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); status.dataset.health = 'success'; }
    } catch (err) {
      const status = this.container.querySelector('#cfgsync-refresh-status');
      if (status) { status.textContent = '刷新失败：' + err.message; status.dataset.health = 'error'; }
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
   * 渲染顶部横向分类标签栏
   */
  renderCategoryTabs(visibleCategories) {
    const tabsEl = this.container?.querySelector?.('#cfgsync-category-tabs');
    if (!tabsEl) return;

    tabsEl.innerHTML = '';
    for (const { ct, displayTypeName, cloudCount, totalCount } of visibleCategories) {
      const isActive = ct === this.activeTab;
      const badgeText = totalCount > 0 ? (cloudCount > 0 ? `${cloudCount}/${totalCount}` : `${totalCount}`) : '0';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cfgsync-cat-tab-btn';
      btn.dataset.tabType = ct;
      btn.style.cssText = `
        height: 28px; padding: 0 10px; margin: 0; border-radius: 5px; font-size: 12px;
        font-weight: ${isActive ? '600' : '400'};
        color: ${isActive ? 'var(--cfgsync-text)' : 'var(--cfgsync-muted)'};
        background: ${isActive ? 'color-mix(in srgb, var(--cfgsync-text) 10%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 2%, transparent)'};
        border: 1px solid ${isActive ? 'color-mix(in srgb, var(--cfgsync-text) 24%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 7%, transparent)'};
        display: inline-flex; align-items: center; gap: 6px; white-space: nowrap !important;
        width: auto !important; min-width: unset !important; cursor: pointer; user-select: none;
        transition: all 0.15s ease;
      `;
      btn.innerHTML = `
        <span>${displayTypeName}</span>
        <span class="cfgsync-tab-badge" style="font-size:12px; padding:0 5px; border-radius:6px; background:${isActive ? 'color-mix(in srgb, var(--cfgsync-text) 15%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 5%, transparent)'}; color:${isActive ? 'var(--cfgsync-text)' : 'var(--cfgsync-muted)'};">${badgeText}</span>
      `;
      btn.onmousedown = (e) => e.stopPropagation();
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.switchCategoryTab(ct);
      };
      tabsEl.appendChild(btn);
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
        `.cfgsync-item-row[data-content-type="${evt.content_type}"][data-item-uid="${evt.item_uid}"][data-source-owner="${CSS.escape(evt.owner_handle || this.accountHandle)}"]`
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
    const isExpanded = ct === this.activeTab || Boolean(this.drawerState.get(ct));
    const groupDrawer = document.createElement('div');
    groupDrawer.className = 'cfgsync-group-drawer';
    groupDrawer.dataset.contentType = ct;
    groupDrawer.style.cssText = `display: ${ct === this.activeTab ? 'block' : 'none'};`;

    groupDrawer.innerHTML = `
      <div class="inline-drawer-header cfgsync-drawer-toggle" style="display: none;">
        <b>${displayTypeName}</b>
        <span class="cfgsync-count-badge">0</span>
        <div class="inline-drawer-icon ${isExpanded ? 'up' : 'down'}"></div>
      </div>
      <div class="cfgsync-drawer-content" style="display: block;">
        <div class="cfgsync-group-items" style="display: flex; flex-direction: column; gap: 8px;"></div>
      </div>
    `;

    return groupDrawer;
  }

  updateGroupDrawer(groupDrawer, ct, items, bindingMap) {
    const badgeEl = groupDrawer.querySelector('.cfgsync-count-badge');
    const cloudCount = items.filter(i => Boolean(i.cloudItem && !i.cloudItem.is_deleted)).length;
    const totalCount = items.length;
    const badgeText = totalCount > 0 ? (cloudCount > 0 ? `${cloudCount}/${totalCount}` : `${totalCount}`) : '0';

    if (badgeEl) {
      badgeEl.textContent = badgeText;
      badgeEl.title = `共 ${totalCount} 项配置：${cloudCount} 项云端有数据，${totalCount - cloudCount} 项未同步`;
    }

    const tabBadgeEl = this.container?.querySelector?.(`.cfgsync-cat-tab-btn[data-tab-type="${ct}"] .cfgsync-tab-badge`);
    if (tabBadgeEl) {
      tabBadgeEl.textContent = badgeText;
    }

    const itemsContainer = groupDrawer.querySelector('.cfgsync-group-items');
    if (!itemsContainer) return;

    if (items.length === 0) {
      itemsContainer.innerHTML = `<div class="cfgsync-empty-notice" style="font-size:12px; color:var(--cfgsync-muted); padding: 16px 4px; text-align:center;">暂无可用配置</div>`;
      return;
    }

    const emptyNotice = itemsContainer.querySelector('.cfgsync-empty-notice');
    if (emptyNotice) {
      emptyNotice.remove();
    }

    const currentItemUids = new Set(items.map(i => itemKey(i.sourceOwner || this.accountHandle, i.itemUid)));

    itemsContainer.querySelectorAll('.cfgsync-item-row').forEach(row => {
      if (!currentItemUids.has(itemKey(row.dataset.sourceOwner || this.accountHandle, row.dataset.itemUid))) {
        row.remove();
      }
    });

    const oldDivider = itemsContainer.querySelector('.cfgsync-section-divider');
    if (oldDivider) oldDivider.remove();

    const hasBoth = cloudCount > 0 && (totalCount - cloudCount) > 0;
    let dividerInserted = false;

    for (const item of items) {
      const binding = bindingMap.get(bindingKey(item.sourceOwner || this.accountHandle, ct, item.itemUid));
      const isUnsynced = !item.cloudItem || item.cloudItem.is_deleted;

      if (hasBoth && isUnsynced && !dividerInserted) {
        const divider = document.createElement('div');
        divider.className = 'cfgsync-section-divider';
        divider.style.cssText = `
          font-size: 12px; color: var(--cfgsync-muted); margin: 10px 2px 4px 2px;
          padding-top: 8px; border-top: 1px dashed color-mix(in srgb, var(--cfgsync-text) 10%, transparent);
          display: flex; align-items: center; justify-content: space-between;
          user-select: none;
        `;
        divider.innerHTML = `
          <span>本地未同步 (${totalCount - cloudCount})</span>
          <span style="opacity:0.6;">点击备份保存到云端</span>
        `;
        itemsContainer.appendChild(divider);
        dividerInserted = true;
      }

      let existingRow = itemsContainer.querySelector(`.cfgsync-item-row[data-item-uid="${item.itemUid}"][data-source-owner="${CSS.escape(item.sourceOwner || this.accountHandle)}"]`);
      if (existingRow) {
        this.updateRowState(existingRow, binding, item.cloudItem, item.existsLocally);
        itemsContainer.appendChild(existingRow);
      } else {
        const newRow = this.createItemRow(ct, item, binding);
        itemsContainer.appendChild(newRow);
      }
    }
  }

  /**
   * 原地无感更新指定分类抽屉与顶部标签的计数角标
   */
  updateSummary() {
    if (!this.container) return;
    const rows = [...this.container.querySelectorAll('.cfgsync-item-row')];
    for (const [id, count] of [['total', rows.length], ['enabled', rows.filter(r => r._binding?.enabled).length], ['cloud', rows.filter(r => r._cloudItem && !r._cloudItem.is_deleted).length]]) {
      const target = this.container.querySelector('#cfgsync-' + id + '-count'); if (target) target.textContent = count;
    }
    const health = this.container.querySelector('#cfgsync-sync-health');
    if (health) health.textContent = this.autoSyncEngine?.enabled ? '后台自动备份已开启' : '自动备份未开启';
  }

  updateDrawerCount(contentType) {
    const groupDrawer = this.container?.querySelector(`.cfgsync-group-drawer[data-content-type="${contentType}"]`);
    if (!groupDrawer) return;
    const rows = Array.from(groupDrawer.querySelectorAll('.cfgsync-item-row'));
    const totalCount = rows.length;
    const cloudCount = rows.filter(r => r._cloudItem && !r._cloudItem.is_deleted).length;
    const badgeText = totalCount > 0 ? (cloudCount > 0 ? `${cloudCount}/${totalCount}` : `${totalCount}`) : '0';

    const badgeEl = groupDrawer.querySelector('.cfgsync-count-badge');
    if (badgeEl) {
      badgeEl.textContent = badgeText;
      badgeEl.title = `共 ${totalCount} 项配置：${cloudCount} 项云端有数据，${totalCount - cloudCount} 项未同步`;
    }

    const tabBadgeEl = this.container?.querySelector?.(`.cfgsync-cat-tab-btn[data-tab-type="${contentType}"] .cfgsync-tab-badge`);
    if (tabBadgeEl) {
      tabBadgeEl.textContent = badgeText;
    }
  }

  /**
   * 获取同步状态的颜色与文字描述
   */
  getStateInfo(state, version, cloudItem = null, binding = null) {
    if (binding && binding.enabled && state === SyncState.SYNCED) {
      if (cloudItem && cloudItem.current_version > (binding.last_synced_version || 0)) {
        return { color: 'var(--cfgsync-warning)', label: '有更新' };
      }
      const fromText = (binding.source_owner_handle && binding.source_owner_handle !== this.accountHandle) ? ` @${binding.source_owner_handle}` : '';
      return { color: 'var(--cfgsync-text)', label: `已同步${fromText}` };
    }
    if (state === SyncState.CONFLICT) {
      return { color: 'var(--cfgsync-danger)', label: '冲突' };
    }
    if (state === SyncState.BACKUP_CREATED) {
      return { color: 'var(--cfgsync-text)', label: '冷备份' };
    }
    if (cloudItem) {
      const isCross = cloudItem.owner_handle && cloudItem.owner_handle !== this.accountHandle;
      const ownerText = isCross ? ` @${cloudItem.owner_handle}` : '';
      return { color: 'var(--cfgsync-text)', label: `已备份${ownerText}` };
    }
    return { color: 'var(--cfgsync-muted)', label: '未同步' };
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
   * 为指定行渲染版本选择器的初始 HTML（统一克制配色，仅对冲突与未下载凸显）
   * @returns {string} badge 或 button 的 HTML
   */
  renderVersionSelectorHtml(state, version, cloudItem = null, binding = null, existsLocally = true) {
    if (!cloudItem) {
      return `<span class="cfgsync-state-badge cfgsync-badge-unsynced" title="当前配置仅保存在本地，尚未备份到云端" style="display:inline-flex; align-items:center; justify-content:center; font-size:12px; height:23px; line-height:21px; box-sizing:border-box; padding:0 8px; border-radius:4px; background:transparent; border:1px dashed color-mix(in srgb, var(--cfgsync-text) 14%, transparent); color:var(--cfgsync-muted); white-space:nowrap; user-select:none; flex-shrink:0;">未同步</span>`;
    }

    const isCross = cloudItem.owner_handle && cloudItem.owner_handle !== this.accountHandle;
    const badgeLabel = state === SyncState.CONFLICT
      ? '冲突 ▾'
      : (isCross ? `@${cloudItem.owner_handle} ▾` : '历史快照 ▾');

    let btnColorStyle = 'border:1px solid color-mix(in srgb, var(--cfgsync-text) 14%, transparent) !important; background:color-mix(in srgb, var(--cfgsync-text) 6%, transparent) !important; color:var(--cfgsync-text) !important;';
    if (state === SyncState.CONFLICT) {
      btnColorStyle = 'border:1px solid rgba(248,81,73,0.45) !important; background:rgba(248,81,73,0.15) !important; color:var(--cfgsync-danger) !important; font-weight:600 !important;';
    } else if (!existsLocally || (binding?.enabled && cloudItem.current_version > (binding.last_synced_version || 0))) {
      btnColorStyle = 'border:1px solid rgba(210,153,34,0.4) !important; background:rgba(210,153,34,0.12) !important; color:var(--cfgsync-warning) !important;';
    }

    return `<button class="cfgsync-history-badge-btn menu_button" type="button" title="点击查看与管理云端历史快照" style="display:inline-flex !important; align-items:center !important; justify-content:center !important; font-size:12px !important; height:23px !important; line-height:21px !important; box-sizing:border-box !important; padding:0 9px !important; margin:0 !important; width:auto !important; min-width:unset !important; border-radius:4px !important; ${btnColorStyle} cursor:pointer !important; outline:none !important; white-space:nowrap !important; flex-shrink:0 !important; transition:all 0.15s ease !important;">
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
    const origHtml = pullBtn ? pullBtn.innerHTML : '拉取';
    if (pullBtn) {
      pullBtn.disabled = true;
      pullBtn.textContent = '拉取中...';
    }
    try {
      const res = await this.syncManager.pullCloud(row._binding, null, targetVersion);
      row._existsLocally = true;
      if (row._binding) {
        row._binding.last_synced_version = res.version;
        row._binding.last_synced_checksum = res.checksum;
        row._binding.state = SyncState.SYNCED;
      }
      if (!row._cloudItem && res) {
        row._cloudItem = {
          owner_handle: res.owner_handle || this.accountHandle,
          current_version: res.version,
          current_checksum: res.checksum,
          item_uid: item.itemUid,
          display_name: item.displayName,
        };
      }
      this.updateRowState(row, row._binding, row._cloudItem, true);
      this.updateDrawerCount(contentType);
      const toastMsg = `已成功拉取【${item.displayName || '配置'}】到本地 (${targetVersion ? `v${targetVersion}` : '最新快照'})`;
      if (typeof toastr !== 'undefined' && toastr?.success) {
        toastr.success(toastMsg);
      }

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
        notify('【拉取已被防替换锁定保护拦截】\n\n当前配置已开启防替换锁定保护，阻止来自云端的覆盖！\n如需覆盖更新本地，请先解除锁定，然后再执行拉取。');
      } else {
        notify(`拉取失败: ${e.message}`);
      }
    } finally {
      if (pullBtn) {
        pullBtn.disabled = !row._cloudItem;
        pullBtn.innerHTML = origHtml;
        pullBtn.style.opacity = row._cloudItem ? '1' : '0.25';
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
    row.dataset.state = binding?.state || (cItem ? "CLOUD_AVAILABLE" : "DISABLED");
    row.dataset.shared = String(Boolean(cItem && cItem.owner_handle !== this.accountHandle));
    const hasCloud = Boolean(cItem && !cItem.is_deleted);

    const isEnabled = Boolean(binding?.enabled);
    const state = binding?.state || (hasCloud ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = binding?.last_synced_version || cItem?.current_version;

    // 1. 仅对异常或待处理状态凸显左边框颜色，其余保持克制中性色
    let leftBorderColor = hasCloud ? 'color-mix(in srgb, var(--cfgsync-text) 32%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 12%, transparent)';
    if (state === SyncState.CONFLICT) {
      leftBorderColor = 'var(--cfgsync-danger)';
    } else if (hasCloud && !existsLocally) {
      leftBorderColor = 'var(--cfgsync-warning)';
    }

    if (hasCloud) {
      row._defaultBg = 'color-mix(in srgb, var(--cfgsync-text) 4%, transparent)';
      row._hoverBg = 'color-mix(in srgb, var(--cfgsync-text) 6%, transparent)';
      row.style.background = row._defaultBg;
      row.style.border = '1px solid color-mix(in srgb, var(--cfgsync-text) 8%, transparent)';
      row.style.borderLeft = `3px solid ${leftBorderColor}`;
    } else {
      row._defaultBg = 'color-mix(in srgb, var(--cfgsync-text) 2%, transparent)';
      row._hoverBg = 'color-mix(in srgb, var(--cfgsync-text) 4%, transparent)';
      row.style.background = row._defaultBg;
      row.style.border = '1px dashed color-mix(in srgb, var(--cfgsync-text) 10%, transparent)';
      row.style.borderLeft = `3px solid ${leftBorderColor}`;
    }

    // 1.5 动态更新名称与文件名状态
    const rowName = row.querySelector('.cfgsync-row-name');
    if (rowName) {
      rowName.style.fontWeight = hasCloud ? '600' : '400';
      rowName.style.color = hasCloud ? 'var(--cfgsync-text)' : 'var(--cfgsync-text)';
    }
    const rowRef = row.querySelector('.cfgsync-row-ref');
    if (rowRef) {
      if (state === SyncState.CONFLICT) {
        const baseRef = rowRef.dataset.sourceRef || rowRef.title || '';
        rowRef.textContent = `${baseRef} · 云端版本冲突`;
        rowRef.style.color = 'var(--cfgsync-danger)';
      } else if (row.dataset.shared === 'true') {
        rowRef.textContent = `共享自 @${cItem.owner_handle} · 只读订阅${existsLocally ? '' : ' · 本地未下载'}`;
        rowRef.style.color = 'var(--cfgsync-muted)';
      } else if (existsLocally) {
        const baseRef = rowRef.dataset.sourceRef || rowRef.title || '';
        const cleanRef = baseRef.startsWith('来自云端') ? (row._itemDisplayName ? `${row._itemDisplayName}.json` : baseRef) : baseRef;
        rowRef.textContent = `${cleanRef}${!hasCloud ? ' · 仅本地' : ''}`;
        rowRef.style.color = hasCloud ? 'var(--cfgsync-muted)' : 'color-mix(in srgb, var(--cfgsync-text) 35%, transparent)';
      } else {
        const owner = cItem?.owner_handle || '云端';
        rowRef.textContent = `来自云端 (@${owner}) · 本地未下载`;
        rowRef.style.color = 'var(--cfgsync-warning)';
      }
    }

    // 2. 状态徽章与历史浮层
    const badgeContainer = row.querySelector('.cfgsync-state-badge-container');
    if (badgeContainer) {
      badgeContainer.innerHTML = this.renderVersionSelectorHtml(state, version, hasCloud ? cItem : null, binding, existsLocally);
      if (hasCloud) {
        const historyBtn = badgeContainer.querySelector('.cfgsync-history-badge-btn');
        if (historyBtn) {
          historyBtn.onmousedown = (e) => e.stopPropagation();
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

    // 3. 按钮状态（统一中性按钮配色）
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    if (pullBtn) {
      pullBtn.disabled = !hasCloud;
      if (!hasCloud) {
        pullBtn.style.opacity = '0.25';
        pullBtn.style.pointerEvents = 'none';
        pullBtn.title = '云端暂无可拉取的备份';
      } else {
        pullBtn.style.opacity = '1';
        pullBtn.style.pointerEvents = 'auto';
        pullBtn.title = !existsLocally ? '从云端拉取此配置保存到本地 (生成本地副本)' : '重新从云端拉取此配置覆盖本地';
      }
    }

    const pushBtn = row.querySelector('.cfgsync-push-btn');
    if (pushBtn) {
      pushBtn.disabled = !existsLocally || row.dataset.shared === 'true';
      if (!existsLocally || row.dataset.shared === 'true') {
        pushBtn.style.opacity = '0.25';
        pushBtn.style.pointerEvents = 'none';
        pushBtn.title = row.dataset.shared === 'true' ? '共享配置为只读，请拉取所有者的更新' : '本地不存在此文件，请先拉取';
      } else {
        pushBtn.style.opacity = '1';
        pushBtn.style.pointerEvents = 'auto';
        pushBtn.title = hasCloud ? '备份到云端，保存新的快照' : '备份此预设或配置到云端，生成首个快照';
      }
    }

    const shareBtn = row.querySelector('.cfgsync-share-btn');
    if (shareBtn) {
      shareBtn.disabled = !hasCloud || row.dataset.shared === 'true';
      if (!hasCloud || row.dataset.shared === 'true') {
        shareBtn.style.opacity = '0.25';
        shareBtn.style.pointerEvents = 'none';
        shareBtn.style.cursor = 'not-allowed';
        shareBtn.title = row.dataset.shared === 'true' ? '只有所有者可以分享此配置' : '尚未推送到云端，无法分享';
      } else {
        shareBtn.style.opacity = '1';
        shareBtn.style.pointerEvents = 'auto';
        shareBtn.style.cursor = 'pointer';
        shareBtn.title = '分享配置 (生成邀请码 / 设为公开)';
      }
    }

    const deleteBtn = row.querySelector('.cfgsync-delete-btn');
    if (deleteBtn) deleteBtn.style.setProperty('display', row.dataset.shared === 'true' ? 'none' : 'inline-flex', 'important');
    this.updateSummary();
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
    row.dataset.sourceOwner = item.sourceOwner || item.cloudItem?.owner_handle || this.accountHandle;
    row.dataset.displayName = item.displayName || '';

    const cItem = item.cloudItem || null;
    const hasCloud = Boolean(cItem && !cItem.is_deleted);

    row._binding = initialBinding;
    row._cloudItem = cItem;
    row._existsLocally = item.existsLocally !== false;

    const isEnabled = Boolean(initialBinding?.enabled);
    const state = initialBinding?.state || (hasCloud ? 'CLOUD_AVAILABLE' : SyncState.DISABLED);
    const version = initialBinding?.last_synced_version || cItem?.current_version;

    const isLocked = Boolean(cItem?.is_locked !== undefined ? cItem.is_locked : item.is_locked);
    row._isLocked = isLocked;

    let leftBorderColor = hasCloud ? 'color-mix(in srgb, var(--cfgsync-text) 32%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 12%, transparent)';
    if (state === SyncState.CONFLICT) {
      leftBorderColor = 'var(--cfgsync-danger)';
    } else if (hasCloud && !row._existsLocally) {
      leftBorderColor = 'var(--cfgsync-warning)';
    }

    row._defaultBg = hasCloud ? 'color-mix(in srgb, var(--cfgsync-text) 4%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 2%, transparent)';
    row._hoverBg = hasCloud ? 'color-mix(in srgb, var(--cfgsync-text) 6%, transparent)' : 'color-mix(in srgb, var(--cfgsync-text) 4%, transparent)';

    row.style.cssText = `
      display: flex; flex-direction: column; gap: 7px;
      padding: 10px 12px; border-radius: 6px;
      background: ${row._defaultBg};
      border: ${hasCloud ? '1px solid color-mix(in srgb, var(--cfgsync-text) 8%, transparent)' : '1px dashed color-mix(in srgb, var(--cfgsync-text) 10%, transparent)'};
      border-left: 3px solid ${leftBorderColor};
      transition: background 0.15s ease;
    `;
    row.onmouseenter = () => { row.style.background = row._hoverBg; };
    row.onmouseleave = () => { row.style.background = row._defaultBg; };

    let avatarHtml = '';
    if (contentType === 'character') {
      const avatarSrc = `/characters/${encodeURIComponent(item.sourceRef || item.displayName + '.png')}`;
      avatarHtml = `
        <div style="width:20px; height:20px; flex-shrink:0; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; overflow:hidden; background:color-mix(in srgb, var(--cfgsync-text) 6%, transparent); border:1px solid color-mix(in srgb, var(--cfgsync-text) 12%, transparent);">
          <img class="cfgsync-char-avatar" src="${avatarSrc}" alt="" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="this.style.display='none';" />
        </div>
      `;
    }

    const rowBtnStyle = 'white-space:nowrap !important; width:auto !important; min-width:unset !important; max-width:unset !important; height:25px !important; padding:0 10px !important; margin:0 !important; font-size:12px !important; font-weight:400 !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; border-radius:4px !important; background:color-mix(in srgb, var(--cfgsync-text) 4%, transparent) !important; border:1px solid color-mix(in srgb, var(--cfgsync-text) 10%, transparent) !important; color:var(--cfgsync-text) !important; transition:all 0.12s ease !important;';

    const refText = row.dataset.sourceOwner !== this.accountHandle ? `共享自 @${row.dataset.sourceOwner} · 只读订阅` : !row._existsLocally
      ? `来自云端 (@${cItem?.owner_handle || '云端'}) · 本地未下载`
      : `${item.sourceRef || ''}${!hasCloud ? ' · 仅本地' : ''}`;

    row.innerHTML = `
      <label class="cfgsync-sync-control" title="开启或关闭此项同步">
        <input type="checkbox" class="cfgsync-toggle" ${isEnabled ? 'checked' : ''} aria-label="同步 ${escapeHtml(item.displayName)}" />
        <span class="cfgsync-check-visual" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10" /></svg></span>
        <span class="cfgsync-check-caption" aria-hidden="true">${row.dataset.sourceOwner !== this.accountHandle ? '订阅' : '同步'}</span>
      </label>
      <div class="cfgsync-card-body">
      <div class="cfgsync-card-header">
        <div class="cfgsync-card-title">
          ${avatarHtml}
          ${(contentType === 'chat' || contentType === 'group_chat') && (item.characterName || (item.sourceRef && item.sourceRef.includes('/'))) ? `
            <span class="cfgsync-chat-char-tag" style="background:color-mix(in srgb, var(--cfgsync-text) 8%, transparent); color:var(--cfgsync-text); font-size:12px; padding:1px 6px; border-radius:3px; border:1px solid color-mix(in srgb, var(--cfgsync-text) 14%, transparent); font-weight:normal; flex-shrink:0;">${escapeHtml(item.characterName || item.sourceRef.split('/')[0])}</span>
            <span class="cfgsync-row-name" title="${escapeHtml(item.displayName)}" style="font-size:13px; font-weight:${hasCloud ? '600' : '400'}; color:${hasCloud ? 'var(--cfgsync-text)' : 'var(--cfgsync-text)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.chatName || (item.displayName && item.displayName.includes(' / ') ? item.displayName.split(' / ').slice(1).join(' / ') : item.displayName))}</span>
          ` : `
            <span class="cfgsync-row-name" title="${escapeHtml(item.displayName)}" style="font-size:13px; font-weight:${hasCloud ? '600' : '400'}; color:${hasCloud ? 'var(--cfgsync-text)' : 'var(--cfgsync-text)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.displayName)}</span>
          `}
        </div>
        <div class="cfgsync-state-badge-container" style="display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">
          ${this.renderVersionSelectorHtml(state, version, hasCloud ? cItem : null, initialBinding, row._existsLocally)}
        </div>
      </div>

      <!-- 下层：左侧文件来源说明 + 右侧操作按钮组 -->
      <div class="cfgsync-card-footer">
        <div class="cfgsync-row-ref" data-source-ref="${escapeHtml(item.sourceRef)}" title="${escapeHtml(refText)}">${escapeHtml(refText)}</div>
        <div class="cfgsync-row-actions" style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
          <button class="cfgsync-pull-btn menu_button" type="button" title="${!row._existsLocally ? '从云端拉取此配置保存到本地 (生成本地副本)' : '重新从云端拉取此配置覆盖本地'}" style="${rowBtnStyle} ${!hasCloud ? 'opacity:0.25 !important; pointer-events:none !important;' : 'cursor:pointer !important;'}">拉取</button>
          <button class="cfgsync-push-btn menu_button" type="button" title="${hasCloud ? '备份到云端，保存新的快照' : '备份此预设或配置到云端，生成首个快照'}" style="${rowBtnStyle} ${!row._existsLocally ? 'opacity:0.25 !important; pointer-events:none !important;' : 'cursor:pointer !important;'}">备份</button>
          ${contentType !== 'chat' && contentType !== 'group_chat' && (contentType !== 'settings' || this._allowSettingsSharing) ? `
          <button class="cfgsync-share-btn menu_button" type="button" title="${hasCloud ? (contentType === 'settings' ? '家庭共享设置 (生成专属邀请码 / 安全注入 API Key)' : '分享配置 (生成邀请码 / 设为公开)') : '尚未推送到云端，无法分享'}" style="${rowBtnStyle} ${!hasCloud ? 'opacity:0.25 !important; pointer-events:none !important; cursor:not-allowed !important;' : 'cursor:pointer !important;'}">分享</button>
          ` : ''}
          ${contentType !== 'settings' ? `
          <button class="cfgsync-delete-btn menu_button" type="button" title="删除配置 (云端备份 / 本地文件)" style="${rowBtnStyle} cursor:pointer !important;">删除</button>
          ` : ''}
        </div>
      </div>
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
      historyBtn.onmousedown = (e) => e.stopPropagation();
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

    // 绑定直接拉取/下载按钮事件（支持跨账号分享配置一键下载）
    const pullBtn = row.querySelector('.cfgsync-pull-btn');
    if (pullBtn) {
      pullBtn.onmousedown = (e) => e.stopPropagation();
      pullBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hasCloud) return;
        await this.restoreSnapshot(row, contentType, item);
      };
    }

    // 勾选切换开关（若本地尚无文件，自动协同下载）
    const toggle = row.querySelector('.cfgsync-toggle');
    toggle.onmousedown = (e) => e.stopPropagation();
    toggle.onchange = async () => {
      toggle.disabled = true;
      try {
        if (toggle.checked) {
          const sourceOwner = row._cloudItem?.owner_handle || this.accountHandle;
          const binding = await this.syncManager.enableSync(this.accountHandle, contentType, item.itemUid, item.displayName, null, sourceOwner);
          row._binding = binding;
          if (!row._existsLocally && hasCloud) {
            await this.restoreSnapshot(row, contentType, item);
          } else {
            this.updateRowState(row, binding, row._cloudItem, row._existsLocally);
          }
        } else {
          const sourceOwner = row._binding?.source_owner_handle || row._cloudItem?.owner_handle || this.accountHandle;
          const bindingUid = this.storage.makeBindingUid(this.accountHandle, sourceOwner, contentType, item.itemUid);
          const backup = await this.storage.getBackup(bindingUid);
          const choice = await chooseDisable(Boolean(backup));
          if (choice === 'cancel') { toggle.checked = true; return; }
          const binding = await this.syncManager.disableSync(bindingUid, choice === 'restore');
          if (choice === 'restore') notify('已恢复开启同步前的本地备份。请刷新酒馆以加载配置。');
          row._binding = binding;
          this.updateRowState(row, binding, row._cloudItem, row._existsLocally);
        }
      } catch (err) {
        console.error('[cfgsync] toggle error:', err);
        toggle.checked = !toggle.checked;
        notify(`切换状态失败: ${escapeHtml(err.message)}`);
      } finally {
        toggle.disabled = false;
      }
    };

    // 手动推送到云端（支持时间快照、自定义备注、缓存精简与网盘式直传）
    const pushBtn = row.querySelector('.cfgsync-push-btn');
    pushBtn.onmousedown = (e) => e.stopPropagation();
    pushBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
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
          pushBtn.textContent = '备份中...';
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
              force: pushOptions.force === true,
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
              row._cloudItem = {
                owner_handle: this.accountHandle,
                current_version: res.version,
                current_checksum: res.checksum,
                item_uid: item.itemUid,
                display_name: item.displayName,
              };
              if (row._binding) {
                row._binding.last_synced_version = res.version;
                row._binding.last_synced_checksum = res.checksum;
                row._binding.state = SyncState.SYNCED;
              }
              this.updateRowState(row, row._binding, row._cloudItem, true);
              this.updateDrawerCount(contentType);
              const toastMsg = `已成功推送到云端 (${res.versionTitle || `v${res.version}`})`;
              if (typeof toastr !== 'undefined' && toastr?.success) {
                toastr.success(toastMsg);
              }
            }
          } catch (e) {
            notify(`推送失败: ${e.message}`);
          } finally {
            pushBtn.disabled = !row._existsLocally;
            pushBtn.innerHTML = origHtml;
            pushBtn.style.opacity = row._existsLocally ? '1' : '0.25';
          }
        },
      });
    };

    // 分享配置（专属邀请码 / 全服公开）
    const shareBtn = row.querySelector('.cfgsync-share-btn');
    if (shareBtn) {
      shareBtn.onmousedown = (e) => e.stopPropagation();
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

    // 安全删除配置（云端备份 / 本地文件；原地更新零刷新）
    const deleteBtn = row.querySelector('.cfgsync-delete-btn');
    if (deleteBtn) {
      deleteBtn.onmouseenter = () => {
        deleteBtn.style.setProperty('color', 'var(--cfgsync-danger)', 'important');
        deleteBtn.style.setProperty('border-color', 'rgba(248,81,73,0.4)', 'important');
        deleteBtn.style.setProperty('background', 'rgba(248,81,73,0.1)', 'important');
      };
      deleteBtn.onmouseleave = () => {
        deleteBtn.style.setProperty('color', 'var(--cfgsync-text)', 'important');
        deleteBtn.style.setProperty('border-color', 'color-mix(in srgb, var(--cfgsync-text) 10%, transparent)', 'important');
        deleteBtn.style.setProperty('background', 'color-mix(in srgb, var(--cfgsync-text) 4%, transparent)', 'important');
      };
      deleteBtn.onmousedown = (e) => e.stopPropagation();
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

            if (deleteCloud && (deleteLocal || !row._existsLocally)) {
              row.style.transition = 'all 0.2s ease';
              row.style.opacity = '0';
              row.style.transform = 'translateX(20px)';
              setTimeout(() => {
                row.remove();
                this.updateDrawerCount(contentType);
              }, 200);
            } else if (deleteCloud) {
              row._cloudItem = null;
              if (row._binding) {
                row._binding.state = SyncState.DISABLED;
              }
              this.updateRowState(row, row._binding, null, true);
              this.updateDrawerCount(contentType);
            } else if (deleteLocal) {
              row._existsLocally = false;
              this.updateRowState(row, row._binding, row._cloudItem, false);
              this.updateDrawerCount(contentType);
            }

            if (deleteLocal && res?.deleted_local === false && res?.local_reason === 'local_file_not_found') {
              notify('【删除提示】\n\n本地未找到该配置文件，已仅删除云端备份记录。');
            }
          },
        });
      };
    }

    this.updateRowState(row, initialBinding, cItem, row._existsLocally);
    return row;
  }

  updateLockBtnState(btn, isLocked, owner = '') {
    if (!btn) return;
    const ownerTip = owner && owner !== this.accountHandle ? `来自 @${owner} 的配置` : '此配置';
    btn.title = isLocked
      ? `防替换保护：已锁定${ownerTip}，阻止任何云端快照覆盖本地 (点击解锁)`
      : `防替换保护：未锁定${ownerTip} (点击开启防替换锁定)`;
    btn.style.background = isLocked ? 'rgba(250, 173, 20, 0.18)' : 'transparent';
    btn.style.borderColor = isLocked ? 'rgba(250, 173, 20, 0.45)' : 'color-mix(in srgb, var(--cfgsync-text) 12%, transparent)';
    btn.style.color = isLocked ? 'var(--cfgsync-warning)' : 'color-mix(in srgb, var(--cfgsync-text) 40%, transparent)';
  }

  renderServerErrorNotice() {
    this.container.innerHTML = `
      <div style="box-sizing: border-box; width: 100%; background: #1c181a; border: 1px solid rgba(248, 81, 73, 0.4); border-left: 4px solid var(--cfgsync-danger); border-radius: 6px; padding: 14px 16px; margin: 4px 0; color: #f5f5f5;">
        <div style="color: var(--cfgsync-danger); font-weight: 600; font-size: 13px; margin-bottom: 8px;">
          服务端插件未就绪
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
          重新检测服务状态
        </button>
      </div>
    `;
    const retryBtn = this.container.querySelector('.cfgsync-retry-btn');
    if (retryBtn) {
      retryBtn.onmousedown = (e) => e.stopPropagation();
      retryBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.container.innerHTML = '';
        this.refresh();
      };
    }
  }
}
