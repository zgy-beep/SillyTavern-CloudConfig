/**
 * 插件管理看板与去重清理工具弹窗 (adminDialog)
 * 落实 P5-6, N-8, TC9, TC10
 */
export function showAdminDashboardDialog({ api, isAdmin = false, onClose = null }) {
  const existing = document.getElementById('cfgsync-dashboard-dialog-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'cfgsync-dashboard-dialog-backdrop';
  backdrop.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.65); z-index: 100000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px);
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    width: 620px; max-width: 95vw; max-height: 85vh;
    background: #1a1e24; border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; overflow: hidden;
    color: #e6edf3; font-family: sans-serif;
  `;

  dialog.innerHTML = `
    <div style="padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
      <div style="display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-chart-pie" style="color:#58a6ff; font-size:16px;"></i>
        <span style="font-weight:600; font-size:14px;">插件管理看板与存储分析</span>
        <span id="cfgsync-dashboard-role-badge" style="font-size:10px; padding:1px 6px; border-radius:10px; background:rgba(88,166,255,0.15); color:#58a6ff; border:1px solid rgba(88,166,255,0.3);"></span>
      </div>
      <button id="cfgsync-dash-close-x" style="background:transparent; border:none; color:rgba(255,255,255,0.5); cursor:pointer; font-size:16px; padding:0 4px;">&times;</button>
    </div>

    <div id="cfgsync-dash-body" style="padding: 16px 18px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;">
      <div style="text-align:center; padding:24px; color:rgba(255,255,255,0.5);"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取存储指标...</div>
    </div>

    <div style="padding: 10px 18px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: flex-end; background: rgba(255,255,255,0.02);">
      <button id="cfgsync-dash-close-btn" class="menu_button" style="padding: 5px 14px; font-size: 12px; cursor: pointer; border-radius: 4px;">关闭</button>
    </div>
  `;

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const closeDialog = () => {
    backdrop.remove();
    if (typeof onClose === 'function') onClose();
  };

  dialog.querySelector('#cfgsync-dash-close-x').onclick = closeDialog;
  dialog.querySelector('#cfgsync-dash-close-btn').onclick = closeDialog;
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeDialog();
  };

  const renderDashboard = async () => {
    const bodyEl = dialog.querySelector('#cfgsync-dash-body');
    const badgeEl = dialog.querySelector('#cfgsync-dashboard-role-badge');

    try {
      const stats = await api.getStats();
      const user = stats.user || {};
      const global = stats.global || null;
      const isAdm = stats.is_admin || isAdmin;

      if (badgeEl) {
        badgeEl.textContent = isAdm ? '系统管理员' : `当前用户: @${user.handle || 'user'}`;
      }

      const formatBytes = (bytes) => {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      };

      let html = '';

      // 1. 用户自身视角
      html += `
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:12px 14px;">
          <div style="font-size:12px; font-weight:600; color:#58a6ff; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-user"></i> <span>账号视角指标 (@${user.handle})</span>
          </div>
          <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; text-align:center;">
            <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
              <div style="font-size:11px; opacity:0.65;">历史版本数</div>
              <div style="font-size:16px; font-weight:600; color:#f0f6fc; margin-top:2px;">${user.total_versions || 0}</div>
            </div>
            <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
              <div style="font-size:11px; opacity:0.65;">活跃配置项</div>
              <div style="font-size:16px; font-weight:600; color:#52c41a; margin-top:2px;">${user.active_items || 0}</div>
            </div>
            <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
              <div style="font-size:11px; opacity:0.65;">已删除墓碑</div>
              <div style="font-size:16px; font-weight:600; color:#faad14; margin-top:2px;">${user.deleted_items || 0}</div>
            </div>
            <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
              <div style="font-size:11px; opacity:0.65;">名下快照总体积</div>
              <div style="font-size:16px; font-weight:600; color:#69c0ff; margin-top:2px;">${formatBytes(user.total_logical_bytes)}</div>
            </div>
          </div>
        </div>
      `;

      // 2. 全站视角（管理员专属，N-8 去重口径）
      if (global) {
        const savedBytes = Math.max(0, global.total_logical_bytes - global.deduplicated_disk_bytes);
        const savingRatio = global.total_logical_bytes > 0
          ? ((savedBytes / global.total_logical_bytes) * 100).toFixed(1)
          : '0.0';

        html += `
          <div style="background:rgba(88,166,255,0.05); border:1px solid rgba(88,166,255,0.2); border-radius:6px; padding:12px 14px;">
            <div style="font-size:12px; font-weight:600; color:#79c0ff; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
              <i class="fa-solid fa-server"></i> <span>全站视角与真实磁盘占用 (N-8 去重口径)</span>
            </div>
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; text-align:center;">
              <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
                <div style="font-size:11px; opacity:0.65;">全站用户数</div>
                <div style="font-size:16px; font-weight:600; color:#f0f6fc; margin-top:2px;">${global.total_users || 0}</div>
              </div>
              <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
                <div style="font-size:11px; opacity:0.65;">锁定受保护快照</div>
                <div style="font-size:16px; font-weight:600; color:#d48806; margin-top:2px;">🔒 ${global.locked_versions || 0}</div>
              </div>
              <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
                <div style="font-size:11px; opacity:0.65;">真实磁盘占用 (去重后)</div>
                <div style="font-size:16px; font-weight:600; color:#13c2c2; margin-top:2px;">${formatBytes(global.deduplicated_disk_bytes)}</div>
              </div>
              <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:4px;">
                <div style="font-size:11px; opacity:0.65;">去重节省比例</div>
                <div style="font-size:16px; font-weight:600; color:#52c41a; margin-top:2px;">${savingRatio}%</div>
              </div>
            </div>
          </div>
        `;
      }

      // 3. 孤儿快照两阶段清理工具 (2-Stage Clean Tools, P5-6, TC10)
      html += `
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:12px 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div style="font-size:12px; font-weight:600; color:#faad14; display:flex; align-items:center; gap:6px;">
              <i class="fa-solid fa-broom"></i> <span>孤儿快照两阶段清理工具</span>
            </div>
            <button id="cfgsync-scan-orphans-btn" class="menu_button" style="padding:3px 10px; font-size:11px; border-radius:4px; cursor:pointer; background:rgba(250,173,20,0.15); border:1px solid rgba(250,173,20,0.4); color:#faad14;">
              <i class="fa-solid fa-magnifying-glass"></i> 扫描预览
            </button>
          </div>
          <div style="font-size:11px; line-height:1.4; color:rgba(255,255,255,0.55); margin-bottom:8px;">
            安全原则：仅扫描已标记删除（墓碑状态）且<strong>未加锁</strong>的废弃历史版本；带有金锁 🔒 标记的快照永不被删。
          </div>
          <div id="cfgsync-orphans-result-area" style="display:none; background:rgba(0,0,0,0.2); border:1px dashed rgba(255,255,255,0.12); border-radius:4px; padding:10px;">
          </div>
        </div>
      `;

      bodyEl.innerHTML = html;

      // 绑定清理扫描事件
      const scanBtn = bodyEl.querySelector('#cfgsync-scan-orphans-btn');
      const resultArea = bodyEl.querySelector('#cfgsync-orphans-result-area');

      if (scanBtn && resultArea) {
        scanBtn.onclick = async () => {
          scanBtn.disabled = true;
          scanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在扫描...';

          try {
            const preview = await api.cleanOrphans(true);
            resultArea.style.display = 'block';

            if (preview.candidate_count === 0) {
              resultArea.innerHTML = `
                <div style="font-size:11.5px; color:#52c41a; text-align:center; padding:6px 0;">
                  <i class="fa-solid fa-check-circle"></i> 当前没有任何未锁定的孤儿快照，存储健康度良好！
                </div>
              `;
            } else {
              resultArea.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                  <span style="font-size:12px; color:#f0f6fc;">
                    发现 <strong>${preview.candidate_count}</strong> 个待清理快照（预估可释放约 <strong>${formatBytes(preview.reclaimable_bytes)}</strong> 空间）
                  </span>
                  <button id="cfgsync-confirm-clean-btn" class="menu_button" style="padding:4px 12px; font-size:11.5px; background:rgba(248,81,73,0.2); border:1px solid rgba(248,81,73,0.5); color:#f85149; cursor:pointer; border-radius:4px; font-weight:600;">
                    <i class="fa-solid fa-trash"></i> 确认清理
                  </button>
                </div>
                <div style="max-height:140px; overflow-y:auto; font-size:11px; color:rgba(255,255,255,0.65); line-height:1.5;">
                  ${preview.candidates.map(c => `<div>• [${c.content_type}] ${c.version_title || '快照 v' + c.version} (@${c.owner_handle}) - ${formatBytes(c.size_bytes)}</div>`).join('')}
                </div>
              `;

              const confirmCleanBtn = resultArea.querySelector('#cfgsync-confirm-clean-btn');
              if (confirmCleanBtn) {
                confirmCleanBtn.onclick = async () => {
                  if (!confirm(`确定要永久清理这 ${preview.candidate_count} 个未锁定孤儿快照吗？\n操作将记录到审计日志且不可撤销。`)) {
                    return;
                  }

                  confirmCleanBtn.disabled = true;
                  confirmCleanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在清理...';

                  try {
                    const cleanRes = await api.cleanOrphans(false);
                    alert(`【孤儿快照清理完成】\n\n成功清除: ${cleanRes.deleted_count} 个版本\n释放空间: ${formatBytes(cleanRes.freed_bytes)}`);
                    await renderDashboard();
                  } catch (e) {
                    alert(`清理失败: ${e.message}`);
                    confirmCleanBtn.disabled = false;
                    confirmCleanBtn.innerHTML = '<i class="fa-solid fa-trash"></i> 确认清理';
                  }
                };
              }
            }
          } catch (err) {
            alert(`扫描失败: ${err.message}`);
          } finally {
            scanBtn.disabled = false;
            scanBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> 扫描预览';
          }
        };
      }
    } catch (err) {
      bodyEl.innerHTML = `<div style="text-align:center; padding:24px; color:#f85149;">加载看板失败: ${err.message}</div>`;
    }
  };

  renderDashboard();
}
