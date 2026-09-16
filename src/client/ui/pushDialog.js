/**
 * 网盘式云端快照直传弹窗 (Option A - 轻量弹窗)
 */

/**
 * 格式化当前本地时间为 YYYY-MM-DD HH:mm:ss
 */
function formatCurrentTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 显示云端快照推送弹窗
 * @param {object} params
 * @param {string} params.displayName 配置项名称
 * @param {string} params.contentType 配置类别
 * @param {(versionTitle: string) => Promise<void>|void} params.onConfirm 确认上传回调
 */
export function showPushDialog({ displayName, contentType, onConfirm }) {
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
    padding: 22px 24px; border-radius: 12px; max-width: 420px; width: 90%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box;
  `;

  const defaultTitle = `${formatCurrentTime()} 备份`;
  const isSettings = contentType === 'settings';

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(24,144,255,0.15); border:1px solid rgba(24,144,255,0.35); display:flex; align-items:center; justify-content:center; color:#1890ff; flex-shrink:0;">
          <i class="fa-solid fa-cloud-arrow-up" style="font-size:14px;"></i>
        </div>
        <div style="min-width:0; flex:1;">
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${displayName}">保存云端快照</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${displayName}</div>
        </div>
      </div>
      <button id="cfgsync-push-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    <div style="margin: 14px 0 16px 0;">
      <label style="display:block; font-size:12px; font-weight:500; color:#c9d1d9; margin-bottom:6px;">快照名称 / 备注 (可直接回车上传)</label>
      <input id="cfgsync-push-title-input" type="text" maxlength="64" value="${defaultTitle}" spellcheck="false" autocomplete="off" style="width:100%; box-sizing:border-box; padding:9px 12px; font-size:13px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; border-radius:7px; border:1.5px solid rgba(255,255,255,0.18); background:#12151d; color:#58a6ff; outline:none; transition:border-color 0.2s ease, box-shadow 0.2s ease;" />
      
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:4px;">
        <div style="font-size:11.5px; color:#8b949e; display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-clock-rotate-left" style="color:#69c0ff; font-size:11px;"></i>
          <span>网盘直传模式，自动保留最近 20 个快照版本</span>
        </div>
        ${isSettings ? `
        <div style="margin-top:6px; padding:8px 10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:#e6edf3; user-select:none;">
            <input id="cfgsync-exclude-heavy-cb" type="checkbox" checked style="accent-color:#1890ff; width:15px; height:15px; cursor:pointer;" />
            <span style="font-weight:500;">精简酒馆助手 (TavernHelper) 缓存数据</span>
          </label>
          <div id="cfgsync-heavy-hint" style="font-size:11px; color:#8b949e; margin-top:4px; margin-left:23px; line-height:1.4;">
            建议精简：排除插件运行期庞大变量与脚本缓存（预估体积 <span style="color:#52c41a; font-weight:600;">~1.0 MB</span>，省流且同步迅速）
          </div>
        </div>
        ` : ''}
      </div>
    </div>

    <div style="display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:16px;">
      <button id="cfgsync-push-cancel-btn" type="button" style="padding:7px 16px; border-radius:6px; font-size:12.5px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">取消</button>
      <button id="cfgsync-push-submit-btn" type="button" style="display:inline-flex; align-items:center; gap:6px; padding:7px 20px; border-radius:6px; font-size:12.5px; font-weight:600; background:#238636; border:1px solid rgba(255,255,255,0.12); color:#ffffff; cursor:pointer; transition:all 0.15s ease; box-shadow:0 1px 4px rgba(0,0,0,0.3);">
        <i class="fa-solid fa-cloud-arrow-up"></i>
        <span>立即上传</span>
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
  modal.querySelector('#cfgsync-push-close-x').onclick = close;
  modal.querySelector('#cfgsync-push-cancel-btn').onclick = close;

  const input = modal.querySelector('#cfgsync-push-title-input');
  const submitBtn = modal.querySelector('#cfgsync-push-submit-btn');

  const heavyCb = modal.querySelector('#cfgsync-exclude-heavy-cb');
  const heavyHint = modal.querySelector('#cfgsync-heavy-hint');
  if (heavyCb && heavyHint) {
    const savedPref = typeof localStorage !== 'undefined' ? localStorage.getItem('cfgsync_pref_exclude_heavy') : null;
    if (savedPref !== null) {
      heavyCb.checked = savedPref !== 'false';
    }
    const updateHint = () => {
      if (heavyCb.checked) {
        heavyHint.innerHTML = '建议精简：排除插件运行期庞大变量与脚本缓存（预估体积 <span style="color:#52c41a; font-weight:600;">~1.0 MB</span>，省流且同步迅速）';
      } else {
        heavyHint.innerHTML = '完整上传：包含酒馆助手全部运行期缓存（预估体积 <span style="color:#faad14; font-weight:600;">~6.6 MB</span>，耗时可能较长）';
      }
    };
    heavyCb.onchange = () => {
      updateHint();
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cfgsync_pref_exclude_heavy', String(heavyCb.checked));
      }
    };
    updateHint();
  }

  // 获得焦点时选中全部文字方便修改
  input.onfocus = () => {
    input.style.borderColor = '#1890ff';
    input.style.boxShadow = '0 0 0 3px rgba(24, 144, 255, 0.2)';
    input.select();
  };
  input.onblur = () => {
    input.style.borderColor = 'rgba(255,255,255,0.18)';
    input.style.boxShadow = 'none';
  };
  setTimeout(() => input.focus(), 50);

  const handleSubmit = async () => {
    const title = input.value.trim() || defaultTitle;
    const excludeHeavy = heavyCb ? heavyCb.checked : undefined;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>上传中...</span>';
    try {
      if (onConfirm) {
        await onConfirm(title, { excludeHeavy });
      }
      close();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i><span>立即上传</span>';
      alert(`上传失败: ${err.message}`);
    }
  };

  submitBtn.onclick = handleSubmit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };
}
