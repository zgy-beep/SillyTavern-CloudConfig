/**
 * 云端快照历史记录弹窗 (支持单快照锁定防替换、单快照还原与删除)
 */

function formatRelativeTime(timestampMs) {
  if (!timestampMs) return '';
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

function formatAbsoluteTime(timestampMs) {
  if (!timestampMs) return '';
  const d = new Date(timestampMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * 打开云端快照历史弹窗
 * @param {object} params
 * @param {string} params.displayName
 * @param {string} params.contentType
 * @param {string} params.itemUid
 * @param {string} params.owner
 * @param {boolean} params.isCrossAccount
 * @param {object} params.api
 * @param {(version: number) => Promise<void>} params.onRestore
 * @param {(deletedVersion: number) => Promise<void>} params.onDeleteVersion
 */
export function showSnapshotHistoryDialog({
  displayName,
  contentType,
  itemUid,
  owner,
  isCrossAccount = false,
  api,
  onRestore,
  onDeleteVersion,
}) {
  const overlay = document.createElement('div');
  overlay.className = 'cfgsync-modal-overlay popup';
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
    padding: 22px 24px; border-radius: 12px; max-width: 560px; width: 92%; max-height: 82vh;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box; display: flex; flex-direction: column;
  `;

  modal.innerHTML = `
    <!-- 头部 -->
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:12px; flex-shrink:0;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(88,166,255,0.15); border:1px solid rgba(88,166,255,0.35); display:flex; align-items:center; justify-content:center; color:#58a6ff; flex-shrink:0;">
          <i class="fa-solid fa-clock-rotate-left" style="font-size:15px;"></i>
        </div>
        <div style="min-width:0; flex:1;">
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">云端快照历史</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${displayName}">
            ${displayName}${isCrossAccount ? ` · 来自 @${owner}` : ''}
          </div>
        </div>
      </div>
      <button id="cfgsync-history-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    <!-- 提示栏：防替换锁定说明 -->
    <div style="background:rgba(250,173,20,0.08); border:1px solid rgba(250,173,20,0.22); border-radius:6px; padding:6px 10px; margin-bottom:12px; font-size:11px; color:#faad14; display:flex; align-items:center; gap:6px; flex-shrink:0;">
      <i class="fa-solid fa-shield-halved" style="font-size:12px;"></i>
      <span>提示：每个配置项上限保存 20 个快照，超额自动淘汰最旧快照。点击快照右侧的 <strong>锁定</strong> 即可永久固定，轮转时绝不被替换！</span>
    </div>

    <!-- 快照列表容器 -->
    <div id="cfgsync-history-list" style="flex:1; overflow-y:auto; min-height:160px; max-height:50vh; padding-right:4px; display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; align-items:center; justify-content:center; height:120px; color:#8b949e; font-size:13px; gap:8px;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size:15px; color:#58a6ff;"></i>
        <span>正在读取云端快照列表...</span>
      </div>
    </div>

    <!-- 底部状态与按钮 -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:16px; border-top:1px solid rgba(255,255,255,0.08); padding-top:12px; flex-shrink:0;">
      <div id="cfgsync-history-summary" style="font-size:11.5px; color:#8b949e;"></div>
      <button id="cfgsync-history-close-btn" type="button" style="padding:6px 18px; border-radius:6px; font-size:12px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">关闭</button>
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

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'touchstart'].forEach((evt) => {
    overlay.addEventListener(evt, (e) => e.stopPropagation());
  });

  overlay.onclick = (e) => {
    e.stopPropagation();
    if (e.target === overlay) close();
  };
  modal.querySelector('#cfgsync-history-close-x').onclick = (e) => {
    e.stopPropagation();
    close();
  };
  modal.querySelector('#cfgsync-history-close-btn').onclick = (e) => {
    e.stopPropagation();
    close();
  };

  const listContainer = modal.querySelector('#cfgsync-history-list');
  const summaryEl = modal.querySelector('#cfgsync-history-summary');

  // 更新底部统计文案
  const updateSummaryText = (versions) => {
    const total = versions.length;
    const lockedCount = versions.filter(v => Boolean(v.is_locked)).length;
    summaryEl.textContent = `共 ${total} 个快照 (已锁定 ${lockedCount} 个 · 自动轮转保留最近 20 个)`;
  };

  // 异步加载快照列表
  (async () => {
    try {
      const res = await api.getVersions(contentType, itemUid, owner);
      const allVersions = (res.versions || []).filter(v => v.operation !== 'DELETE');

      if (allVersions.length === 0) {
        listContainer.innerHTML = `
          <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:120px; color:#8b949e; font-size:12.5px; gap:6px;">
            <i class="fa-regular fa-folder-open" style="font-size:24px; opacity:0.4;"></i>
            <span>暂无可用的云端历史快照</span>
          </div>
        `;
        summaryEl.textContent = '共 0 个快照';
        return;
      }

      updateSummaryText(allVersions);
      listContainer.innerHTML = '';

      allVersions.forEach((v, index) => {
        const isLatest = index === 0;
        const relativeTime = formatRelativeTime(v.created_at);
        const absoluteTime = formatAbsoluteTime(v.created_at);
        const sizeStr = formatBytes(v.size_bytes);
        const displayNameTitle = v.version_title || absoluteTime || '历史备份';

        const row = document.createElement('div');
        row.className = 'cfgsync-snapshot-item';
        row.dataset.version = String(v.version);

        const updateRowBorder = () => {
          row.style.borderLeft = v.is_locked
            ? '3px solid #faad14'
            : (isLatest ? '3px solid #2ea043' : '3px solid rgba(255, 255, 255, 0.15)');
        };

        row.style.cssText = `
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px; padding: 10px 12px;
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          transition: background 0.15s ease;
        `;
        updateRowBorder();
        row.onmouseenter = () => { row.style.background = 'rgba(255, 255, 255, 0.06)'; };
        row.onmouseleave = () => { row.style.background = 'rgba(255, 255, 255, 0.03)'; };

        row.innerHTML = `
          <!-- 快照名称与详情 -->
          <div style="min-width:0; flex:1; display:flex; flex-direction:column; gap:3px;">
            <div style="display:flex; align-items:center; gap:6px; min-width:0;">
              <span style="font-size:13px; font-weight:600; color:#f0f6fc; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${displayNameTitle}">
                ${displayNameTitle}
              </span>
              ${isLatest ? `
                <span style="background:rgba(46,160,67,0.18); color:#3fb950; border:1px solid rgba(46,160,67,0.4); padding:0 5px; border-radius:4px; font-size:10px; font-weight:600; flex-shrink:0;">最新</span>
              ` : ''}
              <span class="cfgsync-snapshot-locked-badge" style="display:${v.is_locked ? 'inline-flex' : 'none'}; align-items:center; gap:3px; background:rgba(250,173,20,0.15); color:#faad14; border:1px solid rgba(250,173,20,0.35); padding:0 5px; border-radius:4px; font-size:10px; font-weight:600; flex-shrink:0;">
                <i class="fa-solid fa-lock" style="font-size:9px;"></i>固定防替换
              </span>
            </div>
            <div style="font-size:11px; color:#8b949e; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span title="${absoluteTime}"><i class="fa-regular fa-clock" style="font-size:10px; margin-right:3px;"></i>${relativeTime}</span>
              ${sizeStr ? `<span>·</span><span>${sizeStr}</span>` : ''}
              ${isCrossAccount ? `<span>·</span><span style="color:#a371f7;">@${owner}</span>` : ''}
            </div>
          </div>

          <!-- 操作按钮区 -->
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <!-- 锁定/解锁防替换按钮 -->
            <button class="cfgsync-lock-snapshot-btn" type="button" style="display:inline-flex; align-items:center; gap:4px; padding:5px 9px; border-radius:6px; font-size:11.5px; font-weight:500; cursor:pointer; transition:all 0.15s ease;">
              <i class="fa-solid ${v.is_locked ? 'fa-lock' : 'fa-lock-open'}"></i>
              <span>${v.is_locked ? '已锁定' : '锁定'}</span>
            </button>

            <!-- 还原按钮 -->
            <button class="cfgsync-restore-snapshot-btn" type="button" title="拉取此快照覆盖本地文件" style="display:inline-flex; align-items:center; gap:4px; padding:5px 11px; border-radius:6px; font-size:11.5px; font-weight:500; background:rgba(88,166,255,0.12); border:1px solid rgba(88,166,255,0.35); color:#58a6ff; cursor:pointer; transition:all 0.15s ease;">
              <i class="fa-solid fa-cloud-arrow-down" style="font-size:11px;"></i>
              <span>还原</span>
            </button>

            <!-- 删除按钮 -->
            <button class="cfgsync-del-snapshot-btn" type="button" title="${v.is_locked ? '已锁定：需先解锁方可删除' : '删除此历史快照'}" style="width:26px; height:26px; border-radius:6px; background:transparent; border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.4); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; font-size:11px; transition:all 0.15s ease;">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        `;

        const lockBtn = row.querySelector('.cfgsync-lock-snapshot-btn');
        const lockedBadge = row.querySelector('.cfgsync-snapshot-locked-badge');

        const updateLockBtnStyle = () => {
          if (v.is_locked) {
            lockBtn.title = '已锁定：版本超额时永久保留，永不被自动替换淘汰 (点击解锁)';
            lockBtn.style.background = 'rgba(250, 173, 20, 0.16)';
            lockBtn.style.borderColor = 'rgba(250, 173, 20, 0.45)';
            lockBtn.style.color = '#faad14';
            lockBtn.innerHTML = '<i class="fa-solid fa-lock" style="font-size:10px;"></i><span>已锁定</span>';
            lockedBadge.style.display = 'inline-flex';
          } else {
            lockBtn.title = '点击锁定：快照超额(20个)时永久保留，不被自动替换淘汰';
            lockBtn.style.background = 'rgba(255, 255, 255, 0.05)';
            lockBtn.style.borderColor = 'rgba(255, 255, 255, 0.14)';
            lockBtn.style.color = '#8b949e';
            lockBtn.innerHTML = '<i class="fa-solid fa-lock-open" style="font-size:10px;"></i><span>锁定</span>';
            lockedBadge.style.display = 'none';
          }
          updateRowBorder();
        };
        updateLockBtnStyle();

        // 切换快照锁定状态 (防替换保护)
        lockBtn.onclick = async () => {
          lockBtn.disabled = true;
          const origHtml = lockBtn.innerHTML;
          lockBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            const targetLocked = !v.is_locked;
            await api.setVersionLock({
              contentType,
              itemUid,
              version: v.version,
              locked: targetLocked,
              owner,
            });
            v.is_locked = targetLocked;
            updateLockBtnStyle();
            updateSummaryText(allVersions);
          } catch (err) {
            lockBtn.innerHTML = origHtml;
            alert(`修改锁定状态失败: ${err.message}`);
          } finally {
            lockBtn.disabled = false;
          }
        };

        // 还原快照
        const restoreBtn = row.querySelector('.cfgsync-restore-snapshot-btn');
        restoreBtn.onclick = async () => {
          const confirmed = confirm(`确定要将【${displayName}】还原到此快照吗？\n\n快照名称: ${displayNameTitle}\n时间: ${absoluteTime}\n\n注意：当前本地对应的文件将被此快照覆盖替换。`);
          if (!confirmed) return;

          restoreBtn.disabled = true;
          restoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>还原中</span>';
          try {
            if (onRestore) {
              await onRestore(v.version);
            }
            close();
          } catch (err) {
            restoreBtn.disabled = false;
            restoreBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i><span>还原</span>';
            alert(`还原失败: ${err.message}`);
          }
        };

        // 删除单个快照
        const delBtn = row.querySelector('.cfgsync-del-snapshot-btn');
        delBtn.onmouseenter = () => {
          delBtn.style.color = '#f85149';
          delBtn.style.borderColor = 'rgba(248,81,73,0.4)';
          delBtn.style.background = 'rgba(248,81,73,0.1)';
        };
        delBtn.onmouseleave = () => {
          delBtn.style.color = 'rgba(255,255,255,0.4)';
          delBtn.style.borderColor = 'rgba(255,255,255,0.12)';
          delBtn.style.background = 'transparent';
        };
        delBtn.onclick = async () => {
          if (v.is_locked) {
            alert('【该快照已被锁定防替换保护】\n\n此快照处于锁定保护状态，防止被淘汰或误删。\n如确实需要删除，请先点击【已锁定】按钮解除锁定后再执行删除。');
            return;
          }

          const confirmed = confirm(`确定要删除此云端快照吗？\n\n快照名称: ${displayNameTitle}\n时间: ${absoluteTime}\n\n删除后该快照将无法找回。`);
          if (!confirmed) return;

          delBtn.disabled = true;
          delBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            await api.deleteVersion({
              contentType,
              itemUid,
              version: v.version,
              owner,
            });

            // 成功后移除该行
            row.remove();
            const idx = allVersions.indexOf(v);
            if (idx !== -1) allVersions.splice(idx, 1);
            updateSummaryText(allVersions);

            if (allVersions.length === 0) {
              listContainer.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:120px; color:#8b949e; font-size:12.5px; gap:6px;">
                  <i class="fa-regular fa-folder-open" style="font-size:24px; opacity:0.4;"></i>
                  <span>云端快照已全部删除</span>
                </div>
              `;
            }

            if (onDeleteVersion) {
              await onDeleteVersion(v.version);
            }
          } catch (err) {
            delBtn.disabled = false;
            delBtn.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
            alert(`删除快照失败: ${err.message}`);
          }
        };

        listContainer.appendChild(row);
      });
    } catch (err) {
      listContainer.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:120px; color:#f85149; font-size:12px; gap:6px;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size:20px;"></i>
          <span>加载快照列表失败: ${err.message}</span>
        </div>
      `;
    }
  })();
}
