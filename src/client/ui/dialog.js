export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function ensureTheme() {
  if (typeof document === 'undefined' || document.getElementById('cfgsync-theme')) return;
  const style = document.createElement('link');
  style.id = 'cfgsync-theme'; style.rel = 'stylesheet';
  style.href = new URL('./theme.css', import.meta.url).href;
  document.head.appendChild(style);
}

/** Shared focus handling for all plugin dialogs, including nested dialogs. */
export function mountDialog(overlay) {
  ensureTheme();
  const previous = document.activeElement;
  const modal = overlay.firstElementChild;
  modal?.setAttribute('role', 'dialog'); modal?.setAttribute('aria-modal', 'true');
  modal?.setAttribute('aria-label', modal.querySelector('h2,h3')?.textContent || '云同步操作');
  if (modal) modal.tabIndex = -1;
  document.body.appendChild(overlay);
  const keydown = event => {
    const top = [...document.querySelectorAll('.cfgsync-modal-overlay')].filter(el => el.style.display !== 'none').at(-1);
    if (top !== overlay) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } else if (event.key === 'Tab') {
      const controls = [...overlay.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')]
        .filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); modal?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  };
  window.addEventListener('keydown', keydown, true);
  queueMicrotask(() => modal?.focus());
  const observer = new MutationObserver(() => {
    if (!overlay.isConnected) {
      window.removeEventListener('keydown', keydown, true);
      observer.disconnect(); if (previous?.isConnected) previous.focus();
    }
  });
  observer.observe(document.body, { childList: true });
}

export function notify(message, kind = 'info') {
  if (typeof document === 'undefined') { globalThis.alert?.(message); return; }
  ensureTheme();
  const toast = document.createElement('div');
  toast.className = `cfgsync-toast cfgsync-toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message; toast.tabIndex = 0;
  toast.title = '点击关闭'; toast.onclick = () => toast.remove();
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), kind === 'error' ? 12000 : 6500);
}

export function chooseDisable(hasBackup) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'cfgsync-modal-overlay';
    overlay.innerHTML = `<div class="cfgsync-modal cfgsync-choice"><h2>关闭同步</h2>
      <p>关闭后将停止后台备份。你可以保留当前配置${hasBackup ? '，或恢复开启同步前的本地备份' : ''}。</p>
      <div class="cfgsync-choice-actions">
        ${hasBackup ? '<button data-choice="restore">恢复本地备份并关闭</button>' : ''}
        <button class="cfgsync-primary" data-choice="keep">保留当前配置并关闭</button>
        <button data-choice="cancel">取消</button></div></div>`;
    const close = value => { overlay.remove(); resolve(value); };
    overlay.onclick = event => { if (event.target === overlay) close('cancel'); };
    overlay.querySelectorAll('[data-choice]').forEach(button => { button.onclick = () => close(button.dataset.choice); });
    mountDialog(overlay);
  });
}
