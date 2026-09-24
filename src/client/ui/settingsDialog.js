/**
 * 云同步设置弹窗 (本机偏好 + 管理员全局同步策略)
 */

export async function showSettingsDialog({ api, autoSyncEngine = null, onUpdated = null }) {
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
    padding: 22px 24px; border-radius: 12px; max-width: 480px; width: 92%;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.1);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    box-sizing: border-box; max-height: 85vh; overflow-y: auto;
  `;

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="width:34px; height:34px; border-radius:8px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); display:flex; align-items:center; justify-content:center; color:#58a6ff; flex-shrink:0;">
          <i class="fa-solid fa-gear" style="font-size:15px;"></i>
        </div>
        <div>
          <div style="font-size:15px; font-weight:600; color:#f0f6fc; line-height:1.3;">云同步设置</div>
          <div style="font-size:11.5px; color:#8b949e; line-height:1.3; margin-top:2px;">管理本机客户端偏好与服务端全局同步策略</div>
        </div>
      </div>
      <button id="cfgsync-settings-close-x" type="button" style="width:26px; height:26px; border-radius:6px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#8b949e; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:15px; padding:0; transition:all 0.15s ease;">&times;</button>
    </div>

    <!-- 加载中占位 -->
    <div id="cfgsync-settings-loading" style="text-align:center; padding:24px; color:#8b949e; font-size:13px;">
      <i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i>正在加载配置信息...
    </div>

    <div id="cfgsync-settings-body" style="display:none; flex-direction:column; gap:16px;">
      <!-- 1. 本机偏好设置 -->
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px 14px;">
        <div style="font-size:12.5px; font-weight:600; color:#58a6ff; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-laptop" style="font-size:12px;"></i>
          <span>本机使用偏好 (仅保存在当前浏览器)</span>
        </div>
        <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none; margin-top:6px;">
          <input id="cfgsync-pref-exclude-heavy" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; margin-top:2px; cursor:pointer;" />
          <div>
            <div style="font-weight:500; color:#e6edf3;">推送通用设置时默认勾选精简酒馆助手缓存</div>
            <div style="font-size:11px; color:#8b949e; line-height:1.4; margin-top:2px;">排除巨大变量和运行时脚本，让 settings 快照体积降低 ~85%</div>
          </div>
        </label>

        <!-- 自动同步偏好 (P6-4, #12) -->
        <div style="margin-top:10px; padding-top:8px; border-top:1px dashed rgba(255,255,255,0.06);">
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none;">
            <input id="cfgsync-pref-autosync-enabled" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; margin-top:2px; cursor:pointer;" />
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:500; color:#e6edf3;">开启后台自动同步 (实验性/无感避让)</span>
                <span id="cfgsync-autosync-chip" style="font-size:10px; padding:1px 5px; border-radius:3px; background:rgba(255,255,255,0.08); color:#8b949e;">默认关闭</span>
              </div>
              <div style="font-size:11px; color:#8b949e; line-height:1.4; margin-top:2px;">在空闲时定期向云端安全备份已开启同步的资产。正在打字或 AI 生成时严格避让，遇到冲突绝不静默覆盖。</div>
            </div>
          </label>
          <div id="cfgsync-pref-autosync-options" style="display:none; align-items:center; justify-content:space-between; margin-top:8px; padding-left:24px;">
            <span style="font-size:11.5px; color:#8b949e;">自动同步执行周期:</span>
            <select id="cfgsync-pref-autosync-interval" style="height:22px; font-size:11px; padding:0 6px; border-radius:4px; background:#12151d; border:1px solid rgba(255,255,255,0.18); color:#58a6ff; outline:none;">
              <option value="300000">每 5 分钟</option>
              <option value="600000" selected>每 10 分钟</option>
              <option value="1800000">每 30 分钟</option>
              <option value="3600000">每 60 分钟</option>
            </select>
          </div>
        </div>
      </div>


      <!-- 2. 服务端全局策略 (需要管理员权限) -->
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px 14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div style="font-size:12.5px; font-weight:600; color:#faad14; display:flex; align-items:center; gap:6px;">
            <i class="fa-solid fa-server" style="font-size:12px;"></i>
            <span>服务端全局同步策略</span>
          </div>
          <span id="cfgsync-admin-badge" style="font-size:10.5px; padding:2px 7px; border-radius:4px; font-weight:500;"></span>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px;">
          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none;">
            <input id="cfgsync-conf-allow-settings" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; margin-top:2px; cursor:pointer;" />
            <div>
              <div style="font-weight:500; color:#e6edf3;">允许家庭成员共享通用设置 (settings.json)</div>
              <div style="font-size:11px; color:#8b949e; line-height:1.4; margin-top:2px;">开启后允许为 settings 生成专属邀请码并实施受控密钥注入</div>
            </div>
          </label>

          <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none;">
            <input id="cfgsync-conf-exclude-heavy" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; margin-top:2px; cursor:pointer;" />
            <div>
              <div style="font-weight:500; color:#e6edf3;">服务端默认精简助手巨大缓存</div>
              <div style="font-size:11px; color:#8b949e; line-height:1.4; margin-top:2px;">当单次推送未指定精简参数时的服务端全局默认行为</div>
            </div>
          </label>

          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.06);">
            <div>
              <div style="font-size:12px; font-weight:500; color:#e6edf3;">快照最大保留版本数 (maxVersions)</div>
              <div style="font-size:11px; color:#8b949e; line-height:1.3; margin-top:2px;">超过此上限将自动修剪删除最早的历史版本</div>
            </div>
            <input id="cfgsync-conf-max-versions" type="number" min="1" max="100" style="width:64px; box-sizing:border-box; padding:4px 8px; font-size:12.5px; border-radius:5px; border:1px solid rgba(255,255,255,0.18); background:#12151d; color:#58a6ff; text-align:center; outline:none;" />
          </div>
        </div>
      </div>

      <!-- 3. 外部存储镜像与灾备配置 (需要管理员权限) -->
      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px 14px;">
        <div style="font-size:12.5px; font-weight:600; color:#58a6ff; margin-bottom:10px; display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-hard-drive" style="font-size:12px;"></i>
          <span>外部存储镜像与容灾 (管理员)</span>
        </div>

        <!-- 本地/NAS 路径镜像 -->
        <div style="padding-bottom:10px; border-bottom:1px dashed rgba(255,255,255,0.06);">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none; margin-bottom:6px;">
            <input id="cfgsync-conf-localpath-enabled" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; cursor:pointer;" />
            <span style="font-weight:500; color:#e6edf3;">启用本地挂载盘 / SMB 路径异步镜像 (LocalPath)</span>
          </label>
          <div style="margin-left:24px;">
            <input id="cfgsync-conf-localpath" type="text" placeholder="挂载绝对路径，如 /mnt/nas/backups" style="width:100%; box-sizing:border-box; padding:5px 8px; font-size:11.5px; border-radius:5px; border:1px solid rgba(255,255,255,0.18); background:#12151d; color:#e6edf3; outline:none;" />
            <div style="font-size:10.5px; color:#d29922; line-height:1.4; margin-top:4px;">
              ⚠️ <b>Docker 容器提示</b>：必须填写容器内映射绝对路径（如 <code>/app/data/backups</code>），不可填写宿主机未映射物理路径。
            </div>
          </div>
        </div>

        <!-- WebDAV 远程网盘镜像 -->
        <div style="margin-top:10px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:#c9d1d9; user-select:none; margin-bottom:6px;">
            <input id="cfgsync-conf-webdav-enabled" type="checkbox" style="accent-color:#1890ff; width:15px; height:15px; cursor:pointer;" />
            <span style="font-weight:500; color:#e6edf3;">启用 WebDAV 远程网盘镜像 (坚果云 / 阿里盘 / Nextcloud)</span>
          </label>
          <div style="margin-left:24px; display:flex; flex-direction:column; gap:6px;">
            <input id="cfgsync-conf-webdav-url" type="text" placeholder="WebDAV 服务端 URL (如 https://dav.example.com/dav/)" style="width:100%; box-sizing:border-box; padding:5px 8px; font-size:11.5px; border-radius:5px; border:1px solid rgba(255,255,255,0.18); background:#12151d; color:#e6edf3; outline:none;" />
            <div style="display:flex; gap:8px;">
              <input id="cfgsync-conf-webdav-username" type="text" placeholder="WebDAV 用户名" style="flex:1; box-sizing:border-box; padding:5px 8px; font-size:11.5px; border-radius:5px; border:1px solid rgba(255,255,255,0.18); background:#12151d; color:#e6edf3; outline:none;" />
              <input id="cfgsync-conf-webdav-password" type="password" placeholder="密码 (留空保留原密码)" style="flex:1; box-sizing:border-box; padding:5px 8px; font-size:11.5px; border-radius:5px; border:1px solid rgba(255,255,255,0.18); background:#12151d; color:#e6edf3; outline:none;" />
            </div>
            <div style="font-size:10.5px; color:#8b949e; line-height:1.3;">
              外部存储驱动仅在后台异步镜像版本快照，网络超时或断连绝对不阻断本地备份。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div style="display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:18px;">
      <button id="cfgsync-settings-cancel-btn" type="button" style="padding:7px 16px; border-radius:6px; font-size:12.5px; font-weight:500; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#c9d1d9; cursor:pointer; transition:all 0.15s ease;">关闭</button>
      <button id="cfgsync-settings-save-btn" type="button" style="display:inline-flex; align-items:center; gap:6px; padding:7px 20px; border-radius:6px; font-size:12.5px; font-weight:600; background:#238636; border:1px solid rgba(255,255,255,0.12); color:#ffffff; cursor:pointer; transition:all 0.15s ease;">
        <i class="fa-solid fa-floppy-disk"></i>
        <span>保存全局设置</span>
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

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'touchstart'].forEach((evt) => {
    overlay.addEventListener(evt, (e) => e.stopPropagation());
  });

  overlay.onclick = (e) => {
    e.stopPropagation();
    if (e.target === overlay) close();
  };
  modal.querySelector('#cfgsync-settings-close-x').onclick = (e) => {
    e.stopPropagation();
    close();
  };
  modal.querySelector('#cfgsync-settings-cancel-btn').onclick = (e) => {
    e.stopPropagation();
    close();
  };

  const loadingEl = modal.querySelector('#cfgsync-settings-loading');
  const bodyEl = modal.querySelector('#cfgsync-settings-body');
  const saveBtn = modal.querySelector('#cfgsync-settings-save-btn');
  const adminBadge = modal.querySelector('#cfgsync-admin-badge');

  const prefHeavy = modal.querySelector('#cfgsync-pref-exclude-heavy');
  const confAllowSettings = modal.querySelector('#cfgsync-conf-allow-settings');
  const confExcludeHeavy = modal.querySelector('#cfgsync-conf-exclude-heavy');
  const confMaxVersions = modal.querySelector('#cfgsync-conf-max-versions');

  const confLocalPathEnabled = modal.querySelector('#cfgsync-conf-localpath-enabled');
  const confLocalPath = modal.querySelector('#cfgsync-conf-localpath');
  const confWebDavEnabled = modal.querySelector('#cfgsync-conf-webdav-enabled');
  const confWebDavUrl = modal.querySelector('#cfgsync-conf-webdav-url');
  const confWebDavUsername = modal.querySelector('#cfgsync-conf-webdav-username');
  const confWebDavPassword = modal.querySelector('#cfgsync-conf-webdav-password');

  // 初始化本机偏好
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('cfgsync_pref_exclude_heavy');
    prefHeavy.checked = saved !== 'false';
  }
  prefHeavy.onchange = () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cfgsync_pref_exclude_heavy', String(prefHeavy.checked));
    }
  };

  const prefAutosync = modal.querySelector('#cfgsync-pref-autosync-enabled');
  const autosyncOptions = modal.querySelector('#cfgsync-pref-autosync-options');
  const autosyncInterval = modal.querySelector('#cfgsync-pref-autosync-interval');
  const autosyncChip = modal.querySelector('#cfgsync-autosync-chip');

  const updateAutosyncChip = (enabled) => {
    if (enabled) {
      autosyncChip.textContent = '运行中';
      autosyncChip.style.background = 'rgba(82,196,26,0.15)';
      autosyncChip.style.color = '#52c41a';
      autosyncOptions.style.display = 'flex';
    } else {
      autosyncChip.textContent = '已关闭';
      autosyncChip.style.background = 'rgba(255,255,255,0.08)';
      autosyncChip.style.color = '#8b949e';
      autosyncOptions.style.display = 'none';
    }
  };

  const isAutoSyncEnabled = autoSyncEngine ? autoSyncEngine.enabled : (typeof localStorage !== 'undefined' && localStorage.getItem('cfgsync_pref_autosync_enabled') === 'true');
  prefAutosync.checked = isAutoSyncEnabled;
  updateAutosyncChip(isAutoSyncEnabled);

  if (autoSyncEngine) {
    autosyncInterval.value = String(autoSyncEngine.intervalMs);
  } else if (typeof localStorage !== 'undefined') {
    const savedInterval = localStorage.getItem('cfgsync_pref_autosync_interval');
    if (savedInterval) autosyncInterval.value = savedInterval;
  }

  prefAutosync.onchange = async () => {
    if (prefAutosync.checked) {
      if (autoSyncEngine) {
        const ok = await autoSyncEngine.requestEnable();
        if (!ok) {
          prefAutosync.checked = false;
          updateAutosyncChip(false);
          return;
        }
      } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const ok = window.confirm('开启自动同步前请确认：\n\n自动同步将在后台空闲时定期备份配置与资产至云端。系统检测到用户正在输入或 AI 正在生成回复时将自动避让。若遇到云端版本冲突将安全暂停并提示人工处理。\n\n是否确认开启？');
        if (!ok) {
          prefAutosync.checked = false;
          updateAutosyncChip(false);
          return;
        }
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cfgsync_pref_autosync_enabled', 'true');
      }
      updateAutosyncChip(true);
    } else {
      if (autoSyncEngine) autoSyncEngine.disable();
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cfgsync_pref_autosync_enabled', 'false');
      }
      updateAutosyncChip(false);
    }
  };

  autosyncInterval.onchange = () => {
    const val = Number(autosyncInterval.value) || 600000;
    if (autoSyncEngine) {
      autoSyncEngine.intervalMs = val;
      if (autoSyncEngine.enabled) autoSyncEngine.start();
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cfgsync_pref_autosync_interval', String(val));
    }
  };


  try {
    const [ctRes, configRes] = await Promise.all([
      api.getContentTypes().catch(() => ({})),
      api.getConfig().catch(() => ({ config: {} })),
    ]);

    const isAdmin = Boolean(ctRes.is_admin);
    const conf = configRes.config || {};

    if (isAdmin) {
      adminBadge.textContent = '管理员 (可编辑)';
      adminBadge.style.background = 'rgba(82,196,26,0.15)';
      adminBadge.style.color = '#52c41a';
      adminBadge.style.border = '1px solid rgba(82,196,26,0.3)';
    } else {
      adminBadge.textContent = '普通成员 (只读模式)';
      adminBadge.style.background = 'rgba(255,255,255,0.08)';
      adminBadge.style.color = '#8b949e';
      adminBadge.style.border = '1px solid rgba(255,255,255,0.12)';

      // 禁用全局配置控件
      confAllowSettings.disabled = true;
      confExcludeHeavy.disabled = true;
      confMaxVersions.disabled = true;
      confMaxVersions.style.opacity = '0.6';

      confLocalPathEnabled.disabled = true;
      confLocalPath.disabled = true;
      confWebDavEnabled.disabled = true;
      confWebDavUrl.disabled = true;
      confWebDavUsername.disabled = true;
      confWebDavPassword.disabled = true;

      saveBtn.style.display = 'none';
    }

    confAllowSettings.checked = Boolean(conf.allowSettingsSharing);
    confExcludeHeavy.checked = conf.excludeHeavyExtensions !== false;
    confMaxVersions.value = conf.maxVersions || 20;

    confLocalPathEnabled.checked = Boolean(conf.localPathEnabled);
    confLocalPath.value = conf.localPath || '';
    confWebDavEnabled.checked = Boolean(conf.webdavEnabled);
    confWebDavUrl.value = conf.webdavUrl || '';
    confWebDavUsername.value = conf.webdavUsername || '';
    confWebDavPassword.value = '';

    loadingEl.style.display = 'none';
    bodyEl.style.display = 'flex';

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>保存中...</span>';
      try {
        const payload = {
          allowSettingsSharing: confAllowSettings.checked,
          excludeHeavyExtensions: confExcludeHeavy.checked,
          maxVersions: Number(confMaxVersions.value) || 20,
          localPathEnabled: confLocalPathEnabled.checked,
          localPath: confLocalPath.value.trim(),
          webdavEnabled: confWebDavEnabled.checked,
          webdavUrl: confWebDavUrl.value.trim(),
          webdavUsername: confWebDavUsername.value.trim(),
        };
        if (confWebDavPassword.value) {
          payload.webdavPassword = confWebDavPassword.value;
        }
        await api.updateConfig(payload);
        if (onUpdated) await onUpdated();
        close();
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i><span>保存全局设置</span>';
        alert(`保存配置失败: ${err.message}`);
      }
    };
  } catch (err) {
    loadingEl.innerHTML = `<span style="color:#f85149;">加载失败: ${err.message}</span>`;
  }
}
