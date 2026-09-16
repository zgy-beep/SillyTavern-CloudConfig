/**
 * 安全删除配置弹窗 (含云端软删除墓碑、本地备份保护与酒馆缓存提示)
 */

export function showDeleteDialog({ displayName, contentType, itemUid, existsLocally, onConfirm }) {
  const overlay = document.createElement('div');
  overlay.className = 'cfgsync-modal-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center; z-index: 99999;
  `;

  const modal = document.createElement('div');
  modal.className = 'cfgsync-modal';
  modal.style.cssText = `
    background: #1c202a !important;
    color: #e6edf3 !important;
    padding: 22px 24px; border-radius: 12px; max-width: 440px; width: 92%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box;
  `;

  const isSettings = contentType === 'settings';

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(248,81,73,0.15); border:1px solid rgba(248,81,73,0.35); display:flex; align-items:center; justify-content:center; color:#f85149; flex-shrink:0;">
          <i class="fa-solid fa-trash-can" style="font-size:15px;"></i>
        </div>
        <div style="min-width:0; flex:1;">
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">删除配置</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${displayName}">${displayName}</div>
        </div>
      </div>
      <button id="cfgsync-delete-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    <div style="margin: 14px 0 16px 0; display:flex; flex-direction:column; gap:12px;">
      <!-- 范围勾选项 -->
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px; color:#e6edf3; user-select:none;">
          <input id="cfgsync-delete-cloud-cb" type="checkbox" checked style="accent-color:#f85149; width:15px; height:15px; cursor:pointer;" />
          <span style="font-weight:500;">删除云端备份</span>
          <span style="font-size:11px; color:#8b949e;">(生成墓碑，重新上传可复活)</span>
        </label>

        <label style="display:flex; align-items:center; gap:8px; ${isSettings || !existsLocally ? 'cursor:not-allowed; opacity:0.5;' : 'cursor:pointer;'} font-size:12.5px; color:#e6edf3; user-select:none;">
          <input id="cfgsync-delete-local-cb" type="checkbox" ${isSettings || !existsLocally ? 'disabled' : ''} style="accent-color:#f85149; width:15px; height:15px; ${isSettings || !existsLocally ? 'cursor:not-allowed;' : 'cursor:pointer;'}" />
          <span style="font-weight:500;">同时删除本地文件</span>
          ${isSettings ? `
          <span style="font-size:10.5px; color:#f85149; background:rgba(248,81,73,0.15); padding:1px 5px; border-radius:3px; margin-left:4px;">禁止删除 settings 本地文件</span>
          ` : (!existsLocally ? `
          <span style="font-size:11px; color:#8b949e;">(本地不存在此文件)</span>
          ` : `
          <span style="font-size:11px; color:#52c41a;">(删前自动生成 .bak 备份)</span>
          `)}
        </label>
      </div>

      <!-- 说明与警示 -->
      <div style="display:flex; flex-direction:column; gap:6px; font-size:11.5px; line-height:1.45; color:#8b949e; background:rgba(0,0,0,0.18); border-radius:6px; padding:10px 12px; border:1px dashed rgba(255,255,255,0.08);">
        <div style="display:flex; align-items:flex-start; gap:6px;">
          <i class="fa-solid fa-circle-info" style="color:#58a6ff; font-size:11px; margin-top:2px; flex-shrink:0;"></i>
          <span><strong>云端防误删机制</strong>：删除后将在云端留下安全墓碑，防止老设备误覆盖；再次推送同名配置即可随时“复活”。</span>
        </div>
        <div style="display:flex; align-items:flex-start; gap:6px;">
          <i class="fa-solid fa-triangle-exclamation" style="color:#faad14; font-size:11px; margin-top:2px; flex-shrink:0;"></i>
          <span><strong>已认领副本说明</strong>：已分享并被其他账号认领的配置已落入其专属本地目录，无法被单方收回。</span>
        </div>
        <div style="display:flex; align-items:flex-start; gap:6px;">
          <i class="fa-solid fa-lightbulb" style="color:#52c41a; font-size:11px; margin-top:2px; flex-shrink:0;"></i>
          <span><strong>提示</strong>：若删除了本地文件，建议刷新页面或重启酒馆以清除内存中的缓存对象。</span>
        </div>
      </div>
    </div>

    <div style="display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:16px;">
      <button id="cfgsync-delete-cancel-btn" type="button" style="padding:7px 16px; border-radius:6px; font-size:12.5px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">取消</button>
      <button id="cfgsync-delete-confirm-btn" type="button" style="display:inline-flex; align-items:center; gap:6px; padding:7px 20px; border-radius:6px; font-size:12.5px; font-weight:600; background:#da3633; border:1px solid rgba(255,255,255,0.12); color:#ffffff; cursor:pointer; transition:all 0.15s ease; box-shadow:0 1px 4px rgba(0,0,0,0.3);">
        <i class="fa-solid fa-trash-can"></i>
        <span>确认删除</span>
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    window.removeEventListener('keydown', handleKeydown);
  };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener('keydown', handleKeydown);

  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  modal.querySelector('#cfgsync-delete-close-x').onclick = close;
  modal.querySelector('#cfgsync-delete-cancel-btn').onclick = close;

  const cloudCb = modal.querySelector('#cfgsync-delete-cloud-cb');
  const localCb = modal.querySelector('#cfgsync-delete-local-cb');
  const confirmBtn = modal.querySelector('#cfgsync-delete-confirm-btn');

  const updateConfirmBtnState = () => {
    const hasSelected = Boolean(cloudCb.checked || localCb.checked);
    confirmBtn.disabled = !hasSelected;
    confirmBtn.style.opacity = hasSelected ? '1' : '0.4';
  };

  cloudCb.onchange = updateConfirmBtnState;
  localCb.onchange = updateConfirmBtnState;

  confirmBtn.onclick = async () => {
    const deleteCloud = Boolean(cloudCb.checked);
    const deleteLocal = Boolean(localCb.checked);
    if (!deleteCloud && !deleteLocal) return;

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>正在删除...</span>';

    try {
      if (onConfirm) {
        await onConfirm({ deleteCloud, deleteLocal });
      }
      close();
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i><span>确认删除</span>';
      alert(`删除失败: ${err.message}`);
    }
  };
}
