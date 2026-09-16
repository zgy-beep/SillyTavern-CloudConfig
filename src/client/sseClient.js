/**
 * 客户端 SSE 实时事件监听器 (SseClient)
 * 连接 /api/plugins/cfgsync/events，防抖通知 UI 刷新，断线重连与轮询降级 (P5-7, N-7)
 */
export class SseClient {
  /**
   * @param {object} options
   * @param {string} [options.url]
   * @param {() => void} options.onUpdate
   * @param {number} [options.debounceMs=500]
   */
  constructor({ url = '/api/plugins/cfgsync/events', onUpdate, debounceMs = 500 } = {}) {
    this.url = url;
    this.onUpdate = onUpdate;
    this.debounceMs = debounceMs;
    this.eventSource = null;
    this.debounceTimer = null;
    this.closed = false;
  }

  connect() {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      return;
    }
    this.closed = false;
    this.close();

    try {
      this.eventSource = new window.EventSource(this.url);

      this.eventSource.addEventListener('change', (e) => {
        this.triggerUpdate();
      });

      this.eventSource.onerror = (err) => {
        // EventSource 内部会自动重连
      };
    } catch (e) {
      console.warn('[cfgsync] Failed to initialize EventSource:', e);
    }
  }

  triggerUpdate() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (typeof this.onUpdate === 'function') {
        this.onUpdate();
      }
    }, this.debounceMs);
  }

  close() {
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
