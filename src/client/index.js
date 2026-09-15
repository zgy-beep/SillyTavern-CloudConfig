import { CloudConfigApi } from './api.js';
import { IdbStorage } from './db/idb.js';
import { ClientSyncManager } from './syncManager.js';
import { ClientPoller } from './poller.js';
import { CloudConfigPanel } from './ui/panel.js';

/**
 * SillyTavern 前端扩展初始化入口
 */
export async function initExtension() {
  console.log('[SillyTavern-CloudConfig] Client extension initializing...');

  // 1. 初始化存储与 API
  const api = new CloudConfigApi();
  const storage = new IdbStorage();
  await storage.open();

  // 2. 获取当前登录账号 Handle（优先直接同步后端鉴权标识）
  let accountHandle = 'default-user';
  try {
    const typeRes = await api.getContentTypes().catch(() => null);
    if (typeRes?.current_user) {
      accountHandle = typeRes.current_user;
    } else if (window.SillyTavern?.getContext) {
      const ctx = window.SillyTavern.getContext();
      accountHandle = ctx?.userId || ctx?.user?.profile?.handle || 'default-user';
    }
  } catch {
    accountHandle = 'default-user';
  }

  // 3. 初始化各核心客户端模块
  const syncManager = new ClientSyncManager(api, storage);
  const poller = new ClientPoller(api, storage, accountHandle);
  const panel = new CloudConfigPanel({
    api,
    syncManager,
    storage,
    accountHandle,
    onAccountChange: (newHandle) => poller.setAccountHandle(newHandle),
  });

  // 4. 启动后台增量轮询
  poller.start();
  poller.onUpdate(() => {
    panel.refresh();
  });

  // 4. 注册并挂载到 ST 扩展设置侧边栏抽屉 (#extensions_settings)
  const mountDrawer = () => {
    if (document.querySelector('#cfgsync-drawer-container')) return true;
    const drawer = document.querySelector('#extensions_settings');
    if (!drawer) return false;

    const drawerContainer = document.createElement('div');
    drawerContainer.id = 'cfgsync-extension-container';
    drawerContainer.className = 'extension_settings';
    drawerContainer.innerHTML = `
      <div class="inline-drawer" style="box-sizing: border-box; width: 100%;">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>☁️ 配置云同步</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none; box-sizing: border-box; width: 100%; padding: 8px 10px;">
          <div id="cfgsync-panel-root" style="box-sizing: border-box; width: 100%;"></div>
        </div>
      </div>
    `;

    // 兼容非 jQuery 环境下的原生切换
    if (!window.$) {
      const toggleBtn = drawerContainer.querySelector('.inline-drawer-toggle');
      const contentEl = drawerContainer.querySelector('.inline-drawer-content');
      const iconEl = drawerContainer.querySelector('.inline-drawer-icon');
      toggleBtn.addEventListener('click', () => {
        const isHidden = contentEl.style.display === 'none';
        contentEl.style.display = isHidden ? 'block' : 'none';
        iconEl.classList.toggle('down', !isHidden);
        iconEl.classList.toggle('up', isHidden);
      });
    }

    drawer.appendChild(drawerContainer);
    panel.render(drawerContainer.querySelector('#cfgsync-panel-root'));
    return true;
  };

  if (!mountDrawer()) {
    const timer = setInterval(() => {
      if (mountDrawer()) clearInterval(timer);
    }, 500);
  }

  console.log('[SillyTavern-CloudConfig] Client extension initialized for account:', accountHandle);
}

// 自动在浏览器环境中载入
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initExtension());
  } else {
    initExtension();
  }
}
