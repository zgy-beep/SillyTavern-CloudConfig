/**
 * SSE 实时事件流服务 (SseService)
 * 满足 P5-7, N-7, N-12 与 TC11：
 * 1. 25s 心跳保活 (:heartbeat\n\n) 破除代理超时
 * 2. 权限隔离：A 的 settings 变动绝不广播给未经授权的 B
 * 3. Last-Event-ID 断线自动补发
 * 4. 广播方法 broadcastEvent
 */
export class SseService {
  /**
   * @param {object} options
   * @param {import('./ChangeEventBus.js').ChangeEventBus} [options.changeBus]
   * @param {import('./AuthorizationService.js').AuthorizationService} [options.authService]
   * @param {import('../config/ConfigService.js').ConfigService} [options.configService]
   * @param {number} [options.heartbeatIntervalMs=25000]
   */
  constructor({ changeBus = null, authService = null, configService = null, heartbeatIntervalMs = 25000 } = {}) {
    this.changeBus = changeBus;
    this.authService = authService;
    this.configService = configService;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.clients = new Set();

    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat();
      }, this.heartbeatIntervalMs);
      if (this.heartbeatTimer.unref) {
        this.heartbeatTimer.unref();
      }
    }
  }

  /**
   * 注册新 SSE 客户端连接
   * @param {import('express').Response} res
   * @param {import('../auth/AuthContext.js').AuthContext} authContext
   * @param {string|number} [lastEventId]
   * @returns {object} client record
   */
  addClient(res, authContext, lastEventId = null) {
    const handle = authContext?.handle || 'anonymous';
    const client = {
      id: Math.random().toString(36).slice(2),
      res,
      authContext,
      handle,
    };
    this.clients.add(client);

    // 立即下发初始 ok 确认包，让客户端和反代（包括 curl -N）立即拿到首字节 (N-7/N-12)
    try {
      res.write(':ok\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {}

    // 若客户端重连带有 Last-Event-ID，回放漏掉的变更事件
    if (lastEventId !== null && lastEventId !== undefined && this.changeBus) {
      const sinceSeq = Number(lastEventId);
      if (!Number.isNaN(sinceSeq) && sinceSeq >= 0) {
        try {
          const missed = this.changeBus.getChanges(handle, sinceSeq);
          if (missed && Array.isArray(missed.events)) {
            for (const evt of missed.events) {
              this.sendToClient(client, evt);
            }
          }
        } catch (err) {
          console.warn('[cfgsync] SSE failed to replay missed events:', err.message);
        }
      }
    }

    return client;
  }

  /**
   * 移除已断开的客户端
   * @param {object} client
   */
  removeClient(client) {
    if (client) {
      this.clients.delete(client);
    }
  }

  /**
   * 向指定客户端发送单个事件
   */
  sendToClient(client, event) {
    try {
      const seq = event.seq || Date.now();
      const payload = JSON.stringify(event);
      client.res.write(`id: ${seq}\nevent: change\ndata: ${payload}\n\n`);
      if (typeof client.res.flush === 'function') client.res.flush();
    } catch (err) {
      this.removeClient(client);
    }
  }

  /**
   * 全网广播变更事件（严格执行可见性过滤与黑名单隔离）
   * @param {object} event
   */
  broadcastEvent(event) {
    if (!event || this.clients.size === 0) return;

    const owner = event.owner_handle || event.ownerHandle;
    const contentType = event.content_type || event.contentType;
    const itemUid = event.item_uid || event.itemUid;
    const allowSettingsSharing = Boolean(this.configService?.get('allowSettingsSharing'));

    for (const client of this.clients) {
      // 1. 本人始终可见自身产生的变更
      if (client.handle === owner) {
        this.sendToClient(client, event);
        continue;
      }

      // 2. 他人事件：settings 类型若未开启 allowSettingsSharing 则坚决不广播
      if (contentType === 'settings' && !allowSettingsSharing) {
        continue;
      }

      // 3. 校验权限：检查是否存在对该 client 的有效授权
      if (this.authService) {
        try {
          const grant = this.authService.getApprovedGrant(owner, client.handle, contentType, itemUid);
          if (!grant) {
            continue;
          }
        } catch {
          continue;
        }
      }

      this.sendToClient(client, event);
    }
  }

  /**
   * 向所有活跃连接发送 25s 心跳保活
   */
  sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.res.write(':heartbeat\n\n');
        if (typeof client.res.flush === 'function') client.res.flush();
      } catch {
        this.removeClient(client);
      }
    }
  }

  /**
   * 关闭 SSE 服务并断开连接
   */
  close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
