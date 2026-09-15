/**
 * 封装并隔离 ST 的用户认证上下文提取逻辑
 */
export class AuthContext {
  /**
   * @param {string} handle 用户唯一账号标识
   * @param {Record<string, string>} directories ST 为该用户分配的数据目录字典
   * @param {any} [rawProfile] 原始 profile 对象
   */
  constructor(handle, directories, rawProfile = null) {
    if (!handle || typeof handle !== 'string') {
      throw new Error('Invalid AuthContext: handle is required and must be a string');
    }
    this.handle = handle;
    this.directories = { ...(directories || {}), handle };
    this.rawProfile = rawProfile;
  }

  /**
   * 从 Express Request 中提取 AuthContext
   * 严格对接 ST 多用户模式结构：req.user = { profile: { handle: '...' }, directories: { ... } }
   * @param {any} req Express Request
   * @returns {AuthContext}
   */
  static fromRequest(req) {
    if (!req) {
      throw new Error('Request object is required');
    }

    const user = req.user;
    if (!user) {
      // 若 ST 未开启多用户或请求未经过登录中间件
      throw new Error('Unauthorized: No user session found in request');
    }

    let handle = null;
    let directories = {};
    let rawProfile = null;

    if (user.profile && typeof user.profile.handle === 'string') {
      handle = user.profile.handle;
      rawProfile = user.profile;
      directories = user.directories || {};
    } else if (typeof user.handle === 'string') {
      // 兼容性容错
      handle = user.handle;
      directories = user.directories || {};
    } else if (typeof user === 'string') {
      // 兼容某些单机/降级模式
      handle = user;
      directories = req.directories || {};
    }

    if (!handle) {
      throw new Error('Unauthorized: User profile handle is missing');
    }

    return new AuthContext(handle, directories, rawProfile);
  }
}
