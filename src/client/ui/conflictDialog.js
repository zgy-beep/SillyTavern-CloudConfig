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
    padding: 24px; border-radius: 10px; max-width: 420px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6); border: 1px solid rgba(255, 77, 79, 0.5);
  `;

  // 强制覆盖 menu_button 的共用按钮样式，避免被酒馆 CSS 压缩按钮宽度
  const btnBase = `
    display: flex !important; align-items: center !important; justify-content: flex-start !important;
    gap: 10px !important; width: 100% !important; box-sizing: border-box !important;
    padding: 12px 16px !important; border-radius: 6px !important; cursor: pointer !important;
    font-size: 13px !important; font-weight: 500 !important; line-height: 1.4 !important;
    white-space: normal !important; text-align: left !important; border: none !important;
    min-width: unset !important; max-width: 100% !important;
    transition: filter 0.15s ease !important;
  `;

  modal.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
      <span style="font-size:20px;">⚠️</span>
      <span style="font-size:16px; font-weight:700; color:#ff4d4f;">云端配置冲突</span>
    </div>
    <p style="font-size:13px; line-height:1.7; margin:0 0 20px 0; opacity:0.9;">
      配置项 <strong>${displayName}</strong> 已被其它设备更新（云端当前版本：<strong>v${serverVersion}</strong>）。<br>
      为防止静默覆盖导致数据丢失，请选择处理策略：
    </p>
    <div style="display:flex; flex-direction:column; gap:10px;">
      <button id="cfgsync-pull-btn" class="menu_button" style="${btnBase} background:#1890ff !important; color:#fff !important;">
        <span style="font-size:18px; flex-shrink:0;">📥</span>
        <span>拉取云端最新版本（覆盖本地）</span>
      </button>
      <button id="cfgsync-overwrite-btn" class="menu_button" style="${btnBase} background:rgba(250,173,20,0.15) !important; color:#faad14 !important; border:1px solid rgba(250,173,20,0.4) !important;">
        <span style="font-size:18px; flex-shrink:0;">⚠️</span>
        <span>仍然覆盖云端（不推荐）</span>
      </button>
      <button id="cfgsync-cancel-btn" class="menu_button" style="${btnBase} background:rgba(255,255,255,0.06) !important; color:rgba(255,255,255,0.7) !important; border:1px solid rgba(255,255,255,0.12) !important;">
        <span style="font-size:18px; flex-shrink:0;">✖</span>
        <span>取消，稍后手动处理</span>
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // 点击遮罩层关闭（等同取消）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close('CANCEL');
    }
  });

  const close = (choice) => {
    document.body.removeChild(overlay);
    if (onResolve) onResolve(choice);
  };

  modal.querySelector('#cfgsync-pull-btn').onclick = () => close('PULL_CLOUD');
  modal.querySelector('#cfgsync-overwrite-btn').onclick = () => close('OVERWRITE_CLOUD');
  modal.querySelector('#cfgsync-cancel-btn').onclick = () => close('CANCEL');
}

