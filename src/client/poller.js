/**
 * 客户端轻量轮询器与跨标签页广播
 */
export class ClientPoller {
  /**
   * @param {import('./api.js').CloudConfigApi} api
   * @param {import('./db/idb.js').IdbStorage} storage
   * @param {string} accountHandle
   * @param {number} [intervalMs] 轮询间隔毫秒，默认 10000ms
   */
  constructor(api, storage, accountHandle, intervalMs = 10000) {
    this.api = api;
    this.storage = storage;
    this.accountHandle = accountHandle;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.isRunning = false;
    this.onUpdateCallbacks = new Set();

    // 跨标签页广播通道
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('st_cfgsync_channel');
      this.channel.onmessage = (event) => {
        if (event.data?.type === 'CHANGES_ACKED' && event.data?.accountHandle === this.accountHandle) {
          this.notifyCallbacks(event.data.events);
        }
      };
    }
  }

  onUpdate(cb) {
    this.onUpdateCallbacks.add(cb);
    return () => this.onUpdateCallbacks.delete(cb);
  }

  notifyCallbacks(events) {
    for (const cb of this.onUpdateCallbacks) {
      try {
        cb(events);
      } catch (err) {
        console.error('[cfgsync poller] Callback error:', err);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext(0);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext(delay) {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this.pollNow(), delay);
  }

  async pollNow() {
    if (!this.isRunning) return;
    try {
      const sinceSeq = await this.storage.getLastAckedSeq(this.accountHandle);
      const res = await this.api.getChanges(sinceSeq);

      if (res && Array.isArray(res.events) && res.events.length > 0) {
        // 逐条处理事件，更新对应绑定的 last_notified_version
        const bindings = await this.storage.getBindingsByAccount(this.accountHandle);
        const bindingMap = new Map(bindings.map(b => [`${b.content_type}:${b.item_uid}`, b]));

        for (const evt of res.events) {
          const key = `${evt.content_type}:${evt.item_uid}`;
          const binding = bindingMap.get(key);
          if (binding && evt.version > (binding.last_notified_version || 0)) {
            binding.last_notified_version = evt.version;
            await this.storage.saveBinding(binding);
          }
        }

        // 确认处理完毕后推进 last_acked_seq
        await this.storage.saveLastAckedSeq(this.accountHandle, res.latest_seq);

        // 通知本页面与跨标签页广播
        this.notifyCallbacks(res.events);
        if (this.channel) {
          this.channel.postMessage({
            type: 'CHANGES_ACKED',
            accountHandle: this.accountHandle,
            latest_seq: res.latest_seq,
            events: res.events,
          });
        }
      }
    } catch (err) {
      console.warn('[cfgsync poller] Poll failed:', err.message);
    } finally {
      this.scheduleNext(this.intervalMs);
    }
  }
}
