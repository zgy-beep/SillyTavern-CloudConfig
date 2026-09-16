/**
 * 云端快照历史记录弹窗 (全面替代原生 select，解决白底白字与截断问题，支持单版本还原与删除)
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
 * @param {boolean} params.isLocked
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
  isLocked = false,
  api,
  onRestore,
  onDeleteVersion,
}) {
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
    padding: 22px 24px; border-radius: 12px; max-width: 520px; width: 92%; max-height: 82vh;
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

  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  modal.querySelector('#cfgsync-history-close-x').onclick = close;
  modal.querySelector('#cfgsync-history-close-btn').onclick = close;

  const listContainer = modal.querySelector('#cfgsync-history-list');
  const summaryEl = modal.querySelector('#cfgsync-history-summary');

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

      summaryEl.textContent = `共 ${allVersions.length} 个云端快照 (自动滚动保留最近 20 个)`;
      listContainer.innerHTML = '';

      allVersions.forEach((v, index) => {
        const isLatest = index === 0;
        const relativeTime = formatRelativeTime(v.created_at);
        const absoluteTime = formatAbsoluteTime(v.created_at);
        const sizeStr = formatBytes(v.size_bytes);
        const displayNameTitle = v.version_title || absoluteTime || '历史备份';

        const row = document.createElement('div');
        row.className = 'cfgsync-snapshot-item';
        row.style.cssText = `
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-left: ${isLatest ? '3px solid #2ea043' : '3px solid rgba(255, 255, 255, 0.15)'};
          border-radius: 8px; padding: 10px 12px;
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
          transition: background 0.15s ease;
        `;
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
            </div>
            <div style="font-size:11px; color:#8b949e; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span title="${absoluteTime}"><i class="fa-regular fa-clock" style="font-size:10px; margin-right:3px;"></i>${relativeTime}</span>
              ${sizeStr ? `<span>·</span><span>${sizeStr}</span>` : ''}
              ${isCrossAccount ? `<span>·</span><span style="color:#a371f7;">@${owner}</span>` : ''}
            </div>
          </div>

          <!-- 操作按钮区 -->
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <button class="cfgsync-restore-snapshot-btn" type="button" title="拉取此快照覆盖本地文件" style="display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:6px; font-size:11.5px; font-weight:500; background:rgba(88,166,255,0.12); border:1px solid rgba(88,166,255,0.35); color:#58a6ff; cursor:pointer; transition:all 0.15s ease;">
              <i class="fa-solid fa-cloud-arrow-down" style="font-size:11px;"></i>
              <span>还原</span>
            </button>
            <button class="cfgsync-del-snapshot-btn" type="button" title="删除此历史快照" style="width:26px; height:26px; border-radius:6px; background:transparent; border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.4); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; font-size:11px; transition:all 0.15s ease;">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        `;

        // 还原快照
        const restoreBtn = row.querySelector('.cfgsync-restore-snapshot-btn');
        restoreBtn.onclick = async () => {
          if (isLocked) {
            alert('【拉取已被防替换锁定保护拦截】\n\n当前配置已开启防替换锁定保护，阻止来自云端的覆盖！\n如需还原历史快照到本地，请先在主面板点击金色 🔒 图标解除锁定。');
            return;
          }

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
            const remainingRows = listContainer.querySelectorAll('.cfgsync-snapshot-item');
            summaryEl.textContent = `共 ${remainingRows.length} 个云端快照 (自动滚动保留最近 20 个)`;

            if (remainingRows.length === 0) {
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
