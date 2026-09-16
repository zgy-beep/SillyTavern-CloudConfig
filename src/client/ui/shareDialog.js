/**
 * 跨账号分享与认领弹窗 (Phase 2)
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
    background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
    justify-content: center; z-index: 99999;
  `;

  const modal = document.createElement('div');
  modal.className = 'cfgsync-modal';
  modal.style.cssText = `
    background: var(--SmartThemeBodyColor, #20232a);
    color: var(--SmartThemeQuoteColor, #f0f0f0);
    padding: 22px; border-radius: 10px; max-width: 380px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6); border: 1px solid rgba(24, 144, 255, 0.4);
    font-family: sans-serif;
  `;

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-key" style="color:#52c41a; font-size:16px;"></i>
        <span style="font-size:15px; font-weight:700;">认领配置分享码</span>
      </div>
      <button id="cfgsync-claim-close-x" style="background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer; font-size:16px; padding:0;">&times;</button>
    </div>
    <p style="font-size:12.5px; line-height:1.5; margin:0 0 14px 0; opacity:0.85;">
      输入好友发给你的 8 位分享邀请码，认领后即可在云端列表查阅并拉取该配置：
    </p>
    <div style="margin-bottom:14px;">
      <input id="cfgsync-claim-code-input" type="text" maxlength="12" placeholder="8 位邀请码 (例如: K7X9M2PQ)" style="width:100%; box-sizing:border-box; padding:9px 12px; font-size:15px; font-family:monospace; font-weight:600; text-transform:uppercase; letter-spacing:2px; text-align:center; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.3); color:#69c0ff; outline:none;" />
      <div id="cfgsync-claim-error" style="display:none; color:#ff4d4f; font-size:11.5px; margin-top:6px; line-height:1.4;"></div>
      <div id="cfgsync-claim-success" style="display:none; color:#52c41a; font-size:12px; margin-top:6px; line-height:1.4;"></div>
    </div>
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="cfgsync-claim-cancel-btn" type="button" style="padding:6px 14px; border-radius:5px; font-size:12px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.8); cursor:pointer;">取消</button>
      <button id="cfgsync-claim-submit-btn" type="button" style="padding:6px 16px; border-radius:5px; font-size:12px; font-weight:600; background:#52c41a; border:none; color:#fff; cursor:pointer;">确认认领</button>
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

  input.focus();

  const handleClaim = async () => {
    const rawCode = input.value.trim();
    if (!rawCode) {
      errorEl.textContent = '请输入分享邀请码';
      errorEl.style.display = 'block';
      successEl.style.display = 'none';
      return;
    }

    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = '认领中...';

    try {
      const res = await api.claimShareCode(rawCode);
      successEl.textContent = res.already_claimed
        ? `您此前已认领过此配置 (@${res.owner_handle})，已为您直接就绪。`
        : `认领成功！配置来自 @${res.owner_handle}，已加入您的云端授权。`;
      successEl.style.display = 'block';
      submitBtn.textContent = '已认领';
      setTimeout(() => {
        close();
        if (onClaimed) onClaimed();
      }, 1200);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = '确认认领';
      errorEl.textContent = err.data?.message || err.message || '认领失败，请检查邀请码是否有效或过期';
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
    background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
    justify-content: center; z-index: 99999;
  `;

  const modal = document.createElement('div');
  modal.className = 'cfgsync-modal';
  modal.style.cssText = `
    background: var(--SmartThemeBodyColor, #20232a);
    color: var(--SmartThemeQuoteColor, #f0f0f0);
    padding: 22px; border-radius: 10px; max-width: 440px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6); border: 1px solid rgba(24, 144, 255, 0.4);
    font-family: sans-serif;
  `;

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:8px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-share-nodes" style="color:#1890ff; font-size:16px;"></i>
        <span style="font-size:14px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:320px;">分享：${displayName}</span>
      </div>
      <button id="cfgsync-share-close-x" style="background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer; font-size:16px; padding:0;">&times;</button>
    </div>

    <!-- 区块 1: 生成分享码 -->
    <div style="margin-bottom:18px; padding:12px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);">
      <div style="font-size:13px; font-weight:600; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <i class="fa-solid fa-ticket" style="color:#69c0ff; font-size:12px;"></i>
        <span>专属邀请码</span>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
        <select id="cfgsync-code-type-select" style="padding:5px 8px; font-size:11.5px; border-radius:4px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.3); color:#e6e6e6; outline:none;">
          <option value="single_use" selected>单次核销 (一人认领后失效)</option>
          <option value="multi_use">多人使用 (不限次数)</option>
        </select>
        <button id="cfgsync-gen-code-btn" type="button" style="padding:5px 12px; font-size:11.5px; font-weight:600; border-radius:4px; background:#1890ff; border:none; color:#fff; cursor:pointer; white-space:nowrap;">生成邀请码</button>
      </div>
      <div id="cfgsync-code-result" style="display:none; margin-top:8px;">
        <div style="display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.4); padding:8px 12px; border-radius:4px; border:1px solid rgba(24,144,255,0.4);">
          <span id="cfgsync-code-display" style="font-family:monospace; font-size:16px; font-weight:700; color:#52c41a; letter-spacing:2px; flex:1;"></span>
          <button id="cfgsync-copy-code-btn" type="button" style="padding:4px 10px; font-size:11px; border-radius:3px; background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.2); color:#e6e6e6; cursor:pointer;">复制</button>
        </div>
        <div style="font-size:11px; color:#faad14; margin-top:6px; line-height:1.4;">
          <i class="fa-solid fa-triangle-exclamation"></i> 提示：对方认领后拉取将下载独立本地副本，已拉取的副本无法追溯收回。
        </div>
      </div>
    </div>

    <!-- 区块 2: 全服公开只读 -->
    <div style="margin-bottom:14px; padding:12px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-size:13px; font-weight:600; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-globe" style="color:#722ed1; font-size:12px;"></i>
            <span>全服公开只读</span>
          </div>
          <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:3px;">开启后，本服务实例上的任何账号均可只读拉取此配置</div>
        </div>
        <button id="cfgsync-public-toggle-btn" type="button" style="padding:5px 12px; font-size:11.5px; border-radius:4px; cursor:pointer; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.08); color:#e6e6e6;">设为公开</button>
      </div>
      <div id="cfgsync-public-status-msg" style="display:none; font-size:11.5px; margin-top:8px;"></div>
    </div>

    <div style="display:flex; justify-content:flex-end;">
      <button id="cfgsync-share-close-btn" type="button" style="padding:6px 14px; border-radius:5px; font-size:12px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.8); cursor:pointer;">完成</button>
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

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    genBtn.textContent = '生成中...';
    try {
      const codeUsage = typeSelect.value;
      const res = await api.createShareCode({
        contentType,
        itemUid,
        codeUsage,
        maxUses: codeUsage === 'multi_use' ? 0 : 1,
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
    try {
      await api.quickPublic({
        contentType,
        itemUid,
        enabled: targetState,
      });
      isCurrentlyPublic = targetState;
      if (isCurrentlyPublic) {
        publicBtn.textContent = '取消公开';
        publicBtn.style.background = 'rgba(245, 34, 45, 0.15)';
        publicBtn.style.borderColor = 'rgba(245, 34, 45, 0.4)';
        publicBtn.style.color = '#ff7875';
        publicMsg.style.display = 'block';
        publicMsg.style.color = '#52c41a';
        publicMsg.textContent = '已开启全服公开只读';
      } else {
        publicBtn.textContent = '设为公开';
        publicBtn.style.background = 'rgba(255,255,255,0.08)';
        publicBtn.style.borderColor = 'rgba(255,255,255,0.2)';
        publicBtn.style.color = '#e6e6e6';
        publicMsg.style.display = 'block';
        publicMsg.style.color = 'rgba(255,255,255,0.5)';
        publicMsg.textContent = '已取消全服公开';
      }
    } catch (err) {
      alert(`设置失败: ${err.message}`);
    } finally {
      publicBtn.disabled = false;
    }
  };
}
