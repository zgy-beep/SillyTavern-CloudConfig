/**
 * ConfigAdapter 抽象基类
 * 定义配置类型与 ST 本地文件交互的统一契约
 */
export class ConfigAdapter {
  /**
   * @param {string} contentType
   */
  constructor(contentType) {
    if (new.target === ConfigAdapter) {
      throw new TypeError('Cannot construct ConfigAdapter instances directly');
    }
    this.contentType = contentType;
  }

  /**
   * 发现该类型下当前有哪些可同步对象
   * @param {Record<string, string>} directories req.user.directories
   * @returns {Promise<Array<{ itemUid: string, displayName: string, sourceRef: string }>>}
   */
  async listItems(directories) {
    throw new Error('listItems() not implemented');
  }

  /**
   * 读取 ST 侧当前内容
   * @param {Record<string, string>} directories
   * @param {string} itemUid
   * @returns {Promise<any>}
   */
  async read(directories, itemUid) {
    throw new Error('read() not implemented');
  }

  /**
   * 统一的写操作入口：UPSERT 写回 ST 本地文件，DELETE 从 ST 中移除
   * @param {Record<string, string>} directories
   * @param {string} itemUid
   * @param {'UPSERT' | 'DELETE'} operation
   * @param {any} [content]
   * @returns {Promise<void>}
   */
  async apply(directories, itemUid, operation, content) {
    throw new Error('apply() not implemented');
  }

  /**
   * 序列化为可存储的 Blob
   * @param {any} content
   * @returns {{ buffer: Buffer, mimeType: string, ext: string }}
   */
  serialize(content) {
    throw new Error('serialize() not implemented');
  }

  /**
   * 从 Blob 反序列化
   * @param {Buffer} buffer
   * @param {string} mimeType
   * @returns {any}
   */
  deserialize(buffer, mimeType) {
    throw new Error('deserialize() not implemented');
  }

  /**
   * 生成用于 checksum 计算的规范化字节序列（消除 JSON key 顺序等无意义差异）
   * @param {any} content
   * @returns {Buffer}
   */
  canonicalize(content) {
    throw new Error('canonicalize() not implemented');
  }

  /**
   * 基本校验
   * @param {any} content
   * @returns {boolean}
   */
  validate(content) {
    return true;
  }

  /**
   * pull/delete 完成后让 ST 前端感知的策略标识
   * @returns {string}
   */
  getReloadStrategy() {
    return 'none';
  }
}
