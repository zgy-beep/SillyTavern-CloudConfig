/**
 * 跨账号分享与认领弹窗 (Phase 2 - 高对比度现代化主题)
 */

/**
 * 显示认领分享码弹窗
 * @param {object} params
 * @param {import('../api.js').CloudConfigApi} params.api
 * @param {() => void} [params.onClaimed]
 */
export function showClaimDialog({ api, onClaimed }) {
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
    padding: 22px 24px; border-radius: 12px; max-width: 400px; width: 90%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box;
  `;

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(82,196,26,0.15); border:1px solid rgba(82,196,26,0.35); display:flex; align-items:center; justify-content:center; color:#52c41a; flex-shrink:0;">
          <i class="fa-solid fa-key" style="font-size:14px;"></i>
        </div>
        <div>
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3;">认领配置分享码</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px;">输入好友发给你的 8 位分享邀请码</div>
        </div>
      </div>
      <button id="cfgsync-claim-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    <div style="margin: 16px 0 14px 0;">
      <label style="display:block; font-size:11.5px; font-weight:500; color:#8b949e; margin-bottom:6px;">8 位邀请码</label>
      <input id="cfgsync-claim-code-input" type="text" maxlength="8" placeholder="例如: K7X9M2PQ" spellcheck="false" autocomplete="off" style="width:100%; box-sizing:border-box; padding:10px 14px; font-size:18px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-weight:700; text-transform:uppercase; letter-spacing:3px; text-align:center; border-radius:8px; border:1.5px solid rgba(255,255,255,0.18); background:#12151d; color:#58a6ff; outline:none; transition:border-color 0.2s ease, box-shadow 0.2s ease;" />
      <div id="cfgsync-claim-error" style="display:none; padding:8px 12px; border-radius:6px; background:rgba(255,77,79,0.15); border:1px solid rgba(255,77,79,0.35); color:#ff7875; font-size:11.5px; margin-top:8px; line-height:1.4;"></div>
      <div id="cfgsync-claim-success" style="display:none; padding:8px 12px; border-radius:6px; background:rgba(82,196,26,0.15); border:1px solid rgba(82,196,26,0.35); color:#73d13d; font-size:12px; margin-top:8px; line-height:1.4;"></div>
    </div>

    <div style="display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:16px;">
      <button id="cfgsync-claim-cancel-btn" type="button" style="padding:7px 16px; border-radius:6px; font-size:12.5px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">取消</button>
      <button id="cfgsync-claim-submit-btn" type="button" style="display:inline-flex; align-items:center; gap:6px; padding:7px 20px; border-radius:6px; font-size:12.5px; font-weight:600; background:#238636; border:1px solid rgba(255,255,255,0.12); color:#ffffff; cursor:pointer; transition:all 0.15s ease; box-shadow:0 1px 4px rgba(0,0,0,0.3);">
        <i class="fa-solid fa-check"></i>
        <span>确认认领</span>
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  modal.querySelector('#cfgsync-claim-close-x').onclick = close;
  modal.querySelector('#cfgsync-claim-cancel-btn').onclick = close;

  const input = modal.querySelector('#cfgsync-claim-code-input');
  const errorEl = modal.querySelector('#cfgsync-claim-error');
  const successEl = modal.querySelector('#cfgsync-claim-success');
  const submitBtn = modal.querySelector('#cfgsync-claim-submit-btn');

  // 输入框获得焦点高亮
  input.onfocus = () => {
    input.style.borderColor = '#52c41a';
    input.style.boxShadow = '0 0 0 3px rgba(82, 196, 26, 0.2)';
  };
  input.onblur = () => {
    input.style.borderColor = 'rgba(255,255,255,0.18)';
    input.style.boxShadow = 'none';
  };
  input.focus();

  const handleClaim = async () => {
    const rawCode = input.value.trim();
    if (!rawCode) {
      errorEl.textContent = '请输入 8 位分享邀请码';
      errorEl.style.display = 'block';
      successEl.style.display = 'none';
      return;
    }

    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>认领中...</span>';

    try {
      const res = await api.claimShareCode(rawCode);
      successEl.innerHTML = res.already_claimed
        ? `<i class="fa-solid fa-circle-check"></i> 您此前已认领过此配置 (@${res.owner_handle})，已直接就绪。`
        : `<i class="fa-solid fa-circle-check"></i> 认领成功！配置来自 <strong>@${res.owner_handle}</strong>，已加入云端授权列表。`;
      successEl.style.display = 'block';
      submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>已完成</span>';
      setTimeout(() => {
        close();
        if (onClaimed) onClaimed();
      }, 1200);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>确认认领</span>';
      errorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${err.data?.message || err.message || '认领失败，请检查邀请码是否有效或过期'}`;
      errorEl.style.display = 'block';
    }
  };

  submitBtn.onclick = handleClaim;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleClaim();
    }
  };
}

/**
 * 显示配置分享设置弹窗
 * @param {object} params
 * @param {import('../api.js').CloudConfigApi} params.api
 * @param {string} params.contentType
 * @param {string} params.itemUid
 * @param {string} params.displayName
 * @param {() => void} [params.onUpdated]
 */
export function showShareDialog({ api, contentType, itemUid, displayName, onUpdated }) {
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
    padding: 22px 24px; border-radius: 12px; max-width: 440px; width: 90%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box;
  `;

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(24,144,255,0.15); border:1px solid rgba(24,144,255,0.35); display:flex; align-items:center; justify-content:center; color:#1890ff; flex-shrink:0;">
          <i class="fa-solid fa-share-nodes" style="font-size:14px;"></i>
        </div>
        <div style="min-width:0; flex:1;">
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${displayName}">分享：${displayName}</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px;">生成专属分享邀请码或一键设为全服公开</div>
        </div>
      </div>
      <button id="cfgsync-share-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    ${contentType === 'settings' ? `
    <!-- 家庭共享模式：API Key 密钥注入授权 -->
    <div style="margin-bottom:14px; padding:12px; border-radius:8px; background:rgba(250,173,20,0.1); border:1px solid rgba(250,173,20,0.3);">
      <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:12.5px; color:#f0f6fc; font-weight:600;">
        <input id="cfgsync-inject-secrets-cb" type="checkbox" style="margin-top:2px; cursor:pointer; accent-color:#faad14; width:15px; height:15px;" />
        <div>
          <div>同时共享 API Key (让家人免配即可调模型)</div>
          <div style="font-size:11px; color:#d29922; font-weight:normal; margin-top:3px; line-height:1.4;">
            ⚠️ 勾选后，认领方在拉取时会自动将本账号的 API Key 写入其环境，明文不经前端传输；但认领后对方已持有密钥，即使撤销共享也无法追回已落盘的密钥，请仅对信任的家庭成员开启。
          </div>
        </div>
      </label>
    </div>
    ` : ''}

    <!-- 区块 1: 生成分享码 -->
    <div style="margin-bottom:16px; padding:14px; border-radius:8px; background:#141720; border:1px solid rgba(255,255,255,0.08);">
      <div style="font-size:13px; font-weight:600; color:#f0f6fc; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <i class="fa-solid fa-ticket" style="color:#58a6ff; font-size:12px;"></i>
        <span>专属邀请码</span>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
        <select id="cfgsync-code-type-select" style="flex:1; padding:6px 10px; font-size:12px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:#1c202a; color:#f0f6fc; outline:none;">
          <option value="single_use" selected>单次核销 (一人认领后失效)</option>
          <option value="multi_use">多人使用 (不限认领次数)</option>
        </select>
        <button id="cfgsync-gen-code-btn" type="button" style="padding:6px 14px; font-size:12px; font-weight:600; border-radius:6px; background:#1f6feb; border:none; color:#fff; cursor:pointer; white-space:nowrap; transition:all 0.15s ease;">生成邀请码</button>
      </div>
      <div id="cfgsync-code-result" style="display:none; margin-top:10px;">
        <div style="display:flex; align-items:center; gap:10px; background:#0d1117; padding:10px 14px; border-radius:6px; border:1px solid rgba(88,166,255,0.35);">
          <span id="cfgsync-code-display" style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:18px; font-weight:700; color:#7ee787; letter-spacing:3px; flex:1; user-select:all;"></span>
          <button id="cfgsync-copy-code-btn" type="button" style="padding:5px 12px; font-size:11.5px; font-weight:500; border-radius:4px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#f0f6fc; cursor:pointer; transition:all 0.15s ease;">复制</button>
        </div>
        <div style="font-size:11px; color:#d29922; margin-top:8px; line-height:1.4; display:flex; align-items:flex-start; gap:6px;">
          <i class="fa-solid fa-triangle-exclamation" style="margin-top:2px;"></i>
          <span>提示：对方认领后拉取将下载独立本地副本，已拉取的副本无法追溯收回；若勾选了共享 API Key，密钥将注入其账号目录且撤销授权不会回收。</span>
        </div>
      </div>
    </div>

    <!-- 区块 2: 全服公开只读 -->
    <div style="margin-bottom:16px; padding:14px; border-radius:8px; background:#141720; border:1px solid rgba(255,255,255,0.08);">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-size:13px; font-weight:600; color:#f0f6fc; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-globe" style="color:#bc8cff; font-size:12px;"></i>
            <span>全服公开只读</span>
          </div>
          <div style="font-size:11px; color:#8b949e; margin-top:3px;">开启后，本服务实例上的任何账号均可只读拉取此配置</div>
        </div>
        <button id="cfgsync-public-toggle-btn" type="button" style="padding:6px 14px; font-size:12px; font-weight:500; border-radius:6px; cursor:pointer; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08); color:#f0f6fc; transition:all 0.15s ease;">设为公开</button>
      </div>
      <div id="cfgsync-public-status-msg" style="display:none; font-size:11.5px; margin-top:8px;"></div>
    </div>

    <div style="display:flex; justify-content:flex-end;">
      <button id="cfgsync-share-close-btn" type="button" style="padding:7px 18px; border-radius:6px; font-size:12.5px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">完成</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (onUpdated) onUpdated();
  };

  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  modal.querySelector('#cfgsync-share-close-x').onclick = close;
  modal.querySelector('#cfgsync-share-close-btn').onclick = close;

  // 生成邀请码
  const genBtn = modal.querySelector('#cfgsync-gen-code-btn');
  const typeSelect = modal.querySelector('#cfgsync-code-type-select');
  const resultBox = modal.querySelector('#cfgsync-code-result');
  const codeDisplay = modal.querySelector('#cfgsync-code-display');
  const copyBtn = modal.querySelector('#cfgsync-copy-code-btn');
  const injectSecretsCb = modal.querySelector('#cfgsync-inject-secrets-cb');

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    genBtn.textContent = '生成中...';
    try {
      const codeUsage = typeSelect.value;
      const injectSecrets = Boolean(injectSecretsCb?.checked);
      const res = await api.createShareCode({
        contentType,
        itemUid,
        codeUsage,
        maxUses: codeUsage === 'multi_use' ? 0 : 1,
        injectSecrets,
      });
      codeDisplay.textContent = res.share_code;
      resultBox.style.display = 'block';
      genBtn.textContent = '重新生成';
      genBtn.disabled = false;
    } catch (err) {
      alert(`生成失败: ${err.message}`);
      genBtn.textContent = '生成邀请码';
      genBtn.disabled = false;
    }
  };

  copyBtn.onclick = () => {
    const text = codeDisplay.textContent;
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '已复制!';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      });
    }
  };

  // 全服公开切换
  const publicBtn = modal.querySelector('#cfgsync-public-toggle-btn');
  const publicMsg = modal.querySelector('#cfgsync-public-status-msg');
  let isCurrentlyPublic = false;

  publicBtn.onclick = async () => {
    publicBtn.disabled = true;
    const targetState = !isCurrentlyPublic;
    const injectSecrets = Boolean(injectSecretsCb?.checked);
    try {
      await api.quickPublic({
        contentType,
        itemUid,
        enabled: targetState,
        injectSecrets,
      });
      isCurrentlyPublic = targetState;
      if (isCurrentlyPublic) {
        publicBtn.textContent = '取消公开';
        publicBtn.style.background = 'rgba(245, 34, 45, 0.15)';
        publicBtn.style.borderColor = 'rgba(245, 34, 45, 0.4)';
        publicBtn.style.color = '#ff7875';
        publicMsg.style.display = 'block';
        publicMsg.style.color = '#73d13d';
        publicMsg.innerHTML = '<i class="fa-solid fa-circle-check"></i> 已开启全服公开只读';
      } else {
        publicBtn.textContent = '设为公开';
        publicBtn.style.background = 'rgba(255,255,255,0.08)';
        publicBtn.style.borderColor = 'rgba(255,255,255,0.18)';
        publicBtn.style.color = '#f0f6fc';
        publicMsg.style.display = 'block';
        publicMsg.style.color = '#8b949e';
        publicMsg.innerHTML = '<i class="fa-solid fa-circle-info"></i> 已取消全服公开';
      }
    } catch (err) {
      alert(`设置失败: ${err.message}`);
    } finally {
      publicBtn.disabled = false;
    }
  };
}
