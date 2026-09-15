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

  // 1. 获取当前登录账号 Handle
  let accountHandle = 'default';
  try {
    // ST 经典全局上下文
    if (window.SillyTavern?.getContext) {
      const ctx = window.SillyTavern.getContext();
      accountHandle = ctx?.userId || ctx?.user?.profile?.handle || 'default';
    }
  } catch {
    accountHandle = 'default';
  }

  // 2. 初始化各核心客户端模块
  const api = new CloudConfigApi();
  const storage = new IdbStorage();
  await storage.open();

  const syncManager = new ClientSyncManager(api, storage);
  const poller = new ClientPoller(api, storage, accountHandle);
  const panel = new CloudConfigPanel({ api, syncManager, storage, accountHandle });

  // 3. 启动后台增量轮询
  poller.start();
  poller.onUpdate(() => {
    panel.refresh();
  });

  // 4. 注册 ST 侧边栏/抽屉入口按钮（如果存在对应容器）
  const drawer = document.querySelector('#extensions_settings');
  if (drawer) {
    const section = document.createElement('div');
    section.className = 'extension_settings_section';
    section.innerHTML = `
      <div class="title_restorable">
        <h4>☁️ 配置云同步</h4>
      </div>
      <div id="cfgsync-panel-root"></div>
    `;
    drawer.appendChild(section);
    panel.render(section.querySelector('#cfgsync-panel-root'));
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
