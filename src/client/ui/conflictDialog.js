/**
 * 409 并发冲突处理弹窗
 */
export function showConflictDialog({
  displayName,
  serverVersion,
  onResolve,
}) {
  const overlay = document.createElement('div');
  overlay.className = 'cfgsync-modal-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
    justify-content: center; z-index: 99999;
  `;

  const modal = document.createElement('div');
  modal.className = 'cfgsync-modal';
  modal.style.cssText = `
    background: var(--SmartThemeBodyColor, #20232a);
    color: var(--SmartThemeQuoteColor, #f0f0f0);
    padding: 24px; border-radius: 8px; max-width: 480px; width: 90%;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5); border: 1px solid #ff4d4f;
  `;

  modal.innerHTML = `
    <h3 style="margin-top:0; color: #ff4d4f; display:flex; align-items:center; gap:8px;">
      ⚠️ 云端配置冲突
    </h3>
    <p style="font-size: 14px; line-height: 1.6;">
      配置项 <strong>${displayName}</strong> 已被其它设备更新（云端当前版本：<strong>v${serverVersion}</strong>）。<br>
      为了防止静默覆盖导致数据丢失，请选择处理策略：
    </p>
    <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px;">
      <button id="cfgsync-pull-btn" class="menu_button" style="background:#1890ff; color:white; border:none; padding:10px; border-radius:4px; cursor:pointer;">
        📥 拉取云端最新版本（覆盖本地）
      </button>
      <button id="cfgsync-overwrite-btn" class="menu_button" style="background:#faad14; color:#222; border:none; padding:10px; border-radius:4px; cursor:pointer;">
        ⚠️ 仍然覆盖云端（不推荐）
      </button>
      <button id="cfgsync-cancel-btn" class="menu_button" style="background:#555; color:white; border:none; padding:10px; border-radius:4px; cursor:pointer;">
        ✖ 取消，稍后手动处理
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = (choice) => {
    document.body.removeChild(overlay);
    if (onResolve) onResolve(choice);
  };

  modal.querySelector('#cfgsync-pull-btn').onclick = () => close('PULL_CLOUD');
  modal.querySelector('#cfgsync-overwrite-btn').onclick = () => close('OVERWRITE_CLOUD');
  modal.querySelector('#cfgsync-cancel-btn').onclick = () => close('CANCEL');
}
